#!/usr/bin/env node

/**
 * Hanime Stremio Addon Server
 * Express server with request logging and image proxy
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { getRouter } = require('stremio-addon-sdk');
const generateLandingHTML = require('./lib/templates/landing_template');
const config = require('./lib/config');
const logger = require('./lib/logger');
const addonInterface = require('./addon');
const apiClient = addonInterface.apiClient; // Get the shared apiClient instance
const userApiManager = addonInterface.userApiManager;
const createImageProxyMiddleware = require('./lib/middleware/proxy_image_middleware');
const createStreamProxyMiddleware = require('./lib/middleware/proxy_stream_middleware');
const { 
  createGeneralRateLimiter, 
  createImageProxyRateLimiter,
  createGeneralSlowDown,
  createImageProxySlowDown,
  getStoreType 
} = require('./lib/middleware/rate_limit_middleware');

// Handle unhandled errors from Redis and other event emitters
process.on('unhandledRejection', (reason, promise) => {
  if (reason && typeof reason === 'object' && reason.message) {
    // Check if it's a Redis connection error
    if (reason.message.includes('Socket closed') || 
        reason.message.includes('Redis') || 
        reason.code === 'ERR_INVALID_URL' ||
        reason.name === 'SocketClosedUnexpectedlyError') {
      logger.warn('Unhandled Redis error (non-fatal)', {
        error: reason.message,
        code: reason.code,
        name: reason.name
      });
      return; // Don't crash on Redis errors
    }
  }
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined
  });
});

process.on('uncaughtException', (err) => {
  // Check if it's a Redis connection error
  if (err.message && (
    err.message.includes('Socket closed') || 
    err.message.includes('Redis') || 
    err.code === 'ERR_INVALID_URL' ||
    err.name === 'SocketClosedUnexpectedlyError'
  )) {
    logger.warn('Uncaught Redis error (non-fatal)', {
      error: err.message,
      code: err.code,
      name: err.name
    });
    return; // Don't crash on Redis errors
  }
  logger.error('Uncaught exception', {
    error: err.message,
    stack: err.stack
  });
  process.exit(1);
});

/**
 * Request logging middleware
 */
// Stremio embeds the user's {email,password} JSON as the first path segment,
// so req.path must never be logged verbatim — redact that segment to keep
// plaintext credentials out of the logs.
function redactPath(p) {
  return String(p).replace(/\/(%7[bB]|\{)[^/]*/, '/<config>');
}

function requestLogger(req, res, next) {
  const start = Date.now();
  const path = redactPath(req.path);

  // Only the finish line is logged at info (it carries status + duration and
  // subsumes the entry line); the entry line stays at debug to halve per-
  // request log volume in production.
  logger.debug(`-> ${req.method} ${path}`, {
    userAgent: req.get('user-agent')?.substring(0, 50) || 'unknown'
  });

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 400 ? 'error' : 'info';
    logger[level](`${req.method} ${path} - ${res.statusCode}`, {
      duration: `${duration}ms`,
      status: res.statusCode
    });
  });

  next();
}

/**
 * Resolve how many proxy hops Express should trust.
 *
 * `true` makes Express trust the leftmost X-Forwarded-For entry, so any client
 * can spoof its IP and slip past the rate limiter — express-rate-limit rejects
 * that outright with ERR_ERL_PERMISSIVE_TRUST_PROXY (it filled the previous
 * logs with that validation error). Count the real hops instead.
 * @returns {boolean|number|string|string[]} Express trust-proxy setting
 */
function resolveTrustProxy() {
  const raw = process.env.TRUST_PROXY;
  const hops = process.env.TRUST_PROXY_HOP_COUNT
    ? parseInt(process.env.TRUST_PROXY_HOP_COUNT, 10)
    : undefined;

  if (raw === undefined) {
    // Platforms such as Railway and Netlify always sit behind a proxy and set
    // X-Forwarded-For, so trusting exactly one hop is both correct and required:
    // with trust proxy disabled, express-rate-limit cannot identify clients and
    // logs ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request. One hop is safe
    // because the proxy appends the real address last, so anything a client
    // prepends is ignored.
    return Number.isFinite(hops) ? hops : 1;
  }
  if (raw === 'false') return false;
  if (raw === 'true') {
    return Number.isFinite(hops) ? hops : 1;
  }
  if (raw === 'loopback') return 'loopback';
  if (raw.includes(',')) return raw.split(',').map((s) => s.trim()).filter(Boolean);

  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
}

