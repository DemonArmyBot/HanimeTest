const assert = require('assert');
const axios = require('axios');
const HanimeUserApi = require('../lib/clients/hanime_user_api_client');
const UserApiManager = require('../lib/clients/user_api_manager');

const originalPost = axios.post;

const TEST_CONFIG = {
  api: {
    htv: {
      authPath: '/rapi/v7/sessions',
      authHosts: ['primary.example', 'secondary.example'],
      maxHostAttempts: 4,
      timeoutMs: 1000,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) test'
    }
  }
};

async function testLoginSendsBrowserHeadersAndApp2Signature() {
  let request;
  axios.post = async (url, body, options) => {
    request = { url, body, options };
    return {
      status: 200,
      data: {
        session_token: 'token-123',
        session_token_expire_time_unix: 4102444800,
        user: {
          id: 42,
          email: 'user@example.com',
          name: 'viewer',
          slug: 'viewer-1',
          coins: 10,
          is_able_to_access_premium: true,
          bt_premium_status: 'Active'
        }
      }
    };
  };

  const api = new HanimeUserApi(null, 'user@example.com', 'secret', null, TEST_CONFIG);
  const result = await api.login('user@example.com', 'secret');

  assert.strictEqual(request.url, 'https://primary.example/rapi/v7/sessions');
  assert.deepStrictEqual(request.body, { email: 'user@example.com', password: 'secret' });
  // Cloudflare answers 403 to requests that don't look like hanime.tv's own.
  assert.strictEqual(request.options.headers.origin, 'https://hanime.tv');
  assert.strictEqual(request.options.headers.referer, 'https://hanime.tv/');
  assert.ok(request.options.headers['user-agent']);
  assert.strictEqual(request.options.headers['x-signature-version'], 'app2');
  assert.ok(request.options.headers['x-claim']);
  assert.ok(request.options.headers['x-signature']);
  // Status must be inspected by the caller (validateStatus accepts anything),
  // otherwise a Cloudflare HTML 403 surfaces as a JSON parse error.
  assert.strictEqual(request.options.validateStatus(403), true);

  assert.strictEqual(result.sessionToken, 'token-123');
  assert.strictEqual(result.sessionTokenExpireTimeUnix, 4102444800);
  assert.strictEqual(result.user.isPremium, true);
  assert.strictEqual(result.user.name, 'viewer');
  assert.strictEqual(api.getSessionToken(), 'token-123');
  assert.strictEqual(api.isPremium, true);
  assert.ok(api.isLoggedIn());
}

async function testLoginRetriesNextHostWhenFirstIsCloudflareBlocked() {
  const attempts = [];
  axios.post = async (url) => {
    attempts.push(url);
    if (url.includes('primary.example')) {
      // Cloudflare challenge: an HTML body, not JSON.
      return {
        status: 403,
        headers: { 'content-type': 'text/html; charset=UTF-8' },
        data: { _nonJsonBody: '<html>Just a moment...</html>' }
      };
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: { session_token: 'token-abc', session_token_expire_time_unix: 4102444800, user: { id: 1 } }
    };
  };

  const api = new HanimeUserApi(null, 'user@example.com', 'secret', null, TEST_CONFIG);
  const result = await api.login('user@example.com', 'secret');

  assert.strictEqual(result.sessionToken, 'token-abc');
  assert.deepStrictEqual(attempts, [
    'https://primary.example/rapi/v7/sessions',
    'https://secondary.example/rapi/v7/sessions'
  ]);
}

async function testLoginReportsBlockDistinctlyFromBadCredentials() {
  axios.post = async () => ({
    status: 403,
    headers: { 'content-type': 'text/html; charset=UTF-8' },
    data: { _nonJsonBody: '<html>Just a moment...</html>' }
  });

  const api = new HanimeUserApi(null, 'user@example.com', 'secret', null, TEST_CONFIG);

  await assert.rejects(
    () => api.login('user@example.com', 'secret'),
    (error) => {
      assert.strictEqual(error.blocked, true);
      assert.match(error.message, /Cloudflare/);
      return true;
    }
  );
}

