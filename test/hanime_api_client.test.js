const assert = require('assert');
const axios = require('axios');
const HanimeApiClient = require('../lib/clients/hanime_api_client');
const config = require('../lib/config');

const originalGet = axios.get;
const originalPost = axios.post;

async function testSearchUsesSearchHvsDataset() {
  const calls = [];
  const searchUrl = 'https://relay.example/api/v11/search_hvs';

  axios.get = async (url) => {
    calls.push(['get', url]);
    assert.strictEqual(url, searchUrl);

    return {
      status: 200,
      data: [
        {
          id: 1,
          name: 'Alpha Episode',
          search_titles: 'Alpha',
          slug: 'alpha-episode',
          description: '<p>first result</p>',
          brand: 'Queen Bee',
          tags: ['hd', 'anal'],
          views: 10,
          likes: 2,
          created_at_unix: 100,
          released_at_unix: 1000
        },
        {
          id: 2,
          name: 'Beta Episode',
          search_titles: 'Beta alternate',
          slug: 'beta-episode',
          description: '<p>matching description</p>',
          brand: 'Queen Bee',
          tags: ['hd', 'milf'],
          views: 50,
          likes: 5,
          created_at_unix: 200,
          released_at_unix: 900
        },
        {
          id: 3,
          name: 'Beta Other Studio',
          search_titles: 'Beta',
          slug: 'beta-other-studio',
          description: '<p>matching but wrong brand</p>',
          brand: 'Pink Pineapple',
          tags: ['hd'],
          views: 100,
          likes: 1,
          created_at_unix: 300,
          released_at_unix: 800
        }
      ]
    };
  };

  axios.post = async () => {
    throw new Error('search should use the current GET search_hvs endpoint');
  };

  const client = new HanimeApiClient({
    api: { searchUrl }
  });

  const results = await client.search({
    query: 'beta',
    tags: ['hd'],
    brands: ['Queen Bee'],
    orderBy: 'views',
    ordering: 'desc',
    page: 0
  });

  assert.deepStrictEqual(results.map(item => item.slug), ['beta-episode']);
  assert.deepStrictEqual(calls, [['get', searchUrl]]);
}

async function testVideoMetadataUsesSearchDatasetWithoutCallingRetiredEndpoint() {
  const requestedUrls = [];
  axios.get = async (url) => {
    requestedUrls.push(url);

    if (url.includes('/api/v8/video')) {
      throw new Error('Retired video metadata endpoint must not be requested');
    }

    return {
      status: 200,
      data: [{
        slug: 'test-video',
        name: 'Test Video',
        tags: ['hd', 'plot']
      }]
    };
  };

  const client = new HanimeApiClient(config);
  const result = await client.getVideoData('test-video');

  assert.strictEqual(result.hentai_video.slug, 'test-video');
  assert.deepStrictEqual(requestedUrls, [
    'https://guest.freeanimehentai.net/api/v11/search_hvs'
  ]);
}

async function testProductionSearchUsesAuthenticatedWorkerRelay() {
  const requests = [];
  axios.get = async (url, options) => {
    requests.push({ url, options });
    return { status: 200, data: [] };
  };

  const client = new HanimeApiClient({
    ...config,
    api: {
      ...config.api,
      searchUrl: 'https://relay.example/api/v11/search_hvs',
      htv: {
        ...config.api.htv,
        relaySecret: 'relay-secret'
      }
    }
  });
  await client.search({});

  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].url, 'https://relay.example/api/v11/search_hvs');
  assert.strictEqual(requests[0].options.headers.authorization, 'Bearer relay-secret');
  assert.strictEqual(requests[0].options.headers['x-signature-version'], 'app2');
  assert.ok(requests[0].options.headers['x-claim']);
  assert.ok(requests[0].options.headers['x-signature']);
}

