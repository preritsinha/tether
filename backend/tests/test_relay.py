"""
Tests for the Waysera relay.

The relay's contract is narrow: forward opaque frames to a channel's other
members, enforce its limits, and keep nothing. These tests pin exactly that,
including the properties that make the zero-knowledge claim meaningful.
"""

import hashlib
import logging

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import main
from services.relay import ChannelFull, RelayHub, RelayLimits, TokenBucket, TooManyChannels


def channel_for(code: str) -> str:
    """Channel ids are the SHA-256 of a journey code, exactly as the client derives them."""
    return hashlib.sha256(code.encode()).hexdigest()


ALPHA = channel_for("ALPHA1")
BRAVO = channel_for("BRAVO2")


@pytest.fixture(autouse=True)
def clean_hub():
    main.hub.reset()
    yield
    main.hub.reset()


@pytest.fixture
def client():
    with TestClient(main.app) as test_client:
        yield test_client


# --------------------------------------------------------------------------
# Health
# --------------------------------------------------------------------------


def test_health_reports_ok(client):
    response = client.get("/v1/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "service": "waysera-relay"}


# --------------------------------------------------------------------------
# Channel identity
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad_channel",
    [
        "ALPHA1",  # a raw journey code, not a digest
        "not-hex-" + "0" * 56,
        "abc",  # too short
        "0" * 63,  # one short of a digest
        "0" * 65,  # one over
        "A" * 64,  # uppercase hex is rejected; the client emits lowercase
    ],
)
def test_non_digest_channel_is_rejected(client, bad_channel):
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect(f"/v1/relay/{bad_channel}") as socket:
            socket.receive_text()
    assert excinfo.value.code == 1008


def test_digest_channel_is_accepted(client):
    with client.websocket_connect(f"/v1/relay/{ALPHA}") as socket:
        socket.send_text("hello")
    assert main.hub.occupancy(ALPHA) == 0


# --------------------------------------------------------------------------
# Forwarding
# --------------------------------------------------------------------------


def test_frame_reaches_peers(client):
    with client.websocket_connect(f"/v1/relay/{ALPHA}") as first:
        with client.websocket_connect(f"/v1/relay/{ALPHA}") as second:
            first.send_text("ciphertext-payload")
            assert second.receive_text() == "ciphertext-payload"


def test_sender_does_not_receive_its_own_frame(client):
    with client.websocket_connect(f"/v1/relay/{ALPHA}") as first:
        with client.websocket_connect(f"/v1/relay/{ALPHA}") as second:
            first.send_text("from-first")
            # If the relay echoed, this would return "from-first" instead.
            second.send_text("from-second")
            assert first.receive_text() == "from-second"
            assert second.receive_text() == "from-first"


def test_frame_reaches_every_peer(client):
    with client.websocket_connect(f"/v1/relay/{ALPHA}") as sender:
        with client.websocket_connect(f"/v1/relay/{ALPHA}") as a:
            with client.websocket_connect(f"/v1/relay/{ALPHA}") as b:
                sender.send_text("broadcast")
                assert a.receive_text() == "broadcast"
                assert b.receive_text() == "broadcast"


def test_channels_are_isolated(client):
    """Traffic must never cross channels.

    Each channel gets a sender and a listener. Both senders fire, then each
    listener is read once: if isolation were broken, the alpha frame would be
    sitting at the head of bravo's queue and the assertion would catch it.
    Checking the *first* frame keeps this deterministic rather than relying on
    a blocking read that would never return.
    """
    with client.websocket_connect(f"/v1/relay/{ALPHA}") as alpha_sender:
        with client.websocket_connect(f"/v1/relay/{ALPHA}") as alpha_listener:
            with client.websocket_connect(f"/v1/relay/{BRAVO}") as bravo_sender:
                with client.websocket_connect(f"/v1/relay/{BRAVO}") as bravo_listener:
                    alpha_sender.send_text("alpha-only")
                    bravo_sender.send_text("bravo-only")

                    assert alpha_listener.receive_text() == "alpha-only"
                    assert bravo_listener.receive_text() == "bravo-only"


def test_relay_is_opaque_to_payload_shape(client):
    """The relay must not care whether a frame is JSON, or valid at all."""
    for payload in ["", "not json {{{", "\x00\x01binary-ish", "🚗"]:
        with client.websocket_connect(f"/v1/relay/{ALPHA}") as first:
            with client.websocket_connect(f"/v1/relay/{ALPHA}") as second:
                first.send_text(payload)
                assert second.receive_text() == payload


# --------------------------------------------------------------------------
# Limits
# --------------------------------------------------------------------------


def test_channel_cap_rejects_the_extra_socket(client, monkeypatch):
    """The cap is exercised with a small hub rather than the production one.

    Standing up eleven concurrent TestClient sockets deadlocks its portal, and
    the number itself is not what matters — that the endpoint refuses the
    socket past the limit is.
    """
    monkeypatch.setattr(main, "hub", RelayHub(RelayLimits(max_sockets_per_channel=2)))

    with client.websocket_connect(f"/v1/relay/{ALPHA}"):
        with client.websocket_connect(f"/v1/relay/{ALPHA}"):
            assert main.hub.occupancy(ALPHA) == 2

            with pytest.raises(WebSocketDisconnect) as excinfo:
                with client.websocket_connect(f"/v1/relay/{ALPHA}") as extra:
                    extra.receive_text()
            assert excinfo.value.code == 1008


