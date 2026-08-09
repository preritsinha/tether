#!/usr/bin/env python3
"""
Load the real Waysera page in headless Chrome and fail on any console error.

The unit suite covers crypto, storage, validation and the session, but it does
not load index.js — so a syntax error or a bad reference there would sail past
it. This attaches over the DevTools protocol before navigating, so errors
thrown during initial parse and load are caught too.

    backend/.venv/bin/python tools/smoke_app.py

Exits non-zero if the page logs an error or throws.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import websockets

REPO_ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = REPO_ROOT / "web"
PORT = 8766
DEBUG_PORT = 9333

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Noise we do not control: the page deliberately runs without a relay here, and
# tiles/geocoding are third-party and offline in this context.
IGNORE_SUBSTRINGS = (
    "favicon",
    "ERR_INTERNET_DISCONNECTED",
    "ERR_NAME_NOT_RESOLVED",
    "net::ERR",
    "WebSocket connection",
    "Failed to load resource",
)


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def start_server() -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(
        ("127.0.0.1", PORT), partial(Handler, directory=str(WEB_ROOT))
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def debugger_url() -> str:
    # Chrome needs a moment to bind the debugging port. Without the pause the
    # retries all fail instantly against a refused connection.
    for _ in range(100):
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{DEBUG_PORT}/json/list", timeout=1
            ) as response:
                targets = json.load(response)
            for target in targets:
                if target.get("type") == "page" and target.get("webSocketDebuggerUrl"):
                    return target["webSocketDebuggerUrl"]
        except Exception:
            pass
        time.sleep(0.1)
    raise RuntimeError("Chrome DevTools endpoint never became available")


def interesting(text: str) -> bool:
    return not any(token in text for token in IGNORE_SUBSTRINGS)


# Exercised in the page after load. Checks the handlers the markup calls really
# exist, then drives a real journey creation through to the rendered code.
PAGE_CHECKS = """
(async () => {
  const report = { missing: [], code: null, errors: [] };
  try {
    const required = [
      'WayseraCrypto', 'WayseraValidate', 'WayseraStore', 'WayseraJourney',
      'createJourney', 'joinJourney', 'leaveJourney', 'copyJourneyCode',
      'shareCurrentInvite', 'toggleDirections', 'toggleBottomSheet',
      'startNavigation', 'stopNavigation', 'requestLocationPermission',
      'dismissLocationBanner'
    ];
    for (const name of required) {
      if (typeof window[name] === 'undefined') report.missing.push(name);
    }

    report.lockup = document.querySelector('.brand-name')
      ? document.querySelector('.brand-name').textContent : null;
    report.title = document.title;

    document.getElementById('destName').value = 'Gateway of India';
    document.getElementById('destLat').value = '18.922';
    document.getElementById('destLng').value = '72.834';
    document.getElementById('duration').value = '180';
    await window.createJourney();

    const codeEl = document.querySelector('.journey-code-display');
    report.code = codeEl ? codeEl.textContent : null;

    const stored = report.code
      ? await window.WayseraStore.getJourney(report.code) : null;
    report.storedDestination = stored && stored.destination
      ? stored.destination.name : null;
    report.storedKey = Boolean(stored && stored.key);
  } catch (error) {
    report.errors.push(String(error && error.stack ? error.stack : error));
  }
  return JSON.stringify(report);
})()
"""


async def collect(url: str, page_url: str) -> tuple[list[str], dict]:
    problems: list[str] = []
    report: dict = {}

    async with websockets.connect(url, max_size=20 * 1024 * 1024) as socket:
        message_id = 0
        pending_eval = None

        async def send(method, params=None):
            nonlocal message_id
            message_id += 1
            await socket.send(
                json.dumps({"id": message_id, "method": method, "params": params or {}})
            )
            return message_id

        # Attach before navigating so load-time failures are captured.
        await send("Runtime.enable")
        await send("Log.enable")
        await send("Page.enable")
        await send("Page.navigate", {"url": page_url})

        try:
            while True:
                raw = await asyncio.wait_for(socket.recv(), timeout=12)
                event = json.loads(raw)
                method = event.get("method")

                if method == "Page.loadEventFired" and pending_eval is None:
                    pending_eval = await send(
                        "Runtime.evaluate",
                        {
                            "expression": PAGE_CHECKS,
                            "awaitPromise": True,
                            "returnByValue": True,
                        },
                    )

                elif event.get("id") == pending_eval and "result" in event:
                    value = event["result"].get("result", {}).get("value")
                    if value:
                        report = json.loads(value)

                elif method == "Runtime.exceptionThrown":
                    details = event["params"]["exceptionDetails"]
                    text = details.get("text", "")
                    exception = details.get("exception") or {}
                    described = exception.get("description") or exception.get("value") or ""
                    combined = f"{text} {described}".strip()
                    if interesting(combined):
                        problems.append(f"uncaught: {combined}")

                elif method == "Log.entryAdded":
                    entry = event["params"]["entry"]
                    if entry.get("level") == "error":
                        text = entry.get("text", "")
                        if interesting(text):
                            problems.append(f"console.error: {text}")

        except asyncio.TimeoutError:
            pass  # Quiet for 12s — the page has settled.

    return problems, report


def main() -> int:
    server = start_server()
    profile = tempfile.mkdtemp(prefix="waysera-smoke-")

    chrome = subprocess.Popen(
        [
            CHROME,
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            f"--remote-debugging-port={DEBUG_PORT}",
            f"--user-data-dir={profile}",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        ws_url = debugger_url()
        problems, report = asyncio.run(
            collect(ws_url, f"http://localhost:{PORT}/index.html")
        )
    finally:
        chrome.terminate()
        try:
            chrome.wait(timeout=10)
        except subprocess.TimeoutExpired:
            chrome.kill()
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    failures = list(problems)

    if not report:
        failures.append("page checks never ran")
    else:
        for error in report.get("errors", []):
            failures.append(f"page check threw: {error}")
        if report.get("missing"):
            failures.append(f"handlers missing from window: {report['missing']}")
        if report.get("lockup") != "Waysera":
            failures.append(f"brand lockup reads {report.get('lockup')!r}")
        if not str(report.get("title", "")).startswith("Waysera"):
            failures.append(f"title reads {report.get('title')!r}")

        code = report.get("code")
        if not code or len(code) != 6:
            failures.append(f"journey code not rendered: {code!r}")
        if report.get("storedDestination") != "Gateway of India":
            failures.append(
                f"destination not persisted: {report.get('storedDestination')!r}"
            )
        if not report.get("storedKey"):
            failures.append("journey key not persisted")

    if failures:
        for failure in failures:
            print(failure)
        print(f"\n{len(failures)} problem(s)")
        return 1

    print(f"index.html OK — created journey {report['code']}, key and destination persisted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
