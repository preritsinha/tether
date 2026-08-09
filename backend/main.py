"""
Waysera — zero-knowledge relay.

This service is deliberately not a database. It forwards opaque frames between
clients that share a channel and retains nothing: no journeys, no people, no
positions, no history. Payloads arrive already encrypted on the device, and the
key travels in the invite link's URL fragment, which browsers never transmit —
so the relay has no way to read what passes through it.

The only state is a map of channel id to connected sockets. It lives in memory
and dies with the connection.
"""

from __future__ import annotations

import logging
import os
import re
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from services.relay import (
    ChannelFull,
    RelayHub,
    RelayLimits,
    TokenBucket,
    TooManyChannels,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("waysera")


class RedactChannelIds(logging.Filter):
    """Strip channel digests out of log records.

    Our own logging never emits a channel id, but uvicorn's access log writes
    the full request path — which carries it. That matters more than it looks:
    a journey code is six characters, so its SHA-256 is trivially reversible
    from a precomputed table. Deriving the channel on the client buys nothing
    if the relay writes it to disk. Scrub it wherever it surfaces.
    """

    _DIGEST = re.compile(r"[0-9a-f]{64}")

    def _scrub(self, value):
        return self._DIGEST.sub("<channel>", value) if isinstance(value, str) else value

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = self._scrub(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(self._scrub(arg) for arg in record.args)
        elif isinstance(record.args, dict):
            record.args = {k: self._scrub(v) for k, v in record.args.items()}
        return True


for _name in ("uvicorn.access", "uvicorn.error", "websockets.server"):
    logging.getLogger(_name).addFilter(RedactChannelIds())

# Channel ids are the client-side SHA-256 of a journey code, so the relay never
# learns the code itself. Anything that is not a 64-character hex digest is
# rejected outright — this is also what stops arbitrary channel names.
CHANNEL_ID = re.compile(r"^[0-9a-f]{64}$")

# WebSocket upgrades are not subject to CORS; this only covers /v1/health.
# There are no cookies or credentials anywhere in the design.
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "*").split(",")
    if origin.strip()
]

limits = RelayLimits()
hub = RelayHub(limits)


@asynccontextmanager
async def lifespan(_: FastAPI):
    logger.info("Waysera relay started (zero-knowledge; no payload is stored or logged)")
    yield
    logger.info("Waysera relay shutting down")


app = FastAPI(
    title="Waysera",
    version="3.0.0",
    description="Zero-knowledge relay for live group navigation.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    """Kept deliberately.

    The previous service answered here, and hosting platforms are commonly
    configured to health-check `/`. Removing it would turn a deploy into a
    rollback for a reason that has nothing to do with the code.
    """
    return {"service": "waysera-relay", "ok": True}


@app.get("/v1/health")
async def health():
    return {"ok": True, "service": "waysera-relay"}


@app.websocket("/v1/relay/{channel_id}")
async def relay(websocket: WebSocket, channel_id: str):
    """Forward every frame received on a channel to that channel's other members.

    The frame is never parsed, logged, or stored. Senders do not receive their
    own frames back.
    """
    await websocket.accept()

    if not CHANNEL_ID.fullmatch(channel_id):
        await websocket.close(code=1008, reason="invalid channel")
        return

    try:
        hub.join(channel_id, websocket)
    except TooManyChannels:
        await websocket.close(code=1013, reason="relay at capacity")
        return
    except ChannelFull:
        await websocket.close(code=1008, reason="channel full")
        return

    # Deliberately logs occupancy only. Channel ids are derived from journey
    # codes, so recording them would undercut the point of the design.
    logger.info("socket joined (occupancy %d)", hub.occupancy(channel_id))

    bucket = TokenBucket(limits.messages_per_second, limits.burst)

    try:
        while True:
            frame = await websocket.receive_text()

            if len(frame.encode("utf-8")) > limits.max_frame_bytes:
                await websocket.close(code=1009, reason="frame too large")
                break

            if not bucket.consume():
                await websocket.close(code=1008, reason="rate limit exceeded")
                break

            await hub.relay(channel_id, websocket, frame)
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.warning("socket closed unexpectedly", exc_info=False)
    finally:
        hub.leave(channel_id, websocket)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
