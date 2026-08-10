/**
 * Waysera journey session.
 *
 * Owns the relay connection and the journey protocol: sealing outbound
 * messages, validating inbound ones, maintaining the roster, and running the
 * key handoff for people who joined by typing a code.
 *
 * WIRE FORMAT
 * -----------
 * Two frame shapes cross the relay, and the difference matters:
 *
 *   {"iv": ..., "ct": ...}   sealed journey traffic, which the relay cannot read
 *   {"hs": {...}}            handshake, which is necessarily in the clear
 *
 * The handshake is plaintext because it cannot be otherwise: someone joining
 * with a code alone holds no key, so they cannot encrypt a request for one.
 * What the relay can therefore observe is that a person by some display name
 * wants into a channel, plus two ephemeral ECDH public keys. It does not
 * learn the journey key. ECDH keeps that from a passive observer.
 *
 * An *active* relay could substitute its own public key and man-in-the-middle
 * the handoff. The mitigation is human: granting a key requires someone to
 * look at the requester's name and tap Allow. Invite links avoid this path
 * entirely, since the key rides in the fragment and no exchange happens.
 */

const WayseraJourney = (() => {
    'use strict';

    const HEARTBEAT_MS = 3000;
    const ROSTER_TICK_MS = 1000;

    // Matches the thresholds the UI has always used for Live/Stale/Offline.
    const LIVE_MS = 10000;
    const STALE_MS = 30000;
    const DROP_MS = 120000;

    const RECONNECT_BASE_MS = 500;
    const RECONNECT_MAX_MS = 15000;

    function generateMemberId() {
        const bytes = crypto.getRandomValues(new Uint8Array(8));
        const hex = Array.from(bytes)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
        return `m_${hex}`;
    }

    function statusFor(lastSeen, now) {
        const age = now - lastSeen;
        if (age <= LIVE_MS) return 'live';
        if (age <= STALE_MS) return 'stale';
        return 'offline';
    }

    class Session {
        constructor(options) {
            this.code = options.code;
            this.key = options.key || null;
            this.name = options.name;
            this.memberId = options.memberId || generateMemberId();
            this.relayBase = options.relayBase;
            this.destination = options.destination || null;
            this.expiresAt = options.expiresAt || null;

            this.socket = null;
            this.channelId = null;
            this.members = new Map();
            this.handlers = new Map();

            this.closed = false;
            this.reconnectAttempt = 0;
            this.heartbeatTimer = null;
            this.rosterTimer = null;

            // Set while we are waiting on someone to grant us the journey key.
            this.pendingHandoff = null;
            this.pendingRequest = null;
            // Requests awaiting an Allow/Deny decision from this device.
            this.pendingRequests = new Map();
        }

        // -------------------------------------------------------------- events

        on(event, handler) {
            if (!this.handlers.has(event)) this.handlers.set(event, new Set());
            this.handlers.get(event).add(handler);
            return () => this.handlers.get(event).delete(handler);
        }

        emit(event, payload) {
            const set = this.handlers.get(event);
            if (!set) return;
            for (const handler of set) {
                try {
                    handler(payload);
                } catch (error) {
                    console.error(`waysera: handler for "${event}" threw`, error);
                }
            }
        }

        // ------------------------------------------------------------ lifecycle

        async connect() {
            this.channelId = await WayseraCrypto.deriveChannelId(this.code);
            // Put ourselves on the roster straight away. Members are otherwise
            // only created by incoming traffic, and our own row appeared only
            // once GPS produced a first fix, so until then you were absent from
            // your own group and the header was short by one.
            this.touchSelf();
            this.openSocket();
            this.startTimers();
        }

        touchSelf() {
            const existing = this.members.get(this.memberId) || {
                memberId: this.memberId,
                name: this.name,
                isSelf: true
            };
            existing.name = this.name;
            existing.lastSeen = Date.now();
            this.members.set(this.memberId, existing);
        }

        openSocket() {
            if (this.closed) return;

            const base = this.relayBase.replace(/^http/, 'ws').replace(/\/+$/, '');
            const socket = new WebSocket(`${base}/v1/relay/${this.channelId}`);
            this.socket = socket;

            socket.onopen = () => {
                this.reconnectAttempt = 0;
                this.emit('connected');
                if (this.key) {
                    this.announce();
                } else {
                    this.requestKey();
                }
            };

            socket.onmessage = (event) => this.handleFrame(event.data);

            socket.onclose = (event) => {
                if (this.closed) return;
                this.emit('disconnected', { code: event.code, reason: event.reason });
                // 1008 means the relay refused us: bad channel, or the journey
                // is full. Retrying would only be refused again.
                if (event.code === 1008 || event.code === 1013) {
                    this.emit('refused', { code: event.code, reason: event.reason });
                    return;
                }
                this.scheduleReconnect();
            };

            socket.onerror = () => {
                // onclose always follows; reconnection is handled there.
            };
        }

        scheduleReconnect() {
            this.reconnectAttempt += 1;
            const delay = Math.min(
                RECONNECT_MAX_MS,
                RECONNECT_BASE_MS * 2 ** (this.reconnectAttempt - 1)
            );
            setTimeout(() => this.openSocket(), delay);
        }

        startTimers() {
            this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
            this.rosterTimer = setInterval(() => this.pruneRoster(), ROSTER_TICK_MS);
        }

        close() {
            this.closed = true;
            clearInterval(this.heartbeatTimer);
            clearInterval(this.rosterTimer);

            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                // Best effort: tell peers we are going rather than making them
                // wait for the roster to time us out.
                this.sendSealed({ type: 'bye', memberId: this.memberId, ts: Date.now() });
                this.socket.close();
            }
            this.socket = null;
        }

        // --------------------------------------------------------------- output

        rawSend(frame) {
            if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
            this.socket.send(JSON.stringify(frame));
            return true;
        }

        async sendSealed(message) {
            if (!this.key) return false;
            return this.rawSend(await WayseraCrypto.seal(this.key, message));
        }

        sendHandshake(message) {
            return this.rawSend({ hs: message });
        }

        announce(reply = false) {
            return this.sendSealed({
                type: 'hello',
                memberId: this.memberId,
                name: this.name,
                reply,
                ts: Date.now()
            });
        }

        heartbeat() {
            this.touchSelf();
            if (!this.key) {
                // Still waiting to be let in. The relay keeps no buffer, so a
                // request made before anyone else was on the channel is gone.
                // Keep asking: whoever arrives next will see it and be
                // prompted. Without this, joining before the rest of the group
                // means waiting forever and nobody ever sees an Allow prompt.
                this.sendKeyRequest();
                return;
            }
            const self = this.members.get(this.memberId);
            if (self && self.lat !== null && self.lat !== undefined) {
                this.sendPosition(self);
            } else {
                this.announce();
            }
        }

        sendPosition(position) {
            this.trackSelf(position);
            return this.sendSealed({
                type: 'position',
                memberId: this.memberId,
                lat: position.lat,
                lng: position.lng,
                heading: position.heading ?? null,
                speed: position.speed ?? null,
                accuracy: position.accuracy ?? null,
                ts: Date.now()
            });
        }

        sendQuickMessage(presetId) {
            return this.sendSealed({
                type: 'quick_message',
                memberId: this.memberId,
                presetId,
                ts: Date.now()
            });
        }

        shareJourneyConfig() {
            if (!this.destination) return false;
            return this.sendSealed({
                type: 'journey_config',
                destination: this.destination,
                expiresAt: this.expiresAt,
                ts: Date.now()
            });
        }

        trackSelf(position) {
            this.touchSelf();
            Object.assign(this.members.get(this.memberId), position);
        }

        // ---------------------------------------------------------------- input

        async handleFrame(raw) {
            let frame;
            try {
                frame = JSON.parse(raw);
            } catch (error) {
                return; // Not ours, or corrupt. Nothing to do.
            }
            if (!frame || typeof frame !== 'object') return;

            // Returned, not fired and forgotten. The handshake and the config
            // reply are async, and letting those promises float means nothing
            // downstream can tell when a frame has finished being processed,
            // reconnection logic and tests included.
            if (frame.hs) {
                return this.handleHandshake(frame.hs);
            }

            if (!this.key) return; // Sealed traffic we cannot open yet.

            const opened = await WayseraCrypto.open(this.key, frame);
            if (opened === null) return;

            const message = WayseraValidate.validatePeerMessage(opened);
            if (!message) return;
            if (message.memberId === this.memberId) return; // Our own echo, if any.

            return this.applyMessage(message);
        }

        async applyMessage(message) {
            switch (message.type) {
                case 'hello':
                    this.touchMember(message.memberId, { name: message.name });
                    if (!message.reply) {
                        // Bring the newcomer up to speed: the destination, and
                        // who we are. Without the second part they would only
                        // ever learn our name if we happened to have no
                        // position to send, since position frames carry none.
                        await this.shareJourneyConfig();
                        await this.announce(true);
                        this.emit('joined', message);
                    }
                    break;

                case 'position':
                    this.touchMember(message.memberId, {
                        lat: message.lat,
                        lng: message.lng,
                        heading: message.heading,
                        speed: message.speed,
                        accuracy: message.accuracy
                    });
                    this.emit('position', message);
                    break;

                case 'quick_message':
                    this.touchMember(message.memberId, {});
                    this.emit('quick_message', message);
                    break;

                case 'journey_config':
                    if (!this.destination) {
                        this.destination = message.destination;
                        this.expiresAt = message.expiresAt;
                        this.emit('journey_config', message);
                    }
                    break;

                case 'bye':
                    this.members.delete(message.memberId);
                    this.emit('left', message);
                    this.emitRoster();
                    break;

                default:
                    break;
            }
        }

        touchMember(memberId, patch) {
            const existing = this.members.get(memberId) || { memberId, name: null };
            Object.assign(existing, patch, { lastSeen: Date.now() });
            this.members.set(memberId, existing);
            this.emitRoster();
        }

        pruneRoster() {
            const now = Date.now();
            let changed = false;
            for (const [memberId, member] of this.members) {
                if (memberId !== this.memberId && now - member.lastSeen > DROP_MS) {
                    this.members.delete(memberId);
                    changed = true;
                }
            }
            // Status is time-derived, so the roster is republished every tick
            // regardless. That is what moves someone to Stale without traffic.
            this.emitRoster();
            if (changed) this.emit('pruned');
        }

        emitRoster() {
            this.emit('roster', this.roster());
        }

        roster() {
            const now = Date.now();
            return Array.from(this.members.values())
                .map((member) => ({
                    ...member,
                    isSelf: member.memberId === this.memberId,
                    status: statusFor(member.lastSeen, now)
                }))
                .sort((a, b) => {
                    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
                    return (a.name || '').localeCompare(b.name || '');
                });
        }

        // ------------------------------------------------------------ handshake

        async requestKey() {
            const pair = await WayseraCrypto.generateHandoffKeyPair();
            this.pendingHandoff = pair;

            // Held so the heartbeat can repeat it. The same ephemeral public
            // key is reused each time, so an approval granted against any
            // attempt still unwraps.
            this.pendingRequest = {
                type: 'key_request',
                memberId: this.memberId,
                name: this.name,
                pub: await WayseraCrypto.exportHandoffPublicKey(pair)
            };

            this.sendKeyRequest();
            this.emit('awaiting_key');
        }

        sendKeyRequest() {
            if (this.key || !this.pendingRequest) return false;
            return this.sendHandshake({ ...this.pendingRequest, ts: Date.now() });
        }

        async handleHandshake(raw) {
            const message = WayseraValidate.validatePeerMessage(raw);
            if (!message) return;

            if (message.type === 'key_request') {
                // Never granted automatically. A human has to look at the name
                // and decide. That tap is the only thing standing between a
                // hostile relay and a substituted public key.
                if (message.memberId === this.memberId) return;
                if (!this.key) return; // We have no key to give.
                this.pendingRequests.set(message.memberId, message);
                this.emit('key_request', message);
                return;
            }

            if (message.type === 'key_grant') {
                return this.acceptKeyGrant(message);
            }
        }

        /** Approve a pending join request and hand over the journey key. */
        async approveKeyRequest(memberId) {
            const request = this.pendingRequests.get(memberId);
            if (!request || !this.key) return false;
            this.pendingRequests.delete(memberId);

            const pair = await WayseraCrypto.generateHandoffKeyPair();
            const secret = await WayseraCrypto.deriveHandoffSecret(
                pair.privateKey,
                await WayseraCrypto.importHandoffPublicKey(request.pub)
            );

            return this.sendHandshake({
                type: 'key_grant',
                memberId: this.memberId,
                forMemberId: memberId,
                pub: await WayseraCrypto.exportHandoffPublicKey(pair),
                wrapped: await WayseraCrypto.wrapJourneyKey(secret, this.key),
                ts: Date.now()
            });
        }

        denyKeyRequest(memberId) {
            // Silent by design. Telling a stranger they were refused only tells
            // them the code was right.
            this.pendingRequests.delete(memberId);
        }

        async acceptKeyGrant(message) {
            if (this.key) return; // Already inside; ignore stray grants.
            if (message.forMemberId !== this.memberId) return;
            if (!this.pendingHandoff) return;

            const secret = await WayseraCrypto.deriveHandoffSecret(
                this.pendingHandoff.privateKey,
                await WayseraCrypto.importHandoffPublicKey(message.pub)
            );
            const key = await WayseraCrypto.unwrapJourneyKey(secret, message.wrapped);
            if (!key) return; // Wrong secret, or a tampered grant.

            this.key = key;
            this.pendingHandoff = null;
            this.pendingRequest = null; // Stops the heartbeat asking again.
            this.emit('key_granted', { key });
            this.announce();
        }
    }

    return { Session, generateMemberId, statusFor, LIVE_MS, STALE_MS, DROP_MS };
})();

window.WayseraJourney = WayseraJourney;