async function testLoginSurfacesApiErrorWithoutRotatingHosts() {
  const attempts = [];
  axios.post = async (url) => {
    attempts.push(url);
    return {
      status: 422,
      headers: { 'content-type': 'application/json' },
      data: { errors: ['Invalid credentials'] }
    };
  };

  const api = new HanimeUserApi(null, 'user@example.com', 'secret', null, TEST_CONFIG);

  await assert.rejects(
    () => api.login('user@example.com', 'secret'),
    (error) => {
      assert.strictEqual(error.blocked, false);
      assert.strictEqual(error.message, 'Invalid credentials');
      return true;
    }
  );
  // A wrong password is not host-specific, so the other host isn't tried.
  assert.strictEqual(attempts.length, 1);
}

async function testLoginRejectsResponseWithoutSessionToken() {
  const attempts = [];
  axios.post = async (url) => {
    attempts.push(url);
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: { user: { id: 1 } }
    };
  };

  const api = new HanimeUserApi(null, 'user@example.com', 'secret', null, TEST_CONFIG);

  await assert.rejects(() => api.login('user@example.com', 'secret'), /session token/);
  assert.strictEqual(attempts.length, 2);
}

async function testLoginTreatsNonJsonBodyAsBlocked() {
  // A Cloudflare 403 whose body is not JSON must still be classified as a
  // block rather than surfacing a JSON parse error.
  axios.post = async () => ({
    status: 403,
    headers: { 'content-type': 'application/octet-stream' },
    data: { _nonJsonBody: 'not json' }
  });

  const api = new HanimeUserApi(null, 'user@example.com', 'secret', null, TEST_CONFIG);

  await assert.rejects(
    () => api.login('user@example.com', 'secret'),
    (error) => error.blocked === true
  );
}

async function testManagerCachesSessionAndSkipsRepeatLogin() {
  let loginCalls = 0;
  axios.post = async () => {
    loginCalls++;
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: {
        session_token: 'cached-token',
        session_token_expire_time_unix: Math.floor(Date.now() / 1000) + 3600,
        user: { id: 7, name: 'viewer', is_able_to_access_premium: false }
      }
    };
  };

  process.env.CACHE_ENABLED = 'true';
  const manager = new UserApiManager();

  const first = await manager.getUserApi('user@example.com', 'secret');
  const second = await manager.getUserApi('user@example.com', 'secret');

  assert.strictEqual(loginCalls, 1);
  assert.strictEqual(first.getSessionToken(), 'cached-token');
  // The cached session is rebuilt into a client, so the token must survive.
  assert.strictEqual(second.getSessionToken(), 'cached-token');
  assert.strictEqual(second.isPremium, false);
}

async function testConcurrentLoginsShareOneUpstreamRequest() {
  let loginCalls = 0;
  axios.post = async () => {
    loginCalls++;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: {
        session_token: 'shared-token',
        session_token_expire_time_unix: Math.floor(Date.now() / 1000) + 3600,
        user: { id: 9, name: 'viewer' }
      }
    };
  };

  const manager = new UserApiManager();
  const results = await Promise.all([
    manager.getUserApi('user@example.com', 'secret'),
    manager.getUserApi('user@example.com', 'secret'),
    manager.getUserApi('user@example.com', 'secret')
  ]);

  assert.strictEqual(loginCalls, 1);
  assert.ok(results.every((api) => api.getSessionToken() === 'shared-token'));
}

async function testCamelCaseConversionHandlesNestedPayloads() {
  const { convertToCamelCase } = HanimeUserApi;

  assert.deepStrictEqual(
    convertToCamelCase({
      session_token: 'a',
      session_token_expire_time_unix: 1,
      user: { is_able_to_access_premium: true, avatar_url: 'x' },
      playlists: [{ playlist_id: 3 }]
    }),
    {
      sessionToken: 'a',
      sessionTokenExpireTimeUnix: 1,
      user: { isAbleToAccessPremium: true, avatarUrl: 'x' },
      playlists: [{ playlistId: 3 }]
    }
  );
}

async function run() {
  try {
    await testLoginSendsBrowserHeadersAndApp2Signature();
    await testLoginRetriesNextHostWhenFirstIsCloudflareBlocked();
    await testLoginReportsBlockDistinctlyFromBadCredentials();
    await testLoginSurfacesApiErrorWithoutRotatingHosts();
    await testLoginRejectsResponseWithoutSessionToken();
    await testLoginTreatsNonJsonBodyAsBlocked();
    await testManagerCachesSessionAndSkipsRepeatLogin();
    await testConcurrentLoginsShareOneUpstreamRequest();
    await testCamelCaseConversionHandlesNestedPayloads();
    console.log('hanime_user_api_client tests passed');
  } finally {
    axios.post = originalPost;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});