# Waysera — Every journey, together.

Waysera is a lightweight live group-navigation app for people heading to the same destination. Start a temporary journey, share a link or six-character code, and see your group on one live map — no account required.

It is built so that **the server cannot see your journey**. Positions, names, messages and destinations are encrypted on your device. The server forwards bytes it has no way to read, and stores nothing at all.

---

## What it does

- **Live group map.** Everyone's position, speed and heading, plus how far each person is from you and from the destination.
- **Journey codes.** Six characters, no signup. Share a link, or read the code out loud.
- **Turn-by-turn navigation**, with voice guidance and automatic rerouting.
- **Quick messages.** Tap to send "Pulling over", "Need fuel", "Go ahead without me". Tap-only, so nobody types while driving.
- **Journey replay.** Scrub back through a finished journey at 1x to 10x, with everything that happened laid out on a timeline.
- **Export.** Take a journey away as JSON or GPX.

Everything is stored on your device. Journeys you have finished stay in a list until you delete them.

---

## How the privacy works

The server is a **relay**, not a database.

```
Client A ──encrypted──┐                    ┌──encrypted── Client B
                      ├─→  Waysera relay  ─┤
Client C ──encrypted──┘   (forwards bytes) └──encrypted── Client D
```

Each journey has a key generated on the device that created it. That key travels in the **fragment** of the invite link, the part after `#`, which browsers never send to any server. The relay only ever sees an opaque channel identifier and encrypted payloads it cannot open.

Joining by typing a code rather than opening a link means you have no key yet, so an existing member has to grant you one. That exchange requires somebody to look at your name and tap **Allow**.

### What this does not mean

Waysera cannot see your journey. That is not the same as your location never leaving your device, and it would be dishonest to claim otherwise:

| Service | What it receives |
| --- | --- |
| Mapbox | Tile requests, revealing the area you are looking at |
| Nominatim | Every destination search |
| openstreetmap.de | Origin **and** destination for every route |

Replacing these with self-hosted equivalents is on the roadmap, not in the product today.

We also do not claim: guaranteed security, suitability for emergencies, background tracking while the browser is closed, or unlimited group size.

---

## Running it locally

```bash
./start.sh
```

That opens the relay and the web client in separate terminal windows. To stop:

```bash
./stop.sh
```

### Manually

**Relay:**

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

**Web client**, in a second terminal:

```bash
cd web
python3 -m http.server 3000
```

Then open `http://localhost:3000`.

WebCrypto and IndexedDB both need a secure context. `localhost` counts as one, a bare LAN IP does not, so testing on a phone over Wi-Fi needs HTTPS.

---

## Project structure

```
waysera/
├── backend/                 # The relay. It stores nothing.
│   ├── main.py              # Health check + WebSocket relay
│   ├── services/relay.py    # Channel registry and limits
│   └── tests/               # pytest
│
├── web/                     # Client. No build step.
│   ├── index.html
│   ├── replay.html
│   ├── tests.html           # Browser test runner
│   └── assets/
│       ├── crypto.js        # AES-GCM, ECDH handoff, invite links
│       ├── journey.js       # Relay session and protocol
│       ├── store.js         # IndexedDB
│       ├── validate.js      # Peer input validation
│       ├── export.js        # JSON and GPX
│       ├── replay.js        # Playback
│       ├── index.js         # App
│       └── app-mobile.css   # Design system
│
├── tools/                   # Test harnesses
├── BRAND.md                 # Brand source of truth
├── start.sh
└── stop.sh
```

---

## The relay API

Two endpoints. That is the whole surface.

```http
GET /v1/health
```

```
WS /v1/relay/{channel_id}
```

`channel_id` is the lowercase SHA-256 of a journey code, worked out on the client, so the code itself never reaches the server. Anything that is not a 64-character hex digest is refused.

Every frame received is forwarded verbatim to the channel's other sockets and to nobody else. The sender never receives its own frames back. The relay never parses, logs, or retains a payload.

Limits: 64 KB per frame, 20 messages per second per socket, 10 sockets per channel.

---

## Tests

```bash
# Relay
cd backend && .venv/bin/python -m pytest

# Crypto, storage, validation, session, export, replay — runs in real Chrome
python3 tools/run_browser_tests.py

# Loads the actual page and drives a journey creation
backend/.venv/bin/python tools/smoke_app.py

# Two headless browsers and a live relay, end to end
backend/.venv/bin/python tools/integration_test.py
```

The browser suites run in Chrome rather than Node for a reason. The code under test needs WebCrypto **and** IndexedDB, and IndexedDB has no faithful Node equivalent, so a polyfill would end up testing the polyfill.

The integration test also asserts the property everything else rests on. It joins a live journey as an unauthorised third party and checks that what crosses the wire is unreadable.

---

## Deploying

**Relay** — a Render web service, root directory `backend`, start command:

```
uvicorn main:app --host 0.0.0.0 --port $PORT
```

Set `ALLOWED_ORIGINS` to your frontend origin. Note that WebSocket upgrades are not subject to CORS, and the relay uses no cookies or credentials, so this only covers the health check.

**Web client** — a Render static site, root directory `web`, publish directory `.`.

Before switching domains, add the new one to the Mapbox token's URL restrictions. The token in `web/assets/config.js` is a publishable `pk.` token. It is served to every visitor by design, so URL restrictions rather than secrecy are what protect it.

---

## Limitations

- **Background tracking is not possible on the web.** Browsers suspend geolocation when a tab is hidden. A wake lock keeps the screen alive during navigation, but only a native app solves the rest.
- **Journey expiry is advisory.** With no server, nothing enforces it.
- **Nothing survives losing your device.** There is no copy anywhere else. That is the trade the privacy model makes, so export a journey if you want to keep it.

---

## Tech

FastAPI and WebSockets on the relay. Vanilla JavaScript on the client, with no framework and no build step. Leaflet with Mapbox tiles, OSRM routing, WebCrypto and IndexedDB.

---

## License

MIT.

---

*Waysera was previously developed under the working name Tether.*

Built for people who are tired of asking, "Where are you?"
