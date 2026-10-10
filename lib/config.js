/**
 * Centralized configuration for Hanime Stremio Addon
 * All environment variables and configuration constants are defined here
 */

const packageJson = require('../package.json');

/**
 * Normalize a user-supplied public base URL.
 *
 * Accepts a bare host ("app.up.railway.app") or a full origin, and always
 * returns an origin with a scheme and no trailing slash so URL building cannot
 * emit a relative path.
 * @param {string|undefined|null} value - Raw PUBLIC_URL value
 * @returns {string|null} Normalized origin, or null when unset/invalid
 */
function normalizePublicUrl(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    // Throws on a malformed host, which is better than shipping a broken base.
    const url = new URL(withScheme);
    return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''));
  } catch (_) {
    return null;
  }
}

const config = {
  server: {
    port: parseInt(process.env.PORT, 10) || 61327,
    // Normalized: a scheme is added when missing and any trailing slash is
    // dropped. Hosts frequently set PUBLIC_URL as a bare domain
    // ("app.up.railway.app"), which produced schemeless asset URLs like
    // "app.up.railway.app/images/logo.png" — the browser then resolved those
    // relative to the page and every logo/background 404'd.
    publicUrl: normalizePublicUrl(process.env.PUBLIC_URL), // Null when unset; set at runtime otherwise
    env: process.env.NODE_ENV || 'development'
  },

  // Optional outbound proxy for upstream API calls only (handshake, login,
    // search). Cloudflare blocks datacenter/VPS egress, so routing these through
    // a residential proxy is the reliable fix. Image fetches deliberately stay
    // direct: they are large, cached at the CDN, and would otherwise double the
    // proxy's bandwidth bill without improving anything.
    //
    // Axios also honours HTTPS_PROXY/HTTP_PROXY globally, but that would drag
    // image traffic through the proxy too, so this is applied per request.
    proxy: {
      // Full URL, optionally with credentials: http://user:pass@host:port
      url: process.env.HTV_PROXY_URL || process.env.HANIME_PROXY_URL || null
    },

  // Cloudflare challenge solver (optional).
    //
    // Hanime guards its API hosts with an interactive JavaScript challenge. A
    // browser passes it by executing the challenge script; an HTTP client cannot,
    // so the handshake and login endpoints return 403 for any server regardless
    // of its IP. The search endpoint is exempt, which is why catalogs work while
    // streams do not.
    //
    // Point cfBypass.url at a solver service that runs a real browser and
    // returns a cf_clearance cookie (e.g. the cf-bypass project). The solver
    // MUST share this addon's egress IP, because cf_clearance is bound to the
    // address that solved it.
    cfBypass: {
      url: process.env.CF_BYPASS_URL || null,
      // Optional shared secret matching the solver's authToken env var.
      token: process.env.CF_BYPASS_TOKEN || null,
      // How long a solved cookie is reused before re-solving.
      ttlMs: (parseInt(process.env.CF_BYPASS_TTL_MS, 10) || 10 * 60) * 1000,
      // Browser-driven solves are slow; allow generous headroom.
      timeoutMs: parseInt(process.env.CF_BYPASS_TIMEOUT_MS, 10) || 90000
    },

  api: {
    // Universal CDN serves the app (auth) API. Its apex domain currently has
    // no origin DNS record, so only the www host is used.
    authority: 'www.universal-cdn.com',
    defaultAuthority: 'www.universal-cdn.com',
    manifestAuthority: 'hanime.tv',
    // Search dataset (the full /api/v11/search_hvs catalogue hanime's frontend
    // downloads and filters client-side). Every host in this list serves the
    // same dataset; requests rotate through them because Cloudflare blocks
    // some egress ranges on some hosts but not others.
    searchPath: '/api/v11/search_hvs',
    searchHosts: (process.env.HTV_SEARCH_HOSTS || [
      'guest.freeanimehentai.net',
      'hanime.tv',
      'auth.hanime.tv',
      'www.hanime.tv'
    ].join(','))
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    // Relay URL for the dataset, used ahead of searchHosts when set.
    searchUrl: process.env.HTV_SEARCH_URL || null,
    defaultDurationMs: 20 * 60 * 1000,
    cdnUrl: 'https://hanime-cdn.com',
    // Playable streams come from hanime's /api/v11/handshake flow. The same
    // host list is used for the handshake and the auth (login) API because
    // Cloudflare's WAF rules apply per-host, not per-path: a host that serves
    // the handshake usually serves /rapi/* as well.
    // See workers/handshake-relay and lib/services/htv_stream_resolver.js.
    htv: {
      handshakeUrl: process.env.HTV_HANDSHAKE_URL || null,
      handshakePath: '/api/v11/handshake',
      // Cloudflare's block is per host: an IP refused by auth.hanime.tv is often
      // still allowed by another host in the same estate. The guest/search host
      // is included because it is frequently reachable even when the primary
      // hosts are not, and hanime serves the handshake from more than one
      // hostname.
      handshakeHosts: (process.env.HTV_HANDSHAKE_HOSTS || [
        'auth.hanime.tv',
        'hanime.tv',
        'www.hanime.tv',
        'guest.freeanimehentai.net'
      ].join(','))
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean),
      // Auth API base (no trailing slash). Login is POST /rapi/v7/sessions.
      authPath: '/rapi/v7/sessions',
      authHosts: (process.env.HTV_AUTH_HOSTS || [
        'www.universal-cdn.com',
        'auth.hanime.tv',
        'hanime.tv'
      ].join(','))
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean),
      relaySecret: process.env.HTV_RELAY_SECRET || null,
      hlsHost: 'https://hanime.tv',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      timeoutMs: 15000,
      // Player-side header delivery. The handshake itself is signed server
      // side; this only controls what headers accompany the HLS request the
      // *player's* device makes, which is where a residential-IP block bites.
      //
      // 'proxyHeaders' uses the documented Stremio field
      // (behaviorHints.proxyHeaders + notWebReady) and works in official
      // Android/Desktop.
      //
      // 'pipe' appends `|User-Agent=...` to the URL, a convention understood by
      // ExoPlayer/MPV derivatives (Nuvio, MPV-EX). Official Stremio treats the
      // whole string as the URL and fails to play it, so this is opt-in.
      playerHeaderMode: process.env.HTV_PLAYER_HEADER_MODE || 'proxyHeaders',
      // UA the player presents to the HLS/CDN endpoints.
      playerUserAgent:
        process.env.HTV_PLAYER_USER_AGENT ||
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      // Headers sent alongside the player UA. hanime's CDN also checks Referer
      // and Origin, so omitting them can 403 even when the UA looks right.
      playerReferer: process.env.HTV_PLAYER_REFERER || 'https://hanime.tv/',
      playerOrigin: process.env.HTV_PLAYER_ORIGIN || 'https://hanime.tv',
      // Upstream hosts tried per request. Hanime blocks datacenter/VPS egress
      // ranges on most of its hosts, so a single hardcoded host fails on any
      // cloud deployment.
      maxHostAttempts: parseInt(process.env.HTV_MAX_HOST_ATTEMPTS, 10) || 4
    }
  },

  // Optional VPS-side stream proxy.
  //
  // When enabled, the player fetches HLS through this server instead of hitting
  // hanime directly. The player then presents no hanime-bound identity of its
  // own, so a residential-IP / header block cannot reach it — the request that
  // matters originates from this VPS. The returned URLs point at PUBLIC_URL,
  // which is what the player's device can actually reach.
  //
  // Off by default: it adds bandwidth and a hop, and it is only needed when the
  // player's own requests are being refused.
  streamProxy: {
    enabled: process.env.STREAM_PROXY_ENABLED === 'true',
    path: process.env.STREAM_PROXY_PATH || '/proxy/stream',
    // Segment/manifest fetch timeouts (ms).
    timeoutMs: parseInt(process.env.STREAM_PROXY_TIMEOUT_MS, 10) || 20000,
    // Cap a single proxied body (MB). Segments are a few MB; a runaway response
    // must not be buffered into memory without bound.
    maxBodyBytes: (parseInt(process.env.STREAM_PROXY_MAX_BODY_MB, 10) || 64) * 1024 * 1024,
    // Seconds a proxied manifest may be cached. Segments are immutable for a
    // given signed URL and are left to the player's own HTTP cache.
    manifestCacheSeconds: parseInt(process.env.STREAM_PROXY_MANIFEST_TTL, 10) || 30,
    // Secret used to sign proxied URLs so the endpoint cannot be used as an
    // open relay for arbitrary URLs. Generated per boot when unset.
    secret: process.env.STREAM_PROXY_SECRET || null,
    // Additional upstream hosts hanime serves media from. Needed when a
    // playlist references segments on a CDN host the addon doesn't know yet;
    // those URIs are otherwise left pointing at upstream and will fail.
    extraHosts: (process.env.STREAM_PROXY_ALLOWED_HOSTS || '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  },

  cache: {
    enabled: process.env.CACHE_ENABLED !== 'false', // Enable in-memory cache (default: true)
    maxSize: process.env.CACHE_MAX_SIZE ? (parseInt(process.env.CACHE_MAX_SIZE, 10) || 5000) : 5000, // Maximum number of cache entries (default: 5000)
    browserCache: (process.env.CACHE_BROWSER_CACHE !== undefined ? process.env.CACHE_BROWSER_CACHE !== 'false' : process.env.BROWSER_CACHE !== 'false'), // Enable browser caching (default: true, supports CACHE_BROWSER_CACHE and BROWSER_CACHE for backward compatibility)
    redisUrl: process.env.CACHE_REDIS_URL || process.env.REDIS_URL || null, // Redis connection URL for persistent cache (optional)
    // Every TTL is env-configurable. The stream TTL in particular is a footgun in
    // proxy mode: the cached value is a handshake-minted hanime.tv/hls URL whose
    // signed token expires well before a multi-hour cache would. Once it lapses,
    // every cached entry points at a dead upstream and playback breaks until the
    // cache drains.
    ttl: {
      catalog: parseInt(process.env.CACHE_TTL_CATALOG, 10) || 2 * 60 * 60, // 2 hours
      meta: parseInt(process.env.CACHE_TTL_META, 10) || 36 * 60 * 60, // 36 hours
      searchDataset: parseInt(process.env.CACHE_TTL_SEARCH_DATASET, 10) || 6 * 60 * 60, // 6 hours
      // Streams are handshake-minted hanime.tv/hls URLs whose signed tokens
      // rotate. Keep this below the token lifetime; lower it further when
      // STREAM_PROXY_ENABLED is on.
      stream: parseInt(process.env.CACHE_TTL_STREAM, 10) || 6 * 60 * 60, // 6 hours
      image: parseInt(process.env.CACHE_TTL_IMAGE, 10) || 30 // 30 seconds
    },
    browserCacheMaxAge: 86400, // 24 hours in seconds for browser cache headers
    imageProxy: {
      queueDelay: parseInt(process.env.IMAGE_PROXY_QUEUE_DELAY, 10) || 100, // Delay between queued requests in ms (default: 100ms)
      enabled: process.env.IMAGE_PROXY_QUEUE !== 'false' // Enable request queue (default: true)
    }
  },

  logging: {
    level: process.env.LOG_LEVEL || 'debug', // debug, info, warn, error, silent
    enabled: process.env.LOGGING_ENABLED !== 'false' // Enable logging (default: true)
  },

  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED !== 'false', // Enable rate limiting (default: true)
    useRedisStore: process.env.RATE_LIMIT_USE_REDIS === 'true', // Use Redis store for rate limiting (default: false)
    // General API rate limit (for Stremio addon endpoints)
    // Set higher than slow-down delayAfter to allow legitimate browsing
    // Users browsing catalogs can generate many requests, so we're generous
    general: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000, // 15 minutes
      max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 200, // 200 requests per window (allows catalog browsing)
      message: 'Too many requests from this IP, please try again later.',
      standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
      legacyHeaders: false // Disable `X-RateLimit-*` headers
    },
    // Stricter limit for image proxy (more resource-intensive)
    // Still higher than slow-down to allow some burst before blocking
    imageProxy: {
      windowMs: parseInt(process.env.RATE_LIMIT_IMAGE_WINDOW_MS, 10) || 15 * 60 * 1000, // 15 minutes
      max: parseInt(process.env.RATE_LIMIT_IMAGE_MAX, 10) || 60, // 60 requests per window
      message: 'Too many image proxy requests from this IP, please try again later.',
      standardHeaders: true,
      legacyHeaders: false
    }
  },

  slowDown: {
    enabled: process.env.SLOW_DOWN_ENABLED !== 'false', // Enable slow-down (default: true)
    useRedisStore: process.env.SLOW_DOWN_USE_REDIS === 'true', // Use Redis store for slow-down (default: false)
    // General API slow-down (for Stremio addon endpoints)
    // Less restrictive: starts closer to rate limit to allow more normal usage
    // Strategy: Start slowing at 150, rate limit at 200 (smaller gap, less aggressive)
    general: {
      windowMs: parseInt(process.env.SLOW_DOWN_WINDOW_MS, 10) || 15 * 60 * 1000, // 15 minutes
      delayAfter: parseInt(process.env.SLOW_DOWN_DELAY_AFTER, 10) || 150, // Start slowing down after 150 requests (closer to rate limit)
      delayMs: parseInt(process.env.SLOW_DOWN_DELAY_MS, 10) || 200, // Add 200ms delay per request after threshold (gentle)
      maxDelayMs: parseInt(process.env.SLOW_DOWN_MAX_DELAY_MS, 10) || 2000 // Maximum delay of 2 seconds (before rate limit kicks in)
    },
    // Less restrictive slow-down for image proxy (more resource-intensive)
    // Starts closer to rate limit to allow more normal usage
    // Strategy: Start slowing at 45, rate limit at 60 (smaller gap)
    imageProxy: {
      windowMs: parseInt(process.env.SLOW_DOWN_IMAGE_WINDOW_MS, 10) || 15 * 60 * 1000, // 15 minutes
      delayAfter: parseInt(process.env.SLOW_DOWN_IMAGE_DELAY_AFTER, 10) || 45, // Start slowing down after 45 requests (closer to rate limit)
      delayMs: parseInt(process.env.SLOW_DOWN_IMAGE_DELAY_MS, 10) || 300, // Add 300ms delay per request after threshold
      maxDelayMs: parseInt(process.env.SLOW_DOWN_IMAGE_MAX_DELAY_MS, 10) || 3000 // Maximum delay of 3 seconds (before rate limit)
    }
  },

  pagination: {
    itemsPerPage: 48
  },

  addon: {
    id: process.env.ADDON_ID || 'hanime-addon',
    version: process.env.ADDON_VERSION || packageJson.version, // Env variable or package.json
    name: process.env.ADDON_NAME || 'Hanime',
    icon: process.env.ADDON_ICON || '/images/favicon.ico', // Relative path
    logo: process.env.ADDON_LOGO || '/images/logo.png', // Relative path
    background: process.env.ADDON_BACKGROUND || '/images/background.jpg', // Relative path
    description: process.env.ADDON_DESCRIPTION || 'Enjoy your unlimited hentai & anime collection. We are the definitive source for the best curated 720p / 1080p HD hentai videos for free.',
    // Stremio Addons Config (optional)
    stremioAddonsConfig: (() => {
      const issuer = process.env.STREMIO_ADDONS_ISSUER;
      const signature = process.env.STREMIO_ADDONS_SIGNATURE;
      return (issuer && signature) ? { issuer, signature } : null;
    })()
  }
};

