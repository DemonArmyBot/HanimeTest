/**
 * serverless function for Hanime Stremio Addon
 */

const serverless = require('serverless-http');
const express = require('express');
const path = require('path');
const { getRouter } = require('stremio-addon-sdk');
const generateLandingHTML = require('../../lib/templates/landing_template');
const addonInterface = require('../../addon');
const apiClient = addonInterface.apiClient; // Get the shared apiClient instance
const createImageProxyMiddleware = require('../../lib/middleware/proxy_image_middleware');
const config = require('../../lib/config');
const logger = require('../../lib/logger');

const app = express();

// Stremio embeds the user's {email,password} JSON as the first path segment,
// so redact that segment before logging the path.
app.use((req, res, next) => {
  logger.debug(`${req.method} ${String(req.path).replace(/\/(%7[bB]|\{)[^/]*/, '/<config>')}`, {
    ip: req.ip || req.headers['x-forwarded-for'],
    userAgent: req.get('user-agent')?.substring(0, 50) || 'unknown'
  });
  next();
});

const landingHTML = generateLandingHTML(addonInterface.manifest);
const hasConfig = (addonInterface.manifest.config || []).length > 0;

// Handle landing page - redirect to /configure if config is required
app.get('/', (req, res) => {
  if (hasConfig && addonInterface.manifest.behaviorHints?.configurationRequired) {
    res.redirect('/configure');
  } else {
    res.setHeader('content-type', 'text/html');
    res.end(landingHTML);
  }
});

// Handle configuration page (required when config is defined)
if (hasConfig) {
  app.get('/configure', (req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(landingHTML);
  });
}

// Credentials verification endpoint, mirroring the express server. Without it
// the configure page can't validate credentials on the Netlify deployment.
app.post('/verify', express.json({ limit: '4kb' }), async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ ok: false, error: 'Email and password are required.' });
  }

  try {
    const userApi = await addonInterface.userApiManager.getUserApi(email, password);
    return res.json({ ok: true, isPremium: !!userApi.isPremium });
  } catch (err) {
    const blocked = !!(err && err.blocked);
    logger.warn('Credential verification failed', {
      emailPrefix: email.substring(0, 3) + '***',
      blocked,
      error: err && err.message ? err.message : String(err)
    });
    return res.status(blocked ? 503 : 401).json({
      ok: false,
      blocked,
      error: blocked
        ? 'Hanime blocked this server (Cloudflare). Deploy the relay Worker and set HTV_RELAY_SECRET.'
        : 'Invalid credentials or upstream error.'
    });
  }
});

app.use(getRouter(addonInterface));

app.get('/proxy/image/:id/:type', (req, res, next) => {
  logger.debug('Proxy request received', {
    path: req.path,
    id: req.params.id,
    type: req.params.type
  });
  next();
}, createImageProxyMiddleware(config, apiClient));

// VPS-side stream proxy (opt-in), matching the express server.
if (config.streamProxy.enabled) {
  const createStreamProxyMiddleware = require('../../lib/middleware/proxy_stream_middleware');
  app.get(`${config.streamProxy.path}/:payload`, createStreamProxyMiddleware(config));
  logger.info('Stream proxy enabled', { path: config.streamProxy.path });
}

app.use('/images', express.static(path.join(__dirname, '../../public/images')));
app.use('/css', express.static(path.join(__dirname, '../../public/css')));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: addonInterface.manifest.version,
    cacheEnabled: config.cache.enabled,
    prefetchEnabled: config.cache.prefetch?.enabled || false
  });
});

// Binary support required for image responses in serverless
module.exports.handler = serverless(app, {
  binary: ['image/*', 'application/octet-stream']
});
