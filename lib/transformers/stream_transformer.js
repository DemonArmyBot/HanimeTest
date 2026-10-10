/**
 * Stream Transformer
 * Transforms Hanime streams to Stremio format
 */

const config = require('../config');
const { titleize } = require('./formatters');

const DEFAULT_DURATION_MS = 20 * 60 * 1000;
const ESTIMATED_BITRATES_MBPS = {
  360: 0.48,
  480: 0.62,
  720: 1.35,
  1080: 2.7
};

// Shown in the Stremio stream list so it's obvious which mode is active.
const PROXY_MODE_NAME = 'Hanime.TV (Proxy)';
const DIRECT_MODE_NAME = 'Hanime.TV';

/**
 * Build the headers the player's device should present when it fetches the
 * HLS manifest/segments.
 *
 * The handshake is signed server-side, but the stream is pulled by the
 * viewer's own device. hanime's edge checks Origin/Referer/User-Agent on those
 * segment requests, so a player sending its default UA can be refused with a
 * 403 even though the addon resolved the URL successfully.
 * @param {Object} playerConfig - config.api.htv player settings
 * @returns {Object} Header map
 */
function buildPlayerHeaders(playerConfig) {
  const headers = {};
  if (playerConfig.userAgent) headers['User-Agent'] = playerConfig.userAgent;
  if (playerConfig.referer) headers['Referer'] = playerConfig.referer;
  if (playerConfig.origin) headers['Origin'] = playerConfig.origin;
  return headers;
}

/**
 * Apply the player-side header strategy to a resolved stream URL.
 *
 * 'proxyHeaders' (default): returns the URL untouched and attaches the headers
 * via behaviorHints, which official Stremio Android/Desktop honour.
 *
 * 'pipe': appends `|User-Agent=...`. This is an ExoPlayer/MPV derivative
 * convention (Nuvio, MPV-EX) that forks parse out of the URL. Official
 * Stremio passes the string through verbatim and then cannot play it, so this
 * mode is opt-in via HTV_PLAYER_HEADER_MODE=pipe.
 *
 * @param {string} url - Resolved stream URL
 * @param {Object} playerConfig - config.api.htv player settings
 * @returns {{url: string, mode: string, headers: Object}} Decorated URL
 */
function applyPlayerHeaders(url, playerConfig) {
  const headers = buildPlayerHeaders(playerConfig);

  if (playerConfig.mode === 'pipe') {
    // encodeURIComponent, not URLSearchParams: form encoding turns spaces into
    // '+', which a player would pass through as a literal '+' in the UA and
    // the header would no longer match a real browser fingerprint.
    const pairs = Object.entries(headers)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');
    return { url: `${url}|${pairs}`, mode: 'pipe', headers };
  }

  return { url, mode: 'proxyHeaders', headers };
}

/**
 * Build a Stremio stream object whose URL points at this addon's own stream
 * proxy. Shared metadata/formatting with toStremioStream so both modes render
 * identically apart from where the bytes come from.
 * @param {Object} stream - Hanime stream object
 * @returns {Object} Stremio stream object
 */
function toProxiedStremioStream(stream) {
  const { buildProxyStreamUrl } = require('../services/hls_stream_proxy_url');
  const base = buildCommonFields(stream, PROXY_MODE_NAME);

  return {
    ...base,
    url: buildProxyStreamUrl(stream.url),
    behaviorHints: {
      // The proxy URL is an HLS playlist served from this addon; it is not a
      // web-ready MP4 either way.
      notWebReady: true,
      videoSize: base.behaviorHints.videoSize
    }
  };
}

/**
 * Build the shared name/title/description/size fields for a stream.
 * @param {Object} stream - Hanime stream object
 * @param {string} label - Stream group label to show in Stremio
 * @returns {Object} Fields common to every stream mode
 */