/**
 * Build the ordered list of candidate URLs for an upstream endpoint.
 * A relay (Worker) URL is used first when explicitly configured, otherwise the
 * direct hosts are tried in order. Cloudflare blocks datacenter egress ranges
 * per-host, so rotation is what keeps the addon working from a cloud host.
 * @param {string} path - API path (e.g. "/api/v11/search_hvs")
 * @param {string[]} hosts - Candidate hostnames
 * @param {string|null} relayUrl - Optional relay URL that takes precedence
 * @returns {string[]} Ordered candidate URLs
 */
function buildUpstreamUrls(path, hosts = [], relayUrl = null) {
  const urls = [];
  if (relayUrl) urls.push(relayUrl);
  for (const host of hosts) {
    const url = `https://${host}${path}`;
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * Get the public URL (computed at runtime if not set via env)
 * @returns {string} Public URL
 */
function getPublicUrl() {
  if (config.server.publicUrl) {
    return config.server.publicUrl;
  }
  // A bound but unreachable address (Railway and similar inject 0.0.0.0, and
  // some platforms inject a bare hostname). Neither is usable as an asset base.
  const bound = config.server.boundAddress;
  if (bound && bound !== '0.0.0.0' && bound !== '::' && !bound.includes(':')) {
    return `http://${bound}:${config.server.port}`;
  }
  return `http://127.0.0.1:${config.server.port}`;
}

/**
 * Build full URL from relative path
 * @param {string} relativePath - Relative path (e.g., '/images/logo.jpg')
 * @returns {string} Full URL
 */
function buildFullUrl(relativePath) {
  if (!relativePath) return '';
  if (relativePath.startsWith('http')) return relativePath; // Already full URL
  return `${getPublicUrl()}${relativePath}`;
}

module.exports = config;
module.exports.normalizePublicUrl = normalizePublicUrl;
module.exports.getPublicUrl = getPublicUrl;
module.exports.buildFullUrl = buildFullUrl;
module.exports.buildUpstreamUrls = buildUpstreamUrls;
