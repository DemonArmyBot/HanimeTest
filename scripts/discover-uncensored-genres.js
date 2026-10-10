#!/usr/bin/env node
/**
 * Probe each genre against Hanime's search API with the `uncensored`
 * tag, keep the ones that return at least one hit, and dump the
 * filtered list to lib/data/uncensored-genres.json. The Uncensored
 * catalog reads from that file so its genre dropdown only shows
 * genres that actually have uncensored content.
 *
 * `censored` and `uncensored` are excluded unconditionally — they
 * conflict with the forced `uncensored` tag the catalog already applies.
 *
 * Run manually whenever you want to refresh:
 *   npm run discover-uncensored-genres
 *
 * Sequential with a 0.8–1.8s random pause between requests to avoid
 * tripping Hanime's rate limiter.
 */

const fs = require('fs');
const path = require('path');
const constants = require('../lib/constants');
const config = require('../lib/config');
const HanimeApiClient = require('../lib/clients/hanime_api_client');

const EXCLUDED = new Set(['censored', 'uncensored']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jitter(minMs, maxMs) {
  return minMs + Math.random() * (maxMs - minMs);
}

async function probe(client, genre) {
  const results = await client.search({
    query: '',
    tags: ['uncensored', genre],
    brands: [],
    page: 0
  });
  return Array.isArray(results) && results.length > 0;
}

async function main() {
  const client = new HanimeApiClient(config);
  const allGenres = constants.genres;
  const toProbe = allGenres.filter(g => !EXCLUDED.has(g));
  const found = new Set();

  console.log(`Discovering uncensored-bearing genres.`);
  console.log(`  Total genres:   ${allGenres.length}`);
  console.log(`  Excluded:       ${[...EXCLUDED].join(', ')} (conflict with forced uncensored tag)`);
  console.log(`  To probe:       ${toProbe.length}`);
  console.log(`  Pacing:         800–1800 ms between requests`);
  console.log();

  const startedAt = Date.now();

  for (let i = 0; i < toProbe.length; i++) {
    const genre = toProbe[i];
    const idx = `[${String(i + 1).padStart(3)}/${toProbe.length}]`;

    let hit = false;
    let errored = false;
    try {
      hit = await probe(client, genre);
    } catch (err) {
      errored = true;
      console.error(`${idx} ${genre} — ERROR: ${err.message}`);
    }

    if (!errored) {
      if (hit) {
        found.add(genre);
        console.log(`${idx} ${genre} — ✓`);
      } else {
        console.log(`${idx} ${genre} — ·`);
      }
    }

    if (i < toProbe.length - 1) {
      await sleep(jitter(800, 1800));
    }
  }

  const sorted = Array.from(found).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  const outDir = path.join(__dirname, '..', 'lib', 'data');
  fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, 'uncensored-genres.json');
  const payload = {
    generatedAt: new Date().toISOString(),
    elapsedSeconds: Number(elapsed),
    totalGenres: allGenres.length,
    probedGenres: toProbe.length,
    excluded: [...EXCLUDED],
    count: sorted.length,
    genres: sorted
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');

  console.log();
  console.log(`Done in ${elapsed}s. ${sorted.length} genres have uncensored content.`);
  console.log(`Written to ${path.relative(process.cwd(), outPath)}`);
}

main().catch(err => {
  console.error('discover-uncensored-genres failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
