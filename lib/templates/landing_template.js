/**
 * Custom landing page template for Hanime Stremio Addon
 * "After-Hours Editorial" aesthetic: warm-ink background, scarlet accent,
 * Fraunces display + DM Sans body + JetBrains Mono URL.
 */

const { buildFullUrl } = require('../config');

function generateLandingHTML(manifest) {
  const logoUrl = manifest.logo || buildFullUrl('/images/logo.jpg');
  const iconUrl = manifest.icon || buildFullUrl('/images/favicon.ico');
  const name = manifest.name || 'Hanime';
  const version = manifest.version || '1.0.0';
  const description = manifest.description || '';

  const configFieldsArray = manifest.config || [];
  const configFields = configFieldsArray.map((field, idx) => {
    const inputType = field.type === 'password' ? 'password' : 'text';
    const isEmail = field.key.toLowerCase() === 'email';
    const isPassword = field.key.toLowerCase() === 'password';
    const autocomplete = isEmail ? 'email' : isPassword ? 'current-password' : 'off';
    const placeholder = isEmail
      ? 'name@domain.com'
      : isPassword
        ? '••••••••'
        : escapeHtml(field.title || field.key);
    const helper = isEmail
      ? 'Your hanime.tv account email'
      : isPassword
        ? 'Used only to authenticate the streams API'
        : '';

    return `
        <div class="field" style="--field-delay: ${0.45 + idx * 0.07}s">
          <label class="field-label" for="${field.key}">${escapeHtml(field.title || field.key)}</label>
          <input
            type="${inputType}"
            id="${field.key}"
            name="${field.key}"
            autocomplete="${autocomplete}"
            spellcheck="false"
            autocapitalize="off"
            placeholder="${placeholder}"
            ${field.required ? 'required' : ''}
          />
          ${helper ? `<p class="field-helper">${helper}</p>` : ''}
        </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(name)} — Stremio Addon</title>
  <link rel="shortcut icon" href="${iconUrl}" type="image/x-icon">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT@9..144,300..800,0..100&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --ink:        #0a0708;
      --ink-2:      #120d0d;
      --panel:      #14100f;
      --panel-2:    #1a1413;
      --line:       #2c211d;
      --line-soft:  #1f1816;
      --cream:      #f3ece1;
      --cream-dim:  #c9bfb1;
      --muted:      #8a7a6c;
      --muted-2:    #5a4e45;
      --scarlet:    #e63946;
      --scarlet-2:  #ff5664;
      --scarlet-glow: rgba(230, 57, 70, 0.18);
    }

    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    html { background: var(--ink); }
    body {
      min-height: 100vh;
      color: var(--cream);
      font-family: 'DM Sans', system-ui, sans-serif;
      font-feature-settings: 'ss01', 'ss02';
      font-size: 16px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      background:
        radial-gradient(900px 700px at 88% -10%, rgba(230, 57, 70, 0.22), transparent 60%),
        radial-gradient(700px 600px at -10% 110%, rgba(120, 30, 50, 0.18), transparent 65%),
        linear-gradient(180deg, #0c0808 0%, var(--ink) 100%);
      overflow-x: hidden;
      position: relative;
    }

    /* Film grain */
    body::before {
      content: '';
      position: fixed; inset: 0;
      pointer-events: none;
      opacity: 0.05;
      z-index: 0;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.95   0 0 0 0 0.92   0 0 0 0 0.88   0 0 0 1 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");
      mix-blend-mode: overlay;
    }

    /* Hairline frame */
    .frame {
      position: relative;
      z-index: 1;
      max-width: 1180px;
      margin: 0 auto;
      padding: clamp(28px, 4vw, 56px) clamp(20px, 4vw, 56px);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* Top bar */
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--line-soft);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 11px;
      letter-spacing: 0.18em;
      color: var(--muted);
      text-transform: uppercase;
    }
    .topbar .dot { color: var(--scarlet); }
    .topbar .right { display: inline-flex; gap: 22px; }
    .topbar .right span { display: inline-flex; align-items: center; gap: 8px; }

    /* Layout */
    .grid {
      flex: 1;
      display: grid;
      grid-template-columns: 1.05fr 1fr;
      gap: clamp(28px, 5vw, 72px);
      align-items: center;
      padding: clamp(40px, 7vw, 80px) 0;
    }
    @media (max-width: 880px) {
      .grid { grid-template-columns: 1fr; gap: 36px; padding: 32px 0; }
    }

    /* Identity column */
    .identity { position: relative; }
    .identity .lockup {
      display: inline-flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 28px;
      opacity: 0; transform: translateY(8px);
      animation: fadeUp 0.7s 0.1s ease forwards;
    }
    .identity .lockup .logo {
      width: 46px; height: 46px;
      border-radius: 50%;
      overflow: hidden;
      background: var(--panel);
      border: 1px solid var(--line);
      box-shadow: 0 0 0 4px rgba(230,57,70,0.0), 0 12px 30px rgba(0,0,0,0.5);
    }
    .identity .lockup .logo img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .identity .lockup .kicker {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10.5px;
      letter-spacing: 0.32em;
      color: var(--muted);
      text-transform: uppercase;
    }
    .identity .lockup .kicker em {
      color: var(--scarlet);
      font-style: normal;
      font-weight: 500;
    }

    .wordmark {
      font-family: 'Fraunces', 'Times New Roman', serif;
      font-variation-settings: 'opsz' 144, 'SOFT' 30;
      font-weight: 600;
      font-size: clamp(64px, 10vw, 128px);
      line-height: 0.92;
      letter-spacing: -0.035em;
      color: var(--cream);
      margin: 0 0 22px;
      opacity: 0; transform: translateY(14px);
      animation: fadeUp 0.9s 0.18s cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
    }
    .wordmark .ampersand {
      color: var(--scarlet);
      font-style: italic;
      font-variation-settings: 'opsz' 144, 'SOFT' 100;
    }

    .edition {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 7px 12px 7px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10.5px;
      letter-spacing: 0.22em;
      color: var(--cream-dim);
      text-transform: uppercase;
      margin-bottom: 28px;
      background: rgba(255,255,255,0.015);
      opacity: 0; transform: translateY(10px);
      animation: fadeUp 0.7s 0.28s ease forwards;
    }
    .edition::before {
      content: '';
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--scarlet);
      box-shadow: 0 0 0 4px rgba(230,57,70,0.18);
    }

    .lede {
      max-width: 46ch;
      font-size: 15.5px;
      line-height: 1.65;
      color: var(--cream-dim);
      margin: 0 0 36px;
      opacity: 0; transform: translateY(10px);
      animation: fadeUp 0.8s 0.36s ease forwards;
    }

    .meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 18px 28px;
      padding-top: 22px;
      border-top: 1px solid var(--line-soft);
      opacity: 0; transform: translateY(10px);
      animation: fadeUp 0.8s 0.42s ease forwards;
    }
    .meta-row .item { min-width: 0; }
    .meta-row .item-label {
      display: block;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      letter-spacing: 0.26em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .meta-row .item-value {
      font-family: 'Fraunces', serif;
      font-variation-settings: 'opsz' 14, 'SOFT' 30;
      font-weight: 500;
      font-size: 17px;
      color: var(--cream);
    }
    .meta-row .accent { color: var(--scarlet); }

    /* Form column */
    .panel {
      position: relative;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.012), rgba(255,255,255,0)) ,
        var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: clamp(24px, 3vw, 36px);
      box-shadow:
        0 1px 0 rgba(255,255,255,0.04) inset,
        0 30px 80px -30px rgba(0,0,0,0.7),
        0 0 0 1px rgba(0,0,0,0.4);
      opacity: 0; transform: translateY(16px);
      animation: fadeUp 0.9s 0.22s cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
    }
    .panel::before {
      content: '';
      position: absolute;
      top: -1px; left: 24px;
      width: 56px; height: 2px;
      background: var(--scarlet);
      border-radius: 2px;
    }

    .section-label {
      display: flex;
      align-items: center;
      gap: 12px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10.5px;
      letter-spacing: 0.28em;
      text-transform: uppercase;
      color: var(--muted);
      margin: 4px 0 22px;
    }
    .section-label::after {
      content: '';
      flex: 1;
      height: 1px;
      background: linear-gradient(90deg, var(--line), transparent);
    }

    .field {
      margin-bottom: 20px;
      opacity: 0; transform: translateY(8px);
      animation: fadeUp 0.6s var(--field-delay, 0.4s) ease forwards;
    }
    .field-label {
      display: block;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10.5px;
      letter-spacing: 0.24em;
      text-transform: uppercase;
      color: var(--cream-dim);
      margin-bottom: 8px;
    }
    .field input[type="text"],
    .field input[type="password"],
    .url-row input[type="text"] {
      width: 100%;
      background: transparent;
      border: 0;
      border-bottom: 1px solid var(--line);
      padding: 10px 0 12px;
      color: var(--cream);
      font-family: 'Fraunces', serif;
      font-variation-settings: 'opsz' 14, 'SOFT' 30;
      font-weight: 400;
      font-size: 19px;
      letter-spacing: -0.005em;
      outline: 0;
      transition: border-color 180ms ease, color 180ms ease;
      caret-color: var(--scarlet);
    }
    .field input::placeholder,
    .url-row input::placeholder {
      color: var(--muted-2);
      font-style: italic;
    }
    .field input:hover,
    .url-row input:hover { border-bottom-color: var(--muted); }
    .field input:focus,
    .url-row input:focus { border-bottom-color: var(--scarlet); }
    .field-helper {
      margin: 8px 0 0;
      font-size: 12.5px;
      color: var(--muted);
      letter-spacing: 0.01em;
    }

    /* Critical: kill black-on-black autofill */
    input:-webkit-autofill,
    input:-webkit-autofill:hover,
    input:-webkit-autofill:focus,
    input:-webkit-autofill:active {
      -webkit-text-fill-color: var(--cream) !important;
      -webkit-box-shadow: 0 0 0 1000px var(--panel) inset !important;
      box-shadow: 0 0 0 1000px var(--panel) inset !important;
      caret-color: var(--scarlet) !important;
      transition: background-color 9999s ease-in-out 0s, color 9999s ease-in-out 0s;
      font-family: 'Fraunces', serif !important;
      font-size: 19px !important;
    }

    .url-row {
      display: flex;
      gap: 10px;
      align-items: stretch;
    }
    .url-row input {
      font-family: 'JetBrains Mono', monospace !important;
      font-size: 12.5px !important;
      letter-spacing: 0;
      color: var(--cream-dim);
    }
    .copy-btn {
      flex: 0 0 auto;
      width: 44px;
      background: transparent;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--cream-dim);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: border-color 160ms ease, color 160ms ease, background 160ms ease;
    }
    .copy-btn:hover { border-color: var(--scarlet); color: var(--scarlet); }
    .copy-btn:focus-visible { outline: 2px solid var(--scarlet); outline-offset: 2px; }

    /* Buttons */
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 30px;
      opacity: 0; transform: translateY(10px);
      animation: fadeUp 0.7s 0.7s ease forwards;
    }
    @media (max-width: 480px) { .actions { grid-template-columns: 1fr; } }

    .btn {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 16px 14px;
      border-radius: 10px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10.5px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      text-decoration: none;
      cursor: pointer;
      border: 1px solid transparent;
      white-space: nowrap;
      line-height: 1;
      transition: transform 140ms ease, background 200ms ease, color 200ms ease, border-color 200ms ease, box-shadow 200ms ease;
      will-change: transform;
    }
    .btn:active { transform: translateY(1px); }
    .btn svg { width: 14px; height: 14px; }
    .btn-primary {
      background: var(--scarlet);
      color: #fff8f4;
      box-shadow:
        0 1px 0 rgba(255,255,255,0.18) inset,
        0 18px 40px -16px var(--scarlet-glow),
        0 0 0 1px rgba(0,0,0,0.2);
    }
    .btn-primary:hover { background: var(--scarlet-2); box-shadow: 0 1px 0 rgba(255,255,255,0.25) inset, 0 22px 50px -16px var(--scarlet-glow); }
    .btn-ghost {
      background: transparent;
      color: var(--cream);
      border-color: var(--line);
    }
    .btn-ghost:hover { border-color: var(--cream-dim); color: var(--cream); background: rgba(255,255,255,0.02); }

    /* Verify row */
    .verify-row {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-top: 18px;
      flex-wrap: wrap;
    }
    .verify-btn {
      flex: 0 0 auto;
      background: transparent;
      color: var(--cream);
      border: 1px solid var(--line);
      padding: 12px 16px;
      font-size: 10.5px;
      letter-spacing: 0.18em;
      border-radius: 8px;
      cursor: pointer;
      font-family: 'JetBrains Mono', monospace;
      text-transform: uppercase;
      display: inline-flex;
      align-items: center;
      gap: 9px;
      white-space: nowrap;
      line-height: 1;
      transition: border-color 160ms ease, color 160ms ease, background 160ms ease, opacity 160ms ease;
    }
    .verify-btn:hover { border-color: var(--cream-dim); color: var(--cream); }
    .verify-btn[disabled] { opacity: 0.6; cursor: progress; }
    .verify-btn .v-icon { width: 14px; height: 14px; }
    .verify-btn .v-icon.spin { animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .verify-status {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 1em;
    }
    .verify-status.is-success { color: #6fcf8a; }
    .verify-status.is-success .pill {
      color: var(--scarlet);
      border-color: var(--scarlet);
    }
    .verify-status.is-error { color: var(--scarlet); }
    .verify-status.is-loading { color: var(--cream-dim); }
    .verify-status .pill {
      display: inline-flex;
      align-items: center;
      padding: 3px 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      font-size: 10px;
      letter-spacing: 0.18em;
      color: var(--cream-dim);
    }

    /* Bottom mark */
    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 22px;
      border-top: 1px solid var(--line-soft);
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      letter-spacing: 0.24em;
      color: var(--muted-2);
      text-transform: uppercase;
    }
    .footer .colophon em {
      color: var(--scarlet);
      font-style: normal;
      font-weight: 500;
    }

    @keyframes fadeUp {
      to { opacity: 1; transform: translateY(0); }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; }
      .wordmark, .edition, .lede, .meta-row, .panel, .field, .actions, .identity .lockup { opacity: 1; transform: none; }
    }
  </style>
</head>
<body>
  <div class="frame">

    <header class="topbar">
      <span><span class="dot">&#9679;</span>&nbsp;&nbsp;${escapeHtml(name).toUpperCase()} STREMIO ADDON</span>
      <span class="right">
        <span>EDITION ${escapeHtml(version)}</span>
        <span>CONFIGURE →</span>
      </span>
    </header>

    <main class="grid">

      <section class="identity">
        <div class="lockup">
          <span class="logo"><img src="${logoUrl}" alt="${escapeHtml(name)} logo"></span>
          <span class="kicker">A&nbsp;Stremio&nbsp;Addon &nbsp;·&nbsp; <em>Configure to Stream</em></span>
        </div>

        <h1 class="wordmark">${escapeHtml(name)}<span class="ampersand">.</span></h1>

        <div class="edition">EDITION&nbsp;&nbsp;${escapeHtml(version)}</div>

        <p class="lede">${escapeHtml(description)}</p>

        <div class="meta-row">
          <div class="item">
            <span class="item-label">Catalogues</span>
            <span class="item-value">${(manifest.catalogs || []).length}</span>
          </div>
          <div class="item">
            <span class="item-label">Resources</span>
            <span class="item-value">${(manifest.resources || []).length}</span>
          </div>
          <div class="item">
            <span class="item-label">Access</span>
            <span class="item-value accent">Authenticated</span>
          </div>
        </div>
      </section>

      <section class="panel" aria-label="Configuration">
        ${configFieldsArray.length > 0 ? `
        <div class="section-label">Credentials</div>
        <form id="mainForm" novalidate>
          ${configFields}
        </form>

        <div class="verify-row">
          <button type="button" id="verifyBtn" class="verify-btn" aria-describedby="verifyStatus">
            <svg class="v-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 12l2 2 4-4"></path>
              <circle cx="12" cy="12" r="9"></circle>
            </svg>
            <span class="v-label">Verify Credentials</span>
          </button>
          <span id="verifyStatus" class="verify-status" aria-live="polite"></span>
        </div>

        <div class="section-label" style="margin-top: 30px">Manifest</div>
        <div class="field" style="--field-delay: 0.62s; margin-bottom: 0;">
          <label class="field-label" for="generatedUrl">Addon URL</label>
          <div class="url-row">
            <input type="text" id="generatedUrl" readonly value="" aria-label="Generated manifest URL">
            <button type="button" id="copyUrlBtn" class="copy-btn" title="Copy URL" aria-label="Copy manifest URL">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="11" height="11" rx="2"></rect>
                <path d="M5 15V6a2 2 0 0 1 2-2h9"></path>
              </svg>
            </button>
          </div>
          <p class="field-helper">This URL updates as you fill in the form.</p>
        </div>
        ` : ''}

        <div class="actions">
          <a id="installLink" class="btn btn-primary" href="#">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 4v12"></path>
              <path d="M6 10l6 6 6-6"></path>
              <path d="M5 20h14"></path>
            </svg>
            Install in Stremio
          </a>
          <a id="installWebLink" class="btn btn-ghost" href="#" target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"></circle>
              <path d="M3 12h18"></path>
              <path d="M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18"></path>
            </svg>
            Open Stremio Web
          </a>
        </div>
      </section>

    </main>

    <footer class="footer">
      <span class="colophon"><em>Configured locally</em></span>
      <span>HANIME / / EDITION ${escapeHtml(version)}</span>
    </footer>

  </div>

  <script>
    (function () {
      var installLink = document.getElementById('installLink');
      var installWebLink = document.getElementById('installWebLink');
      var mainForm = document.getElementById('mainForm');
      var generatedUrlInput = document.getElementById('generatedUrl');
      var copyUrlBtn = document.getElementById('copyUrlBtn');

      function getFilteredConfig() {
        if (!mainForm) return {};
        var data = Object.fromEntries(new FormData(mainForm));
        return Object.fromEntries(
          Object.entries(data).filter(function (kv) { return kv[1] && String(kv[1]).trim() !== ''; })
        );
      }

      // Strip the current page's filename so URLs are built relative to the
      // mount path. This preserves any reverse-proxy prefix (e.g. /hanime/<token>/).
      function getBasePath() {
        return window.location.pathname.replace(/\\/[^\\/]*$/, '/');
      }

      function getManifestUrl() {
        var cfg = getFilteredConfig();
        var base = window.location.protocol + '//' + window.location.host + getBasePath();
        if (Object.keys(cfg).length > 0) {
          var encoded = encodeURIComponent(JSON.stringify(cfg));
          return base + encoded + '/manifest.json';
        }
        return base + 'manifest.json';
      }

      function updateLinks() {
        var url = getManifestUrl();
        if (generatedUrlInput) generatedUrlInput.value = url;

        if (installLink) {
          var cfg = getFilteredConfig();
          var stremioBase = 'stremio://' + window.location.host + getBasePath();
          if (Object.keys(cfg).length > 0) {
            var encoded = encodeURIComponent(JSON.stringify(cfg));
            installLink.href = stremioBase + encoded + '/manifest.json';
          } else {
            installLink.href = stremioBase + 'manifest.json';
          }
        }
        if (installWebLink) {
          installWebLink.href = 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(url);
        }
      }

      if (copyUrlBtn && generatedUrlInput) {
        copyUrlBtn.addEventListener('click', function () {
          var url = generatedUrlInput.value;
          var done = function () {
            var original = copyUrlBtn.innerHTML;
            copyUrlBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 12 10 18 20 6"></polyline></svg>';
            copyUrlBtn.style.color = 'var(--scarlet)';
            copyUrlBtn.style.borderColor = 'var(--scarlet)';
            setTimeout(function () {
              copyUrlBtn.innerHTML = original;
              copyUrlBtn.style.color = '';
              copyUrlBtn.style.borderColor = '';
            }, 1600);
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(done).catch(function () {
              generatedUrlInput.select(); document.execCommand('copy'); done();
            });
          } else {
            generatedUrlInput.select(); document.execCommand('copy'); done();
          }
        });
      }

      if (installLink && mainForm) {
        installLink.addEventListener('click', function (e) {
          if (!mainForm.reportValidity()) { e.preventDefault(); return false; }
        });
      }

      if (mainForm) {
        mainForm.addEventListener('input', updateLinks);
        mainForm.addEventListener('change', updateLinks);
      }
      updateLinks();

      // --- Verify credentials ---
      var verifyBtn = document.getElementById('verifyBtn');
      var verifyStatus = document.getElementById('verifyStatus');
      var verifyLabel = verifyBtn ? verifyBtn.querySelector('.v-label') : null;
      var verifyIcon = verifyBtn ? verifyBtn.querySelector('.v-icon') : null;
      var checkIconSvg = '<svg class="v-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 12l2 2 4-4"></path><circle cx="12" cy="12" r="9"></circle></svg>';
      var spinnerSvg = '<svg class="v-icon spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9" opacity="0.9"></path></svg>';

      function setStatus(state, message, premiumLabel) {
        if (!verifyStatus) return;
        verifyStatus.className = 'verify-status' + (state ? ' is-' + state : '');
        var html = message ? message.replace(/[<>&]/g, function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c];}) : '';
        if (premiumLabel) {
          html += ' <span class="pill">' + premiumLabel + '</span>';
        }
        verifyStatus.innerHTML = html;
      }

      function setVerifyButton(state) {
        if (!verifyBtn) return;
        if (state === 'loading') {
          verifyBtn.setAttribute('disabled', 'disabled');
          if (verifyIcon) verifyIcon.outerHTML = spinnerSvg;
          if (verifyLabel) verifyLabel.textContent = 'Verifying…';
        } else {
          verifyBtn.removeAttribute('disabled');
          var iconNow = verifyBtn.querySelector('.v-icon');
          if (iconNow) iconNow.outerHTML = checkIconSvg;
          if (verifyLabel) verifyLabel.textContent = 'Verify Credentials';
        }
        // Re-bind references after innerHTML swap
        verifyIcon = verifyBtn.querySelector('.v-icon');
        verifyLabel = verifyBtn.querySelector('.v-label');
      }

      if (verifyBtn) {
        verifyBtn.addEventListener('click', function () {
          var cfg = getFilteredConfig();
          if (!cfg.email || !cfg.password) {
            setStatus('error', 'Enter email and password first.');
            return;
          }
          setVerifyButton('loading');
          setStatus('loading', 'Contacting hanime.tv…');

          // Build verify URL as a sibling of the current page, preserving any
          // path prefix (e.g. /hanime/configure → /hanime/verify).
          var basePath = window.location.pathname.replace(/\\/[^\\/]*$/, '/');
          var verifyUrl = window.location.origin + basePath + 'verify';

          fetch(verifyUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: cfg.email, password: cfg.password })
          })
            .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
            .then(function (resp) {
              setVerifyButton('idle');
              if (resp.status === 200 && resp.data && resp.data.ok) {
                var pill = resp.data.isPremium ? 'Premium · 1080p' : 'Standard';
                setStatus('success', '✓ Authenticated', pill);
              } else if (resp.data && resp.data.blocked) {
                // Cloudflare blocked this server. The credentials are fine;
                // self-hosting from a residential connection or deploying the
                // relay Worker is what fixes it.
                setStatus('error', '✗ Server blocked by Cloudflare — your credentials were not checked. Self-host from a residential connection or deploy the relay Worker.');
              } else {
                var msg = (resp.data && resp.data.error) ? resp.data.error : 'Verification failed.';
                setStatus('error', '✗ ' + msg);
              }
            })
            .catch(function (e) {
              setVerifyButton('idle');
              setStatus('error', '✗ Network error: ' + (e && e.message ? e.message : 'unknown'));
            });
        });
      }
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(text) {
  if (!text) return '';
  var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, function (m) { return map[m]; });
}

module.exports = generateLandingHTML;
