const assert = require('assert');
const path = require('path');
const HlsStreamProxy = require('../lib/services/hls_stream_proxy');
const {
  buildProxyStreamUrl,
  setProxySecret,
  signPayload
} = require('../lib/services/hls_stream_proxy_url');
const config = require('../lib/config');

const SEGMENT = Buffer.from('FAKE-TS-SEGMENT-BYTES-0123456789');

const TEST_CONFIG = {
  ...config,
  streamProxy: {
    enabled: true,
    path: '/proxy/stream',
    timeoutMs: 5000,
    maxBodyBytes: 1024 * 1024,
    manifestCacheSeconds: 30,
    secret: 'unit-test-secret'
  }
};

function newProxy() {
  return new HlsStreamProxy(TEST_CONFIG);
}

function testSignedUrlRoundTrips() {
  const proxy = newProxy();
  const upstream = 'https://hanime.tv/hls/video/720/index.m3u8?token=abc';
  const path = proxy.signUrl(upstream);

  const payload = path.split('/').pop().split('?s=')[0];
  const signature = path.split('?s=')[1];

  assert.strictEqual(proxy.verifyUrl(payload, signature).url, upstream);
}

function testBadSignatureIsRejected() {
  const proxy = newProxy();
  const path = proxy.signUrl('https://hanime.tv/hls/x.m3u8');
  const payload = path.split('/').pop().split('?s=')[0];

  const result = proxy.verifyUrl(payload, 'forged-signature');
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /signature/);
}

function testSignatureIsCheckedBeforeHostAllowlist() {
  // A forged signature must not even be decoded into a URL.
  const proxy = newProxy();
  const payload = Buffer.from('https://evil.example/x.m3u8').toString('base64url');
  const result = proxy.verifyUrl(payload, 'nope');

  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /signature/);
}

function testUpstreamHostAllowlistBlocksSSRF() {
  const proxy = newProxy();

  const disallowed = [
    'https://evil.example/hls/x.m3u8',
    'https://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://hanime.tv/hls/x.m3u8',                // not https
    'https://localhost:8080/x.m3u8',
    'https://hanime.tv.evil.example/x.m3u8',     // suffix trickery
    'not a url'
  ];

  for (const url of disallowed) {
    assert.strictEqual(proxy.isAllowedUpstream(url).ok, false, `should refuse ${url}`);
  }

  for (const url of ['https://hanime.tv/hls/x.m3u8', 'https://hanime-cdn.com/a/b.ts']) {
    assert.strictEqual(proxy.isAllowedUpstream(url).ok, true, `should allow ${url}`);
  }
}

function testRewriteManifestRewritesEveryUriForm() {
  const proxy = newProxy();
  const manifest = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    '#EXTINF:9.0,',
    'relative-segment.ts',
    '#EXTINF:9.0,',
    '/hls/video/720/absolute.ts?token=t',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    '#EXT-X-MAP:URI="/hls/video/720/init.mp4"',
    '#EXTINF:9.0,',
    'https://hanime.tv/hls/video/720/absolute2.ts',
    '#EXT-X-ENDLIST',
    ''
  ].join('\n');

  const out = proxy.rewriteManifest(manifest, 'https://hanime.tv/hls/video/720/index.m3u8?token=t');
  const lines = out.split('\n');

  // Relative URI resolves against the manifest URL and becomes a proxy path.
  assert.ok(lines.includes('#EXTM3U'));
  assert.ok(lines.includes('#EXT-X-ENDLIST'));

  const segmentLines = lines.filter((l) => l.startsWith('/proxy/stream/'));
  assert.strictEqual(segmentLines.length, 3, 'three bare segment URIs rewritten');

  // Every rewritten URI carries a signature.
  for (const line of segmentLines) {
    assert.ok(line.includes('?s='), `missing signature: ${line}`);
  }

  // URI= attributes inside tags are rewritten too; without this the AES key and
  // init segment would still point straight at hanime and 403.
  assert.ok(lines.some((l) => l.startsWith('#EXT-X-KEY:') && l.includes('/proxy/stream/')));
  assert.ok(lines.some((l) => l.startsWith('#EXT-X-MAP:') && l.includes('/proxy/stream/')));
}

