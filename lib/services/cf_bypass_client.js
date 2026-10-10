/**
 * Cloudflare Challenge Solver Client
 *
 * Hanime puts an interactive JavaScript challenge (`cf-mitigated: challenge`)
 * on its API hosts. A browser passes it by executing the challenge script; an
 * HTTP client cannot, so axios gets 403 no matter which IP it comes from.
 * That is why the search endpoint works from a server while the handshake
 * endpoint does not — the search endpoint simply isn't challenged.
 *
 * The fix is to solve the challenge in a real browser and replay the resulting
 * `cf_clearance` cookie. An external solver service (see the README for the
 * cf-bypass project) does exactly that.
 *
 * IMPORTANT: `cf_clearance` is bound to the IP that solved it, so the solver
 * must reach Cloudflare through the same egress IP as this addon. Running the
 * solver as a sidecar next to the addon is the intended setup.
 */

const axios = require('axios');
const logger = require('../logger');

// Challenges are cached for a while because solving one costs a full browser
// launch, and Cloudflare only re-challenges periodically.
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const SOLVE_TIMEOUT_MS = 90 * 1000;

class CfBypassClient {
  /**
   * @param {Object} appConfig - App config (uses config.cfBypass)
   */
  constructor(appConfig) {
    const cf = (appConfig && appConfig.cfBypass) || {};
    this.enabled = !!cf.url;
    this.baseUrl = cf.url || null;
    this.token = cf.token || null;
    this.ttlMs = cf.ttlMs || DEFAULT_TTL_MS;
    this.timeoutMs = cf.timeoutMs || SOLVE_TIMEOUT_MS;
    // domain -> { cookie, userAgent, expiresAt }
    this.cache = new Map();
    // Collapse concurrent solves for the same domain into one browser launch.
    this.inFlight = new Map();
  }

  /**
   * Solve the challenge for a domain and cache the resulting cookie.
   *
   * @param {string} domain - Origin to solve, e.g. "https://hanime.tv"
   * @param {boolean} [force] - Ignore any cached solution
   * @returns {Promise<{cookie: string, userAgent: string}|null>} Solution, or null when unavailable
   */
  async solve(domain, force = false) {
    if (!this.enabled) return null;

    const cached = this.cache.get(domain);
    if (!force && cached && Date.now() < cached.expiresAt) {
      return cached;
    }

    if (this.inFlight.has(domain)) {
      return this.inFlight.get(domain);
    }

    const attempt = this._requestSolve(domain)
      .finally(() => this.inFlight.delete(domain));

    this.inFlight.set(domain, attempt);
    return attempt;
  }

  /**
   * Ask the solver service for a fresh challenge solution.
   * @private
   * @param {string} domain - Origin to solve
   * @returns {Promise<{cookie: string, userAgent: string}|null>} Solution or null
   */
  async _requestSolve(domain) {
    try {
      const response = await axios.post(`${this.baseUrl}/cloudflare`, {
        mode: 'iuam',
        domain,
        ttl: Math.floor(this.ttlMs / 1000),
        ...(this.token ? { authToken: this.token } : {})
      }, {
        timeout: this.timeoutMs,
        // The solver answers 403 as a *status* when it cannot clear the
        // challenge, so inspect the status rather than trusting the parse.
        validateStatus: () => true
      });

      const data = response.data || {};
      const clearance = data.cf_clearance || data.cfClearance;

      if (response.status !== 200 || !clearance) {
        logger.warn('Cloudflare solver did not return a clearance cookie', {
          domain,
          status: response.status,
          message: data.message || data.error
        });
        return null;
      }

      const solution = {
        cookie: `cf_clearance=${clearance}`,
        userAgent: data.user_agent || data.userAgent || null,
        expiresAt: Date.now() + this.ttlMs
      };

      this.cache.set(domain, solution);
      logger.info('Cloudflare challenge solved', { domain, userAgent: solution.userAgent });
      return solution;
    } catch (error) {
      logger.warn('Cloudflare solver request failed', { domain, error: error.message });
      return null;
    }
  }

  /**
   * Get the extra headers needed to present a solved challenge.
   *
   * @param {string} domain - Origin the request targets
   * @returns {Promise<Object>} Headers to merge into the request (empty when unsolved)
   */
  async getHeaders(domain) {
    const solution = await this.solve(domain);
    if (!solution) return {};

    const headers = { cookie: solution.cookie };
    // The cookie is paired with the UA that solved it; sending a different one
    // invalidates it.
    if (solution.userAgent) headers['user-agent'] = solution.userAgent;
    return headers;
  }

  /**
   * Drop a cached solution so the next request re-solves.
   * @param {string} domain - Origin whose solution should be discarded
   */
  invalidate(domain) {
    this.cache.delete(domain);
  }

  /**
   * Report whether a response looks like an unsolved Cloudflare challenge.
   *
   * @param {Object} response - Axios response (validateStatus: () => true)
   * @returns {boolean} True when the response is an interactive challenge
   */
  isChallenge(response) {
    if (!response) return false;
    if (response.status === 403 && response.headers && response.headers['cf-mitigated'] === 'challenge') {
      return true;
    }
    // The solver-facing hosts sometimes omit the header but still return the
    // interstitial HTML.
    const body = response.data;
    const text = Buffer.isBuffer(body)
      ? body.slice(0, 2048).toString('utf8')
      : (typeof body === 'string' ? body.slice(0, 2048) : '');
    return /Just a moment|cf-chl-|challenge-platform/.test(text);
  }
}

/**
 * Extract the origin (scheme://host) from a URL string.
 * @param {string} url - Absolute URL
 * @returns {string|null} Origin, or null when unparseable
 */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (_) {
    return null;
  }
}

module.exports = CfBypassClient;
module.exports.originOf = originOf;