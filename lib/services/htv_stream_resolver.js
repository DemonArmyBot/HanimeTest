const crypto = require('crypto');
const axios = require('axios');
const { buildUpstreamUrls } = require('../config');
const { upstreamProxyOptions } = require('../utils/proxy_helper');
const logger = require('../logger');
const signatureService = require('./htv_signature_service');
const CfBypassClient = require('./cf_bypass_client');
const { originOf } = require('./cf_bypass_client');

const ESTIMATED_BITRATES_MBPS = new Map([
  [360, 0.48],
  [480, 0.62],
  [720, 1.35],
  [1080, 2.7]
]);

// hanime's "insecure" message envelope: AES-256-GCM, key = SHA-256 of a fixed
// label, AAD = a second fixed label. Used to seal the handshake request token
// and to open the `x-token` response header. (Names taken verbatim from
// hanime's app_init bundle: encryptInsecureMessage / decryptInsecureMessage.)
const MSG_KEY = crypto.createHash('sha256').update('htv-insecure-handshake-v1').digest();
const MSG_AAD = Buffer.from('htv-insecure-v1');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (str) => Buffer.from(
  String(str).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '='),
  'base64'
);

/**
 * Seal an object into a hanime "insecure" message token.
 * @param {Object} obj
 * @returns {string} base64url token
 */
function sealMessage(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MSG_KEY, iv, { authTagLength: 16 });
  cipher.setAAD(MSG_AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const envelope = {
    v: 1,
    alg: 'AES-256-GCM',
    iv: b64url(iv),
    tag: b64url(cipher.getAuthTag()),
    data: b64url(data)
  };
  return b64url(Buffer.from(JSON.stringify(envelope)));
}

/**
 * Open a hanime "insecure" message token.
 * @param {string} token base64url token
 * @returns {Object} parsed payload
 */
