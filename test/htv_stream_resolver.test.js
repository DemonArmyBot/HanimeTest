const assert = require('assert');
const axios = require('axios');
const signatureService = require('../lib/services/htv_signature_service');
const HtvStreamResolver = require('../lib/services/htv_stream_resolver');
const { sealMessage } = require('../lib/services/htv_stream_resolver');
const { toStremioStream } = require('../lib/transformers/stream_transformer');
const config = require('../lib/config');

const originalGet = axios.get;
const originalPost = axios.post;
const originalGetSignature = signatureService.getSignature;

async function testDoesNotProbeBlockedMetadataSources() {
  const getRequests = [];

  signatureService.getSignature = async () => ({ signature: 'test', time: 123 });
  axios.post = async () => ({
    status: 200,
    headers: {
      'x-token': sealMessage({ sources: [{ height: 720, url: '/hls/blocked-720' }] })
    }
  });
  axios.get = async (url) => {
    getRequests.push(url);
    return { status: 403, headers: {}, data: '<html>blocked</html>' };
  };

  const resolver = new HtvStreamResolver(config);
  const streams = await resolver.resolveStreams('test-video');

  assert.deepStrictEqual(getRequests, []);
  assert.strictEqual(streams[0].durationMs, 20 * 60 * 1000);
  assert.strictEqual(streams[0].filesizeMbs, 202.5);
  assert.strictEqual(streams[0].durationEstimated, true);
  assert.strictEqual(streams[0].filesizeEstimated, true);
}

async function testUsesConfiguredRelayWithBearerSecret() {
  const handshakeRequests = [];

  signatureService.getSignature = async () => ({ signature: 'test', time: 123 });
  axios.post = async (url, body, options) => {
    handshakeRequests.push({ url, body, options });
    return {
      status: 200,
      headers: {
        'x-token': sealMessage({ sources: [{ height: 720, url: '/hls/relay-720' }] })
      }
    };
  };
  const resolver = new HtvStreamResolver({
    api: {
      defaultDurationMs: 20 * 60 * 1000,
      htv: {
        handshakeUrl: 'https://relay.example/api/v11/handshake',
        relaySecret: 'relay-secret',
        hlsHost: 'https://hanime.tv'
      }
    }
  });
  const streams = await resolver.resolveStreams('test-video');

  assert.strictEqual(streams.length, 1);
  assert.strictEqual(handshakeRequests.length, 1);
  assert.strictEqual(
    handshakeRequests[0].url,
    'https://relay.example/api/v11/handshake'
  );
  assert.strictEqual(
    handshakeRequests[0].options.headers.authorization,
    'Bearer relay-secret'
  );
}

async function testFallsBackAcrossHandshakeHostsWhenBlocked() {
  const attempts = [];

  signatureService.getSignature = async () => ({ signature: 'test', time: 123 });
  axios.post = async (url) => {
    attempts.push(url);
    if (url.includes('blocked.example')) {
      return { status: 403, headers: {}, data: '<html>Just a moment...</html>' };
    }
    return {
      status: 200,
      headers: {
        'x-token': sealMessage({ sources: [{ height: 1080, url: '/hls/ok-1080' }] })
      }
    };
  };

  const resolver = new HtvStreamResolver({
    api: {
      defaultDurationMs: 20 * 60 * 1000,
      htv: {
        handshakePath: '/api/v11/handshake',
        handshakeHosts: ['blocked.example', 'working.example'],
        maxHostAttempts: 4,
        hlsHost: 'https://hanime.tv'
      }
    }
  });

  const streams = await resolver.resolveStreams('test-video');

  assert.strictEqual(streams.length, 1);
  assert.strictEqual(streams[0].height, 1080);
  assert.deepStrictEqual(attempts, [
    'https://blocked.example/api/v11/handshake',
    'https://working.example/api/v11/handshake'
  ]);
}

