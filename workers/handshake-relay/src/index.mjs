const RELAY_PATH = '/api/v11/handshake';
const SEARCH_PATH = '/api/v11/search_hvs';
const LOGIN_PATH = '/rapi/v7/sessions';
const UPSTREAM_URL = 'https://auth.hanime.tv/api/v11/handshake';
const SEARCH_UPSTREAM_URL = 'https://guest.freeanimehentai.net/api/v11/search_hvs';
const LOGIN_UPSTREAM_URL = 'https://www.universal-cdn.com/rapi/v7/sessions';
const MAX_BODY_BYTES = 16 * 1024;
const FORWARDED_REQUEST_HEADERS = [
  'x-signature',
  'x-signature-version',
  'x-claim',
  'x-time',
  'x-session-token'
];
const ROUTES = {
  [RELAY_PATH]: { method: 'POST', upstream: UPSTREAM_URL, body: true },
  [SEARCH_PATH]: { method: 'GET', upstream: SEARCH_UPSTREAM_URL, body: false },
  [LOGIN_PATH]: { method: 'POST', upstream: LOGIN_UPSTREAM_URL, body: true }
};

async function secretsEqual(actual, expected) {
  if (!actual || !expected) return false;

  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(actual)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected))
  ]);
  const actualBytes = new Uint8Array(actualHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < actualBytes.length; index++) {
    difference |= actualBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}

function jsonResponse(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

export function createRelay({ fetchImpl = fetch } = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const route = ROUTES[url.pathname];
      if (!route) {
        return jsonResponse(404, 'Not found');
      }
      if (request.method !== route.method) {
        return jsonResponse(405, 'Method not allowed');
      }

      const authorized = await secretsEqual(
        request.headers.get('authorization'),
        env.RELAY_SECRET && `Bearer ${env.RELAY_SECRET}`
      );
      if (!authorized) {
        return jsonResponse(401, 'Unauthorized');
      }
      let body;
      if (route.body) {
        if (!request.headers.get('content-type')?.startsWith('application/json')) {
          return jsonResponse(415, 'JSON body required');
        }
        body = await request.arrayBuffer();
        if (body.byteLength > MAX_BODY_BYTES) {
          return jsonResponse(413, 'Request body too large');
        }
      }

      const headers = new Headers({
        accept: 'application/json',
        'content-type': 'application/json',
        'accept-language': 'en-US,en;q=0.9',
        origin: 'https://hanime.tv',
        referer: 'https://hanime.tv/',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
      });
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }

      let upstream;
      try {
        upstream = await fetchImpl(new Request(route.upstream, {
          method: route.method,
          headers,
          body: route.body ? body : undefined
        }));
      } catch (_) {
        return jsonResponse(502, 'Upstream unavailable');
      }

      const contentType = upstream.headers.get('content-type') || 'application/json';
      const responseHeaders = new Headers({
        'cache-control': 'no-store',
        'content-type': contentType
      });
      const token = upstream.headers.get('x-token');
      if (token) responseHeaders.set('x-token', token);

      // Hanime answers a Cloudflare-challenged request with an HTML page and a
      // 403. Forwarding that body verbatim makes the addon report a JSON parse
      // error instead of a block, so translate it into a recognizable status.
      if (contentType.includes('text/html') && upstream.status === 403) {
        return jsonResponse(403, 'Upstream blocked (Cloudflare challenge)');
      }

      return new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders
      });
    }
  };
}

export default createRelay();