#!/usr/bin/env python3
"""
run.py — one-command launcher for the Hanime Stremio addon.

Does the boring setup work so you can just run it:

  1. checks Python / Node.js / npm are present and new enough
  2. installs npm dependencies on first run (and when package.json changes)
  3. loads a .env file into the environment (if one exists)
  4. runs preflight checks against your settings and warns about problems
  5. starts the server and prints a short summary

Usage:
    python run.py                 # install if needed, then start
    python run.py --check         # run preflight checks only, don't start
    python run.py --port 7000     # override the port
    python run.py --install       # force a fresh npm install
    python run.py --no-color      # disable coloured output

No third-party Python packages are required.
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NODE_MIN_MAJOR = 20

# ---------------------------------------------------------------- output helpers

class Style:
    """ANSI colours, disabled when not attached to a terminal or --no-color."""

    def __init__(self, enabled: bool):
        self.enabled = enabled

    def _wrap(self, code: str, text: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.enabled else text

    def dim(self, t):     return self._wrap("2", t)
    def bold(self, t):    return self._wrap("1", t)
    def green(self, t):   return self._wrap("32", t)
    def yellow(self, t):  return self._wrap("33", t)
    def red(self, t):     return self._wrap("31", t)
    def cyan(self, t):    return self._wrap("36", t)
    def magenta(self, t): return self._wrap("35", t)


def banner(s: Style) -> None:
    art = r"""
   __  __      _ _
  / / / /___ _(_) |_ ___
 / /_/ / __ `/ / | __/ __|
/ __  / /_/ / / / | || (__
\_/ /_/\__,_/_/_|_|\__\___|

  Stremio addon for Hanime.tv
"""
    for line in art.strip("\n").splitlines():
        print(s.magenta(line))
    print()


# ---------------------------------------------------------------- checks

def fail(msg: str) -> None:
    print(f"  ✗ {msg}", file=sys.stderr)
    sys.exit(1)


def check_python(s: Style) -> None:
    if sys.version_info < (3, 7):
        fail(f"Python 3.7+ is required (found {sys.version.split()[0]}).")


def check_node(s: Style) -> str:
    node = shutil.which("node")
    if not node:
        fail("Node.js was not found. Install Node.js 20 or newer: https://nodejs.org")

    try:
        out = subprocess.run([node, "-v"], capture_output=True, text=True, timeout=15).stdout.strip()
        major = int(out.lstrip("v").split(".")[0])
    except Exception:
        fail("Node.js is installed but `node -v` failed. Reinstall Node.js 20 or newer.")

    if major < NODE_MIN_MAJOR:
        fail(f"Node.js {NODE_MIN_MAJOR}+ is required (found {out}). Upgrade: https://nodejs.org")

    if not shutil.which("npm"):
        fail("npm was not found. It ships with Node.js — reinstall Node.js.")

    print(f"  ✓ node {out}")
    return node


def check_sources(s: Style) -> None:
    for required in ("server.js", "package.json", "addon.js"):
        if not (ROOT / required).exists():
            fail(f"'{required}' is missing. run.py must sit in the project folder.")


def deps_are_current(s: Style) -> bool:
    """True when node_modules matches the current package-lock.json."""
    lock = ROOT / "package-lock.json"
    modules = ROOT / "node_modules"
    if not modules.is_dir():
        return False
    if not lock.exists():
        return True
    return lock.stat().st_mtime <= modules.stat().st_mtime


def install_deps(s: Style) -> None:
    print(s.dim("  … installing npm dependencies (first run can take a minute)"))
    cmd = ["npm", "install", "--no-audit", "--no-fund"]
    # Capture npm's chatter so it doesn't scroll past the banner; it is only
    # printed if the install fails, when the detail actually matters.
    result = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        print(s.red("\n  npm install failed:\n"))
        print(result.stdout or "")
        print(result.stderr or "", file=sys.stderr)
        sys.exit(1)


def verify_tests(s: Style) -> None:
    """The addon ships a self-check; run it so failures surface before serving."""
    try:
        result = subprocess.run(
            ["npm", "run", "--silent", "test"],
            cwd=ROOT, capture_output=True, text=True, timeout=300,
        )
    except subprocess.TimeoutExpired:
        print(s.yellow("  ! self-check timed out, continuing anyway"))
        return

    if result.returncode == 0:
        print(s.green("  ✓ self-check passed"))
    else:
        print(s.yellow("  ! self-check reported failures — the server will still start"))
        tail = (result.stdout or "").strip().splitlines()[-3:]
        for line in tail:
            print(s.dim(f"      {line}"))


# ---------------------------------------------------------------- .env loading

def load_dotenv(s: Style) -> dict:
    """Load KEY=value pairs from .env into os.environ (existing values win)."""
    env_path = ROOT / ".env"
    if not env_path.exists():
        return {}

    loaded = {}
    for raw in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        loaded[key] = value
        # Real environment variables take precedence over the file, so a
        # one-off PORT=... on the command line still works.
        os.environ.setdefault(key, value)

    if loaded:
        print(s.green(f"  ✓ loaded {len(loaded)} value(s) from .env"))
    return loaded


# ---------------------------------------------------------------- preflight

def port_is_free(port: int) -> bool:
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(1)
        return sock.connect_ex(("127.0.0.1", port)) != 0


def preflight(s: Style, args, env: dict) -> None:
    print(s.bold("\n  Configuration check"))
    print(s.dim("  " + "-" * 46))

    port = args.port or int(os.environ.get("PORT") or 61327)
    public_url = os.environ.get("PUBLIC_URL") or env.get("PUBLIC_URL")
    proxy_on = str(os.environ.get("STREAM_PROXY_ENABLED", "")).lower() == "true"

    if args.port:
        os.environ["PORT"] = str(args.port)
    print(f"  {'✓' if port_is_free(port) else '!'} port {port} "
          f"{'is free' if port_is_free(port) else 'is already in use'}")

    if public_url:
        print(s.green(f"  ✓ PUBLIC_URL {public_url}"))
        if not re.match(r"^https?://", public_url):
            print(s.yellow("  ! PUBLIC_URL has no http(s):// — https:// will be added automatically"))
        if re.search(r"(localhost|127\.0\.0\.1)", public_url):
            print(s.yellow("  ! PUBLIC_URL points at localhost; players cannot reach it"))
    else:
        print(s.yellow("  ! PUBLIC_URL is not set"))
        print(s.dim("      Needed for image/logo URLs, and REQUIRED if you enable the stream proxy."))
        print(s.dim("      Local testing? Use http://localhost:%d" % port))

    if proxy_on:
        if public_url and not re.search(r"(localhost|127\.0\.0\.1)", public_url):
            print(s.green("  ✓ stream proxy enabled and PUBLIC_URL looks reachable"))
        else:
            print(s.red("  ! STREAM_PROXY_ENABLED=true but PUBLIC_URL is not a public address."))
            print(s.red("      Players would receive http://127.0.0.1/... URLs and nothing will play."))

        ttl = os.environ.get("CACHE_TTL_STREAM")
        if not ttl:
            print(s.yellow("  ! CACHE_TTL_STREAM is not set (default 6h)."))
            print(s.yellow("      Cached stream entries are signed HLS URLs that expire — use 1800."))
        elif int(ttl) > 3600:
            print(s.yellow(f"  ! CACHE_TTL_STREAM={ttl} is long for signed URLs; 1800 is safer"))

    if os.environ.get("CF_BYPASS_URL"):
        print(s.green("  ✓ Cloudflare solver configured (only needed if the handshake starts failing)"))
    else:
        print(s.dim("  · CF_BYPASS_URL not set — fine, /hls/ playback does not need it"))

    print(s.dim("  " + "-" * 46))


def summarize(s: Style, port: int) -> None:
    public_url = os.environ.get("PUBLIC_URL") or f"http://localhost:{port}"
    print()
    print(s.bold("  Addon URL — paste this into Stremio → Addons → Community Addons"))
    print()
    print(s.cyan(f"      {public_url}/manifest.json"))
    print()
    print(s.dim("  Stremio will ask for your Hanime email and password."))
    print(s.dim("  Configuration is only needed for premium (1080p) streams; guest playback works without it."))
    print(s.dim("\n  Press Ctrl+C to stop.\n"))


# ---------------------------------------------------------------- main

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Launch the Hanime Stremio addon.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--check", action="store_true", help="run checks only, don't start the server")
    parser.add_argument("--port", type=int, help="override PORT")
    parser.add_argument("--install", action="store_true", help="force npm install")
    parser.add_argument("--no-tests", action="store_true", help="skip the bundled self-check")
    parser.add_argument("--no-color", action="store_true", help="disable coloured output")
    args = parser.parse_args()

    s = Style(not args.no_color and sys.stdout.isatty())
    banner(s)

    check_python(s)
    check_node(s)
    check_sources(s)

    if args.install or not deps_are_current(s):
        install_deps(s)
    else:
        print(s.green("  ✓ dependencies already installed"))

    if not args.no_tests:
        verify_tests(s)

    env = load_dotenv(s)
    preflight(s, args, env)

    if args.check:
        print(s.dim("\n  --check only; not starting the server.\n"))
        return 0

    port = int(os.environ.get("PORT") or 61327)
    summarize(s, port)

    started = time.time()
    try:
        return subprocess.run(["node", "server.js"], cwd=ROOT).returncode
    except KeyboardInterrupt:
        print(f"\n\n  Stopped after {time.time() - started:.0f}s. Bye.\n")
        return 0


if __name__ == "__main__":
    sys.exit(main())