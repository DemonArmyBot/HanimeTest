const { parseStremioId } = require('../utils/formatters');
const { toStremioStreams } = require('../transformers/stream_transformer');
const { cacheWrapStream } = require('../cache');
const { emptyResponse } = require('./response_helpers');
const HtvStreamResolver = require('../services/htv_stream_resolver');

class StreamHandler {
  constructor(logger, config, userApiManager) {
    this.logger = logger;
    this.config = config;
    this.userApiManager = userApiManager;
    this.streamResolver = new HtvStreamResolver(config);
  }

  // ============================================================================
  // Public Methods
  // ============================================================================

  async handle(args) {
    try {
      const id = args.id;

      if (!id) {
        this.logger.warn('Stream handler called without ID');
        return emptyResponse('stream');
      }

      const parsedId = parseStremioId(id);
      if (parsedId.kind === 'invalid' || parsedId.kind === 'series') {
        // Parent series ids carry no streams of their own.
        return emptyResponse('stream');
      }

      // Login is optional for playback: the handshake resolver works as a
      // guest (720p). A session token, when we can get one, is passed through
      // to unlock premium qualities — but a login failure must not break
      // playback, so fall back to guest instead of erroring out.
      const userConfig = args.config || {};
      const { email, password } = userConfig;
      let userApi = null;
      if (email && password) {
        try {
          userApi = await this.userApiManager.getUserApi(email, password);
        } catch (error) {
          this.logger.warn('Stream handler: login failed, resolving as guest', {
            error: error.message
          });
        }
      }

      const streams = await this._getStreams(id, parsedId.slug, userApi);

      return {
        ...streams,
        cacheMaxAge: this.config.cache.ttl.stream, // 6 hours in seconds
        staleRevalidate: 600 // 10 minutes
      };
    } catch (error) {
      this.logger.error('Stream handler error', {
        id: args.id,
        error: error.message,
        stack: error.stack
      });
      return emptyResponse('stream');
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Get playable video streams via hanime's /api/v11/handshake flow.
   * Returns absolute hanime.tv/hls URLs that Stremio plays directly (the
   * deprecated app→highwinds manifest URLs no longer resolve). A session
   * token, when available, unlocks premium qualities (e.g. 1080p).
   * @private
   * @param {string} slug - Video slug
   * @param {Object} [userApi] - Authenticated user API instance (optional)
   * @returns {Promise<Array>} Array of stream objects in transformer shape
   */
  async _getVideoStreams(slug, userApi) {
    const sessionToken = userApi && typeof userApi.getSessionToken === 'function'
      ? userApi.getSessionToken()
      : null;

    const resolved = await this.streamResolver.resolveStreams(slug, sessionToken);

    if (!resolved.length) {
      this.logger.warn('No streams resolved via handshake', { slug });
      return [];
    }

    const streams = resolved.map(stream => ({
      url: stream.url,
      height: stream.height,
      filesize_mbs: stream.filesizeMbs,
      filesize_estimated: stream.filesizeEstimated,
      duration_in_ms: stream.durationMs,
      duration_estimated: stream.durationEstimated,
      video_stream_group_id: 'Hanime.TV'
    }));

    // Logged at info, not debug: "did this resolve, and to what qualities?" is the
    // single most useful fact when someone reports streams missing, and
    // LOG_LEVEL=info is the usual production setting where debug is invisible.
    this.logger.info('Video streams resolved via handshake', {
      slug,
      streamsCount: streams.length,
      resolutions: streams.map(s => `${s.height || '?'}p`).join(', ')
    });

    return streams;
  }

  /**
   * Get streams for a video or series episode
   * @private
   * @param {string} id - Full ID with prefix (e.g., "hanime:video-slug" or "hanime:series:base:episode-slug")
   * @param {string} videoId - Validated video slug for this request
   * @param {Object|null} userApi - Authenticated user API instance, or null for guest
   * @returns {Promise<Object>} Streams object with streams array
   */
  async _getStreams(id, videoId, userApi) {
    return cacheWrapStream(id, async () => {
      // Use authenticated API
      const streams = await this._getVideoStreams(videoId, userApi);

      if (!streams || !Array.isArray(streams)) {
        this.logger.warn('Stream handler: no streams returned', {
          id,
          videoId,
          resultType: typeof streams,
          isArray: Array.isArray(streams)
        });
        return emptyResponse('stream');
      }

      const cacheConfig = {
        maxAge: this.config.cache.browserCacheMaxAge,
        staleError: 6 * 30 * 24 * 60 * 60 // 6 months in seconds
      };

      const response = toStremioStreams(streams, cacheConfig);

      if (!response.streams || response.streams.length === 0) {
        return emptyResponse('stream');
      }

      return response;
    });
  }
}

module.exports = StreamHandler;