function buildCommonFields(stream, label) {
  const groupName = stream.video_stream_group_id || '';
  const name = titleize(groupName.replace(/-/g, ' '));
  const suppliedFilesizeMbs = Number(stream.filesize_mbs);
  const suppliedDurationMs = Number(stream.duration_in_ms);
  const durationMissing = !Number.isFinite(suppliedDurationMs) || suppliedDurationMs <= 0;
  const durationMs = durationMissing ? DEFAULT_DURATION_MS : suppliedDurationMs;
  const bitrateMbps = ESTIMATED_BITRATES_MBPS[Number(stream.height)] || 1.35;
  const filesizeMissing = !Number.isFinite(suppliedFilesizeMbs) || suppliedFilesizeMbs <= 0;
  const filesizeMbs = filesizeMissing
    ? Math.round((bitrateMbps * (durationMs / 1000) / 8) * 10) / 10
    : suppliedFilesizeMbs;
  const roundedFilesizeMbs = Math.round(filesizeMbs);
  const details = [];
  details.push(`💾 ${roundedFilesizeMbs} MB`);
  details.push(`⌚ ${(durationMs / 60000).toFixed(0)} min`);
  const description = [name.slice(0, -3), details.join(' ')].filter(Boolean).join('\n');

  return {
    name: `${label}\n${stream.height || 0}p`,
    title: description,
    description,
    behaviorHints: {
      videoSize: Math.round(filesizeMbs * 1024 * 1024)
    }
  };
}

/**
 * Transform Hanime stream to Stremio stream object
 * @param {Object} stream - Hanime stream object
 * @returns {Object} Stremio stream object
 */
function toStremioStream(stream) {
  if (!stream || !stream.url) return null;

  // Proxy mode: the player fetches the manifest from this addon instead of
  // contacting hanime, so no hanime-bound identity is ever sent by the player.
  // This is the reliable fix when the viewer's own egress is what Cloudflare
  // refuses. Falling back to header decoration would defeat the purpose.
  if (config.streamProxy?.enabled) {
    return toProxiedStremioStream(stream);
  }

  const playerConfig = {
    mode: config.api?.htv?.playerHeaderMode || 'proxyHeaders',
    userAgent: config.api?.htv?.playerUserAgent,
    referer: config.api?.htv?.playerReferer,
    origin: config.api?.htv?.playerOrigin
  };
  const decorated = applyPlayerHeaders(stream.url, playerConfig);
  const base = buildCommonFields(stream, DIRECT_MODE_NAME);

  // HLS is not a plain MP4, so it is never web-ready and must be declared as
  // such for proxyHeaders to be applied by official clients.
  const behaviorHints = {
    notWebReady: true,
    videoSize: base.behaviorHints.videoSize
  };

  // Only attach proxyHeaders in the spec mode; a piped URL already carries the
  // headers, and sending both makes forks apply the header twice.
  if (decorated.mode === 'proxyHeaders') {
    behaviorHints.proxyHeaders = { request: decorated.headers };
  }

  return {
    name: base.name,
    title: base.title,
    description: base.description,
    url: decorated.url,
    behaviorHints
  };
}

/**
 * Transform array of Hanime streams to Stremio streams
 * @param {Array} hanimeStreams - Array of Hanime stream objects
 * @param {Object} cacheConfig - Cache configuration
 * @returns {Object} Stremio streams response
 */
function toStremioStreams(hanimeStreams, cacheConfig) {
  if (!Array.isArray(hanimeStreams)) {
    return { streams: [] };
  }

  const streams = hanimeStreams
    .map(stream => toStremioStream(stream))
    .filter(stream => stream?.url?.trim());

  return {
    streams: streams,
    cacheMaxAge: cacheConfig.maxAge,
    staleError: cacheConfig.staleError
  };
}

module.exports = {
  DIRECT_MODE_NAME,
  PROXY_MODE_NAME,
  buildCommonFields,
  buildPlayerHeaders,
  applyPlayerHeaders,
  toProxiedStremioStream,
  toStremioStream,
  toStremioStreams
};
