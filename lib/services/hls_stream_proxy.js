/**
 * HLS Stream Proxy
 *
 * Serves HLS manifests and segments on behalf of the player so that the
 * player's device never talks to hanime directly. The player's request arrives
 * here, this server fetches the upstream with the headers hanime's edge
 * expects, and the body is passed straight through.
 *
 * Two URL shapes are handled:
 *   /proxy/stream/<base64url upstream url>   manifest or segment
 *   /proxy/stream/<token>/<base64url upstream url>   credentialed variant
 *
 * Every URL is HMAC-signed so this endpoint cannot be pointed at arbitrary
 * destinations, and upstream hosts are allowlisted so even a forged signature
 * cannot turn it into a general proxy.
 */

const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const logger = require('../logger');
const { buildPlayerHeaders } = require('../transformers/stream_transformer');

// Only these hosts may ever be fetched. Anything else is refused regardless of
// signature, which bounds the damage from a leaked/guessable secret.
//
// This list is a floor, not a ceiling: hanime can serve playlists from
// hanime.tv and segments from a separate CDN host. Anything referenced from an
// already-verified playlist is rewritten only if it is on this list, so an
// unknown host is left pointing at upstream and will fail loudly rather than
// being silently proxied. Extend it with STREAM_PROXY_ALLOWED_HOSTS when a new
// CDN appears.
const ALLOWED_UPSTREAM_HOSTS = new Set([
  'hanime.tv',
  'www.hanime.tv',
  'auth.hanime.tv',
  'hanime-cdn.com',
  'www.hanime-cdn.com',
  'guest.freeanimehentai.net',
  // Segment/media hosts observed alongside playlist hosts. Kept explicit so the
  // allowlist never becomes a wildcard.
  'm3u8s.highwinds-cdn.com',
  'videos.hanime.tv',
  'media.hanime-cdn.com'
]);

