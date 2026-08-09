"""
Channel registry for the Waysera relay.

The hub knows which sockets are attached to which opaque channel and nothing
else. It never inspects a payload; frames arrive as ciphertext and are
forwarded verbatim. Everything here lives in memory and dies with the process;
there is no persistence by design.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Set

from fastapi import WebSocket


@dataclass(frozen=True)
class RelayLimits:
    """Guardrails that keep a public relay from becoming a free broadcast service."""

    max_frame_bytes: int = 64 * 1024
    max_sockets_per_channel: int = 10
    max_channels: int = 5_000
    messages_per_second: float = 20.0
    burst: float = 40.0


class ChannelFull(Exception):
    """The channel already holds the maximum number of participants."""


class TooManyChannels(Exception):
    """The relay is at capacity and cannot open another channel."""


class TokenBucket:
    """Per-socket send allowance, refilled continuously at a fixed rate."""

    __slots__ = ("_capacity", "_rate", "_tokens", "_updated")

    def __init__(self, rate: float, capacity: float) -> None:
        self._rate = rate
        self._capacity = capacity
        self._tokens = capacity
        self._updated = time.monotonic()

    def consume(self, amount: float = 1.0) -> bool:
        now = time.monotonic()
        self._tokens = min(
            self._capacity, self._tokens + (now - self._updated) * self._rate
        )
        self._updated = now
        if self._tokens < amount:
            return False
        self._tokens -= amount
        return True


class RelayHub:
    """Maps channel id -> connected sockets, and forwards frames between them."""

    def __init__(self, limits: Optional[RelayLimits] = None) -> None:
        self.limits = limits or RelayLimits()
        self._channels: Dict[str, Set[WebSocket]] = {}

    @property
    def channel_count(self) -> int:
        return len(self._channels)

    def occupancy(self, channel_id: str) -> int:
        return len(self._channels.get(channel_id, ()))

    def join(self, channel_id: str, socket: WebSocket) -> None:
        sockets = self._channels.get(channel_id)
        if sockets is None:
            if len(self._channels) >= self.limits.max_channels:
                raise TooManyChannels
            sockets = set()
            self._channels[channel_id] = sockets
        if len(sockets) >= self.limits.max_sockets_per_channel:
            raise ChannelFull
        sockets.add(socket)

    def leave(self, channel_id: str, socket: WebSocket) -> None:
        sockets = self._channels.get(channel_id)
        if not sockets:
            return
        sockets.discard(socket)
        if not sockets:
            # Empty channels are dropped so the registry cannot grow unbounded.
            del self._channels[channel_id]

    def peers(self, channel_id: str, sender: WebSocket) -> List[WebSocket]:
        """Everyone on the channel except the sender. Materialised so the
        caller can mutate the channel while iterating."""
        return [s for s in self._channels.get(channel_id, ()) if s is not sender]

    async def relay(self, channel_id: str, sender: WebSocket, frame: str) -> int:
        """Forward one opaque frame to every peer. Returns the delivery count."""
        delivered = 0
        unreachable: List[WebSocket] = []

        for socket in self.peers(channel_id, sender):
            try:
                await socket.send_text(frame)
                delivered += 1
            except Exception:
                # A socket that cannot be written to is gone; reap it rather
                # than letting it linger and count against the channel cap.
                unreachable.append(socket)

        for socket in unreachable:
            self.leave(channel_id, socket)

        return delivered

    def reset(self) -> None:
        """Drop all channels. Used by tests."""
        self._channels.clear()
