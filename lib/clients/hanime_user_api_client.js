const axios = require('axios');
const { getAppSignature } = require('@nekolab/hanime/dist/modules/crypto');
const { buildUpstreamUrls } = require('../config');
const { upstreamProxyOptions } = require('../utils/proxy_helper');
const CfBypassClient = require('../services/cf_bypass_client');
const { originOf } = require('../services/cf_bypass_client');
const logger = require('../logger');

// Upstream retired the /rapi/v4 app API (2026-07). Auth lives on /rapi/v7
// with an {email, password} payload instead of v4's {burger, fries}, and
// per-video data moved to the v8 endpoint. The bundled @nekolab/hanime request
// client still targets v4, sends no browser headers (Cloudflare rejects it
// with a 403 challenge on every request), parses the body before checking the
// status, and has no timeout — so this client issues the requests itself.
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

/**
 * Convert snake_case keys to camelCase (one level deep + nested plain objects).
 * Mirrors the conversion the bundled client applied to its JSON responses.
 * @param {*} value - Value to convert
 * @returns {*} Converted value
 */
function convertToCamelCase(value) {
  if (Array.isArray(value)) {
    return value.map(convertToCamelCase);
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      const camel = key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
      out[camel] = convertToCamelCase(val);
    }
    return out;
  }
  return value;
}

/**
 * Clean API wrapper for Hanime operations
 * Provides methods without console logging for use in other projects
 * Automatically handles session token expiration and refresh
 */
class HanimeUserApi {
  /**
   * Create a new HanimeUserApi instance
   * @param {string} sessionToken - Optional existing session token
   * @param {string} email - Optional user email for auto-refresh
   * @param {string} password - Optional user password for auto-refresh
   * @param {number} sessionTokenExpireTimeUnix - Optional expiration time (Unix timestamp)
   * @param {Object} [config] - App config (uses config.api.htv for hosts)
   */
  constructor(sessionToken = null, email = null, password = null, sessionTokenExpireTimeUnix = null, config = require('../config')) {
    this.sessionToken = sessionToken || null;
    this.email = email;
    this.password = password;
    this.sessionTokenExpireTimeUnix = sessionTokenExpireTimeUnix;
    this.isPremium = false;

    const htv = (config && config.api && config.api.htv) || {};
    this.authUrls = buildUpstreamUrls(
      htv.authPath || '/rapi/v7/sessions',
      htv.authHosts,
      htv.authUrl || null
    );
    this.relaySecret = htv.relaySecret || null;
    this.userAgent = htv.userAgent || DEFAULT_USER_AGENT;
    this.timeoutMs = htv.timeoutMs || 15000;
    this.maxHostAttempts = htv.maxHostAttempts || 4;
    // Remembers the host that last accepted credentials so the cached-session
    // reuse path and later logins skip hosts already known to be blocked.
    this.lastAuthUrlIndex = 0;
    // Routed through a residential proxy when configured.
    this.proxyOptions = upstreamProxyOptions(config);
    this.hasProxy = !!this.proxyOptions.proxy;
    // Login sits behind the same interactive challenge as the handshake.
    this.cfBypass = new CfBypassClient(config);
  }

  // ============================================================================
  // Public Methods
  // ============================================================================

