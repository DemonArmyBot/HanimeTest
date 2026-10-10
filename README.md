# Hanime Stremio Addon

A self-hosted [Stremio](https://www.stremio.com/) addon for browsing and streaming Hanime.tv — catalogue browsing, search, genre and studio filters, series grouping, an uncensored catalogue, and authenticated playback.

```
 _   _              _ _
| | | | ___  __ _ _(_) |_ ___
| |_| |/ _ \/ _` | | | __/ __|
|  _  |  __/ (_| | | | || (__
|_| |_|\___|\__, |_|_|\__\___|
```

---

## Table of contents

- [Quick start](#quick-start)
- [Installing in Stremio](#installing-in-stremio)
- [Configuration](#configuration)
  - [Required](#required)
  - [Recommended for streaming](#recommended-for-streaming)
  - [Commonly tuned](#commonly-tuned)
  - [Everything else](#everything-else)
- [Deploying](#deploying)
- [Troubleshooting playback](#troubleshooting-playback)
- [How it works](#how-it-works)
- [Development](#development)

---

## Quick start

### Option A — `run.py` (easiest)

Needs [Python 3.7+](https://python.org) and [Node.js 20+](https://nodejs.org). Nothing else.

```bash
python run.py
```

The launcher checks your toolchain, installs npm dependencies on first run, runs the bundled self-check, validates your settings, then starts the server and prints the URL to paste into Stremio.

```bash
python run.py --check          # validate setup without starting
python run.py --port 7000      # override the port
python run.py --install        # force a fresh npm install
python run.py --help           # all options
```

Put settings in a `.env` file next to `run.py` (see [`.env.example`](.env.example)) and they are picked up automatically.

### Option B — Docker Compose

```bash
cp .env.example .env      # optional but recommended
docker compose up -d
```

### Option C — Node.js directly

```bash
npm install
npm start
```

---

## Installing in Stremio

1. Open Stremio → **Addons** → **Community Addons**
2. Paste your addon URL:
   - `http://localhost:61327/manifest.json` when running locally
   - `https://your-deployment.example/manifest.json` when deployed
3. Click **Install**
4. Click **Configure** and enter your Hanime email and password

> **Configuration is optional.** Guest playback works without it. Config only
> unlocks premium (1080p) qualities for a premium account.

---

## Configuration

Configuration is entirely through environment variables. Nothing is stored on
disk except whatever you put in `.env`.

### Required

Only one variable is genuinely required, and only for deployed instances.

| Variable | Why | Example |
|---|---|---|
| `PUBLIC_URL` | Used to build manifest asset URLs (logo, icons) and — when the stream proxy is on — the URLs your player follows. **Required in practice for any deployment.** A bare hostname is accepted; `https://` is added for you. | `https://hanime-addon.up.railway.app` |

Running locally you can skip it entirely and use `http://localhost:61327`.

### Recommended for streaming

If streams show up in Stremio but do not play, you almost certainly need these two.

| Variable | Default | Why |
|---|---|---|
| `STREAM_PROXY_ENABLED` | `false` | Routes playback through your server so the player's own IP never reaches Hanime. **This is the fix for "streams won't play".** |
| `CACHE_TTL_STREAM` | `21600` (6h) | Lower this to `1800` when the proxy is on. Cached stream entries are *signed* HLS URLs that expire; a 6-hour cache outlives them and playback starts failing. |

```bash
PUBLIC_URL=https://your-app.up.railway.app
STREAM_PROXY_ENABLED=true
CACHE_TTL_STREAM=1800
```

### Commonly tuned

| Variable | Default | Description |
|---|---|---|
| `PORT` | `61327` | Port to listen on |
| `LOG_LEVEL` | `debug` | `debug`, `info`, `warn`, `error`, `silent`. Use `info` in production. |
| `CACHE_ENABLED` | `true` | In-memory caching |
| `CACHE_REDIS_URL` | – | Redis URL. Optional, but with multiple instances this keeps the cache shared instead of per-instance. |
| `TRUST_PROXY` | `1` | Proxy hops to trust. Correct behind Railway/nginx/Cloudflare. Set `false` when exposed directly. |
| `RATE_LIMIT_ENABLED` | `true` | Per-IP request limiting |
| `SLOW_DOWN_ENABLED` | `true` | Gradual slow-down before the hard limit |
| `STREAM_PROXY_SECRET` | random per boot | Signs proxy URLs. Set a fixed value so links survive a restart. |
| `ADDON_NAME` | `Hanime` | Display name in Stremio |

### Everything else

<details>
<summary>Advanced variables (69 total)</summary>

**Upstream hosts and Cloudflare**

| Variable | Default |
|---|---|
| `HTV_SEARCH_HOSTS` | `guest.freeanimehentai.net,hanime.tv,auth.hanime.tv,www.hanime.tv` |
| `HTV_HANDSHAKE_HOSTS` | `auth.hanime.tv,hanime.tv,www.hanime.tv,guest.freeanimehentai.net` |
| `HTV_AUTH_HOSTS` | `www.universal-cdn.com,auth.hanime.tv,hanime.tv` |
| `HTV_MAX_HOST_ATTEMPTS` | `4` |
| `HTV_SEARCH_URL` / `HTV_HANDSHAKE_URL` / `HTV_AUTH_URL` | – (relay overrides the host lists) |
| `HTV_RELAY_SECRET` | – |

**Cloudflare challenge solver** (only needed if the *handshake* starts failing)

| Variable | Default |
|---|---|
| `CF_BYPASS_URL` | – |
| `CF_BYPASS_TOKEN` | – |
| `CF_BYPASS_TTL_MS` | `600000` |
| `CF_BYPASS_TIMEOUT_MS` | `90000` |

**Outbound proxy** (for IP-reputation blocks; *not* for the JS challenge)

| Variable | Default |
|---|---|
| `HTV_PROXY_URL` / `HANIME_PROXY_URL` | – |
| `HTTPS_PROXY` / `HTTP_PROXY` | – (honoured by axios, but also routes images) |

**Player-side headers**

| Variable | Default |
|---|---|
| `HTV_PLAYER_HEADER_MODE` | `proxyHeaders` (`pipe` for ExoPlayer/MPV forks only) |
| `HTV_PLAYER_USER_AGENT` | mobile Chrome |
| `HTV_PLAYER_REFERER` | `https://hanime.tv/` |
| `HTV_PLAYER_ORIGIN` | `https://hanime.tv` |

**Stream proxy**

| Variable | Default |
|---|---|
| `STREAM_PROXY_PATH` | `/proxy/stream` |
| `STREAM_PROXY_TIMEOUT_MS` | `20000` |
| `STREAM_PROXY_MAX_BODY_MB` | `64` |
| `STREAM_PROXY_MANIFEST_TTL` | `30` |
| `STREAM_PROXY_ALLOWED_HOSTS` | – |

**Cache TTLs**

`CACHE_TTL_STREAM`, `CACHE_TTL_CATALOG`, `CACHE_TTL_META`, `CACHE_TTL_SEARCH_DATASET`, `CACHE_TTL_IMAGE`, `CACHE_MAX_SIZE`, `CACHE_BROWSER_CACHE`

**Rate limiting / slow-down**

`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_IMAGE_MAX`, `RATE_LIMIT_IMAGE_WINDOW_MS`, `RATE_LIMIT_USE_REDIS`, `SLOW_DOWN_DELAY_AFTER`, `SLOW_DOWN_DELAY_MS`, `SLOW_DOWN_MAX_DELAY_MS`, `SLOW_DOWN_WINDOW_MS`, `SLOW_DOWN_IMAGE_*`, `SLOW_DOWN_USE_REDIS`

**Addon branding**

`ADDON_ID`, `ADDON_NAME`, `ADDON_ICON`, `ADDON_LOGO`, `ADDON_BACKGROUND`, `ADDON_DESCRIPTION`, `ADDON_VERSION`, `STREMIO_ADDONS_ISSUER`, `STREMIO_ADDONS_SIGNATURE`

</details>

---

## Deploying

### Railway

Zero-config: it detects `npm start` from `package.json`.

Set these variables:

```
PUBLIC_URL=https://<your-app>.up.railway.app
STREAM_PROXY_ENABLED=true
CACHE_TTL_STREAM=1800
LOG_LEVEL=info
```

### Fly.io

```bash
fly launch --no-deploy
fly secrets set PUBLIC_URL=https://<your-app>.fly.dev
fly deploy
```

`fly.toml` is included.

### Render / Heroku / any Node host

Build: `npm install` · Start: `npm start`. Set `PUBLIC_URL` and the streaming variables above.

### Docker (standalone)

```bash
docker build -t hanime-addon .
docker run -d -p 61327:61327 \
  -e PUBLIC_URL=https://your-domain.example \
  -e STREAM_PROXY_ENABLED=true \
  -e CACHE_TTL_STREAM=1800 \
  --name hanime-addon hanime-addon
```

### Behind nginx / Cloudflare

Keep `TRUST_PROXY` at `1` for a single proxy hop. `PUBLIC_URL` must be the
**public** origin, never an internal address.

### Cloudflare Worker relay

For deployments whose egress Cloudflare challenges on the *handshake* endpoint,
`workers/handshake-relay` proxies two fixed upstream routes. Deploy with:

```bash
npx wrangler secret put RELAY_SECRET --config workers/handshake-relay/wrangler.jsonc
npx wrangler deploy --config workers/handshake-relay/wrangler.jsonc
```

Then set `HTV_HANDSHAKE_URL` / `HTV_SEARCH_URL` to the Worker and
`HTV_RELAY_SECRET` to the same value. Never commit that secret.

### Netlify

`netlify.toml` is included for serverless deployment. Note that serverless
functions are a poor fit for the stream proxy, which moves sustained bandwidth
through the function.

---

## Troubleshooting playback

| Symptom | Cause | Fix |
|---|---|---|
| **Streams listed, won't play** | Player is blocked; it talks to Hanime directly | `STREAM_PROXY_ENABLED=true` **and** `PUBLIC_URL` set to a public address |
| **No streams at all**, log shows `HTV handshake failed on all hosts` | Hanime's handshake endpoint sits behind an interactive JS challenge | Usually resolves itself; if persistent, deploy the Worker relay or set `CF_BYPASS_URL` |
| **Everything empty**, including catalogues | All upstream hosts blocked | Set `HTV_SEARCH_HOSTS`, or check network egress |
| **Logo/icons 404** | `PUBLIC_URL` set without a scheme in an older build, or unset | Set `PUBLIC_URL` with `https://` |
| **Plays for a while, then stops** | Cached stream entry outlived its signed URL | Lower `CACHE_TTL_STREAM` to `1800` |
| **Playback works for you, not others** | `PUBLIC_URL` points at localhost | Set it to the public origin |
| **Rate-limit warnings in logs** | `X-Forwarded-For` present but untrusted | Set `TRUST_PROXY=1` |
| **403 in the image proxy** | CDN rejected the request | Check `HTV_PLAYER_USER_AGENT`; raise `LOG_LEVEL` for detail |

Read the startup banner. It reports the resolved `PUBLIC_URL`, whether the
stream proxy and Cloudflare solver are active, and flags unreachable URLs.

---

## How it works

```
Stremio ──► addon server ──► hanime search API      (catalogue + metadata)
    │              │
    │              └──────► hanime handshake API   (mints signed HLS URLs)
    │
    └─ streams ────────► proxy/stream/* ──► hanime.tv/hls/…   (stream proxy on)
```

- **Catalogues** come from Hanime's `search_hvs` dataset, which the addon
  downloads and filters locally. Result is cached and shared across all
  catalogue categories.
- **Streams** are minted by a signed handshake. Hanime no longer exposes stream
  URLs through its public API, which is why configuration exists.
- **The stream proxy** rewrites HLS manifests so segments, AES keys and init
  segments are fetched through your server. URLs are HMAC-signed and upstream
  hosts are allowlisted, so the endpoint cannot be used as an open relay.

### Available catalogues

| Catalogue | Search | Filters |
|---|---|---|
| Hanime | ✅ | genre + studio |
| Hanime Recent / Most Likes / Most Views / Newest | — | — |
| Hanime Uncensored | — | genre + studio |
| Hanime Series | ✅ | — |

---

## Development

```bash
npm run dev     # debug logging, cache disabled
npm test        # run the test suite
npm run build   # rebuild Tailwind CSS
```

Refresh the generated filter datasets when Hanime's catalogue changes:

```bash
npm run discover-brands
npm run discover-uncensored-genres
```

API reference lives in [`openapi.yaml`](openapi.yaml).

---

## Credits

Forked from [mrcanelas/hanime-tv-addon](https://github.com/mrcanelas/hanime-tv-addon).

## License

[MIT](LICENSE)

## Disclaimer

For educational use. Comply with local law and Hanime.tv's terms of service.