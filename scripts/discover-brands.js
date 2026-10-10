#!/usr/bin/env node
/**
 * Probe each brand against Hanime's search API with the `uncensored`
 * tag, keep the ones that return at least one hit, and dump the
 * filtered list to lib/data/uncensored-brands.json. The Uncensored
 * catalog reads from that file so its brand dropdown only shows
 * brands that actually have uncensored content.
 *
 * Run manually whenever you want to refresh:
 *   npm run discover-brands
 *
 * Sequential with a 0.8–1.8s random pause between requests to avoid
 * tripping Hanime's rate limiter.
 */

const fs = require('fs');
const path = require('path');
const constants = require('../lib/constants');
const config = require('../lib/config');
const HanimeApiClient = require('../lib/clients/hanime_api_client');

// Brands the project owner has confirmed have uncensored content.
// Skipping the search API request for these saves time and avoids
// risking false negatives if a single probe gets rate limited.
const KNOWN_GOOD = ['Vanilla', 'Arms', 'Green Bunny', 'MS Pictures'];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jitter(minMs, maxMs) {
  return minMs + Math.random() * (maxMs - minMs);
}

async function probe(client, brand) {
  const results = await client.search({
    query: '',
    tags: ['uncensored'],
    brands: [brand],
    page: 0
  });
  return Array.isArray(results) && results.length > 0;
}

async function main() {
  const client = new HanimeApiClient(config);
  const allBrands = constants.brands;
  const knownSet = new Set(KNOWN_GOOD);
  const toProbe = allBrands.filter(b => !knownSet.has(b));
  const found = new Set(KNOWN_GOOD);

  console.log(`Discovering uncensored-bearing brands.`);
  console.log(`  Total brands:   ${allBrands.length}`);
  console.log(`  Pre-included:   ${KNOWN_GOOD.length} (${KNOWN_GOOD.join(', ')})`);
  console.log(`  To probe:       ${toProbe.length}`);
  console.log(`  Pacing:         800–1800 ms between requests`);
  console.log();

  const startedAt = Date.now();

  for (let i = 0; i < toProbe.length; i++) {
    const brand = toProbe[i];
    const idx = `[${String(i + 1).padStart(3)}/${toProbe.length}]`;

    let hit = false;
    let errored = false;
    try {
      hit = await probe(client, brand);
    } catch (err) {
      errored = true;
      console.error(`${idx} ${brand} — ERROR: ${err.message}`);
    }

    if (!errored) {
      if (hit) {
        found.add(brand);
        console.log(`${idx} ${brand} — ✓`);
      } else {
        console.log(`${idx} ${brand} — ·`);
      }
    }

    // Random pause to stay friendly with Hanime's rate limiter.
    if (i < toProbe.length - 1) {
      await sleep(jitter(800, 1800));
    }
  }

  const sorted = Array.from(found).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  const outDir = path.join(__dirname, '..', 'lib', 'data');
  fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, 'uncensored-brands.json');
  const payload = {
    generatedAt: new Date().toISOString(),
    elapsedSeconds: Number(elapsed),
    totalBrands: allBrands.length,
    probedBrands: toProbe.length,
    knownGood: KNOWN_GOOD,
    count: sorted.length,
    brands: sorted
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');

  console.log();
  console.log(`Done in ${elapsed}s. ${sorted.length} brands have uncensored content.`);
  console.log(`Written to ${path.relative(process.cwd(), outPath)}`);
}

main().catch(err => {
  console.error('discover-brands failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
