#!/usr/bin/env python3
"""
End-to-end test across two real browser pages and a live relay.

The unit suite wires two sessions to each other in one process, which proves
the protocol but not the transport. This starts the actual relay, opens two
headless Chrome pages, has one create a journey and the other join by invite
link, and checks that positions and quick messages genuinely cross the wire.

It also asserts the property the whole design rests on: that what the relay
carries is ciphertext.

    backend/.venv/bin/python tools/integration_test.py
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
BACKEND = REPO_ROOT / "backend"
VENV_PYTHON = BACKEND / ".venv" / "bin" / "python"

STATIC_PORT = 8768
RELAY_PORT = 8769
DEBUG_PORT = 9334
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

RELAY = f"http://localhost:{RELAY_PORT}"
ORIGIN = f"http://localhost:{STATIC_PORT}"


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class Page:
    """One browser tab, driven over the DevTools protocol."""

    def __init__(self, socket):
        self.socket = socket
        self._id = 0

    @classmethod
    async def open(cls, target_id):
        url = f"ws://127.0.0.1:{DEBUG_PORT}/devtools/page/{target_id}"
        socket = await websockets.connect(url, max_size=20 * 1024 * 1024)
        page = cls(socket)
        await page.call("Runtime.enable")
        await page.call("Page.enable")
        return page

    async def call(self, method, params=None):
        self._id += 1
        message_id = self._id
        await self.socket.send(
            json.dumps({"id": message_id, "method": method, "params": params or {}})
        )
        while True:
            event = json.loads(await asyncio.wait_for(self.socket.recv(), timeout=30))
            if event.get("id") == message_id:
                if "error" in event:
                    raise RuntimeError(f"{method}: {event['error']}")
                return event.get("result", {})

    async def navigate(self, url, ready="typeof window.startJourney === 'function'"):
        """Navigate and wait for the page's own signal, not a fixed delay.

        The readiness expression differs per page — the replay view never loads
        index.js, so it has no startJourney to wait for.
        """
        await self.call("Page.navigate", {"url": url})
        for _ in range(100):
            if await self.evaluate(ready):
                return
            await asyncio.sleep(0.1)
        raise RuntimeError(f"page never finished loading: {url}")

    async def evaluate(self, expression, await_promise=False):
        result = await self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "awaitPromise": await_promise,
                "returnByValue": True,
            },
        )
        details = result.get("exceptionDetails")
        if details:
            raise RuntimeError(f"page threw: {details.get('text')} {details}")
        return result.get("result", {}).get("value")

    async def json_eval(self, expression):
        return json.loads(await self.evaluate(expression, await_promise=True))

    async def close(self):
        await self.socket.close()


def start_static():
    server = ThreadingHTTPServer(
        ("127.0.0.1", STATIC_PORT), partial(Handler, directory=str(WEB_ROOT))
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def start_relay():
    process = subprocess.Popen(
        [
            str(VENV_PYTHON), "-m", "uvicorn", "main:app",
            "--host", "127.0.0.1", "--port", str(RELAY_PORT), "--log-level", "warning",
        ],
        cwd=str(BACKEND),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(100):
        try:
            with urllib.request.urlopen(f"{RELAY}/v1/health", timeout=1):
                return process
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("relay never became healthy")


def start_chrome(profile):
    process = subprocess.Popen(
        [
            CHROME, "--headless=new", "--disable-gpu", "--no-first-run",
            "--no-default-browser-check",
            f"--remote-debugging-port={DEBUG_PORT}",
            f"--user-data-dir={profile}",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(100):
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{DEBUG_PORT}/json/version", timeout=1
            ):
                return process
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("Chrome never exposed its debugger")


def new_target(url):
    request = urllib.request.Request(
        f"http://127.0.0.1:{DEBUG_PORT}/json/new?{url}", method="PUT"
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)["id"]


async def run() -> list[str]:
    failures: list[str] = []

    host_target = new_target(f"{ORIGIN}/index.html")
    host = await Page.open(host_target)
    await host.navigate(f"{ORIGIN}/index.html")

    # Point the client at our relay, then create a journey and enter it.
    # startJourney is called directly rather than through the rendered button so
    # no display name is remembered — that keeps the second page from
    # auto-joining under the first page's identity.
    created = await host.json_eval(f"""
        (async () => {{
            CONFIG.API_BASE = '{RELAY}';
            document.getElementById('destName').value = 'Gateway of India';
            document.getElementById('destLat').value = '18.922';
            document.getElementById('destLng').value = '72.834';
            document.getElementById('duration').value = '180';
            await createJourney();

            const code = document.querySelector('.journey-code-display').textContent;
            const stored = await WayseraStore.getJourney(code);
            const encodedKey = await WayseraCrypto.exportJourneyKey(stored.key);
            const link = WayseraCrypto.buildInviteLink(location.origin, code, encodedKey);

            await startJourney(code, 'Alex');
            return JSON.stringify({{ code, link }});
        }})()
    """)

    code, link = created["code"], created["link"]
    if len(code) != 6:
        failures.append(f"unexpected journey code {code!r}")

    # The key must be in the fragment, never the query — that is what keeps it
    # away from the static host and the relay.
    if "#" not in link or link.index("#") > link.index("k="):
        failures.append(f"invite key is not in the fragment: {link}")

    guest_target = new_target(link)
    guest = await Page.open(guest_target)
    await guest.navigate(link)

    await guest.evaluate(f"""
        (() => {{
            CONFIG.API_BASE = '{RELAY}';
            window.__received = [];
            return true;
        }})()
    """)
    await guest.evaluate(f"startJourney('{code}', 'Riya')", await_promise=True)
    await guest.evaluate(
        "session.on('quick_message', (m) => window.__received.push(m)), true"
    )

    # Both send a position so each has something to show the other.
    await host.evaluate(
        "session.sendPosition({ lat: 19.076, lng: 72.8777, heading: 90, speed: 12 })",
        await_promise=True,
    )
    await guest.evaluate(
        "session.sendPosition({ lat: 18.95, lng: 72.85, heading: 180, speed: 8 })",
        await_promise=True,
    )

    async def roster(page):
        """Wait for the roster to settle, not merely to be populated.

        A position can arrive before its sender's hello, so an entry legitimately
        exists with no name for a moment — the UI shows 'Someone' until it
        resolves. Waiting only on the count made this test race.
        """
        names = []
        for _ in range(60):
            names = await page.json_eval(
                "Promise.resolve(JSON.stringify("
                "session.roster().map(m => m.isSelf ? 'me:' + m.name : m.name)))"
            )
            if len(names) >= 2 and all(names):
                return names
            await asyncio.sleep(0.25)
        return names

    host_roster = await roster(host)
    guest_roster = await roster(guest)

    if sorted(host_roster) != ["Riya", "me:Alex"]:
        failures.append(f"host roster wrong: {host_roster}")
    if sorted(guest_roster) != ["Alex", "me:Riya"]:
        failures.append(f"guest roster wrong: {guest_roster}")

    # The guest must see the destination it never had locally.
    destination = await guest.evaluate(
        "currentRoom && currentRoom.destination && currentRoom.destination.name"
    )
    if destination != "Gateway of India":
        failures.append(f"destination did not reach the guest: {destination!r}")

    # A position must have crossed the wire, not just a name.
    host_view = await guest.json_eval(
        "Promise.resolve(JSON.stringify("
        "session.roster().filter(m => !m.isSelf).map(m => [m.lat, m.speed])))"
    )
    if not host_view or host_view[0][0] is None:
        failures.append(f"guest never saw a position: {host_view}")

    channel = await host.evaluate(
        f"WayseraCrypto.deriveChannelId('{code}')", await_promise=True
    )

    # A late joiner must receive nothing that already happened — the relay keeps
    # no buffer. Heartbeats are paused first, otherwise the eavesdropper would
    # see live traffic within seconds and the check would prove nothing.
    for page in (host, guest):
        await page.evaluate("clearInterval(session.heartbeatTimer), true")

    if await eavesdrop(channel, seconds=2.5) is not None:
        failures.append("relay handed past traffic to a late joiner")

    # Now listen *while* traffic flows, and inspect what actually crosses.
    listener = asyncio.create_task(eavesdrop(channel, seconds=10, want=2))
    await asyncio.sleep(0.5)  # let the eavesdropper attach

    await host.evaluate("sendQuickMessage('need-fuel')", await_promise=True)
    await host.evaluate(
        "session.sendPosition({ lat: 19.076, lng: 72.8777, heading: 90, speed: 12 })",
        await_promise=True,
    )

    received = []
    for _ in range(40):
        received = await guest.json_eval(
            "Promise.resolve(JSON.stringify(window.__received))"
        )
        if received:
            break
        await asyncio.sleep(0.25)

    if not received:
        failures.append("quick message never arrived")
    elif received[0].get("text") != "Need fuel":
        failures.append(f"quick message text wrong: {received[0]}")

    leaked = await listener
    if leaked is None:
        failures.append("eavesdropper saw no live traffic — check the test")
    else:
        # The frames must be envelopes and nothing else.
        for secret in ("Gateway", "19.076", "Need fuel", "need-fuel", "Alex", "Riya"):
            if secret in leaked:
                failures.append(f"RELAY TRAFFIC IS READABLE — found {secret!r}")
        for line in leaked.splitlines():
            try:
                frame = json.loads(line)
            except json.JSONDecodeError:
                failures.append(f"unexpected non-JSON frame: {line[:80]}")
                continue
            if set(frame) - {"iv", "ct"} and "hs" not in frame:
                failures.append(f"frame carried unexpected fields: {sorted(frame)}")

    # ---- recording and replay -------------------------------------------
    # Each device records what it received, so both should independently hold a
    # track of the other without anything having been uploaded.
    for page in (host, guest):
        await page.evaluate("flushPoints()", await_promise=True)

    host_points = await host.evaluate(
        f"WayseraStore.getPoints('{code}').then(p => p.length)", await_promise=True
    )
    guest_points = await guest.evaluate(
        f"WayseraStore.getPoints('{code}').then(p => p.length)", await_promise=True
    )
    if not host_points:
        failures.append("host recorded nothing")
    if not guest_points:
        failures.append("guest recorded nothing")

    # The replay page must open that recording and render a usable timeline.
    await host.navigate(
        f"{ORIGIN}/replay.html?j={code}",
        ready="Boolean(document.getElementById('replayScrubber'))",
    )
    replay = await host.json_eval("""
        Promise.resolve().then(async () => {
            for (let i = 0; i < 60; i += 1) {
                const scrubber = document.getElementById('replayScrubber');
                if (scrubber && Number(scrubber.max) > 0) break;
                await new Promise(r => setTimeout(r, 100));
            }
            const error = document.getElementById('replayError');
            return JSON.stringify({
                error: error && error.style.display !== 'none' ? error.textContent : null,
                title: document.getElementById('replayTitle').textContent,
                span: Number(document.getElementById('replayScrubber').max),
                events: document.getElementById('replayEvents').children.length,
                speeds: document.getElementById('replaySpeeds').children.length
            });
        })
    """)

    if replay.get("error"):
        failures.append(f"replay page errored: {replay['error']}")
    if replay.get("title") != "Gateway of India":
        failures.append(f"replay title wrong: {replay.get('title')!r}")
    if not replay.get("span"):
        failures.append("replay timeline has no span")
    if replay.get("speeds") != 4:
        failures.append(f"expected 4 playback speeds, got {replay.get('speeds')}")
    if not replay.get("events"):
        failures.append("replay timeline shows no events")

    await host.close()
    await guest.close()
    return failures


async def eavesdrop(channel_id: str, seconds: float, want: int = 1):
    """Join the channel as an unauthorised third party and read what passes.

    Anyone can do this — the channel id is derived from a six-character code
    and the relay asks nothing of whoever connects. That is precisely why the
    payloads have to be unreadable.
    """
    url = f"ws://127.0.0.1:{RELAY_PORT}/v1/relay/{channel_id}"
    async with websockets.connect(url) as socket:
        collected = []
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline and len(collected) < want:
            remaining = deadline - time.monotonic()
            try:
                collected.append(await asyncio.wait_for(socket.recv(), timeout=remaining))
            except asyncio.TimeoutError:
                break
        return "\n".join(collected) if collected else None


def main() -> int:
    static = start_static()
    relay = start_relay()
    profile = tempfile.mkdtemp(prefix="waysera-integration-")
    chrome = start_chrome(profile)

    try:
        failures = asyncio.run(run())
    finally:
        for process in (chrome, relay):
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
        static.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    if failures:
        for failure in failures:
            print(f"FAIL  {failure}")
        print(f"\n{len(failures)} failure(s)")
        return 1

    print("two browsers joined one journey over the live relay; traffic was ciphertext")
    return 0


if __name__ == "__main__":
    sys.exit(main())
