/**
 * Outbound proxy helper
 *
 * Cloudflare blocks datacenter/VPS egress ranges, so the handshake, login and
 * search requests can be routed through a residential proxy. Image fetches are
 * deliberately excluded: they are large, already CDN-cached, and proxied traffic
 * would waste the proxy's bandwidth without helping.
 */

/**
 * Convert a proxy URL into the shape axios expects.
 *
 * Accepts `http://host:port`, `socks5://host:port`, and either form with
 * embedded credentials (`http://user:pass@host:port`). A missing port resolves
 * to the protocol default. Returns null when no proxy is configured or the
 * value cannot be parsed, so callers can pass the result straight through.
 *
 * @param {string|null} proxyUrl - Proxy URL from config
 * @returns {Object|null} Axios proxy config, or null when unset/invalid
 */
function toAxiosProxyConfig(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== 'string') return null;

  let parsed;
  try {
    parsed = new URL(proxyUrl.trim());
  } catch (_) {
    return null;
  }

  // `new URL()` drops the port when it is the protocol default, so
  // "https://host" yields an empty port. Falling back to 80 there would send
  // HTTPS traffic to the wrong port entirely.
  const DEFAULT_PORTS = {
    'http:': 80,
    'https:': 443,
    'socks5:': 1080
  };

  // socks5h:// means "resolve the hostname on the proxy side", which is what
  // axios does for socks5 anyway; accept the alias rather than silently
  // ignoring the setting.
  const protocol = parsed.protocol === 'socks5h:' ? 'socks5:' : parsed.protocol;

  if (!DEFAULT_PORTS[protocol]) {
    return null;
  }

  const config = {
    protocol,
    host: parsed.hostname,
    port: parsed.port ? parseInt(parsed.port, 10) : DEFAULT_PORTS[protocol]
  };

  if (parsed.username) {
    config.auth = {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password || '')
    };
  }

  return config;
}

/**
 * Build the per-request axios options fragment for upstream API calls.
 *
 * @param {Object} appConfig - App config
 * @returns {Object} Options to spread into an axios request
 */
function upstreamProxyOptions(appConfig) {
  const proxy = toAxiosProxyConfig(appConfig && appConfig.proxy && appConfig.proxy.url);
  return proxy ? { proxy } : {};
}

/**
 * Redact credentials from a proxy URL for logging.
 * @param {string|null} proxyUrl - Proxy URL
 * @returns {string|null} Safe-to-log form
 */
function redactProxyUrl(proxyUrl) {
  if (!proxyUrl) return null;
  return String(proxyUrl).replace(/\/\/[^@/]+@/, '//***@');
}

module.exports = {
  toAxiosProxyConfig,
  upstreamProxyOptions,
  redactProxyUrl
};