/**
 * Start HTTP server
 */
function serveHTTP(addonInterface, opts = {}) {
  const app = express();

  // Accurate client IPs behind a reverse proxy are what make the rate limiter
  // and slow-down effective, so trust the configured number of hops.
  const trustProxy = resolveTrustProxy();
  app.set('trust proxy', trustProxy);

  if (trustProxy) {
    logger.debug('Express trust proxy enabled', { trustProxy });
  }

  app.use(requestLogger);

  // Apply rate limiting and slow-down if enabled
  // Combining both: slow-down first (gradual delay), then rate limit (hard block)
  // This provides layered protection - slow-down deters abuse, rate limit prevents overload
  if (config.rateLimit.enabled || config.slowDown.enabled) {
    // Apply slow-down first (if enabled) - gradually delays responses
    if (config.slowDown.enabled) {
      const generalSlowDown = createGeneralSlowDown();
      const imageProxySlowDown = createImageProxySlowDown();

      // Apply general slow-down to all routes
      app.use(generalSlowDown);

      // Apply stricter slow-down to image proxy endpoint
      app.use('/proxy/image/:id/:type', imageProxySlowDown);

      logger.info('Slow-down enabled', {
        general: `Starts after ${config.slowDown.general.delayAfter} requests, ${config.slowDown.general.delayMs}ms delay per request (max ${config.slowDown.general.maxDelayMs}ms)`,
        imageProxy: `Starts after ${config.slowDown.imageProxy.delayAfter} requests, ${config.slowDown.imageProxy.delayMs}ms delay per request (max ${config.slowDown.imageProxy.maxDelayMs}ms)`
      });
    }

    // Apply rate limiting (if enabled) - hard blocks after limit
    if (config.rateLimit.enabled) {
      const generalLimiter = createGeneralRateLimiter();
      const imageProxyLimiter = createImageProxyRateLimiter();

      // Apply general rate limit to all routes
      app.use(generalLimiter);

      // Apply stricter rate limit to image proxy endpoint
      app.use('/proxy/image/:id/:type', imageProxyLimiter);

      // Get actual store type being used (may differ from config if Redis unavailable)
      const actualStoreType = getStoreType();
      
      logger.info('Rate limiting enabled', {
        general: `${config.rateLimit.general.max} requests per ${config.rateLimit.general.windowMs / 1000}s`,
        imageProxy: `${config.rateLimit.imageProxy.max} requests per ${config.rateLimit.imageProxy.windowMs / 1000}s`,
        store: actualStoreType === 'redis' ? 'Redis (distributed)' : 'Memory (local)'
      });
    }
  } else {
    logger.debug('Rate limiting and slow-down disabled');
  }

  const landingHTML = generateLandingHTML(addonInterface.manifest);
  const hasConfig = (addonInterface.manifest.config || []).length > 0;
  const verifyInFlight = new Map();

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

// Credentials verification endpoint used by the configure page.
  // POSTs {email, password} → tries to authenticate against Hanime; on
  // success the session is cached so the subsequent stream call reuses it.
  app.post('/verify', express.json({ limit: '4kb' }), async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ ok: false, error: 'Email and password are required.' });
    }

    // Single-flight: a retried configure form shouldn't trigger a second login
    // (and a second hit against hanime) while the first is still in flight.
    if (verifyInFlight.has(email)) return verifyInFlight.get(email);

    const attempt = (async () => {
      try {
        const userApi = await userApiManager.getUserApi(email, password);
        return res.json({ ok: true, isPremium: !!userApi.isPremium });
      } catch (err) {
        const blocked = !!(err && err.blocked);
        logger.warn('Credential verification failed', {
          emailPrefix: email.substring(0, 3) + '***',
          blocked,
          error: err && err.message ? err.message : String(err)
        });
        // Distinguish "your password is wrong" from "this server is blocked by
        // Cloudflare" — the configure page shows different guidance for each,
        // and conflating them made blocked hosts look like a wrong password.
        return res.status(blocked ? 503 : 401).json({
          ok: false,
          blocked,
          error: blocked
            ? 'Hanime blocked this server (Cloudflare). Self-host from a residential connection, or set HTV_HANDSHAKE_URL / HTV_RELAY_SECRET to a relay.'
            : 'Invalid credentials or upstream error.'
        });
      }
    })();

    verifyInFlight.set(email, attempt);
    try {
      return await attempt;
    } finally {
      verifyInFlight.delete(email);
    }
  });

  app.use(getRouter(addonInterface));

  // Try public/images first for Vercel, then images for local
  const publicImagesPath = path.join(__dirname, 'public', 'images');
  const imagesPath = path.join(__dirname, 'images');
  const imagePath = fs.existsSync(publicImagesPath) ? publicImagesPath : imagesPath;
  app.use('/images', express.static(imagePath));

  // Serve static CSS files
  app.use('/css', express.static(path.join(__dirname, 'public', 'css')));

  app.get('/proxy/image/:id/:type', createImageProxyMiddleware(config, apiClient));

  // VPS-side stream proxy (opt-in). Sits on a plain path — not behind the
  // addon config prefix — because the player follows these URLs itself and has
  // no Stremio config segment to carry.
  if (config.streamProxy.enabled) {
    app.get(`${config.streamProxy.path}/:payload`, createStreamProxyMiddleware(config));
    logger.info('Stream proxy enabled', {
      path: config.streamProxy.path,
      timeoutMs: config.streamProxy.timeoutMs
    });

    // The player is handed absolute proxy URLs built from PUBLIC_URL. If that is
    // unset the URLs point at 127.0.0.1, which is the *player's* machine, and
    // every stream silently fails to play. Refuse to look healthy.
    const proxyBase = config.getPublicUrl();
    if (!config.server.publicUrl || /127\.0\.0\.1|localhost|\[?::1\]?/.test(proxyBase)) {
      logger.error(
        'Stream proxy is enabled but PUBLIC_URL is not set to a public address. ' +
        `The player would receive URLs like ${proxyBase}${config.streamProxy.path}/... , ` +
        'which it cannot reach. Set PUBLIC_URL to this deployment\'s public origin, ' +
        'e.g. PUBLIC_URL=https://your-app.up.railway.app, or disable STREAM_PROXY_ENABLED.'
      );
    }
  }

  const server = app.listen(opts.port);

  return new Promise((resolve, reject) => {
    server.on('listening', () => {
      // Record the bind address so getPublicUrl() can build a usable asset base
      // when PUBLIC_URL is absent (0.0.0.0 / :: are not client-reachable).
      const address = server.address();
      config.server.boundAddress = typeof address === 'string' ? address : address.address;
      const baseUrl = `http://127.0.0.1:${address.port}`;

      // Set publicUrl at runtime if not already set
      if (!config.server.publicUrl) {
        config.server.publicUrl = baseUrl;
      }

      const url = `${baseUrl}/manifest.json`;

      logger.info('='.repeat(60));
      logger.info('Hanime Stremio Addon Server Started');
      logger.info('='.repeat(60));
      logger.info(`HTTP addon accessible at: ${url}`);
      logger.info(`Public URL: ${config.server.publicUrl}`);
      logger.info(`Port: ${server.address().port}`);
      logger.info(`Environment: ${config.server.env}`);
      logger.info(`Log Level: ${config.logging.level}`);
      logger.info('='.repeat(60));
      logger.info('Waiting for requests...');

      resolve({ url, server });
    });

    server.on('error', (err) => {
      logger.error('Server error', { error: err.message, stack: err.stack });
      reject(err);
    });
  });
}

// Start server
serveHTTP(addonInterface, { port: config.server.port })
  .catch((err) => {
    logger.error('Failed to start server', { error: err.message });
    process.exit(1);
  });
