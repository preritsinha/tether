#!/usr/bin/env python3
"""
Run the Waysera browser test suite headlessly and report the result.

The crypto and storage layers depend on WebCrypto and IndexedDB, so they have
to run in a real browser. This serves web/ over http://localhost (a secure
context, which both APIs require), drives headless Chrome at tests.html, and
waits for the page to POST its results back.

    python3 tools/run_browser_tests.py

Exits non-zero if any test fails or the browser never reports.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = REPO_ROOT / "web"
PORT = 8765
TIMEOUT_SECONDS = 120

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    shutil.which("google-chrome") or "",
    shutil.which("chromium") or "",
]

received = threading.Event()
payload: dict = {}


class Handler(SimpleHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 - required by BaseHTTPRequestHandler
        if self.path != "/__results":
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload.update(json.loads(self.rfile.read(length) or b"{}"))
        except json.JSONDecodeError:
            payload.update({"error": "malformed results payload"})

        self.send_response(204)
        self.end_headers()
        received.set()

    def log_message(self, *args):
        pass  # Keep the report readable.


def find_chrome() -> str | None:
    for candidate in CHROME_CANDIDATES:
        if candidate and os.path.exists(candidate):
            return candidate
    return None


def main() -> int:
    chrome = find_chrome()
    if not chrome:
        print("No Chrome/Chromium found. Open http://localhost:%d/tests.html by hand." % PORT)
        return 2

    server = ThreadingHTTPServer(
        ("127.0.0.1", PORT), partial(Handler, directory=str(WEB_ROOT))
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()

    profile = tempfile.mkdtemp(prefix="waysera-test-profile-")
    process = subprocess.Popen(
        [
            chrome,
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            f"--user-data-dir={profile}",
            f"http://localhost:{PORT}/tests.html",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        if not received.wait(TIMEOUT_SECONDS):
            print(f"No results within {TIMEOUT_SECONDS}s — the page may have failed to load.")
            return 2
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    results = payload.get("results", [])
    failed = [r for r in results if not r.get("ok")]

    for result in results:
        if not result.get("ok"):
            print(f"FAIL  {result['name']}")
            print(f"      {result.get('error', '')}")

    total = payload.get("total", len(results))
    passed = payload.get("passed", total - len(failed))
    print(f"\n{passed}/{total} passed" + (f", {len(failed)} failed" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