function testRewriteManifestPreservesIvAndTagAttributes() {
  const proxy = newProxy();
  const out = proxy.rewriteManifest(
    '#EXT-X-KEY:METHOD=AES-128,URI="k.bin",IV=0x0123,KEYFORMAT="identity"',
    'https://hanime.tv/hls/v/720/index.m3u8'
  );

  assert.ok(out.includes('IV=0x0123'), 'IV must survive rewriting');
  assert.ok(out.includes('KEYFORMAT="identity"'), 'KEYFORMAT must survive rewriting');
  assert.ok(out.includes('/proxy/stream/'));
}

function testRewriteManifestLeavesForeignHostsAlone() {
  const proxy = newProxy();
  const out = proxy.rewriteManifest(
    '#EXTINF:9.0,\nhttps://evil.example/track.ts',
    'https://hanime.tv/hls/v/720/index.m3u8'
  );

  // Rewriting a foreign host into a signed proxy URL would just produce a link
  // the proxy refuses; leaving it untouched is the honest outcome.
  assert.ok(out.includes('https://evil.example/track.ts'));
  assert.ok(!out.includes('/proxy/stream/'));
}

function testRewrittenManifestLinesAllVerify() {
  const proxy = newProxy();
  const out = proxy.rewriteManifest(
    '#EXTINF:9.0,\nseg0.ts\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    'https://hanime.tv/hls/v/720/index.m3u8'
  );

  const matches = out.match(/\/proxy\/stream\/([^?\s"]+)\?s=([^&\s"]+)/g) || [];
  assert.ok(matches.length >= 2);

  for (const match of matches) {
    const [payload, sig] = match.split('/proxy/stream/')[1].split('?s=');
    const verified = proxy.verifyUrl(payload, sig);
    assert.strictEqual(verified.ok, true, `should verify: ${match}`);
    assert.ok(verified.url.startsWith('https://hanime.tv/'));
  }
}

function testBuildProxyStreamUrlUsesPublicUrl() {
  const previous = config.server.publicUrl;
  const previousSecret = config.streamProxy.secret;

  config.server.publicUrl = 'https://addon.example.com';
  config.streamProxy.secret = 'shared-test-secret';

  const url = buildProxyStreamUrl('https://hanime.tv/hls/v/720/index.m3u8');

  assert.ok(url.startsWith('https://addon.example.com/proxy/stream/'),
    `expected PUBLIC_URL base, got ${url}`);

  // The transformer signs with this helper and the middleware verifies with
  // HlsStreamProxy; they must agree.
  const proxy = new HlsStreamProxy({
    ...config,
    streamProxy: { ...config.streamProxy, secret: 'shared-test-secret' }
  });
  const parsed = new URL(url);
  const payload = parsed.pathname.split('/').pop();
  const signature = parsed.searchParams.get('s');
  assert.strictEqual(proxy.verifyUrl(payload, signature).ok, true);

  config.server.publicUrl = previous;
  config.streamProxy.secret = previousSecret;
}

function testSignPayloadIsDeterministicWithinASecret() {
  setProxySecret('abc');
  const underAbc = signPayload('x');
  // Stable across calls within one secret.
  assert.strictEqual(underAbc, signPayload('x'));

  // Different secret must produce a different signature, otherwise the
  // signature is not actually bound to the secret.
  setProxySecret('def');
  assert.notStrictEqual(signPayload('x'), underAbc);

  setProxySecret('abc');
}

/**
 * Stand-in Express response for driving the middleware without a server.
 * @returns {Object} Minimal response recorder
 */
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    headersSent: false,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    end(body) { this.body = body; this.headersSent = true; return this; },
    send(body) { this.body = body; this.headersSent = true; return this; }
  };
}

/**
 * Drive the middleware the way Express would for one upstream URL.
 * @param {Object} middleware - Stream proxy middleware
 * @param {string} upstreamUrl - URL to proxy
 * @returns {Promise<Object>} Recorded response
 */
async function proxyThrough(middleware, upstreamUrl) {
  const signed = buildProxyStreamUrl(upstreamUrl);
  const parsed = new URL(signed);
  const res = makeRes();
  await middleware({
    params: { payload: parsed.pathname.split('/').pop() },
    query: { s: parsed.searchParams.get('s') }
  }, res);
  return res;
}

/**
 * Install a stub for the real axios module before the proxy service loads, so
 * the service's fetch path (headers, status handling, manifest/segment
 * branching) is exercised against canned upstream responses.
 * @param {Array} calls - Array that receives each upstream request
 * @returns {Object} The stubbed axios module
 */