def test_oversized_frame_closes_the_socket(client):
    oversized = "x" * (main.limits.max_frame_bytes + 1)
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect(f"/v1/relay/{ALPHA}") as socket:
            socket.send_text(oversized)
            socket.receive_text()
    assert excinfo.value.code == 1009


def test_frame_size_is_measured_in_bytes_not_characters(client):
    """A multi-byte payload just under the character limit is still over in bytes."""
    # Each emoji is 4 bytes, so this is ~2x the byte budget at half the length.
    payload = "🚗" * (main.limits.max_frame_bytes // 2)
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect(f"/v1/relay/{ALPHA}") as socket:
            socket.send_text(payload)
            socket.receive_text()
    assert excinfo.value.code == 1009


def test_flooding_trips_the_rate_limit(client):
    budget = int(main.limits.burst)
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect(f"/v1/relay/{ALPHA}") as socket:
            for _ in range(budget * 3):
                socket.send_text("flood")
            socket.receive_text()
    assert excinfo.value.code == 1008


def test_normal_traffic_stays_under_the_rate_limit(client):
    with client.websocket_connect(f"/v1/relay/{ALPHA}") as first:
        with client.websocket_connect(f"/v1/relay/{ALPHA}") as second:
            # A journey sends a position roughly every 3s; ten frames is far
            # below the allowance and must pass untouched.
            for index in range(10):
                first.send_text(f"position-{index}")
            for index in range(10):
                assert second.receive_text() == f"position-{index}"


# --------------------------------------------------------------------------
# Registry hygiene
# --------------------------------------------------------------------------


def test_empty_channel_is_dropped(client):
    with client.websocket_connect(f"/v1/relay/{ALPHA}"):
        assert main.hub.channel_count == 1
    assert main.hub.channel_count == 0, "an empty channel must not linger"


def test_channel_survives_while_a_peer_remains(client):
    with client.websocket_connect(f"/v1/relay/{ALPHA}"):
        with client.websocket_connect(f"/v1/relay/{ALPHA}"):
            assert main.hub.occupancy(ALPHA) == 2
        assert main.hub.occupancy(ALPHA) == 1
    assert main.hub.channel_count == 0


# --------------------------------------------------------------------------
# Hub and bucket units
# --------------------------------------------------------------------------


class FakeSocket:
    def __init__(self):
        self.sent = []

    async def send_text(self, frame):
        self.sent.append(frame)


def test_hub_raises_when_channel_is_full():
    hub = RelayHub(RelayLimits(max_sockets_per_channel=2))
    hub.join(ALPHA, FakeSocket())
    hub.join(ALPHA, FakeSocket())
    with pytest.raises(ChannelFull):
        hub.join(ALPHA, FakeSocket())


def test_hub_raises_when_relay_is_at_capacity():
    hub = RelayHub(RelayLimits(max_channels=1))
    hub.join(ALPHA, FakeSocket())
    with pytest.raises(TooManyChannels):
        hub.join(BRAVO, FakeSocket())


def test_hub_excludes_the_sender_from_peers():
    hub = RelayHub()
    sender, peer = FakeSocket(), FakeSocket()
    hub.join(ALPHA, sender)
    hub.join(ALPHA, peer)
    assert hub.peers(ALPHA, sender) == [peer]


def test_token_bucket_allows_burst_then_blocks():
    bucket = TokenBucket(rate=0.0, capacity=3)
    assert bucket.consume()
    assert bucket.consume()
    assert bucket.consume()
    assert not bucket.consume(), "capacity is exhausted and the rate is zero"


def test_token_bucket_refills_over_time():
    bucket = TokenBucket(rate=1000.0, capacity=1)
    assert bucket.consume()
    assert not bucket.consume()
    # A generous rate refills the single token almost immediately.
    for _ in range(100_000):
        if bucket.consume():
            break
    else:
        pytest.fail("bucket never refilled")


# --------------------------------------------------------------------------
# Log hygiene
# --------------------------------------------------------------------------


def test_channel_digest_is_redacted_from_logs():
    """A journey code is ~31 bits, so its digest is reversible from a
    precomputed table. If the relay logs the digest, deriving it client-side
    protects nothing — so it must never reach a log record."""
    log_filter = main.RedactChannelIds()

    record = logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg='%s - "WebSocket %s" [accepted]',
        args=("127.0.0.1:1234", f"/v1/relay/{ALPHA}"),
        exc_info=None,
    )

    assert log_filter.filter(record) is True
    rendered = record.getMessage()
    assert ALPHA not in rendered
    assert "<channel>" in rendered


def test_redaction_leaves_ordinary_messages_alone():
    log_filter = main.RedactChannelIds()
    record = logging.LogRecord(
        name="waysera",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="socket joined (occupancy %d)",
        args=(3,),
        exc_info=None,
    )
    assert log_filter.filter(record) is True
    assert record.getMessage() == "socket joined (occupancy 3)"


def test_root_answers_for_platform_health_checks(client):
    """Hosting platforms commonly probe `/`. The previous service answered
    there, so removing it would fail a deploy for a non-code reason."""
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["ok"] is True
