const fs = require('fs');
const path = require('path');
const vm = require('vm');
const logger = require('../logger');

/**
 * Computes hanime's `web2` request signature (window.ssignature / window.stime)
 * required by the /api/v11/handshake stream endpoint.
 *
 * The signature is produced by a WASM module hanime ships in its player bundle
 * (vendored at lib/vendor/htv_signature_wasm.js). That module is an Emscripten
 * single-file build: on load it computes a fresh time-based signature and, on
 * every `"e"` DOM event, recomputes it. We boot it once inside a sandboxed vm
 * with a minimal window/document shim (no real network — the vm's XHR/fetch are
 * inert stubs), then dispatch `"e"` per request to mint a current signature.
 */
class HtvSignatureService {
  constructor() {
    this.win = null;
    this.ready = false;
    this.bootError = null;
  }

  /**
   * Boot the WASM signature module. Idempotent. Resolves once the module has
   * produced its first signature (or rejects if it never boots).
   * @returns {Promise<boolean>} true if ready
   */
  async init() {
    if (this.ready) return true;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._boot();
    return this._initPromise;
  }

  async _boot() {
    try {
      const code = fs.readFileSync(
        path.join(__dirname, '..', 'vendor', 'htv_signature_wasm.js'),
        'utf8'
      );
      const win = this._makeWindowShim();
      vm.createContext(win);
      // The module boots asynchronously (WASM instantiation) and its main()
      // throws a benign late error after registering the "e" listener; that
      // throw surfaces as an uncaught async error, so swallow it rather than
      // let it crash the process.
      const swallow = () => {};
      process.on('uncaughtException', swallow);
      process.on('unhandledRejection', swallow);
      try {
        vm.runInContext(code, win, { filename: 'htv_signature_wasm.js' });
      } catch (_) { /* sync errors are non-fatal here */ }

      // Wait for the WASM to instantiate and emit its first signature.
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (typeof win.ssignature === 'string' && win.ssignature.length > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      process.removeListener('uncaughtException', swallow);
      process.removeListener('unhandledRejection', swallow);

      if (typeof win.ssignature !== 'string' || !win.ssignature) {
        throw new Error('signature module booted but produced no signature');
      }
      this.win = win;
      this.ready = true;
      logger.info('HTV signature service ready');
      return true;
    } catch (error) {
      this.bootError = error;
      logger.error('HTV signature service failed to boot', { error: error.message });
      return false;
    }
  }

  /**
   * Mint a fresh web2 signature.
   * @returns {Promise<{signature: string, time: (string|number)}|null>}
   */
  async getSignature() {
    if (!(await this.init())) return null;
    try {
      this.win.dispatchEvent(new this.win.CustomEvent('e'));
      const signature = this.win.ssignature;
      const time = this.win.stime;
      if (!signature) return null;
      return { signature, time };
    } catch (error) {
      logger.warn('HTV signature refresh failed', { error: error.message });
      return null;
    }
  }

  /**
   * Minimal browser-like global object the Emscripten module needs. No real
   * network: XHR/fetch are inert so any incidental analytics code is a no-op.
   * @private
   */
  _makeWindowShim() {
    const events = {};
    const win = {
      addEventListener: (t, h) => { (events[t] = events[t] || []).push(h); },
      removeEventListener: (t, h) => { if (events[t]) events[t] = events[t].filter((x) => x !== h); },
      dispatchEvent: (e) => {
        (events[e.type] || []).slice().forEach((h) => { try { h(e); } catch (_) { /* ignore */ } });
        return true;
      },
      atob: (s) => Buffer.from(s, 'base64').toString('binary'),
      btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
      TextEncoder, TextDecoder,
      performance: { now: () => Date.now() },
      console, Date, Math, JSON, setTimeout, clearTimeout,
      WebAssembly, Uint8Array, Uint32Array, Object, Array,
      parseInt, parseFloat, String, Number, Boolean, Error, Promise, Symbol,
      navigator: { userAgent: 'Mozilla/5.0', platform: 'MacIntel' },
      location: { href: 'https://hanime.tv/', origin: 'https://hanime.tv', protocol: 'https:', host: 'hanime.tv', hostname: 'hanime.tv' },
      CustomEvent: class { constructor(type, init) { this.type = type; this.detail = (init && init.detail) || null; } },
      XMLHttpRequest: class { open() {} send() {} setRequestHeader() {} },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    };
    win.document = {
      createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, appendChild() {} }),
      head: { appendChild() {} },
      body: { appendChild() {} },
      readyState: 'complete',
      currentScript: { src: 'https://hanime-cdn.com/js/vendor.js' },
      addEventListener: win.addEventListener,
      location: win.location,
      cookie: ''
    };
    win.window = win;
    win.self = win;
    win.globalThis = win;
    win.top = win;
    win.parent = win;
    win.frames = win;
    return win;
  }
}

module.exports = new HtvSignatureService();
