const assert = require('assert');

async function loadWorker() {
  return import('../workers/handshake-relay/src/index.mjs');
}

async function testRejectsUnauthorizedRequests() {
  const { createRelay } = await loadWorker();
  let upstreamCalls = 0;
  const relay = createRelay({
    fetchImpl: async () => {
      upstreamCalls++;
      return new Response('unexpected');
    }
  });

  const response = await relay.fetch(
    new Request('https://relay.example/api/v11/handshake', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' }
    }),
    { RELAY_SECRET: 'expected-secret' }
  );

  assert.strictEqual(response.status, 401);
  assert.strictEqual(upstreamCalls, 0);
}

async function testRejectsNonHandshakeRoutes() {
  const { createRelay } = await loadWorker();
  let upstreamCalls = 0;
  const relay = createRelay({
    fetchImpl: async () => {
      upstreamCalls++;
      return new Response('unexpected');
    }
  });

  const response = await relay.fetch(
    new Request('https://relay.example/anything', {
      headers: { authorization: 'Bearer expected-secret' }
    }),
    { RELAY_SECRET: 'expected-secret' }
  );

  assert.strictEqual(response.status, 404);
  assert.strictEqual(upstreamCalls, 0);
}

async function testForwardsHandshakeAndPreservesToken() {
  const { createRelay } = await loadWorker();
  let upstreamRequest;
  const relay = createRelay({
    fetchImpl: async (request) => {
      upstreamRequest = request;
      return new Response('{"status":"OK"}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-token': 'sealed-stream-sources'
        }
      });
    }
  });

  const response = await relay.fetch(
    new Request('https://relay.example/api/v11/handshake', {
      method: 'POST',
      body: '{"token":"sealed-request"}',
      headers: {
        authorization: 'Bearer expected-secret',
        'content-type': 'application/json',
        'x-signature': 'signature',
        'x-signature-version': 'web2',
        'x-time': '123',
        'x-session-token': 'session',
        'x-untrusted-header': 'must-not-forward'
      }
    }),
    { RELAY_SECRET: 'expected-secret' }
  );

  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.headers.get('x-token'), 'sealed-stream-sources');
  assert.strictEqual(upstreamRequest.url, 'https://auth.hanime.tv/api/v11/handshake');
  assert.strictEqual(upstreamRequest.method, 'POST');
  assert.strictEqual(upstreamRequest.headers.get('x-signature'), 'signature');
  assert.strictEqual(upstreamRequest.headers.get('x-session-token'), 'session');
  assert.strictEqual(upstreamRequest.headers.get('authorization'), null);
  assert.strictEqual(upstreamRequest.headers.get('x-untrusted-header'), null);
  assert.deepStrictEqual(await upstreamRequest.json(), { token: 'sealed-request' });
}