async function testNormalizesLiveSearchDatasetEnvelope() {
  // The live /api/v11/search_hvs endpoint answers with
  // { data: [...], ads: {...} }; the previous parser only understood a bare
  // array / `hits`, so every catalog came back empty.
  const client = new HanimeApiClient({
    api: { searchPath: '/api/v11/search_hvs', searchHosts: ['primary.example'] }
  });

  assert.deepStrictEqual(
    client._normalizeSearchDataset({ data: [{ slug: 'a' }], ads: { nav: {} } }),
    [{ slug: 'a' }]
  );
  assert.deepStrictEqual(
    client._normalizeSearchDataset({ hits: '[{"slug":"b"}]' }),
    [{ slug: 'b' }]
  );
  assert.deepStrictEqual(client._normalizeSearchDataset({ hits: [{ slug: 'c' }] }), [{ slug: 'c' }]);
  assert.deepStrictEqual(client._normalizeSearchDataset({ hentai_videos: [{ slug: 'd' }] }), [{ slug: 'd' }]);
  assert.deepStrictEqual(client._normalizeSearchDataset({ data: 'not json' }), []);
  assert.deepStrictEqual(client._normalizeSearchDataset(null), []);
}

async function testSearchFallsBackAcrossHostsWhenOneIsBlocked() {
  const attempts = [];
  axios.get = async (url) => {
    attempts.push(url);
    if (url.includes('blocked.example')) {
      return { status: 403, data: '<html>challenge</html>' };
    }
    return { status: 200, data: { data: [{ slug: 'ok' }] } };
  };

  const client = new HanimeApiClient({
    api: {
      searchPath: '/api/v11/search_hvs',
      searchHosts: ['blocked.example', 'working.example'],
      htv: { maxHostAttempts: 4, timeoutMs: 1000 }
    }
  });

  const dataset = await client._fetchSearchDataset(Date.now());

  assert.deepStrictEqual(dataset, [{ slug: 'ok' }]);
  assert.deepStrictEqual(attempts, [
    'https://blocked.example/api/v11/search_hvs',
    'https://working.example/api/v11/search_hvs'
  ]);
}

async function testSearchKeepsLastGoodDatasetWhenEveryHostFails() {
  const client = new HanimeApiClient({
    api: {
      searchPath: '/api/v11/search_hvs',
      searchHosts: ['blocked.example'],
      htv: { maxHostAttempts: 2, timeoutMs: 1000 }
    }
  });

  client.searchDatasetCache = { data: [{ slug: 'cached' }], fetchedAt: 0 };

  axios.get = async () => ({ status: 403, data: '<html>challenge</html>' });

  const dataset = await client._fetchSearchDataset(Date.now());
  assert.deepStrictEqual(dataset, [{ slug: 'cached' }]);
}

async function testVideoMetadataNormalizesSearchDatasetFields() {
  axios.get = async (url) => {
    if (url.includes('/api/v11/search_hvs')) {
      return {
        status: 200,
        data: [{
          slug: 'dataset-video',
          name: 'Dataset Video',
          tags: ['hd', 'plot'],
          description: '<p>Dataset description</p>'
        }]
      };
    }
    throw new Error(`Unexpected GET ${url}`);
  };

  const client = new HanimeApiClient(config);
  const result = await client.getVideoData('dataset-video');

  assert.strictEqual(result.hentai_video.slug, 'dataset-video');
  assert.strictEqual(result.hentai_video.duration_in_ms, 20 * 60 * 1000);
  assert.deepStrictEqual(result.hentai_video.hentai_tags, [
    { text: 'hd' },
    { text: 'plot' }
  ]);
}

function testSearchDatasetCacheWindowIsSixHours() {
  const client = new HanimeApiClient(config);
  assert.strictEqual(client.searchDatasetTtlMs, 6 * 60 * 60 * 1000);
}

async function main() {
  try {
    await testSearchUsesSearchHvsDataset();
    await testVideoMetadataUsesSearchDatasetWithoutCallingRetiredEndpoint();
    await testProductionSearchUsesAuthenticatedWorkerRelay();
    await testNormalizesLiveSearchDatasetEnvelope();
    await testSearchFallsBackAcrossHostsWhenOneIsBlocked();
    await testSearchKeepsLastGoodDatasetWhenEveryHostFails();
    await testVideoMetadataNormalizesSearchDatasetFields();
    testSearchDatasetCacheWindowIsSixHours();
  } finally {
    axios.get = originalGet;
    axios.post = originalPost;
  }
}

main()
  .then(() => {
    console.log('hanime_api_client tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