function installAxiosStub(calls) {
  const axiosPath = require.resolve('axios');
  delete require.cache[axiosPath];
  require(axiosPath);
  require.cache[axiosPath].exports = {
    get: async (url, opts) => {
      calls.push({ url, headers: opts.headers });
      const body = (buf, type) => ({
        status: 200,
        headers: { 'content-type': type, 'content-length': String(Buffer.byteLength(buf)) },
        data: Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8')
      });

      if (url.endsWith('/master.m3u8')) {
        return body('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n/hls/360/index.m3u8\n',
          'application/vnd.apple.mpegurl');
      }
      if (url.endsWith('/360/index.m3u8')) {
        return body([
          '#EXTM3U', '#EXT-X-TARGETDURATION:10',
          '#EXT-X-KEY:METHOD=AES-128,URI="/hls/360/key.bin",IV=0x0',
          '#EXT-X-MAP:URI="/hls/360/init.mp4"',
          '#EXTINF:9.0,', 'seg0.ts', '#EXT-X-ENDLIST', ''
        ].join('\n'), 'application/vnd.apple.mpegurl');
      }
      if (url.endsWith('/seg0.ts')) return body(SEGMENT, 'video/mp2t');
      if (url.endsWith('/key.bin')) return body(Buffer.alloc(16, 7), 'application/octet-stream');
      if (url.endsWith('/init.mp4')) return body(Buffer.alloc(32, 9), 'application/octet-stream');
      if (url.endsWith('/blocked.ts')) {
        return { status: 403, headers: { 'content-type': 'text/html' }, data: Buffer.from('<html>challenge</html>') };
      }
      return { status: 404, headers: {}, data: Buffer.from('') };
    }
  };
}

/**
 * The player must be able to walk manifest -> media playlist -> segment with
 * every hop pointing back at this addon, which is the whole point of the mode.
 */
