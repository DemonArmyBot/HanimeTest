const assert = require('assert');
const { cleanDescription } = require('../lib/transformers/formatters');
const { toStremioStream, applyPlayerHeaders, buildPlayerHeaders } = require('../lib/transformers/stream_transformer');
const config = require('../lib/config');
const { toStremioMeta, toStremioSeriesMeta, parseAlternateTitles } = require('../lib/transformers/meta_transformer');
const { toStremioCatalogItem, toStremioSeriesCatalogItem } = require('../lib/transformers/catalog_transformer');
const { isValidSlug, parseStremioId } = require('../lib/utils/formatters');

function testCleanDescriptionPreservesLetterP() {
  const description = '<p>A popular episode with plenty of suspense.</p>\n<p>Part two.</p>';

  assert.strictEqual(
    cleanDescription(description),
    'A popular episode with plenty of suspense.\nPart two.'
  );
}

function testStreamMetadataUsesStremioCompatibleNotation() {
  const stream = toStremioStream({
    url: 'https://hanime.tv/hls/test',
    height: 720,
    video_stream_group_id: 'Hanime.TV',
    filesize_mbs: 202.5,
    filesize_estimated: true,
    duration_in_ms: 20 * 60 * 1000,
    duration_estimated: true
  });

  assert.ok(stream.title.includes('💾 203 MB'));
  assert.ok(stream.title.includes('⌚ 20 min'));
  assert.ok(!stream.title.includes('~'));
  assert.strictEqual(stream.description, stream.title);
  assert.strictEqual(
    stream.behaviorHints.videoSize,
    Math.round(202.5 * 1024 * 1024)
  );
}

function testDefaultModeKeepsUrlCleanAndSendsProxyHeaders() {
  const stream = toStremioStream({
    url: 'https://hanime.tv/hls/test',
    height: 1080,
    video_stream_group_id: 'Hanime.TV'
  });

  // Official Stremio passes `url` straight to the HTTP client, so a pipe here
  // would make the stream unplayable outside ExoPlayer forks.
  assert.strictEqual(stream.url, 'https://hanime.tv/hls/test');
  assert.ok(!stream.url.includes('|'));

  // proxyHeaders is only honoured alongside notWebReady, and HLS is never
  // web-ready.
  assert.strictEqual(stream.behaviorHints.notWebReady, true);
  assert.ok(stream.behaviorHints.proxyHeaders);

  const request = stream.behaviorHints.proxyHeaders.request;
  assert.strictEqual(request['User-Agent'], config.api.htv.playerUserAgent);
  assert.strictEqual(request['Referer'], 'https://hanime.tv/');
  assert.strictEqual(request['Origin'], 'https://hanime.tv');
  assert.ok(request['User-Agent'].includes('Android'));
}

function testPipeModeAppendsEncodedUserAgentToUrl() {
  const playerConfig = {
    mode: 'pipe',
    userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    referer: 'https://hanime.tv/',
    origin: 'https://hanime.tv'
  };

  const decorated = applyPlayerHeaders('https://hanime.tv/hls/test', playerConfig);

  assert.ok(decorated.url.startsWith('https://hanime.tv/hls/test|'));
  assert.ok(decorated.url.includes('User-Agent='));

  // The UA contains spaces, slashes and parentheses, so it must be
  // percent-encoded or the pipe splits on the wrong characters.
  const piped = decorated.url.split('|')[1];
  assert.ok(!piped.includes(' '));
  assert.ok(!piped.includes('+'), 'spaces must encode as %20, not +');

  const parsed = new URLSearchParams(piped);
  assert.strictEqual(parsed.get('User-Agent'), playerConfig.userAgent);
  assert.strictEqual(parsed.get('Referer'), 'https://hanime.tv/');
  assert.strictEqual(parsed.get('Origin'), 'https://hanime.tv');
}

function testPipeModeOmitsProxyHeadersToAvoidDoubleApplying() {
  const stream = toStremioStreamWithMode('pipe');
  assert.ok(stream.url.includes('|User-Agent='));
  assert.strictEqual(stream.behaviorHints.proxyHeaders, undefined);
  assert.strictEqual(stream.behaviorHints.notWebReady, true);
}

/**
 * Build a stream with the header mode forced, so the mode-specific assertions
 * do not depend on ambient config.
 */