async function testForwardsSignedSearchDatasetRequest() {
  const { createRelay } = await loadWorker();
  let upstreamRequest;
  const relay = createRelay({
    fetchImpl: async (request) => {
      upstreamRequest = request;
      return new Response('[{"slug":"test-video"}]', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const response = await relay.fetch(
    new Request('https://relay.example/api/v11/search_hvs', {
      headers: {
        authorization: 'Bearer expected-secret',
        'x-claim': '123',
        'x-signature': 'signature',
        'x-signature-version': 'app2',
        'x-session-token': '',
        'x-untrusted-header': 'must-not-forward'
      }
    }),
    { RELAY_SECRET: 'expected-secret' }
  );

  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(await response.json(), [{ slug: 'test-video' }]);
  assert.strictEqual(
    upstreamRequest.url,
    'https://guest.freeanimehentai.net/api/v11/search_hvs'
  );
  assert.strictEqual(upstreamRequest.method, 'GET');
  assert.strictEqual(upstreamRequest.headers.get('x-claim'), '123');
  assert.strictEqual(upstreamRequest.headers.get('x-signature'), 'signature');
  assert.strictEqual(upstreamRequest.headers.get('authorization'), null);
  assert.strictEqual(upstreamRequest.headers.get('x-untrusted-header'), null);
}

async function testForwardsLoginRequestWithBrowserHeaders() {
  const { createRelay } = await loadWorker();
  let upstreamRequest;
  const relay = createRelay({
    fetchImpl: async (request) => {
      upstreamRequest = request;
      return new Response('{"session_token":"token"}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const response = await relay.fetch(
    new Request('https://relay.example/rapi/v7/sessions', {
      method: 'POST',
      body: '{"email":"user@example.com","password":"secret"}',
      headers: {
        authorization: 'Bearer expected-secret',
        'content-type': 'application/json',
        'x-claim': '123',
        'x-signature': 'signature',
        'x-signature-version': 'app2',
        'x-untrusted-header': 'must-not-forward'
      }
    }),
    { RELAY_SECRET: 'expected-secret' }
  );

  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(await response.json(), { session_token: 'token' });
  assert.strictEqual(
    upstreamRequest.url,
    'https://www.universal-cdn.com/rapi/v7/sessions'
  );
  assert.strictEqual(upstreamRequest.method, 'POST');
  // Cloudflare rejects requests that don't look like they came from the site,
  // so the relay supplies the browser headers hanime expects.
  assert.ok(upstreamRequest.headers.get('user-agent'));
  assert.strictEqual(upstreamRequest.headers.get('origin'), 'https://hanime.tv');
  assert.strictEqual(upstreamRequest.headers.get('referer'), 'https://hanime.tv/');
  assert.strictEqual(upstreamRequest.headers.get('x-signature'), 'signature');
  assert.strictEqual(upstreamRequest.headers.get('authorization'), null);
  assert.strictEqual(upstreamRequest.headers.get('x-untrusted-header'), null);
}

async function testTranslatesCloudflareHtmlChallengeIntoJsonError() {
  const { createRelay } = await loadWorker();
  const relay = createRelay({
    fetchImpl: async () => new Response('<!DOCTYPE html><title>Just a moment...</title>', {
      status: 403,
      headers: { 'content-type': 'text/html; charset=UTF-8' }
    })
  });

  const response = await relay.fetch(
    new Request('https://relay.example/api/v11/handshake', {
      method: 'POST',
      body: '{}',
      headers: {
        authorization: 'Bearer expected-secret',
        'content-type': 'application/json'
      }
    }),
    { RELAY_SECRET: 'expected-secret' }
  );

  // Without this the addon sees an HTML body and reports a JSON parse error
  // instead of recognising a Cloudflare block.
  assert.strictEqual(response.status, 403);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.deepStrictEqual(await response.json(), {
    error: 'Upstream blocked (Cloudflare challenge)'
  });
}

async function testRejectsLoginRouteWithWrongMethod() {
  const { createRelay } = await loadWorker();
  let upstreamCalls = 0;
  const relay = createRelay({
    fetchImpl: async () => {
      upstreamCalls++;
      return new Response('unexpected');
    }
  });

  const response = await relay.fetch(
    new Request('https://relay.example/rapi/v7/sessions', {
      method: 'GET',
      headers: { authorization: 'Bearer expected-secret' }
    }),
    { RELAY_SECRET: 'expected-secret' }
  );

  assert.strictEqual(response.status, 405);
  assert.strictEqual(upstreamCalls, 0);
}

async function testRejectsOversizedLoginBody() {
  const { createRelay } = await loadWorker();
  let upstreamCalls = 0;
  const relay = createRelay({
    fetchImpl: async () => {
      upstreamCalls++;
      return new Response('unexpected');
    }
  });

  const response = await relay.fetch(
    new Request('https://relay.example/rapi/v7/sessions', {
      method: 'POST',
      body: JSON.stringify({ email: 'a'.repeat(20000) }),
      headers: {
        authorization: 'Bearer expected-secret',
        'content-type': 'application/json'
      }
    }),
    { RELAY_SECRET: 'expected-secret' }
  );

  assert.strictEqual(response.status, 413);
  assert.strictEqual(upstreamCalls, 0);
}

async function testReturnsBadGatewayWhenUpstreamFails() {
  const { createRelay } = await loadWorker();
  const relay = createRelay({
    fetchImpl: async () => {
      throw new Error('upstream unavailable');
    }
  });

  const response = await relay.fetch(
    new Request('https://relay.example/api/v11/handshake', {
      method: 'POST',
      body: '{}',
      headers: {
        authorization: 'Bearer expected-secret',
        'content-type': 'application/json'
      }
    }),
    { RELAY_SECRET: 'expected-secret' }
  );

  assert.strictEqual(response.status, 502);
  assert.deepStrictEqual(await response.json(), { error: 'Upstream unavailable' });
}

async function run() {
  await testRejectsUnauthorizedRequests();
  await testRejectsNonHandshakeRoutes();
  await testForwardsHandshakeAndPreservesToken();
  await testForwardsSignedSearchDatasetRequest();
  await testForwardsLoginRequestWithBrowserHeaders();
  await testTranslatesCloudflareHtmlChallengeIntoJsonError();
  await testRejectsLoginRouteWithWrongMethod();
  await testRejectsOversizedLoginBody();
  await testReturnsBadGatewayWhenUpstreamFails();
  console.log('worker relay tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
