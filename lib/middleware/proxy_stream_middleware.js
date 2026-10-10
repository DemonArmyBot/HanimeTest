/**
 * Stream Proxy Middleware
 * Express glue for HlsStreamProxy.
 */

const logger = require('../logger');
const HlsStreamProxy = require('../services/hls_stream_proxy');

/**
 * Create the stream proxy middleware for Express.
 *
 * Route shape (registered by the caller, so it can sit behind the addon's
 * config prefix):
 *   GET /proxy/stream/:payload?s=<signature>
 *
 * @param {Object} config - App config
 * @returns {Function} Express middleware
 */
function createStreamProxyMiddleware(config) {
  const proxy = new HlsStreamProxy(config);

  return async (req, res) => {
    const { payload } = req.params;
    const signature = req.query.s;

    const verified = proxy.verifyUrl(payload, signature);
    if (!verified.ok) {
      // 403 rather than 404: the URL was signed by us once, so a bad signature
      // means tampering or a rotated secret, and the player can retry.
      logger.warn('Stream proxy refused a request', {
        reason: verified.reason,
        hasPayload: !!payload,
        hasSignature: !!signature
      });
      res.status(403);
      return res.send('Invalid or expired stream proxy link.');
    }

    try {
      await proxy.proxy(req, res, verified.url);
    } catch (err) {
      const status = err.response?.status;
      logger.error('Stream proxy error', {
        status,
        error: err.message
      });
      if (!res.headersSent) {
        res.status(status === 403 ? 502 : 502);
        res.send('Failed to proxy stream.');
      }
    }
  };
}

module.exports = createStreamProxyMiddleware;