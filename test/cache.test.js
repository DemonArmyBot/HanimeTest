const assert = require('assert');
const { cacheWrapCatalog, cacheWrapStream } = require('../lib/cache');

async function testConcurrentMissesShareOneUpstreamRequest() {
  let upstreamCalls = 0;
  const key = `single-flight-${Date.now()}-${Math.random()}`;
  const fetchCatalog = async () => {
    upstreamCalls++;
    await new Promise(resolve => setTimeout(resolve, 20));
    return [{ id: 'result' }];
  };

  const results = await Promise.all(
    Array.from({ length: 10 }, () => cacheWrapCatalog(key, fetchCatalog))
  );

  assert.strictEqual(upstreamCalls, 1);
  assert.strictEqual(results.length, 10);
  assert.deepStrictEqual(results[0], [{ id: 'result' }]);
}

/**
 * An empty stream list means the handshake failed this time (upstream 403s
 * intermittently). Caching it for the full stream TTL left the addon reporting
 * no streams for hours after a single transient failure.
 */
async function testEmptyStreamResultsAreNotCached() {
  const key = `empty-streams-${Date.now()}-${Math.random()}`;
  let calls = 0;
  const resolve = async () => {
    calls++;
    return { streams: [], cacheMaxAge: 21600 };
  };

  await cacheWrapStream(key, resolve);
  await cacheWrapStream(key, resolve);
  await cacheWrapStream(key, resolve);

  assert.strictEqual(calls, 3, 'a failed handshake must be retried, not cached');
}

async function testSuccessfulStreamResultsAreStillCached() {
  const key = `good-streams-${Date.now()}-${Math.random()}`;
  let calls = 0;
  const resolve = async () => {
    calls++;
    return { streams: [{ url: 'https://hanime.tv/hls/a.m3u8' }] };
  };

  await cacheWrapStream(key, resolve);
  await cacheWrapStream(key, resolve);

  assert.strictEqual(calls, 1, 'a real stream result should still be cached');
}

Promise.resolve()
  .then(testConcurrentMissesShareOneUpstreamRequest)
  .then(testEmptyStreamResultsAreNotCached)
  .then(testSuccessfulStreamResultsAreStillCached)
  .then(() => console.log('cache tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
