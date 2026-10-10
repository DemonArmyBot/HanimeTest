#!/usr/bin/env node
/**
 * Refresh the vendored hanime signature module (lib/vendor/htv_signature_wasm.js).
 *
 * hanime ships the web2-signature WASM inside a hashed player bundle
 * (hanime-cdn.com/js/vendor.<hash>.min.js) referenced from every video page.
 * When they rotate it, the vendored copy goes stale and streams stop
 * resolving. This script scrapes a video page for the current vendor bundle
 * URL, downloads it, sanity-checks that it still exposes the signature
 * globals, and rewrites the vendored file (preserving the header).
 *
 * Usage:
 *   node scripts/refresh-htv-signature.js [videoSlug]
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const VENDORED = path.join(__dirname, '..', 'lib', 'vendor', 'htv_signature_wasm.js');

async function main() {
  const slug = process.argv[2] || 'bible-black-6';
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
    console.error('Invalid slug:', slug);
    process.exit(1);
  }
  const pageUrl = `https://hanime.tv/videos/hentai/${slug}`;
  console.log('Fetching video page:', pageUrl);
  const page = await axios.get(pageUrl, { headers: { 'user-agent': UA, referer: 'https://hanime.tv/' } });

  const m = page.data.match(/https:\/\/hanime-cdn\.com\/js\/vendor\.[a-f0-9]+\.min\.js/);
  if (!m) throw new Error('Could not find vendor bundle URL on the page');
  const bundleUrl = m[0];
  console.log('Vendor bundle:', bundleUrl);

  const bundle = await axios.get(bundleUrl, { headers: { 'user-agent': UA }, responseType: 'text' });
  const code = bundle.data;

  // Sanity: the module must still emit the signature globals and hold the WASM.
  if (!code.includes('window.ssignature') || !code.includes('base64Decode("AGFzbQ')) {
    throw new Error('Downloaded bundle does not look like the signature module (missing ssignature/WASM)');
  }

  const header = `/*
 * Vendored from hanime.tv (${bundleUrl.replace(/^https:\/\//, '')}), ${new Date().toISOString().slice(0, 10)}.
 * Self-contained Emscripten module whose sole purpose is computing the web2
 * request signature (window.ssignature / window.stime) required by the
 * /api/v11/handshake stream endpoint. Run inside a sandboxed vm by
 * lib/services/htv_signature_service.js. Do not edit by hand; refresh with
 * scripts/refresh-htv-signature.js if hanime rotates the bundle.
 * eslint-disable
 */
`;
  fs.writeFileSync(VENDORED, header + code);
  console.log(`Wrote ${code.length} bytes to ${VENDORED}`);
  console.log('Done. Run a stream request to confirm signatures still validate.');
}

main().catch((e) => { console.error('Refresh failed:', e.message); process.exit(1); });