function toStremioStreamWithMode(mode) {
  const { toStremioStream: build } = require('../lib/transformers/stream_transformer');
  const previousMode = config.api.htv.playerHeaderMode;
  config.api.htv.playerHeaderMode = mode;
  try {
    return build({
      url: 'https://hanime.tv/hls/test',
      height: 1080,
      video_stream_group_id: 'Hanime.TV'
    });
  } finally {
    config.api.htv.playerHeaderMode = previousMode;
  }
}

function testBuildPlayerHeadersSkipsUnsetValues() {
  assert.deepStrictEqual(
    buildPlayerHeaders({ userAgent: 'UA', referer: '', origin: null }),
    { 'User-Agent': 'UA' }
  );
  assert.deepStrictEqual(buildPlayerHeaders({}), {});
}

function testPublicUrlIsNormalized() {
  const { normalizePublicUrl } = require('../lib/config');

  // Hosts commonly set PUBLIC_URL as a bare domain. Emitting that verbatim
  // produced schemeless asset URLs, which browsers resolve as relative paths
  // and 404 on.
  assert.strictEqual(normalizePublicUrl('hanimetest.up.railway.app'), 'https://hanimetest.up.railway.app');
  assert.strictEqual(normalizePublicUrl('https://addon.example.com'), 'https://addon.example.com');
  assert.strictEqual(normalizePublicUrl('https://addon.example.com/'), 'https://addon.example.com');
  assert.strictEqual(normalizePublicUrl('https://addon.example.com/base/'), 'https://addon.example.com/base');
  assert.strictEqual(normalizePublicUrl('http://127.0.0.1:61327'), 'http://127.0.0.1:61327');
  assert.strictEqual(normalizePublicUrl('https://addon.example.com:8080'), 'https://addon.example.com:8080');

  for (const bad of ['', '   ', null, undefined, 'not a url::']) {
    assert.strictEqual(normalizePublicUrl(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
}

function testOutboundProxyConfig() {
  const { toAxiosProxyConfig, upstreamProxyOptions, redactProxyUrl } =
    require('../lib/utils/proxy_helper');

  assert.deepStrictEqual(toAxiosProxyConfig('http://1.2.3.4:8080'), {
    protocol: 'http:', host: '1.2.3.4', port: 8080
  });

  assert.deepStrictEqual(toAxiosProxyConfig('http://user:pass@1.2.3.4:8080'), {
    protocol: 'http:', host: '1.2.3.4', port: 8080,
    auth: { username: 'user', password: 'pass' }
  });

  // A missing port must resolve to the protocol default. `new URL()` reports an
  // empty port for these, and defaulting to 80 would send HTTPS to the wrong
  // port entirely.
  assert.strictEqual(toAxiosProxyConfig('https://1.2.3.4').port, 443);
  assert.strictEqual(toAxiosProxyConfig('http://1.2.3.4').port, 80);
  assert.strictEqual(toAxiosProxyConfig('socks5://1.2.3.4').port, 1080);

  // socks5h means "resolve on the proxy side", which is what axios does for
  // socks5 anyway.
  assert.strictEqual(toAxiosProxyConfig('socks5h://1.2.3.4:1080').protocol, 'socks5:');

  // Percent-encoded credentials must be decoded, not passed through raw.
  assert.strictEqual(toAxiosProxyConfig('https://u:p%40ss@1.2.3.4:443').auth.password, 'p@ss');

  for (const bad of [null, '', 'garbage', 'ftp://x:1']) {
    assert.strictEqual(toAxiosProxyConfig(bad), null, `should reject ${bad}`);
  }

  // No proxy configured must mean "no proxy option", never a broken one.
  assert.deepStrictEqual(upstreamProxyOptions({}), {});
  assert.deepStrictEqual(
    upstreamProxyOptions({ proxy: { url: 'http://1.2.3.4:8080' } }),
    { proxy: { protocol: 'http:', host: '1.2.3.4', port: 8080 } }
  );

  // Credentials must never reach the logs.
  assert.strictEqual(redactProxyUrl('http://user:secret@1.2.3.4:8080'), 'http://***@1.2.3.4:8080');
  assert.strictEqual(redactProxyUrl(null), null);
}

function testProxyModeEmitsSignedProxyUrl() {
  const stream = toStremioStreamWithConfig(
    'proxyHeaders',
    { enabled: true, path: '/proxy/stream', secret: 'proxy-mode-secret' }
  );

  // The player's URL must point at this addon (PUBLIC_URL), never at hanime —
  // that is the entire point of proxy mode.
  assert.ok(stream.url.startsWith('http://127.0.0.1:') || stream.url.startsWith('https://'),
    `expected addon URL, got ${stream.url}`);
  assert.ok(!stream.url.includes('hanime.tv'), `proxy mode must not leak the upstream host: ${stream.url}`);
  assert.ok(stream.url.includes('/proxy/stream/'));
  assert.ok(stream.url.includes('?s='), 'proxy URL must be signed');

  // Header decoration is pointless in proxy mode: the addon presents the
  // headers itself, so sending them to the player too is misleading.
  assert.strictEqual(stream.behaviorHints.proxyHeaders, undefined);
  assert.strictEqual(stream.behaviorHints.notWebReady, true);
  assert.ok(stream.name.includes('Proxy'), `proxy mode should be labelled, got ${stream.name}`);
}

function testProxyModeDisabledKeepsDirectUrl() {
  const stream = toStremioStreamWithConfig(
    'proxyHeaders',
    { enabled: false, path: '/proxy/stream', secret: 'proxy-mode-secret' }
  );

  assert.strictEqual(stream.url, 'https://hanime.tv/hls/test');
  assert.ok(!stream.name.includes('Proxy'));
  assert.ok(stream.behaviorHints.proxyHeaders, 'default mode must keep sending proxyHeaders');
}

function testProxyModeUrlVerifiesAgainstTheProxySecret() {
  const proxyConfig = { enabled: true, path: '/proxy/stream', secret: 'shared-secret-for-test' };
  const stream = toStremioStreamWithConfig('proxyHeaders', proxyConfig);

  const HlsStreamProxy = require('../lib/services/hls_stream_proxy');
  const proxy = new HlsStreamProxy({ ...config, streamProxy: proxyConfig });

  const parsed = new URL(stream.url);
  const payload = parsed.pathname.split('/').pop();
  const signature = parsed.searchParams.get('s');
  const verified = proxy.verifyUrl(payload, signature);

  assert.strictEqual(verified.ok, true);
  assert.strictEqual(verified.url, 'https://hanime.tv/hls/test');
}

/**
 * Build a stream with both the header mode and the proxy config overridden, so
 * the assertions do not depend on ambient environment.
 */
function toStremioStreamWithConfig(headerMode, streamProxyOverrides) {
  const previousMode = config.api.htv.playerHeaderMode;
  const previousProxy = config.streamProxy;
  config.api.htv.playerHeaderMode = headerMode;
  config.streamProxy = { ...previousProxy, ...streamProxyOverrides };
  try {
    return toStremioStream({
      url: 'https://hanime.tv/hls/test',
      height: 1080,
      video_stream_group_id: 'Hanime.TV'
    });
  } finally {
    config.api.htv.playerHeaderMode = previousMode;
    config.streamProxy = previousProxy;
  }
}

function testSeriesCatalogItemUsesStremioGenreKey() {
  // Stremio reads catalog genres from `genre`. Emitting only `genres` left
  // series rows without genres in the catalog board.
  const item = toStremioSeriesCatalogItem({
    id: 'series:mujin-eki',
    slug: 'series:mujin-eki',
    name: 'Mujin Eki',
    tags: ['vanilla', 'hd'],
    cover_url: 'https://hanime-cdn.com/images/covers/mujin-eki.webp',
    description: '<p>test</p>',
    episodeCount: 4
  });

  assert.deepStrictEqual(item.genre, ['Vanilla', 'Hd']);
  assert.strictEqual(item.genres, undefined);
  assert.strictEqual(item.type, 'series');
}

function testCatalogItemFallsBackToProxyWhenDatasetHasNoImage() {
  const item = toStremioCatalogItem({ slug: 'test-video', name: 'Test', tags: [] });

  assert.ok(item.poster.includes('/proxy/image/'));
  assert.ok(item.id === 'hanime:test-video');
}

function testMetaExposesAlternateTitlesFromSearchTitles() {
  const meta = toStremioMeta({
    slug: 'doukyuusei-climax-2',
    name: 'Doukyuusei Climax 2',
    search_titles: 'Doukyuusei Climax Classmates 同級生 クライマックス 동급생',
    hentai_tags: [{ text: 'hd' }, { text: 'vanilla' }],
    description: '<p>test</p>',
    likes: 10,
    dislikes: 1,
    released_at_unix: 840000000
  }, { poster: '', background: '' });

  assert.deepStrictEqual(meta.alternateTitles, [
    'Doukyuusei', 'Climax', 'Classmates', '同級生', 'クライマックス', '동급생'
  ]);
  assert.deepStrictEqual(meta.genre, ['Hd', 'Vanilla']);
}

function testParseAlternateTitlesDropsPrimaryAndDuplicates() {
  assert.deepStrictEqual(
    parseAlternateTitles('Alpha Alpha Beta a 2', 'Alpha'),
    ['Beta']
  );
  // Single-character fragments are dropped: they're noise in search.
  assert.deepStrictEqual(parseAlternateTitles('Beta x Gamma', 'Alpha'), ['Beta', 'Gamma']);
  assert.deepStrictEqual(parseAlternateTitles('', 'Alpha'), []);
  assert.deepStrictEqual(parseAlternateTitles(null, 'Alpha'), []);
}

function testSeriesMetaLinksEveryEpisodeToPlayableStreams() {
  const meta = toStremioSeriesMeta(
    'series:mujin-eki',
    'Mujin Eki',
    [
      { slug: 'mujin-eki-1', name: 'Mujin Eki 1', tags: ['hd'], description: 'ep1' },
      { slug: 'mujin-eki-2', name: 'Mujin Eki 2', tags: ['hd'], description: 'ep2' }
    ],
    { poster: '', background: '' }
  );

  assert.strictEqual(meta.id, 'hanime:series:mujin-eki');
  assert.deepStrictEqual(
    meta.videos.map((v) => v.id),
    ['hanime:series:mujin-eki:mujin-eki-1', 'hanime:series:mujin-eki:mujin-eki-2']
  );
  assert.strictEqual(meta.videos[0].episode, 1);
  assert.strictEqual(meta.videos[1].episode, 2);
}

function testSlugValidationRejectsNonSlugInput() {
  assert.ok(isValidSlug('doukyuusei-climax-2'));
  assert.ok(!isValidSlug(''));
  assert.ok(!isValidSlug(null));
  assert.ok(!isValidSlug('../../etc/passwd'));
  assert.ok(!isValidSlug('has spaces'));
  assert.ok(!isValidSlug('Upper-Case'));
  assert.ok(!isValidSlug('trailing-'));
  assert.ok(!isValidSlug('a'.repeat(201)));
}

function testParseStremioIdClassifiesAndValidates() {
  assert.deepStrictEqual(parseStremioId('hanime:my-video-1'), {
    kind: 'video', seriesBase: null, slug: 'my-video-1'
  });
  assert.deepStrictEqual(parseStremioId('hanime:series:mujin-eki'), {
    kind: 'series', seriesBase: 'mujin-eki', slug: null
  });
  assert.deepStrictEqual(parseStremioId('hanime:series:mujin-eki:mujin-eki-1'), {
    kind: 'seriesEpisode', seriesBase: 'mujin-eki', slug: 'mujin-eki-1'
  });
  assert.strictEqual(parseStremioId('hanime:../secret').kind, 'invalid');
  assert.strictEqual(parseStremioId('otheraddon:slug').kind, 'invalid');
  assert.strictEqual(parseStremioId('hanime:series:mujin-eki:extra:parts').kind, 'invalid');
}

testCleanDescriptionPreservesLetterP();
testStreamMetadataUsesStremioCompatibleNotation();
testDefaultModeKeepsUrlCleanAndSendsProxyHeaders();
testPipeModeAppendsEncodedUserAgentToUrl();
testPipeModeOmitsProxyHeadersToAvoidDoubleApplying();
testBuildPlayerHeadersSkipsUnsetValues();
testPublicUrlIsNormalized();
testOutboundProxyConfig();
testProxyModeEmitsSignedProxyUrl();
testProxyModeDisabledKeepsDirectUrl();
testProxyModeUrlVerifiesAgainstTheProxySecret();
testSeriesCatalogItemUsesStremioGenreKey();
testCatalogItemFallsBackToProxyWhenDatasetHasNoImage();
testMetaExposesAlternateTitlesFromSearchTitles();
testParseAlternateTitlesDropsPrimaryAndDuplicates();
testSeriesMetaLinksEveryEpisodeToPlayableStreams();
testSlugValidationRejectsNonSlugInput();
testParseStremioIdClassifiesAndValidates();
console.log('transformer tests passed');