async function testReadsServerStreamsAndSkipsNonNormalSources() {
  signatureService.getSignature = async () => ({ signature: 'test', time: 123 });
  axios.post = async () => ({
    status: 200,
    headers: {
      'x-token': sealMessage({
        // The manifest carries promo/premium entries in `sources` and the real
        // streams nested under `servers[].streams`.
        sources: [
          { src: '/hls/preview', height: 360, kind: 'preview' },
          { src: '/hls/upsell', height: 1080, kind: 'promo' }
        ],
        servers: [
          { streams: [{ src: '/hls/normal-720', height: 720, kind: 'normal' }] },
          { streams: [{ signed_url: 'https://hanime.tv/hls/normal-480', height: 480 }] }
        ]
      })
    }
  });

  const resolver = new HtvStreamResolver({
    api: {
      defaultDurationMs: 20 * 60 * 1000,
      htv: {
        handshakeUrl: 'https://relay.example/api/v11/handshake',
        hlsHost: 'https://hanime.tv'
      }
    }
  });

  const streams = await resolver.resolveStreams('test-video');

  assert.deepStrictEqual(
    streams.map((s) => s.url),
    ['https://hanime.tv/hls/normal-720', 'https://hanime.tv/hls/normal-480']
  );
}

async function testReturnsNoStreamsWhenEveryHostIsBlocked() {
  const attempts = [];

  signatureService.getSignature = async () => ({ signature: 'test', time: 123 });
  axios.post = async (url) => {
    attempts.push(url);
    return { status: 403, headers: {}, data: '<html>Just a moment...</html>' };
  };

  const resolver = new HtvStreamResolver({
    api: {
      defaultDurationMs: 20 * 60 * 1000,
      htv: {
        handshakePath: '/api/v11/handshake',
        handshakeHosts: ['blocked.example'],
        maxHostAttempts: 2,
        hlsHost: 'https://hanime.tv'
      }
    }
  });

  assert.deepStrictEqual(await resolver.resolveStreams('test-video'), []);
  // One attempt per host: retrying a host that already answered 403 only
  // wastes the request budget and delays the fallback.
  assert.deepStrictEqual(attempts, ['https://blocked.example/api/v11/handshake']);
}

function testDefaultHandshakeHostsCoverUpstreamAuthorities() {
  assert.ok(config.api.htv.handshakeHosts.length >= 2);
  assert.ok(config.api.htv.handshakeHosts.includes('auth.hanime.tv'));
  assert.deepStrictEqual(
    new HtvStreamResolver(config).handshakeUrls,
    config.api.htv.handshakeHosts.map((h) => `https://${h}/api/v11/handshake`)
  );
}

function testStreamCacheWindowIsSixHours() {
  assert.strictEqual(config.cache.ttl.stream, 6 * 60 * 60);
}

function testMissingMetadataDoesNotRenderZeroes() {
  const stream = toStremioStream({
    url: 'https://hanime.tv/hls/test',
    height: 720,
    video_stream_group_id: 'Hanime.TV'
  });

  assert.ok(!stream.title.includes('💾 0 MB'));
  assert.ok(!stream.title.includes('⌚ 0 min'));
  assert.ok(stream.title.includes('💾 203 MB'));
  assert.ok(stream.title.includes('⌚ 20 min'));
  assert.ok(!stream.title.includes('~'));
  assert.strictEqual(
    stream.behaviorHints.videoSize,
    Math.round(202.5 * 1024 * 1024)
  );
}

async function run() {
  try {
    await testDoesNotProbeBlockedMetadataSources();
    await testUsesConfiguredRelayWithBearerSecret();
    await testFallsBackAcrossHandshakeHostsWhenBlocked();
    await testReadsServerStreamsAndSkipsNonNormalSources();
    await testReturnsNoStreamsWhenEveryHostIsBlocked();
    testDefaultHandshakeHostsCoverUpstreamAuthorities();
    testStreamCacheWindowIsSixHours();
    testMissingMetadataDoesNotRenderZeroes();
    console.log('htv_stream_resolver tests passed');
  } finally {
    axios.get = originalGet;
    axios.post = originalPost;
    signatureService.getSignature = originalGetSignature;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
