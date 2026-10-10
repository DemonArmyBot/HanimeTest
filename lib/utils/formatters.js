/**
 * Utility Formatters
 * ID validation and prefix handling utilities
 */

const constants = require('../constants');

/**
 * Check if an ID is a Hanime ID
 * With idPrefixes set in manifest, Stremio should only route IDs starting with "hanime:" to this addon
 * @param {string} id - ID to check
 * @returns {boolean} True if it's a Hanime ID
 */
function isHanimeId(id) {
  if (!id || typeof id !== 'string') return false;
  
  // Check if ID starts with hanime: prefix
  return id.startsWith(`${constants.addonPrefix}:`);
}

/**
 * Strip the addon prefix from an ID
 * @param {string} id - ID with prefix (e.g., "hanime:video-slug" or "hanime:series:slug:episode")
 * @returns {string} ID without prefix (e.g., "video-slug" or "series:slug:episode")
 */
function stripAddonPrefix(id) {
  if (!id || typeof id !== 'string') return id;
  
  const prefix = `${constants.addonPrefix}:`;
  if (id.startsWith(prefix)) {
    return id.substring(prefix.length);
  }
  
  return id;
}

/**
 * Validate a slug coming from a request path segment.
 *
 * Slugs reach this addon from three places: Stremio request paths, the addon
 * image proxy (`/proxy/image/:id/:type`), and the dataset itself. They are
 * interpolated into upstream URLs and cache keys, so anything that is not a
 * plain hanime slug is rejected before it reaches a request builder.
 * @param {string} slug - Candidate slug
 * @returns {boolean} True when the slug is a plain hanime slug
 */
function isValidSlug(slug) {
  if (!slug || typeof slug !== 'string') return false;
  // Hanime slugs are lowercase ASCII words joined by hyphens. Cap the length
  // so a long path segment can't be used to inflate upstream requests.
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 200;
}

/**
 * Parse a Stremio id into its slug parts.
 * Accepts "hanime:slug", "hanime:series:base", "hanime:series:base:episode".
 * @param {string} id - Full Stremio id
 * @returns {{kind: string, seriesBase: string|null, slug: string|null}} Parsed id
 */
function parseStremioId(id) {
  const stripped = stripAddonPrefix(id);
  if (stripped === id && !isHanimeId(id)) {
    return { kind: 'invalid', seriesBase: null, slug: null };
  }

  if (stripped.startsWith('series:')) {
    const parts = stripped.split(':');
    if (parts.length === 2) {
      return isValidSlug(parts[1])
        ? { kind: 'series', seriesBase: parts[1], slug: null }
        : { kind: 'invalid', seriesBase: null, slug: null };
    }
    if (parts.length === 3) {
      return isValidSlug(parts[1]) && isValidSlug(parts[2])
        ? { kind: 'seriesEpisode', seriesBase: parts[1], slug: parts[2] }
        : { kind: 'invalid', seriesBase: null, slug: null };
    }
    return { kind: 'invalid', seriesBase: null, slug: null };
  }

  return isValidSlug(stripped)
    ? { kind: 'video', seriesBase: null, slug: stripped }
    : { kind: 'invalid', seriesBase: null, slug: null };
}

module.exports = {
  isHanimeId,
  isValidSlug,
  parseStremioId,
  stripAddonPrefix
};

