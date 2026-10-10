/**
 * Proxy URL builder
 *
 * Split out from the proxy service so the transformer can produce a signed
 * proxy URL without instantiating the middleware or pulling in axios. The
 * signing secret is shared through config, so both sides always agree.
 */

const crypto = require('crypto');
const config = require('../config');

// Populated by the proxy service at boot so the transformer and the middleware
// sign/verify with the same secret. Falls back to a per-process secret, which
// still works for a single process (the normal self-hosted case).
let sharedSecret = null;

/**
 * Register the secret the proxy service is using.
 * @param {string} secret - HMAC secret
 */
function setProxySecret(secret) {
  sharedSecret = secret;
}

/**
 * Get the signing secret, preferring an explicit env value.
 * @returns {string} HMAC secret
 */
function getSecret() {
  if (config.streamProxy?.secret) return config.streamProxy.secret;
  if (sharedSecret) return sharedSecret;
  // Lazily generate once so repeated calls in the same process agree.
  if (!lazySecret) lazySecret = crypto.randomBytes(32).toString('hex');
  return lazySecret;
}

let lazySecret = null;

/**
 * Sign a base64url payload.
 * @param {string} payload - base64url payload
 * @returns {string} base64url signature
 */
function signPayload(payload) {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

/**
 * Build an absolute, signed proxy URL for an upstream HLS URL.
 * @param {string} upstreamUrl - Absolute hanime URL
 * @returns {string} Absolute proxy URL under PUBLIC_URL
 */
function buildProxyStreamUrl(upstreamUrl) {
  const { buildFullUrl, getPublicUrl, streamProxy } = config;
  const payload = Buffer.from(upstreamUrl, 'utf8').toString('base64url');
  const path = `${streamProxy.path}/${payload}?s=${signPayload(payload)}`;
  return buildFullUrl(path) || `${getPublicUrl()}${path}`;
}

module.exports = {
  buildProxyStreamUrl,
  setProxySecret,
  signPayload
};