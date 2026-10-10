const assert = require('assert');
const axios = require('axios');
const CfBypassClient = require('../lib/services/cf_bypass_client');
const signatureService = require('../lib/services/htv_signature_service');
const { sealMessage } = require('../lib/services/htv_stream_resolver');

const originalPost = axios.post;
const originalGetSignature = signatureService.getSignature;

const CF_CONFIG = {
  api: { htv: { handshakeHosts: ['hanime.test'], timeoutMs: 2000 } },
  cfBypass: { url: 'http://solver.local', token: 'secret-token', ttlMs: 60000, timeoutMs: 5000 }
};

/**
 * Drive the handshake against stubbed axios, faking a Cloudflare challenge
 * until a clearance cookie is presented.
 * @param {Object} plan - { solveWorks: boolean }
 * @returns {Promise<Object>} Observed behaviour
 */
async function runHandshake(plan) {
  const seen = [];
  let solveCalls = 0;

  signatureService.getSignature = async () => ({ signature: 'sig', time: 1 });

  axios.post = async (url, body, opts) => {
    // Solver endpoint.
    if (String(url).includes('/cloudflare')) {
      solveCalls++;
      return {
        status: 200,
        data: {
          cf_clearance: plan.solveWorks ? 'CLEARED' : null,
          user_agent: 'Mozilla/5.0 (Solved UA)'
        }
      };
    }

    seen.push({ url, cookie: opts.headers.cookie || null, ua: opts.headers['user-agent'] });

    const challenged = !opts.headers.cookie;
    if (challenged) {
      return {
        status: 403,
        headers: { 'cf-mitigated': 'challenge' },
        data: '<html><title>Just a moment...</title></html>'
      };
    }

    return {
      status: 200,
      headers: {
        'x-token': sealMessage({
          sources: [{ src: '/hls/after-solve-720', height: 720, kind: 'normal' }]
        })
      },
      data: {}
    };
  };

  const HtvStreamResolver = require('../lib/services/htv_stream_resolver');
  const resolver = new HtvStreamResolver({
    api: { htv: { handshakePath: '/api/v11/handshake', handshakeHosts: ['hanime.test'], timeoutMs: 2000, maxHostAttempts: 2 } },
    cfBypass: CF_CONFIG.cfBypass
  });

  const streams = await resolver.resolveStreams('test-video');
  return { streams, seen, solveCalls };
}

async function testSolvesChallengeAndRetries() {
  const { streams, seen, solveCalls } = await runHandshake({ solveWorks: true });

  assert.strictEqual(solveCalls, 1, 'the solver should be consulted once');
  assert.strictEqual(streams.length, 1, 'a stream should resolve after solving');

  // First attempt has no cookie, second carries the clearance.
  assert.strictEqual(seen[0].cookie, null, 'first attempt must go out unsolved');
  assert.strictEqual(seen[1].cookie, 'cf_clearance=CLEARED',
    'retry must carry the solved cookie');
  assert.strictEqual(streams[0].url, 'https://hanime.tv/hls/after-solve-720');
}

async function testSendsTheSolverUserAgentWithTheCookie() {
  const { seen } = await runHandshake({ solveWorks: true });

  // cf_clearance is paired with the UA that solved it; sending a different one
  // invalidates the cookie.
  assert.strictEqual(seen[1].ua, 'Mozilla/5.0 (Solved UA)');
}

async function testDoesNotLoopWhenSolverReturnsNothing() {
  const { seen, solveCalls } = await runHandshake({ solveWorks: false });

  assert.strictEqual(solveCalls, 1, 'a failed solve must not be retried endlessly');
  // One unsolved attempt per host, plus the one post-solve retry attempt.
  assert.ok(seen.length <= 4, `expected a bounded number of attempts, got ${seen.length}`);
}

async function testDisabledSolverLeavesRequestsUntouched() {
  signatureService.getSignature = async () => ({ signature: 'sig', time: 1 });
  const seen = [];
  axios.post = async (url, body, opts) => {
    seen.push(opts.headers.cookie || null);
    return { status: 403, headers: { 'cf-mitigated': 'challenge' }, data: '<html>Just a moment</html>' };
  };

  const HtvStreamResolver = require('../lib/services/htv_stream_resolver');
  const resolver = new HtvStreamResolver({
    api: { htv: { handshakePath: '/api/v11/handshake', handshakeHosts: ['hanime.test'], timeoutMs: 2000, maxHostAttempts: 2 } }
  });

  const streams = await resolver.resolveStreams('test-video');

  assert.deepStrictEqual(streams, []);
  assert.ok(seen.every((c) => c === null), 'no cookie should be sent without a solver');
}

async function testClientCachesSolutionPerDomain() {
  const axiosPath = require.resolve('axios');
  const C = require('../lib/services/cf_bypass_client');
  const client = new C(CF_CONFIG);

  let solves = 0;
  axios.post = async () => {
    solves++;
    return { status: 200, data: { cf_clearance: 'C', user_agent: 'UA' } };
  };

  const first = await client.solve('https://hanime.tv');
  const second = await client.solve('https://hanime.tv');

  assert.strictEqual(solves, 1, 'a solved challenge must be reused, not re-solved');
  assert.strictEqual(first.cookie, 'cf_clearance=C');
  assert.strictEqual(second.cookie, 'cf_clearance=C');

  // force=true is how a challenge triggers a re-solve.
  await client.solve('https://hanime.tv', true);
  assert.strictEqual(solves, 2, 'a forced solve must actually re-solve');

  // A different domain is solved separately.
  await client.solve('https://auth.hanime.tv');
  assert.strictEqual(solves, 3);

  axios.post = originalPost;
}

async function testChallengeDetection() {
  const C = require('../lib/services/cf_bypass_client');
  const client = new C(CF_CONFIG);

  assert.strictEqual(client.isChallenge({
    status: 403, headers: { 'cf-mitigated': 'challenge' }, data: ''
  }), true);

  assert.strictEqual(client.isChallenge({
    status: 403, headers: {}, data: Buffer.from('<html>Just a moment...</html>')
  }), true, 'the interstitial must be recognised even without the header');

  assert.strictEqual(client.isChallenge({
    status: 200, headers: {}, data: Buffer.from('#EXTM3U')
  }), false);

  assert.strictEqual(client.isChallenge({
    status: 403, headers: {}, data: { errors: ['Invalid credentials'] }
  }), false, 'a JSON API error is not a challenge');
}

function testOriginExtraction() {
  const { originOf } = require('../lib/services/cf_bypass_client');
  assert.strictEqual(originOf('https://hanime.tv/hls/a/b?x=1'), 'https://hanime.tv');
  assert.strictEqual(originOf('not a url'), null);
}

async function run() {
  await testSolvesChallengeAndRetries();
  await testSendsTheSolverUserAgentWithTheCookie();
  await testDoesNotLoopWhenSolverReturnsNothing();
  await testDisabledSolverLeavesRequestsUntouched();
  await testClientCachesSolutionPerDomain();
  await testChallengeDetection();
  testOriginExtraction();
  console.log('cf_bypass_client tests passed');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    axios.post = originalPost;
    signatureService.getSignature = originalGetSignature;
  });