/**
 * Image Fetch Service
 * Handles CDN image fetching with retry logic and failure tracking
 */

const axios = require('axios');
const mime = require('mime-types');

/**
 * Sleep utility for retry delays
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class ImageFetchService {
  constructor(cdnUrl) {
    this.cdnUrl = cdnUrl;
    this.failedRequests = new Map(); // key -> timestamp of last 403
  }

  /**
   * Fetch image with retry logic
   */
  async fetch(imageUrl, imagePath, maxRetries = 2) {
    // No Pragma/Cache-Control: CDN edge caches key off those, and forcing
    // revalidation on every poster request is what turned a slow proxy into a
    // slow one. Browser-like Sec-Fetch-* and Origin/Referer are kept because
    // the CDN rejects requests that don't look like they came from hanime.tv.
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://hanime.tv',
      'Referer': 'https://hanime.tv/',
      'Sec-Fetch-Dest': 'image',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site'
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const lastFailure = this.failedRequests.get(imageUrl);
        if (lastFailure && Date.now() - lastFailure < 60000) {
          const waitTime = 1000 + Math.random() * 1500;
          await sleep(waitTime);
        }

        const response = await axios.get(imageUrl, {
          headers,
          responseType: 'arraybuffer',
          timeout: 10000, // 10 second timeout
          validateStatus: () => true
        });

        if (response.status !== 200) {
          const err = new Error(`Image request failed with status ${response.status}`);
          err.response = { status: response.status, data: response.data };
          throw err;
        }

        // Success - remove from failed cache if present
        this.failedRequests.delete(imageUrl);

        // Determine content type
        const contentType = response.headers['content-type'] ||
                           mime.lookup(imageUrl) ||
                           'image/jpeg';

        return {
          buffer: response.data,
          contentType
        };
      } catch (err) {
        const status = err.response?.status;

        // 403/5xx are usually Cloudflare or an upstream blip and recover;
        // a 404 will never, so don't spend 20s of backoff on it.
        const retriable = status === 403 || status === 429 || status >= 500 || !status;

        if (retriable && attempt < maxRetries) {
          this.failedRequests.set(imageUrl, Date.now());

          const backoffDelay = [1000, 3000, 6000][attempt] || 6000;
          const jitter = Math.random() * 500;
          const delay = backoffDelay + jitter;

          await sleep(delay);
          continue;
        }

        // If not retrying, throw the error
        throw err;
      }
    }
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      failedRequests: this.failedRequests.size
    };
  }
}

module.exports = ImageFetchService;