  /**
   * Login with email and password
   * @param {string} email - User email
   * @param {string} password - User password
   * @returns {Promise<Object>} Login result with user info and session token
   */
  async login(email, password) {
    const loginResult = await this._requestSession(email, password);
    const user = loginResult.user || {};

    this.sessionToken = loginResult.sessionToken;
    this.info = loginResult;

    // Store credentials and expiration for auto-refresh
    this.email = email;
    this.password = password;
    this.sessionTokenExpireTimeUnix = loginResult.sessionTokenExpireTimeUnix;
    this.isPremium = !!user.isAbleToAccessPremium;

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        slug: user.slug,
        coins: user.coins,
        avatarUrl: user.avatarUrl,
        isPremium: !!user.isAbleToAccessPremium,
        premiumStatus: user.btPremiumStatus
      },
      sessionToken: loginResult.sessionToken,
      sessionTokenExpireTimeUnix: loginResult.sessionTokenExpireTimeUnix,
      sessionTokenExpiresAt: loginResult.sessionTokenExpireTimeUnix
        ? new Date(loginResult.sessionTokenExpireTimeUnix * 1000)
        : null,
      fullResponse: loginResult // Include full response if needed
    };
  }

  /**
   * Get current session token
   * @returns {string|null} Session token or null if not logged in
   */
  getSessionToken() {
    return this.sessionToken || null;
  }

  /**
   * Get session token expiration time (Unix timestamp)
   * @returns {number|null} Expiration time or null if not set
   */
  getSessionTokenExpireTimeUnix() {
    return this.sessionTokenExpireTimeUnix || null;
  }

  /**
   * Check if user is logged in
   * @returns {boolean} True if logged in
   */
  isLoggedIn() {
    return this.getSessionToken() !== null;
  }

  /**
   * Set credentials for auto-refresh (useful if credentials weren't provided in constructor)
   * @param {string} email - User email
   * @param {string} password - User password
   */
  setCredentials(email, password) {
    this.email = email;
    this.password = password;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * POST the session request across the auth host chain until one answers with
   * a session token. Each host is tried with a fresh app2 signature.
   * @private
   * @param {string} email - User email
   * @param {string} password - User password
   * @returns {Promise<Object>} Camelized login payload
   */
  async _requestSession(email, password) {
    const attempts = Math.min(this.maxHostAttempts, this.authUrls.length);
    let lastError = null;
    let blocked = 0;
    // Hosts already attempted a solve this round, so a challenge cannot loop.
    const solvedHosts = new Set();
    // Headers carrying a solved Cloudflare clearance cookie, if any.
    let cfHeaders = {};

    for (let i = 0; i < attempts; i++) {
      const index = (this.lastAuthUrlIndex + i) % this.authUrls.length;
      const url = this.authUrls[index];

      try {
        const response = await this._postSession(url, email, password, cfHeaders);

        if (response.status !== 200) {
          // Cloudflare answers a challenged/blocked request with an HTML page,
          // so a JSON body here means the request reached hanime's app.
          const message = this._extractApiMessage(response.data)
            || `HTTP ${response.status}`;
          lastError = new Error(message);

          if (this._isBlockedResponse(response)) {
            blocked++;

            // Interactive challenge: solve it and retry this same host once.
            if (this.cfBypass.enabled && !solvedHosts.has(url)) {
              solvedHosts.add(url);
              const origin = originOf(url);
              const solved = origin ? await this.cfBypass.solve(origin, true) : null;
              if (solved) {
                cfHeaders = { cookie: solved.cookie };
                if (solved.userAgent) cfHeaders['user-agent'] = solved.userAgent;
                i--; // retry with the solved cookie
                continue;
              }
            }

            logger.warn('Hanime login blocked by upstream', { url, status: response.status });
            continue;
          }

          // A real API answer (bad credentials, etc.) won't improve on another
          // host — surface it immediately.
          logger.warn('Hanime login rejected', { url, status: response.status, message });
          lastError.status = response.status;
          lastError.rejected = true;
          // Callers (the /verify endpoint) branch on `blocked`.
          lastError.blocked = false;
          throw lastError;
        }

        const payload = convertToCamelCase(response.data);

        if (!payload || !payload.sessionToken) {
          lastError = new Error('Hanime login response contained no session token');
          logger.warn('Hanime login response missing session token', { url });
          continue;
        }

        this.lastAuthUrlIndex = index;
        return payload;
      } catch (error) {
        lastError = error;
        if (!this._isRetriable(error)) throw error;
        logger.warn('Hanime login request failed', { url, error: error.message });
      }
    }

    const blockedAll = blocked >= attempts;
    const error = new Error(
      blockedAll
        ? (this.cfBypass.enabled
            ? 'Hanime still refused this server after solving the Cloudflare challenge. Confirm the solver shares this addon\'s egress IP.'
            : 'Hanime blocked this server with an interactive Cloudflare challenge, which no HTTP client can pass. Configure CF_BYPASS_URL to a browser-based solver that shares this server\'s egress IP. A proxy alone will not help — the blocker is the challenge script, not the IP.')
        : (lastError ? lastError.message : 'Hanime login failed')
    );
    error.blocked = blockedAll;
    error.status = lastError && lastError.status;
    throw error;
  }

  /**
   * Issue a single signed POST /rapi/v7/sessions request.
   * @private
   */
  _postSession(url, email, password, extraHeaders = {}) {
    const claim = Math.floor(Date.now() / 1000);
    const headers = {
      'accept': 'application/json, text/plain, */*',
      'content-type': 'application/json;charset=UTF-8',
      'accept-language': 'en-US,en;q=0.9',
      'origin': 'https://hanime.tv',
      'referer': 'https://hanime.tv/',
      'user-agent': this.userAgent,
      'x-claim': String(claim),
      'x-signature-version': 'app2',
      'x-signature': getAppSignature(claim),
      'x-session-token': ''
    };
    if (this.relaySecret) headers.authorization = `Bearer ${this.relaySecret}`;
    // A solved Cloudflare clearance cookie must accompany the request.
    Object.assign(headers, extraHeaders);

    return axios.post(url, { email, password }, {
      headers,
      timeout: this.timeoutMs,
      // Inspect the status ourselves: Cloudflare answers 403 with HTML, which
      // the default `validateStatus` path would otherwise surface as a
      // generic JSON parse error instead of a block.
      validateStatus: () => true,
      responseType: 'json',
      ...this.proxyOptions,
      transformResponse: [(data) => {
        try {
          return JSON.parse(data);
        } catch (_) {
          // Non-JSON (Cloudflare challenge page) — keep the marker so the
          // caller can tell "blocked" from "API returned an error".
          return typeof data === 'string' && data ? { _nonJsonBody: data } : data;
        }
      }]
    });
  }

  /**
   * Detect a Cloudflare challenge/block page instead of an API response.
   * @private
   */
  _isBlockedResponse(response) {
    if (response.status !== 403 && response.status !== 503) return false;
    const body = response.data;
    if (body && typeof body === 'object' && body._nonJsonBody) return true;
    const contentType = String(response.headers?.['content-type'] || '');
    return contentType.includes('text/html');
  }

  /**
   * Pull a human-readable message out of an API error payload.
   * @private
   */
  _extractApiMessage(data) {
    if (!data) return null;
    if (typeof data === 'string') return null;
    const errors = data.errors;
    if (Array.isArray(errors) && errors.length) return String(errors[0]);
    if (typeof errors === 'string') return errors;
    if (data.message) return String(data.message);
    if (data.error) return String(data.error);
    return null;
  }

  /**
   * Decide whether a failure is worth retrying on the next host.
   * @private
   */
  _isRetriable(error) {
    if (!error) return false;
    // A definitive API answer (wrong password, malformed request) is not
    // host-specific; retrying it on the next host only wastes logins.
    if (error.rejected) return false;
    if (error.blocked) return true;
    const status = error.response?.status || error.status;
    if (status === 403 || status === 429 || status === 503) return true;
    // Network-level failures (DNS, TLS, timeouts) are host specific.
    return !status;
  }
}

module.exports = HanimeUserApi;
module.exports.convertToCamelCase = convertToCamelCase;