// Media segment extensions. Used only as a hint for the Accept header before a
// request is made; the authoritative manifest/segment decision is made from the
// response body (see detectManifest), because hanime serves playlists from
// extensionless paths such as /hls/<id>/<token>.
const SEGMENT_EXTENSIONS = /\.(ts|m4s|mp4|m4a|mp3|aac|webm|vtt|key)(\?|#|$)/i;
const MANIFEST_EXTENSIONS = /\.m3u8(\?|#|$)/i;

// Every HLS playlist begins with this tag, whatever the URL looks like.
const MANIFEST_MAGIC = '#EXTM3U';

/**
 * Decide whether a fetched body is a playlist or media bytes.
 *
 * Guessing from the URL is not safe: hanime serves its playlists from
 * extensionless paths (`/hls/<id>/<token>`), so a `.ts`-or-`.m3u8` heuristic
 * would classify a real manifest as a segment and pass it through unrewritten,
 * sending the player straight back to hanime for the segments.
 *
 * @param {Buffer} body - Response body
 * @param {string} contentType - Upstream content-type header
 * @returns {boolean} true when the body is an HLS playlist
 */
function detectManifest(body, contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('mpegurl')) return true;

  // Sniff the body rather than trusting the content-type. hanime serves its
  // playlists from extensionless paths, and may or may not label them as
  // m3u8; a manifest labelled octet-stream must still be rewritten, because
  // passing it through unrewritten silently breaks proxy mode. Media bytes
  // never begin with the #EXTM3U tag, so the sniff cannot misfire.
  const head = Buffer.isBuffer(body) ? body.slice(0, 64).toString('utf8') : String(body || '').slice(0, 64);
  return head.trimStart().startsWith(MANIFEST_MAGIC);
}

const b64urlDecode = (value) => Buffer.from(String(value), 'base64url').toString('utf8');

class HlsStreamProxy {
  /**
   * @param {Object} appConfig - App config (uses config.streamProxy)
   */
  constructor(appConfig) {
    const proxyConfig = (appConfig && appConfig.streamProxy) || {};
    this.timeoutMs = proxyConfig.timeoutMs || 20000;
    this.maxBodyBytes = proxyConfig.maxBodyBytes || 64 * 1024 * 1024;
    this.manifestCacheSeconds = proxyConfig.manifestCacheSeconds ?? 30;
    // A per-boot secret is fine: signed URLs simply stop resolving after a
    // restart, and players re-fetch the stream list on reconnect.
    this.secret = proxyConfig.secret || crypto.randomBytes(32).toString('hex');
    // The transformer signs URLs independently of this instance, so it must
    // share this secret.
    require('./hls_stream_proxy_url').setProxySecret(this.secret);
    this.playerConfig = {
      userAgent: appConfig?.api?.htv?.playerUserAgent,
      referer: appConfig?.api?.htv?.playerReferer,
      origin: appConfig?.api?.htv?.playerOrigin
    };

    // Extra hosts the operator has confirmed hanime serves media from.
    const extraHosts = proxyConfig.extraHosts || [];
    for (const host of extraHosts) {
      const normalized = String(host).trim().toLowerCase();
      if (normalized) ALLOWED_UPSTREAM_HOSTS.add(normalized);
    }
  }

  // ============================================================================
  // URL signing
  // ============================================================================

  /**
   * Build a signed proxy path for an upstream URL.
   * @param {string} upstreamUrl - Absolute hanime URL to proxy
   * @returns {string} Signed proxy path (leading slash)
   */
  signUrl(upstreamUrl) {
    const payload = Buffer.from(upstreamUrl, 'utf8').toString('base64url');
    const sig = this._sign(payload);
    return `${config.streamProxy.path}/${payload}?s=${sig}`;
  }

  /**
   * Verify a proxy path's signature and recover the upstream URL.
   * @param {string} payload - base64url payload from the path
   * @param {string} signature - signature from the query string
   * @returns {{ok: true, url: string}|{ok: false, reason: string}} Verification result
   */
  verifyUrl(payload, signature) {
    if (!payload || !signature) return { ok: false, reason: 'missing signature' };

    const expected = this._sign(payload);
    const a = Buffer.from(String(signature));
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'bad signature' };
    }

    let url;
    try {
      url = b64urlDecode(payload);
    } catch (_) {
      return { ok: false, reason: 'undecodable payload' };
    }

    const allowed = this.isAllowedUpstream(url);
    if (!allowed.ok) return { ok: false, reason: allowed.reason };

    return { ok: true, url };
  }

  /**
   * @private
   */
  _sign(payload) {
    return crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  /**
   * Check an upstream URL against the host allowlist and scheme.
   * @param {string} url - Candidate URL
   * @returns {{ok: boolean, reason?: string}} Allowlist verdict
   */
  isAllowedUpstream(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return { ok: false, reason: 'invalid url' };
    }
    if (parsed.protocol !== 'https:') {
      return { ok: false, reason: 'non-https scheme' };
    }
    const host = parsed.hostname.toLowerCase();
    if (!ALLOWED_UPSTREAM_HOSTS.has(host)) {
      return { ok: false, reason: `host not allowed: ${host}` };
    }
    return { ok: true };
  }

  // ============================================================================
  // Manifest rewriting
  // ============================================================================

  /**
   * Rewrite a manifest so nested playlist and segment URIs point back at this
   * proxy. HLS manifests mix absolute and relative URIs and repeat them in tags
   * (#EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA), so each has to be handled.
   *
   * @param {string} manifest - Raw m3u8 body
   * @param {string} baseUrl - Absolute URL the manifest was fetched from
   * @returns {string} Rewritten manifest
   */
  rewriteManifest(manifest, baseUrl) {
    const base = new URL(baseUrl);

    // Resolve a possibly-relative URI against the manifest's own URL.
    const absolutize = (uri) => {
      try {
        return new URL(uri, base).toString();
      } catch (_) {
        return null;
      }
    };

    const lines = String(manifest).split(/\r?\n/);
    const out = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Blank lines and the #EXTM3U header carry no URIs.
      if (!trimmed) {
        out.push(line);
        continue;
      }

      if (!trimmed.startsWith('#')) {
        const absolute = absolutize(trimmed);
        if (absolute && this.isAllowedUpstream(absolute).ok) {
          out.push(this.signUrl(absolute));
        } else {
          // Not ours (or unparseable): leave it untouched rather than rewriting
          // it into something that cannot resolve.
          out.push(line);
        }
        continue;
      }

      // Tags carrying a URI attribute.
      if (/^#EXT-X-(KEY|MAP|MEDIA|I-FRAME-STREAM-INF|PART):/.test(trimmed)) {
        out.push(line.replace(/URI="([^"]+)"/g, (match, uri) => {
          const absolute = absolutize(uri);
          if (!absolute || !this.isAllowedUpstream(absolute).ok) return match;
          return `URI="${this.signUrl(absolute)}"`;
        }));
        continue;
      }

      // Variant/media stream lines point at a nested playlist on the next line.
      if (/^#EXT-X-(STREAM-INF|MEDIA):/.test(trimmed)) {
        out.push(line);
        continue;
      }

      out.push(line);
    }

    return out.join('\n');
  }

  // ============================================================================
  // Fetching
  // ============================================================================

  /**
   * Proxy one upstream request to the client.
   *
   * @param {Object} req - Express request
   * @param {Object} res - Express response
   * @param {string} upstreamUrl - Verified hanime URL
   * @returns {Promise<void>} Resolves once the response is finished
   */
  async proxy(req, res, upstreamUrl) {
    // Only a hint for the Accept header; the real decision happens once the
    // body is in hand (see detectManifest).
    const hintIsManifest = MANIFEST_EXTENSIONS.test(upstreamUrl) ||
      (!SEGMENT_EXTENSIONS.test(upstreamUrl) && looksLikeManifest(upstreamUrl));

    const upstream = await axios.get(upstreamUrl, {
      headers: {
        ...buildPlayerHeaders(this.playerConfig),
        accept: hintIsManifest
          ? 'application/vnd.apple.mpegurl,application/x-mpegurl,*/*'
          : '*/*',
        'accept-language': 'en-US,en;q=0.9'
      },
      timeout: this.timeoutMs,
      responseType: 'arraybuffer',
      maxRedirects: 3,
      // Inspect the status ourselves so a Cloudflare HTML page is reported as a
      // block rather than being handed to the player as if it were a segment.
      validateStatus: () => true
    });

    if (upstream.status < 200 || upstream.status >= 300) {
      const contentType = String(upstream.headers['content-type'] || '');
      logger.warn('Stream proxy upstream refused', {
        status: upstream.status,
        contentType,
        hintIsManifest
      });
      res.status(upstream.status === 403 ? 502 : upstream.status);
      return res.end(contentType.includes('text/html')
        ? 'Upstream blocked (Cloudflare) while proxying the stream.'
        : 'Upstream error while proxying the stream.');
    }

    // Guard against an unexpectedly large body being held in memory.
    const declared = Number(upstream.headers['content-length'] || 0);
    if (declared && declared > this.maxBodyBytes) {
      res.status(413);
      return res.end('Upstream body too large to proxy.');
    }

    const body = Buffer.from(upstream.data);
    const isManifest = detectManifest(body, upstream.headers['content-type']);

    if (isManifest) {
      const rewritten = this.rewriteManifest(body.toString('utf8'), upstreamUrl);
      res.status(200);
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      res.setHeader('cache-control', `public, max-age=${this.manifestCacheSeconds}`);
      res.setHeader('access-control-allow-origin', '*');
      return res.end(rewritten);
    }

    // Segments: pass the bytes through untouched and let the player cache them.
    res.status(200);
    res.setHeader('content-type', upstream.headers['content-type'] || 'video/mp2t');
    res.setHeader('content-length', body.length);
    res.setHeader('cache-control', 'public, max-age=86400, immutable');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-expose-headers', 'content-length,content-range');
    return res.end(body);
  }
}

/**
 * Heuristic for extensionless manifest URLs: hanime's HLS entries commonly end
 * in `/index` or `/master` rather than `.m3u8`.
 * @param {string} url - Candidate URL
 * @returns {boolean} true when the URL looks like a playlist
 */
function looksLikeManifest(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch (_) {
    return false;
  }
  return /\/(index|master|playlist|manifest)(\.m3u8)?$/.test(pathname);
}

module.exports = HlsStreamProxy;
module.exports.ALLOWED_UPSTREAM_HOSTS = ALLOWED_UPSTREAM_HOSTS;
module.exports.detectManifest = detectManifest;