async function testFullPlaybackWalkThroughProxy() {
  const calls = [];
  installAxiosStub(calls);

  const previousPublicUrl = config.server.publicUrl;
  const previousSecret = config.streamProxy.secret;

  config.server.publicUrl = 'https://addon.example.com';
  config.streamProxy.secret = 'walk-secret';

  // Fresh modules so the service captures the stubbed axios at load time.
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}lib${path.sep}`)) delete require.cache[key];
  }
  const Proxy = require('../lib/services/hls_stream_proxy');
  Proxy.ALLOWED_UPSTREAM_HOSTS.add('cdn.hanime.tv');
  const createStreamProxyMiddleware = require('../lib/middleware/proxy_stream_middleware');
  const urlBuilder = require('../lib/services/hls_stream_proxy_url');
  const middleware = createStreamProxyMiddleware(config);

  const proxied = (url) => proxyThrough(middleware, url);
  const SIGNED = '/proxy/stream/';

  try {
    const master = await proxied('https://cdn.hanime.tv/hls/master.m3u8');
    assert.strictEqual(master.statusCode, 200);
    const masterText = master.body.toString();

    // The master playlist must no longer name the upstream host, otherwise the
    // player would be sent straight back to hanime.
    assert.ok(!masterText.includes('cdn.hanime.tv/hls/360'),
      'served manifest must not reference the upstream host');
    const variant = masterText.split('\n').find((l) => l.startsWith(SIGNED));
    assert.ok(variant, 'nested playlist must be rewritten to a proxy path');

    const media = await proxied('https://cdn.hanime.tv/hls/360/index.m3u8');
    assert.strictEqual(media.statusCode, 200);
    const mediaText = media.body.toString();

    assert.ok(/#EXTINF:[\d.]+,\n\/proxy\/stream\//.test(mediaText), 'segment URI rewritten');
    assert.ok(/#EXT-X-KEY:[^\n]*\/proxy\/stream\//.test(mediaText), 'AES key URI rewritten');
    assert.ok(/#EXT-X-MAP:[^\n]*\/proxy\/stream\//.test(mediaText), 'init map URI rewritten');
    assert.ok(mediaText.includes('IV=0x0'), 'IV must survive rewriting');

    // The addon must present the player identity upstream, not the default.
    const manifestCall = calls.find((c) => c.url.endsWith('/360/index.m3u8'));
    assert.match(manifestCall.headers['User-Agent'], /Android/);
    assert.strictEqual(manifestCall.headers['Referer'], 'https://hanime.tv/');

    const segment = await proxied('https://cdn.hanime.tv/hls/360/seg0.ts');
    assert.ok(segment.body.equals(SEGMENT), 'segment bytes must pass through untouched');
    assert.match(segment.headers['content-type'], /video\/mp2t/);
    assert.match(segment.headers['cache-control'], /max-age=86400/,
      'segments should be cacheable by the player');
    assert.strictEqual(Number(segment.headers['content-length']), SEGMENT.length);

    const key = await proxied('https://cdn.hanime.tv/hls/360/key.bin');
    assert.strictEqual(key.statusCode, 200);
    assert.strictEqual(key.body.length, 16);

    const map = await proxied('https://cdn.hanime.tv/hls/360/init.mp4');
    assert.strictEqual(map.statusCode, 200);
    assert.strictEqual(map.body.length, 32);

    // A blocked upstream must surface as a proxy error, never as a body the
    // player would try to decode as video.
    const blocked = await proxied('https://cdn.hanime.tv/hls/blocked.ts');
    assert.strictEqual(blocked.statusCode, 502);
    assert.ok(!Buffer.isBuffer(blocked.body) || !blocked.body.equals(SEGMENT));
  } finally {
    config.server.publicUrl = previousPublicUrl;
    config.streamProxy.secret = previousSecret;
    const axiosPath = require.resolve('axios');
    delete require.cache[axiosPath];
  }
}

// A real hanime handshake URL, captured from a live session. It is what the
// addon hands to the player in proxy mode, and it has no .m3u8 extension.
const REAL_HANIME_HLS_URL =
  'https://hanime.tv/hls/3541/clzn86h8crhqm8d1lk78Axs8x7Zt9ff4jzgps70jl9vp4dcdr0mp5419gx081f2vkhtcghpbpA1yk0jxxz641fnt176mhA0qd3d7mzw2cmy57gfvp01hznpjjp1ssgrxx1';

function testRealHanimeUrlIsRecognisedAsAManifest() {
  const { detectManifest } = require('../lib/services/hls_stream_proxy');
  const manifest = Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:9.0,\nseg0.ts\n');

  // hanime serves playlists from extensionless paths, so a URL-shape heuristic
  // would call this a segment and pass it through unrewritten — which sends the
  // player straight back to hanime for the segments and 403s.
  assert.ok(!/\.m3u8(\?|#|$)/i.test(REAL_HANIME_HLS_URL),
    'fixture should exercise the extensionless path shape');

  assert.strictEqual(detectManifest(manifest, 'application/vnd.apple.mpegurl'), true);
  assert.strictEqual(detectManifest(manifest, 'application/octet-stream'), true,
    'octet-stream must fall through to body sniffing, not be treated as media');
  assert.strictEqual(detectManifest(manifest, ''), true,
    'a missing content-type must not misclassify a playlist');

  // Real media must never be mistaken for a playlist.
  assert.strictEqual(detectManifest(SEGMENT, 'video/mp2t'), false);
  assert.strictEqual(detectManifest(Buffer.alloc(64, 9), 'application/octet-stream'), false);
  assert.strictEqual(detectManifest(Buffer.from('<html>challenge</html>'), 'text/html'), false);
}

function testExtraHostsExtendTheAllowlist() {
  const proxy = new HlsStreamProxy({
    ...TEST_CONFIG,
    streamProxy: { ...TEST_CONFIG.streamProxy, extraHosts: ['CDN.Example.COM', ' ', ''] }
  });

  assert.strictEqual(proxy.isAllowedUpstream('https://cdn.example.com/hls/a.m3u8').ok, true);
  assert.strictEqual(proxy.isAllowedUpstream('https://not-listed.example/a.m3u8').ok, false);
}

async function run() {
  testSignedUrlRoundTrips();
  testBadSignatureIsRejected();
  testSignatureIsCheckedBeforeHostAllowlist();
  testUpstreamHostAllowlistBlocksSSRF();
  testRealHanimeUrlIsRecognisedAsAManifest();
  testExtraHostsExtendTheAllowlist();
  testRewriteManifestRewritesEveryUriForm();
  testRewriteManifestPreservesIvAndTagAttributes();
  testRewriteManifestLeavesForeignHostsAlone();
  testRewrittenManifestLinesAllVerify();
  testBuildProxyStreamUrlUsesPublicUrl();
  testSignPayloadIsDeterministicWithinASecret();
  await testFullPlaybackWalkThroughProxy();
  console.log('hls_stream_proxy tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});