function openMessage(token) {
  const envelope = JSON.parse(b64urlDecode(token).toString('utf8'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', MSG_KEY, b64urlDecode(envelope.iv), { authTagLength: 16 });
  decipher.setAAD(MSG_AAD);
  decipher.setAuthTag(b64urlDecode(envelope.tag));
  const plain = Buffer.concat([decipher.update(b64urlDecode(envelope.data)), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

class HtvStreamResolver {
  /**
   * @param {Object} config - App config (uses config.api.htv)
   */
  constructor(config) {
    const htv = (config && config.api && config.api.htv) || {};
    // The relay, when configured, is tried first; otherwise the direct hosts
    // are rotated. Cloudflare's WAF blocks datacenter egress on some hosts but
    // not others, so a single hardcoded host fails from most cloud hosts.
    this.handshakeUrls = htv.handshakeUrl
      ? [htv.handshakeUrl]
      : buildUpstreamUrls(htv.handshakePath || '/api/v11/handshake', htv.handshakeHosts);
    this.relaySecret = htv.relaySecret || null;
    this.hlsHost = htv.hlsHost || 'https://hanime.tv';
    this.timeoutMs = htv.timeoutMs || 15000;
    this.maxHostAttempts = htv.maxHostAttempts || 4;
    // Never try fewer hosts than are configured: the whole point of the list is
    // that some hosts are blocked for this egress range. A retry budget lower
    // than the list length silently gave up before reaching a reachable host.
    this.maxHostAttempts = Math.max(this.maxHostAttempts, this.handshakeUrls.length);
    this.lastHandshakeUrlIndex = 0;
    this.defaultDurationMs = htv.defaultDurationMs ||
      (config && config.api && config.api.defaultDurationMs) ||
      20 * 60 * 1000;
    this.userAgent = htv.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
    // Routed through a residential proxy when configured. This is the single
    // most effective fix when the deployment's own egress is Cloudflare-blocked.
    this.proxyOptions = upstreamProxyOptions(config);
    // Solves hanime's JavaScript challenge when a solver service is configured.
    this.cfBypass = new CfBypassClient(config);
    // Hosts already attempted a solve this round, so a challenge cannot cause an
    // infinite solve/retry loop.
    this.solvedDomains = new Set();
  }

  /**
   * Resolve playable HLS streams for a video slug via the /api/v11/handshake
   * flow. Returns absolute hanime.tv/hls URLs that Stremio can play directly
   * (their segments and AES key are openly fetchable). Empty array on failure.
   *
   * @param {string} slug - Video slug (e.g. "bible-black-6")
   * @param {string} [sessionToken] - Optional session token to unlock premium
   *   (e.g. 1080p) qualities; omit for guest playback.
   * @returns {Promise<Array<{height: (string|number), url: string}>>}
   */
  async resolveStreams(slug, sessionToken) {
    if (!slug) return [];

    const sig = await signatureService.getSignature();
    if (!sig) {
      logger.warn('HTV stream resolve: no signature available', { slug });
      return [];
    }

    const token = sealMessage({
      timestamp_unix: Math.floor(Date.now() / 1000),
      directive: 'htv_player_handshake',
      slug
    });

    const payload = await this._requestHandshake(token, sig, sessionToken, slug);
    if (!payload) return [];

    const normalizedSources = this._normalizeSources(payload);
    if (normalizedSources.length === 0) {
      logger.warn('HTV handshake returned no playable sources', { slug });
      return [];
    }

    return normalizedSources.map((source) => {
      const durationMs = this.defaultDurationMs;
      const bitrateMbps = ESTIMATED_BITRATES_MBPS.get(Number(source.height)) || 1.35;
      const filesizeMbs = Math.round(
        (bitrateMbps * (durationMs / 1000) / 8) * 10
      ) / 10;
      return {
        ...source,
        filesizeMbs,
        durationMs,
        filesizeEstimated: true,
        durationEstimated: true
      };
    });
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * POST the handshake across the host chain and decrypt the returned x-token.
   * @private
   * @returns {Promise<Object|null>} decrypted manifest payload or null
   */
  async _requestHandshake(token, sig, sessionToken, slug) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': this.userAgent,
      referer: 'https://hanime.tv/',
      origin: 'https://hanime.tv',
      'x-signature-version': 'web2',
      'x-signature': sig.signature,
      'x-time': String(sig.time)
    };
    if (this.relaySecret) headers.authorization = `Bearer ${this.relaySecret}`;
    if (sessionToken) headers['x-session-token'] = sessionToken;

    const attempts = Math.min(this.maxHostAttempts, this.handshakeUrls.length);
    let lastStatus = null;

    for (let i = 0; i < attempts; i++) {
      const index = (this.lastHandshakeUrlIndex + i) % this.handshakeUrls.length;
      const url = this.handshakeUrls[index];

      let response;
      try {
        response = await axios.post(url, { token }, {
          headers,
          timeout: this.timeoutMs,
          validateStatus: () => true,
          ...this.proxyOptions
        });
      } catch (error) {
        logger.warn('HTV handshake request failed', { url, slug, error: error.message });
        continue;
      }

      lastStatus = response.status;
      const xToken = response.headers['x-token'];

      if (response.status === 200 && xToken) {
        try {
          const payload = openMessage(xToken);
          this.lastHandshakeUrlIndex = index;
          return payload;
        } catch (error) {
          logger.warn('HTV handshake x-token decode failed', { url, slug, error: error.message });
          continue;
        }
      }

      // An interactive challenge is solvable: ask the browser-based solver for a
      // fresh clearance cookie and retry this same host once. The cookie is
      // bound to the solver's IP, so this only works when the solver shares our
      // egress.
      if (this.cfBypass.enabled && !this.solvedDomains.has(url)) {
        const origin = originOf(url);
        if (origin) {
          logger.info('Handshake hit a Cloudflare challenge, solving', { url });
          this.solvedDomains.add(url);
          const solved = await this.cfBypass.solve(origin, true);
          if (solved) {
            Object.assign(headers, {
              cookie: solved.cookie,
              ...(solved.userAgent ? { 'user-agent': solved.userAgent } : {})
            });
            i--; // retry this host with the new headers
            continue;
          }
          logger.warn('Cloudflare solve produced no cookie; retrying hosts anyway', { url });
        }
      }

      logger.warn('HTV handshake non-200 or missing x-token', {
        url,
        slug,
        status: response.status,
        challenge: this.cfBypass.isChallenge(response),
        errorId: response.data && response.data.error_id
      });
    }

    logger.warn('HTV handshake failed on all hosts', {
      slug,
      attempts,
      lastStatus,
      hosts: attempts,
      viaProxy: !!this.proxyOptions.proxy,
      cfSolver: this.cfBypass.enabled,
      hint: lastStatus === 403
        ? this.cfBypass.enabled
          ? 'Cloudflare challenge survived the solver. Confirm the solver shares this addon\'s egress IP, since cf_clearance is bound to the address that solved it.'
          : 'Blocked by an interactive Cloudflare challenge, which no HTTP client can pass. Configure CF_BYPASS_URL to a browser-based solver service that shares this server\'s egress IP. A proxy alone will not help — the blocker is the challenge script, not the IP.'
        : undefined
    });

    return null;
  }

  /**
   * Collect playable sources from a handshake manifest.
   *
   * The manifest carries sources in two places depending on the account
   * tier: a flat `sources` array and per-server `servers[].streams`. Entries
   * with a `kind` other than `normal` are promo/premium-only and do not play
   * from a guest handshake, so they are skipped.
   * @private
   * @returns {Array<{height: (string|number), url: string}>}
   */
  _normalizeSources(payload) {
    const collected = [];

    if (Array.isArray(payload.sources)) {
      collected.push(...payload.sources);
    }
    if (Array.isArray(payload.servers)) {
      for (const server of payload.servers) {
        if (server && Array.isArray(server.streams)) collected.push(...server.streams);
      }
    }

    const seen = new Set();
    const sources = [];

    for (const source of collected) {
      if (!source || typeof source !== 'object') continue;
      const kind = source.kind || 'normal';
      if (kind !== 'normal') continue;

      const rawUrl = source.src || source.signed_url || source.url || '';
      if (!rawUrl) continue;

      const url = rawUrl.startsWith('http') ? rawUrl : `${this.hlsHost}${rawUrl}`;
      if (seen.has(url)) continue;
      seen.add(url);

      sources.push({
        height: source.height || source.label || '',
        url
      });
    }

    return sources;
  }
}

module.exports = HtvStreamResolver;
module.exports.sealMessage = sealMessage;
module.exports.openMessage = openMessage;