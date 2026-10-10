/**
 * Hanime API Client
 * Encapsulates all HTTP communication with Hanime.tv APIs
 */

const axios = require('axios');
const { getAppSignature } = require('@nekolab/hanime/dist/modules/crypto');
const { buildUpstreamUrls } = require('../config');
const { upstreamProxyOptions } = require('../utils/proxy_helper');
const logger = require('../logger');

/**
 * Sleep utility for retry delays
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class HanimeApiClient {
  constructor(config) {
    const api = (config && config.api) || {};
    const htv = api.htv || {};

    // Ordered candidate URLs for the search dataset. The relay (when set)
    // is preferred; direct hosts act as the fallback chain.
    this.searchUrls = api.searchUrl
      ? [api.searchUrl]
      : buildUpstreamUrls(api.searchPath || '/api/v11/search_hvs', api.searchHosts);
    this.relaySecret = htv.relaySecret || null;
    this.userAgent = htv.userAgent || null;
    this.timeoutMs = htv.timeoutMs || 15000;
    this.maxHostAttempts = htv.maxHostAttempts || 4;
    // Never cap below the list length: a smaller budget would give up before
    // reaching a host that isn't blocked for this egress range.
    this.maxHostAttempts = Math.max(this.maxHostAttempts, this.searchUrls.length);
    this.defaultDurationMs = api.defaultDurationMs || 20 * 60 * 1000;
    this.searchPageSize = (config && config.pagination && config.pagination.itemsPerPage) || 48;
    this.searchDatasetCache = {
      data: null,
      fetchedAt: 0
    };
    this.searchDatasetTtlMs = ((config && config.cache && config.cache.ttl && config.cache.ttl.searchDataset) || 6 * 60 * 60) * 1000;
this.searchDatasetPending = null;
    // Routed through a residential proxy when configured; Cloudflare blocks
    // datacenter egress but not residential ranges.
    this.proxyOptions = upstreamProxyOptions(config);
    // Index of the host that last served the dataset, so the next cold fetch
    // starts where the previous one succeeded instead of re-probing a blocked
    // host first.
    this.lastSearchUrlIndex = 0;

    this.searchHeaders = {
      'accept': 'application/json, text/plain, */*',
      'content-type': 'application/json;charset=UTF-8',
      'accept-language': 'en-US,en;q=0.9',
      'origin': 'https://hanime.tv',
      'referer': 'https://hanime.tv/',
      'user-agent': this.userAgent ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    // Note: This client is for public/unauthenticated API calls only
    // Authenticated requests (streams) are handled by StreamService using UserApiManager
  }

  // ============================================================================
  // Public Methods
  // ============================================================================

  /**
   * Get video data from the shared search dataset.
   * @param {string} slug - Video slug/ID
   * @returns {Promise<Object|null>} Video data object or null
   */
  async getVideoData(slug) {
    if (!slug) {
      logger.warn('getVideoData called without slug');
      return null;
    }

    const dataset = await this._getSearchDataset();
    const video = dataset.find(item => item && item.slug === slug);
    if (!video) return null;

    return {
      hentai_video: {
        ...video,
        duration_in_ms: this.defaultDurationMs,
        duration_estimated: true,
        hentai_tags: (Array.isArray(video.tags) ? video.tags : [])
          .map(text => ({ text }))
      }
    };
  }

  /**
   * Search for videos with retry logic for 403 errors
   * @param {Object} params - Search parameters
   * @param {number} maxRetries - Maximum number of retries (default: 2)
   * @returns {Promise<Array>} Array of video results
   */
  async search({ query = '', tags = [], brands = [], orderBy = 'created_at_unix', ordering = 'desc', page = 0 }, maxRetries = 2) {
    try {
      return await this._retryRequest(
        async () => {
          const dataset = await this._getSearchDataset();
          const filteredResults = this._filterSearchResults(dataset, { query, tags, brands });
          const sortedResults = this._sortSearchResults(filteredResults, orderBy, ordering);
          const pagedResults = this._paginateSearchResults(sortedResults, page);

          logger.debug('Hanime search dataset success', {
            datasetCount: dataset.length,
            filteredCount: filteredResults.length,
            resultsCount: pagedResults.length
          });

          return pagedResults;
        },
        {
          operation: 'Search API',
          params: { query, tagsCount: tags.length, brandsCount: brands.length, page }
        },
        maxRetries
      );
    } catch (error) {
      return [];
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Get the current Hanime search dataset.
   * Hanime's frontend now fetches the full dataset and filters client-side.
   * @private
   */
  async _getSearchDataset() {
    const now = Date.now();
    const cached = this.searchDatasetCache.data;

    if (cached && now - this.searchDatasetCache.fetchedAt < this.searchDatasetTtlMs) {
      return cached;
    }

    // Single-flight: on a cold start or after TTL expiry, many catalog
    // requests can arrive at once. Without coalescing, each would fetch the
    // full dataset (and each retry the same 403 backoff) independently. Share
    // one in-flight fetch across all concurrent callers.
    if (this.searchDatasetPending) {
      return this.searchDatasetPending;
    }

    this.searchDatasetPending = this._fetchSearchDataset(now)
      .finally(() => { this.searchDatasetPending = null; });

    return this.searchDatasetPending;
  }

  /**
   * Fetch and cache the search dataset. Serves the last good dataset if every
   * upstream host fails, so a transient blip doesn't empty every catalog.
   * @private
   */
  async _fetchSearchDataset(now) {
    const lastGood = this.searchDatasetCache.data;
    const attempts = Math.min(this.maxHostAttempts, this.searchUrls.length);
    let lastError = null;

    for (let i = 0; i < attempts; i++) {
      const index = (this.lastSearchUrlIndex + i) % this.searchUrls.length;
      const url = this.searchUrls[index];

      try {
        const response = await axios.get(url, {
          headers: this._getSearchHeaders(),
          timeout: this.timeoutMs,
          validateStatus: () => true,
          ...this.proxyOptions
        });

        if (response.status !== 200) {
          lastError = new Error(`HTTP ${response.status}`);
          logger.warn('Hanime search dataset non-200 status', { url, status: response.status });
          continue;
        }

        const dataset = this._normalizeSearchDataset(response.data);

        if (dataset.length === 0 && lastGood && lastGood.length > 0) {
          // An empty payload here means the upstream answered but we failed to
          // read it (shape change or an error envelope). Keep serving the last
          // good dataset instead of wiping every catalog.
          logger.warn('Hanime search dataset parsed empty, keeping last good dataset', { url });
          return lastGood;
        }

        this.searchDatasetCache = { data: dataset, fetchedAt: now };
        this.lastSearchUrlIndex = index;
        return dataset;
      } catch (error) {
        lastError = error;
        logger.warn('Hanime search dataset fetch failed', { url, error: error.message });
      }
    }

    logger.error('Hanime search dataset unavailable on all hosts', {
      attempts,
      hosts: attempts,
      error: lastError ? lastError.message : 'unknown'
    });

    return lastGood || [];
  }

  /**
   * Build the current app2 signature required by Hanime's search dataset.
   * @private
   */
  _getSearchHeaders() {
    const claim = Math.floor(Date.now() / 1000);
    const headers = {
      ...this.searchHeaders,
      'x-claim': String(claim),
      'x-signature-version': 'app2',
      'x-signature': getAppSignature(claim),
      'x-session-token': ''
    };
    if (this.relaySecret) headers.authorization = `Bearer ${this.relaySecret}`;
    return headers;
  }

  /**
   * Normalize current and legacy search payload shapes.
   *
   * The live endpoint answers with `{ data: [...], ads: {...} }`. Older shapes
   * returned a bare array, a JSON-encoded `hits` string, or `hits` as an array,
   * and the app API wraps hits under `hentai_videos`.
   * @private
   */
  _normalizeSearchDataset(data) {
    if (Array.isArray(data)) {
      return data;
    }

    if (!data || typeof data !== 'object') {
      return [];
    }

    if (Array.isArray(data.data)) {
      return data.data;
    }

    if (Array.isArray(data.hentai_videos)) {
      return data.hentai_videos;
    }

    if (Array.isArray(data.hits)) {
      return data.hits;
    }

    for (const key of ['hits', 'data', 'results']) {
      const value = data[key];
      if (typeof value === 'string' && value) {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) return parsed;
          if (Array.isArray(parsed?.data)) return parsed.data;
          if (Array.isArray(parsed?.hits)) return parsed.hits;
        } catch (error) {
          logger.warn('Failed to parse search hits', { key, error: error.message });
        }
      }
    }

    return [];
  }

  /**
   * Apply query, tag, and brand filters to the search dataset.
   * @private
   */
  _filterSearchResults(dataset, { query = '', tags = [], brands = [] }) {
    if (!Array.isArray(dataset)) return [];

    const normalizedQuery = this._normalizeString(query);
    const queryTerms = normalizedQuery ? normalizedQuery.split(/\s+/).filter(Boolean) : [];
    const normalizedTags = tags.map(tag => this._normalizeString(tag)).filter(Boolean);
    const normalizedBrands = brands.map(brand => this._normalizeString(brand)).filter(Boolean);

    return dataset.filter(item => {
      if (!item || !item.slug) return false;

      if (queryTerms.length > 0) {
        const searchText = this._normalizeString([
          item.name,
          item.search_titles,
          item.description,
          Array.isArray(item.tags) ? item.tags.join(' ') : ''
        ].filter(Boolean).join(' '));

        if (!queryTerms.every(term => searchText.includes(term))) {
          return false;
        }
      }

      if (normalizedTags.length > 0) {
        const itemTags = new Set((Array.isArray(item.tags) ? item.tags : [])
          .map(tag => this._normalizeString(tag)));

        if (!normalizedTags.every(tag => itemTags.has(tag))) {
          return false;
        }
      }

      if (normalizedBrands.length > 0) {
        const itemBrand = this._normalizeString(item.brand);
        if (!normalizedBrands.includes(itemBrand)) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Sort search results by requested field and direction.
   * @private
   */
  _sortSearchResults(results, orderBy = 'created_at_unix', ordering = 'desc') {
    const direction = ordering === 'asc' ? 1 : -1;

    return [...results].sort((a, b) => {
      const aValue = this._getSortableValue(a, orderBy);
      const bValue = this._getSortableValue(b, orderBy);

      if (aValue < bValue) return -1 * direction;
      if (aValue > bValue) return 1 * direction;
      return 0;
    });
  }

  /**
   * Return a single page of results.
   * @private
   */
  _paginateSearchResults(results, page = 0) {
    const safePage = Number.isFinite(page) && page > 0 ? page : 0;
    const start = safePage * this.searchPageSize;
    return results.slice(start, start + this.searchPageSize);
  }

  /**
   * Normalize user-facing text for local matching.
   * @private
   */
  _normalizeString(value) {
    return String(value || '')
      .replace(/<[^>]*>/g, ' ')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Return sortable values with timestamp aliases for the current dataset.
   * @private
   */
  _getSortableValue(item, field) {
    if (!item) return '';

    const value = item[field];
    if (value !== undefined && value !== null) {
      return typeof value === 'string' ? value.toLowerCase() : value;
    }

    if (field === 'created_at_unix' && item.created_at) {
      return Date.parse(item.created_at) || 0;
    }

    if (field === 'released_at_unix' && item.released_at) {
      return Date.parse(item.released_at) || 0;
    }

    return '';
  }

  /**
   * Sleep utility for retry delays
   * @private
   */
  async _sleep(ms) {
    return sleep(ms);
  }

  /**
   * Generic retry wrapper with exponential backoff for 403 errors
   * @private
   * @param {Function} requestFn - Async function to execute
   * @param {Object} context - Context for logging (operation name, params)
   * @param {number} maxRetries - Maximum number of retries
   * @returns {Promise} Result of the request function
   */
  async _retryRequest(requestFn, context = {}, maxRetries = 2) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        logger.debug(`${context.operation} request`, {
          ...context.params,
          attempt: attempt + 1
        });

        return await requestFn();
      } catch (error) {
        const status = error.response?.status;

        if (status === 403 && attempt < maxRetries) {
          const backoffDelay = [2000, 5000, 10000][attempt] || 10000; // 2s, 5s, 10s
          const jitter = Math.random() * 1000; // Add 0-1s jitter
          const delay = backoffDelay + jitter;

          logger.debug(`${context.operation} 403, retrying with backoff`, {
            ...context.params,
            attempt: attempt + 1,
            delay: `${Math.round(delay)}ms`
          });

          await this._sleep(delay);
          continue;
        }

        if (status === 403) {
          logger.debug(`${context.operation} 403 (likely blocked)`, {
            ...context.params,
            attempt: attempt + 1
          });
        } else {
          logger.error(`${context.operation} error`, {
            ...context.params,
            error: error.message,
            status,
            attempt: attempt + 1
          });
        }

        throw error;
      }
    }
  }
}

module.exports = HanimeApiClient;