/**
 * Waysera browser tests.
 *
 * These run in a real browser rather than under Node, because the code under
 * test depends on WebCrypto and IndexedDB — IndexedDB does not exist in Node
 * without polyfills, and a polyfill would be testing the polyfill.
 *
 * Open /tests.html, or let the Python runner drive it and collect results.
 */

(() => {
    'use strict';

    const results = [];
    const tests = [];

    function test(name, fn) {
        tests.push({ name, fn });
    }

    function assert(condition, message) {
        if (!condition) throw new Error(message || 'assertion failed');
    }

    function assertEqual(actual, expected, message) {
        if (actual !== expected) {
            throw new Error(
                `${message || 'not equal'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
            );
        }
    }

    function assertNull(value, message) {
        if (value !== null) {
            throw new Error(`${message || 'expected null'} — got ${JSON.stringify(value)}`);
        }
    }

    const C = () => window.WayseraCrypto;
    const V = () => window.WayseraValidate;
    const S = () => window.WayseraStore;

    // =====================================================================
    // crypto: encoding
    // =====================================================================

    test('base64url round-trips arbitrary bytes', () => {
        const bytes = new Uint8Array([0, 1, 2, 251, 252, 253, 254, 255]);
        const encoded = C().bytesToBase64Url(bytes);
        assert(!/[+/=]/.test(encoded), 'must be url-safe with no padding');
        const decoded = C().base64UrlToBytes(encoded);
        assertEqual(Array.from(decoded).join(','), Array.from(bytes).join(','));
    });

    // =====================================================================
    // crypto: journey codes
    // =====================================================================

    test('journey codes avoid visually ambiguous characters', () => {
        for (let i = 0; i < 200; i += 1) {
            const code = C().generateJourneyCode();
            assertEqual(code.length, 6, 'code length');
            assert(!/[O0I1]/.test(code), `ambiguous character in ${code}`);
            assert(C().isValidCode(code), `generated code must validate: ${code}`);
        }
    });

    test('journey codes are not trivially repeating', () => {
        const seen = new Set();
        for (let i = 0; i < 200; i += 1) seen.add(C().generateJourneyCode());
        assert(seen.size > 190, `expected near-unique codes, got ${seen.size}/200`);
    });

    test('isValidCode rejects malformed input', () => {
        assert(!C().isValidCode(''), 'empty');
        assert(!C().isValidCode('ABC'), 'too short');
        assert(!C().isValidCode('ABCDEFG'), 'too long');
        assert(!C().isValidCode('ABC0EF'), 'excluded character 0');
        assert(!C().isValidCode('ABC-EF'), 'punctuation');
        assert(C().isValidCode('abcdef'), 'lowercase should normalise');
    });

    // =====================================================================
    // crypto: channel derivation
    // =====================================================================

    test('channel id is 64 lowercase hex and deterministic', async () => {
        const a = await C().deriveChannelId('ABC234');
        const b = await C().deriveChannelId('ABC234');
        assertEqual(a, b, 'must be deterministic');
        assert(/^[0-9a-f]{64}$/.test(a), `relay requires lowercase hex digest, got ${a}`);
    });

    test('channel id ignores code casing and surrounding space', async () => {
        const canonical = await C().deriveChannelId('ABC234');
        assertEqual(await C().deriveChannelId('abc234'), canonical);
        assertEqual(await C().deriveChannelId('  ABC234  '), canonical);
    });

    test('different codes produce different channels', async () => {
        const a = await C().deriveChannelId('ABC234');
        const b = await C().deriveChannelId('ABC235');
        assert(a !== b, 'distinct codes must not collide');
    });

    // =====================================================================
    // crypto: sealing
    // =====================================================================

    test('journey key exports and re-imports', async () => {
        const key = await C().generateJourneyKey();
        const encoded = await C().exportJourneyKey(key);
        const reimported = await C().importJourneyKey(encoded);
        const sealed = await C().seal(key, { hello: 'there' });
        const opened = await C().open(reimported, sealed);
        assertEqual(opened.hello, 'there');
    });

    test('importJourneyKey rejects a wrong-length key', async () => {
        let threw = false;
        try {
            await C().importJourneyKey(C().bytesToBase64Url(new Uint8Array(16)));
        } catch (error) {
            threw = true;
        }
        assert(threw, 'a 128-bit key must be rejected');
    });

    test('seal produces an opaque envelope and open reverses it', async () => {
        const key = await C().generateJourneyKey();
        const message = { type: 'position', lat: 19.076, lng: 72.8777 };
        const sealed = await C().seal(key, message);

        assert(typeof sealed.iv === 'string' && typeof sealed.ct === 'string', 'envelope shape');
        const asText = JSON.stringify(sealed);
        assert(!asText.includes('position'), 'plaintext type must not be visible');
        assert(!asText.includes('19.076'), 'coordinates must not be visible');

        const opened = await C().open(key, sealed);
        assertEqual(opened.lat, 19.076);
        assertEqual(opened.lng, 72.8777);
    });

    test('each seal uses a fresh nonce', async () => {
        const key = await C().generateJourneyKey();
        const first = await C().seal(key, { same: 'payload' });
        const second = await C().seal(key, { same: 'payload' });
        assert(first.iv !== second.iv, 'IV must not repeat');
        assert(first.ct !== second.ct, 'identical plaintext must not yield identical ciphertext');
    });

    test('open returns null for the wrong key', async () => {
        const sealed = await C().seal(await C().generateJourneyKey(), { secret: 1 });
        assertNull(await C().open(await C().generateJourneyKey(), sealed));
    });

    test('open rejects tampered ciphertext', async () => {
        const key = await C().generateJourneyKey();
        const sealed = await C().seal(key, { lat: 19.076 });

        const bytes = C().base64UrlToBytes(sealed.ct);
        bytes[0] ^= 0xff;
        const tampered = { iv: sealed.iv, ct: C().bytesToBase64Url(bytes) };

        assertNull(await C().open(key, tampered), 'AES-GCM must reject modified ciphertext');
    });

    test('open returns null rather than throwing on garbage', async () => {
        const key = await C().generateJourneyKey();
        assertNull(await C().open(key, null));
        assertNull(await C().open(key, {}));
        assertNull(await C().open(key, { iv: 'x', ct: 'y' }));
        assertNull(await C().open(key, { iv: 123, ct: 456 }));
    });

    // =====================================================================
    // crypto: ECDH handoff
    // =====================================================================

    test('two parties derive the same handoff secret', async () => {
        const host = await C().generateHandoffKeyPair();
        const joiner = await C().generateHandoffKeyPair();

        const hostPub = await C().exportHandoffPublicKey(host);
        const joinerPub = await C().exportHandoffPublicKey(joiner);

        const hostSecret = await C().deriveHandoffSecret(
            host.privateKey,
            await C().importHandoffPublicKey(joinerPub)
        );
        const joinerSecret = await C().deriveHandoffSecret(
            joiner.privateKey,
            await C().importHandoffPublicKey(hostPub)
        );

        const journeyKey = await C().generateJourneyKey();
        const wrapped = await C().wrapJourneyKey(hostSecret, journeyKey);
        const unwrapped = await C().unwrapJourneyKey(joinerSecret, wrapped);

        assert(unwrapped !== null, 'joiner must recover the journey key');

        // The recovered key must actually open traffic sealed with the original.
        const sealed = await C().seal(journeyKey, { proof: 'handoff works' });
        assertEqual((await C().open(unwrapped, sealed)).proof, 'handoff works');
    });

    test('an eavesdropper cannot unwrap the journey key', async () => {
        const host = await C().generateHandoffKeyPair();
        const joiner = await C().generateHandoffKeyPair();
        const attacker = await C().generateHandoffKeyPair();

        const hostSecret = await C().deriveHandoffSecret(
            host.privateKey,
            await C().importHandoffPublicKey(await C().exportHandoffPublicKey(joiner))
        );
        const attackerSecret = await C().deriveHandoffSecret(
            attacker.privateKey,
            await C().importHandoffPublicKey(await C().exportHandoffPublicKey(host))
        );

        const wrapped = await C().wrapJourneyKey(hostSecret, await C().generateJourneyKey());
        assertNull(await C().unwrapJourneyKey(attackerSecret, wrapped));
    });

    // =====================================================================
    // crypto: invite links
    // =====================================================================

    test('invite link keeps code and key in the fragment', async () => {
        const key = await C().generateJourneyKey();
        const encoded = await C().exportJourneyKey(key);
        const link = C().buildInviteLink('https://example.com', 'ABC234', encoded);

        const url = new URL(link);
        assertEqual(url.search, '', 'nothing may sit in the query string');
        assert(url.hash.includes('ABC234'), 'code belongs in the fragment');
        assert(url.hash.includes(encoded), 'key belongs in the fragment');
        // The fragment is the whole point: browsers never transmit it.
        assert(link.indexOf('#') < link.indexOf(encoded), 'key must come after the #');
    });

    test('invite fragment parses back to code and key', async () => {
        const encoded = await C().exportJourneyKey(await C().generateJourneyKey());
        const link = C().buildInviteLink('https://example.com', 'ABC234', encoded);
        const parsed = C().parseInviteFragment(new URL(link).hash);

        assertEqual(parsed.code, 'ABC234');
        assertEqual(parsed.key, encoded);
    });

    test('a code-only fragment parses with a null key', () => {
        const parsed = C().parseInviteFragment('#/j/ABC234');
        assertEqual(parsed.code, 'ABC234');
        assertEqual(parsed.key, null);
    });

    test('non-invite fragments are rejected', () => {
        assertNull(C().parseInviteFragment(''));
        assertNull(C().parseInviteFragment('#/somewhere'));
        assertNull(C().parseInviteFragment('#/j/BAD'), 'invalid code must not parse');
        assertNull(C().parseInviteFragment('#/j/ABC0EF'), 'excluded character');
    });

    // =====================================================================
    // validate: escaping
    // =====================================================================

    test('escapeHtml neutralises an injection payload', () => {
        const payload = '<img src=x onerror=alert(1)>';
        const escaped = V().escapeHtml(payload);
        assert(!escaped.includes('<'), 'no raw angle brackets may survive');
        assert(!escaped.includes('>'), 'no raw angle brackets may survive');
        assertEqual(escaped, '&lt;img src=x onerror=alert(1)&gt;');
    });

    test('escapeHtml handles quotes and ampersands', () => {
        assertEqual(V().escapeHtml(`" ' &`), '&quot; &#39; &amp;');
    });

    test('setText writes literally, never as markup', () => {
        const host = document.createElement('div');
        V().setText(host, '<b>not bold</b>');
        assertEqual(host.children.length, 0, 'no elements may be created');
        assertEqual(host.textContent, '<b>not bold</b>');
    });

    // =====================================================================
    // validate: names
    // =====================================================================

    test('cleanName strips control and bidi characters', () => {
        // Escapes, not literals: these characters are invisible in a diff,
        // and a bidi override in a display name is exactly the trick this
        // test exists to catch.
        assertEqual(V().cleanName('Ri\u0000ya'), 'Riya', 'NUL');
        assertEqual(V().cleanName('Ri\u202Eya'), 'Riya', 'bidi override');
        assertEqual(V().cleanName('Ri\u200Bya'), 'Riya', 'zero-width space');
        assertEqual(V().cleanName('\uFEFFRiya'), 'Riya', 'BOM');
        assertEqual(V().cleanName('Ri\u001Fya'), 'Riya', 'unit separator');
    });

    test('cleanName collapses whitespace and trims', () => {
        assertEqual(V().cleanName('  Riya   Sharma  '), 'Riya Sharma');
    });

    test('cleanName caps length and rejects empties', () => {
        assertEqual(V().cleanName('x'.repeat(200)).length, V().MAX_NAME_LENGTH);
        assertNull(V().cleanName(''));
        assertNull(V().cleanName('   '));
        assertNull(V().cleanName(42));
        assertNull(V().cleanName(null));
    });

    // =====================================================================
    // validate: messages
    // =====================================================================

    const GOOD_ID = 'm_abcdef123456';

    test('unknown message types are dropped', () => {
        assertNull(V().validatePeerMessage({ type: 'evil', memberId: GOOD_ID }));
        assertNull(V().validatePeerMessage({ type: 'exec' }));
        assertNull(V().validatePeerMessage(null));
        assertNull(V().validatePeerMessage('a string'));
        assertNull(V().validatePeerMessage([]));
    });

    test('prototype-shaped type names cannot reach a validator', () => {
        // Without a hasOwnProperty guard these resolve to Object.prototype
        // members and would be invoked as validators.
        assertNull(V().validatePeerMessage({ type: 'constructor' }));
        assertNull(V().validatePeerMessage({ type: '__proto__' }));
        assertNull(V().validatePeerMessage({ type: 'toString' }));
        assertNull(V().validatePeerMessage({ type: 'hasOwnProperty' }));
    });

    test('a valid position is accepted and rebuilt, not passed through', () => {
        const incoming = {
            type: 'position',
            memberId: GOOD_ID,
            lat: 19.076,
            lng: 72.8777,
            heading: 90,
            speed: 12,
            ts: 1700000000000,
            smuggled: '<script>alert(1)</script>'
        };
        const clean = V().validatePeerMessage(incoming);

        assert(clean !== null, 'should validate');
        assert(clean !== incoming, 'must return a new object');
        assertEqual(clean.smuggled, undefined, 'unknown fields must not survive');
        assertEqual(clean.lat, 19.076);
    });

    test('positions with impossible coordinates are dropped', () => {
        const base = { type: 'position', memberId: GOOD_ID, ts: 1700000000000 };
        assertNull(V().validatePeerMessage({ ...base, lat: 91, lng: 0 }), 'lat > 90');
        assertNull(V().validatePeerMessage({ ...base, lat: 0, lng: 181 }), 'lng > 180');
        assertNull(V().validatePeerMessage({ ...base, lat: NaN, lng: 0 }), 'NaN');
        assertNull(V().validatePeerMessage({ ...base, lat: Infinity, lng: 0 }), 'Infinity');
        assertNull(V().validatePeerMessage({ ...base, lat: '19.0', lng: 0 }), 'numeric string');
        assertNull(V().validatePeerMessage({ ...base, lat: null, lng: 0 }), 'null');
    });

    test('malformed member ids are dropped', () => {
        const base = { type: 'position', lat: 0, lng: 0, ts: 1 };
        assertNull(V().validatePeerMessage({ ...base, memberId: 'short' }));
        assertNull(V().validatePeerMessage({ ...base, memberId: 'has spaces!!' }));
        assertNull(V().validatePeerMessage({ ...base, memberId: 'x'.repeat(100) }));
        assertNull(V().validatePeerMessage({ ...base, memberId: 42 }));
    });

    test('heading wraps instead of being rejected', () => {
        const base = { type: 'position', memberId: GOOD_ID, lat: 0, lng: 0, ts: 1 };
        assertEqual(V().validatePeerMessage({ ...base, heading: 360 }).heading, 0);
        assertEqual(V().validatePeerMessage({ ...base, heading: -90 }).heading, 270);
        assertEqual(V().validatePeerMessage({ ...base, heading: 450 }).heading, 90);
        assertNull(V().validatePeerMessage({ ...base, heading: NaN }).heading);
    });

    test('absurd speeds are discarded but the position survives', () => {
        const base = { type: 'position', memberId: GOOD_ID, lat: 0, lng: 0, ts: 1 };
        assertNull(V().validatePeerMessage({ ...base, speed: 99999 }).speed);
        assertNull(V().validatePeerMessage({ ...base, speed: -5 }).speed);
        assertEqual(V().validatePeerMessage({ ...base, speed: 25 }).speed, 25);
    });

    test('quick messages must name a known preset', () => {
        const base = { type: 'quick_message', memberId: GOOD_ID, ts: 1 };
        assertNull(V().validatePeerMessage({ ...base, presetId: 'unknown' }));
        assertNull(V().validatePeerMessage({ ...base, presetId: '<script>alert(1)</script>' }));
        assertNull(V().validatePeerMessage({ ...base, presetId: 'constructor' }));

        const clean = V().validatePeerMessage({ ...base, presetId: 'need-fuel' });
        assertEqual(clean.presetId, 'need-fuel');
        assertEqual(clean.text, 'Need fuel', 'text comes from our table, never the peer');
    });

    test('quick message text cannot be overridden by the sender', () => {
        const clean = V().validatePeerMessage({
            type: 'quick_message',
            memberId: GOOD_ID,
            presetId: 'need-fuel',
            text: '<img src=x onerror=alert(1)>',
            ts: 1
        });
        assertEqual(clean.text, 'Need fuel');
    });

    test('a hostile display name is sanitised, not rejected outright', () => {
        const clean = V().validatePeerMessage({
            type: 'hello',
            memberId: GOOD_ID,
            name: '<img src=x onerror=alert(1)>',
            ts: 1
        });
        assert(clean !== null, 'the name is escaped at render time, so accept it');
        assertEqual(clean.name, '<img src=x onerror=alert(1)>'.slice(0, V().MAX_NAME_LENGTH));
        // The guarantee is that rendering it is safe.
        assert(!V().escapeHtml(clean.name).includes('<'), 'must be safe once escaped');
    });

    test('key_grant requires a well-formed wrapped envelope', () => {
        const base = { type: 'key_grant', memberId: GOOD_ID, forMemberId: GOOD_ID, pub: 'abc123', ts: 1 };
        assertNull(V().validatePeerMessage({ ...base }));
        assertNull(V().validatePeerMessage({ ...base, wrapped: {} }));
        assertNull(V().validatePeerMessage({ ...base, wrapped: { iv: 'a!', ct: 'b' } }), 'non-base64url');
        assert(V().validatePeerMessage({ ...base, wrapped: { iv: 'aaa', ct: 'bbb' } }) !== null);
    });

    test('journey_config validates its destination', () => {
        const base = { type: 'journey_config', ts: 1 };
        assertNull(V().validatePeerMessage({ ...base }));
        assertNull(V().validatePeerMessage({ ...base, destination: { name: 'X', lat: 999, lng: 0 } }));

        const clean = V().validatePeerMessage({
            ...base,
            destination: { name: '  Gateway of India  ', lat: 18.922, lng: 72.834 }
        });
        assertEqual(clean.destination.name, 'Gateway of India');
    });

    // =====================================================================
    // store
    // =====================================================================

    test('journey round-trips through IndexedDB with its CryptoKey intact', async () => {
        await S().clearAll();
        const key = await C().generateJourneyKey();

        await S().putJourney({
            code: 'ABC234',
            key,
            destination: { name: 'Gateway of India', lat: 18.922, lng: 72.834 },
            createdAt: 1700000000000
        });

        const loaded = await S().getJourney('ABC234');
        assertEqual(loaded.destination.name, 'Gateway of India');

        // The stored key must still work, not just survive as an object.
        const sealed = await C().seal(loaded.key, { proof: 'stored key works' });
        assertEqual((await C().open(key, sealed)).proof, 'stored key works');
    });

    test('points are stored and returned in time order', async () => {
        await S().clearAll();
        await S().appendPoints('ABC234', [
            { memberId: 'm_bbbbbbbbbbbb', ts: 300, lat: 3, lng: 3 },
            { memberId: 'm_aaaaaaaaaaaa', ts: 100, lat: 1, lng: 1 },
            { memberId: 'm_aaaaaaaaaaaa', ts: 200, lat: 2, lng: 2 }
        ]);

        const points = await S().getPoints('ABC234');
        assertEqual(points.length, 3);
        assertEqual(points.map((p) => p.ts).join(','), '100,200,300');
    });

    test('points can be read back per member', async () => {
        await S().clearAll();
        await S().appendPoints('ABC234', [
            { memberId: 'm_aaaaaaaaaaaa', ts: 100, lat: 1, lng: 1 },
            { memberId: 'm_bbbbbbbbbbbb', ts: 150, lat: 9, lng: 9 },
            { memberId: 'm_aaaaaaaaaaaa', ts: 200, lat: 2, lng: 2 }
        ]);

        const mine = await S().getPointsByMember('ABC234', 'm_aaaaaaaaaaaa');
        assertEqual(mine.length, 2);
        assertEqual(mine.map((p) => p.lat).join(','), '1,2');
    });

    test('journeys are isolated from one another', async () => {
        await S().clearAll();
        await S().appendPoints('ABC234', [{ memberId: 'm_aaaaaaaaaaaa', ts: 1, lat: 1, lng: 1 }]);
        await S().appendPoints('XYZ789', [{ memberId: 'm_aaaaaaaaaaaa', ts: 1, lat: 2, lng: 2 }]);

        assertEqual((await S().getPoints('ABC234')).length, 1);
        assertEqual((await S().getPoints('XYZ789')).length, 1);
        assertEqual((await S().getPoints('ABC234'))[0].lat, 1);
    });

    test('deleting a journey cascades to its points and events', async () => {
        await S().clearAll();
        await S().putJourney({ code: 'ABC234', createdAt: 1 });
        await S().appendPoints('ABC234', [
            { memberId: 'm_aaaaaaaaaaaa', ts: 1, lat: 1, lng: 1 },
            { memberId: 'm_aaaaaaaaaaaa', ts: 2, lat: 2, lng: 2 }
        ]);
        await S().appendEvent('ABC234', { ts: 1, kind: 'joined', data: { name: 'Riya' } });
        await S().appendPoints('XYZ789', [{ memberId: 'm_bbbbbbbbbbbb', ts: 1, lat: 5, lng: 5 }]);

        await S().deleteJourney('ABC234');

        assertEqual(await S().getJourney('ABC234'), undefined, 'journey gone');
        assertEqual((await S().getPoints('ABC234')).length, 0, 'points must not be orphaned');
        assertEqual((await S().getEvents('ABC234')).length, 0, 'events must not be orphaned');
        assertEqual((await S().getPoints('XYZ789')).length, 1, 'other journeys untouched');
    });

    test('an over-cap track is halved, keeping first and last points', async () => {
        await S().clearAll();
        const points = [];
        for (let i = 0; i < 60; i += 1) {
            points.push({ memberId: 'm_aaaaaaaaaaaa', ts: i * 1000, lat: i, lng: i });
        }
        await S().appendPoints('ABC234', points);

        const removed = await S().pruneMemberPoints('ABC234', 'm_aaaaaaaaaaaa', 40);
        assert(removed > 0, 'should have pruned');

        const kept = await S().getPointsByMember('ABC234', 'm_aaaaaaaaaaaa');
        assert(kept.length < 60, 'track should shrink');
        assertEqual(kept[0].ts, 0, 'first point anchors the timeline');
        assertEqual(kept[kept.length - 1].ts, 59000, 'last point anchors the timeline');
    });

    test('pruning leaves a track under the cap alone', async () => {
        await S().clearAll();
        await S().appendPoints('ABC234', [
            { memberId: 'm_aaaaaaaaaaaa', ts: 1, lat: 1, lng: 1 },
            { memberId: 'm_aaaaaaaaaaaa', ts: 2, lat: 2, lng: 2 }
        ]);
        assertEqual(await S().pruneMemberPoints('ABC234', 'm_aaaaaaaaaaaa', 40), 0);
        assertEqual((await S().getPointsByMember('ABC234', 'm_aaaaaaaaaaaa')).length, 2);
    });

    // =====================================================================
    // journey session
    // =====================================================================

    const J = () => window.WayseraJourney;

    /**
     * Wire two sessions directly to each other, standing in for the relay.
     * Frames are JSON-round-tripped so the sessions see exactly what a real
     * socket would deliver.
     */
    function connectPair(a, b) {
        const inflight = [];
        const link = (from, to) => {
            from.rawSend = (frame) => {
                inflight.push(to.handleFrame(JSON.stringify(frame)));
                return true;
            };
        };
        link(a, b);
        link(b, a);

        return async function settle() {
            // Handlers dispatch further frames, so drain until quiet.
            for (let pass = 0; pass < 20 && inflight.length; pass += 1) {
                await Promise.all(inflight.splice(0));
            }
        };
    }

    async function makeSession(overrides = {}) {
        return new (J().Session)({
            code: 'ABC234',
            name: 'Someone',
            relayBase: 'http://localhost',
            ...overrides
        });
    }

    test('member ids satisfy the validator', () => {
        for (let i = 0; i < 50; i += 1) {
            const id = J().generateMemberId();
            assert(V().memberId(id) !== null, `generated id must validate: ${id}`);
        }
    });

    test('status moves live to stale to offline with age', () => {
        const now = 1000000;
        assertEqual(J().statusFor(now, now), 'live');
        assertEqual(J().statusFor(now - 5000, now), 'live');
        assertEqual(J().statusFor(now - 20000, now), 'stale');
        assertEqual(J().statusFor(now - 60000, now), 'offline');
    });

    test('a position from a peer lands on the roster', async () => {
        const key = await C().generateJourneyKey();
        const host = await makeSession({ key, name: 'Host' });
        const peer = await makeSession({ key, name: 'Peer' });
        const settle = connectPair(host, peer);

        await peer.sendPosition({ lat: 19.076, lng: 72.8777, heading: 90, speed: 12 });
        await settle();

        const entry = host.roster().find((m) => m.memberId === peer.memberId);
        assert(entry, 'peer should appear on the roster');
        assertEqual(entry.lat, 19.076);
        assertEqual(entry.speed, 12);
        assertEqual(entry.status, 'live');
    });

    test('a session ignores frames it cannot open', async () => {
        const host = await makeSession({ key: await C().generateJourneyKey() });
        const stranger = await makeSession({ key: await C().generateJourneyKey() });
        const settle = connectPair(host, stranger);

        await stranger.sendPosition({ lat: 1, lng: 1 });
        await settle();

        assertEqual(host.roster().length, 0, 'a different key must not reach the roster');
    });

    test('bye removes the member immediately', async () => {
        const key = await C().generateJourneyKey();
        const host = await makeSession({ key, name: 'Host' });
        const peer = await makeSession({ key, name: 'Peer' });
        const settle = connectPair(host, peer);

        await peer.announce();
        await settle();
        assertEqual(host.roster().length, 1);

        await host.handleFrame(
            JSON.stringify(await C().seal(key, {
                type: 'bye', memberId: peer.memberId, ts: Date.now()
            }))
        );
        assertEqual(host.roster().length, 0, 'bye should drop the member');
    });

    test('journey config reaches someone who joined by link', async () => {
        const key = await C().generateJourneyKey();
        const host = await makeSession({
            key,
            name: 'Host',
            destination: { name: 'Gateway of India', lat: 18.922, lng: 72.834 }
        });
        const joiner = await makeSession({ key, name: 'Joiner' });
        const settle = connectPair(host, joiner);

        assertEqual(joiner.destination, null, 'joiner starts with no destination');

        await joiner.announce();
        await settle();

        assert(joiner.destination !== null, 'host should have shared the destination');
        assertEqual(joiner.destination.name, 'Gateway of India');
    });

    test('code-only join completes through the approved handoff', async () => {
        const key = await C().generateJourneyKey();
        const host = await makeSession({
            key,
            name: 'Host',
            destination: { name: 'Gateway of India', lat: 18.922, lng: 72.834 }
        });
        const joiner = await makeSession({ key: null, name: 'Riya' });
        const settle = connectPair(host, joiner);

        let prompted = null;
        host.on('key_request', (request) => { prompted = request; });

        await joiner.requestKey();
        await settle();

        assert(prompted !== null, 'host must be prompted, never auto-granted');
        assertEqual(prompted.name, 'Riya');
        assertEqual(joiner.key, null, 'no key before approval');

        await host.approveKeyRequest(joiner.memberId);
        await settle();

        assert(joiner.key !== null, 'joiner should hold the journey key');

        // The granted key must actually open host traffic, and the joiner
        // should have been brought up to speed on the destination.
        await host.sendPosition({ lat: 19.076, lng: 72.8777 });
        await settle();

        const entry = joiner.roster().find((m) => m.memberId === host.memberId);
        assert(entry, 'host should be visible to the joiner');
        assertEqual(entry.lat, 19.076);
        assertEqual(joiner.destination.name, 'Gateway of India');
    });

    test('a key request sent to an empty channel is retried', async () => {
        // The relay has no buffer, so a request made before anyone else is on
        // the channel simply vanishes. Asking once is not enough.
        const key = await C().generateJourneyKey();
        const joiner = await makeSession({ key: null, name: 'Riya' });

        let sentIntoTheVoid = 0;
        joiner.rawSend = () => { sentIntoTheVoid += 1; return true; };
        await joiner.requestKey();
        assertEqual(sentIntoTheVoid, 1, 'first attempt goes nowhere');

        // The host turns up afterwards.
        const host = await makeSession({ key, name: 'Alex' });
        const settle = connectPair(host, joiner);

        let prompted = null;
        host.on('key_request', (request) => { prompted = request; });

        joiner.heartbeat();
        await settle();

        assert(prompted !== null, 'the request must repeat until somebody answers');
        assertEqual(prompted.name, 'Riya');
    });

    test('retries stop once the key has been granted', async () => {
        const key = await C().generateJourneyKey();
        const host = await makeSession({ key, name: 'Alex' });
        const joiner = await makeSession({ key: null, name: 'Riya' });
        const settle = connectPair(host, joiner);

        await joiner.requestKey();
        await settle();
        await host.approveKeyRequest(joiner.memberId);
        await settle();
        assert(joiner.key !== null, 'joiner should be in');

        let asked = 0;
        host.on('key_request', () => { asked += 1; });
        joiner.heartbeat();
        joiner.heartbeat();
        await settle();
        assertEqual(asked, 0, 'no further requests once we are inside');
    });

    test('denying a request hands over nothing', async () => {
        const host = await makeSession({ key: await C().generateJourneyKey(), name: 'Host' });
        const joiner = await makeSession({ key: null, name: 'Stranger' });
        const settle = connectPair(host, joiner);

        await joiner.requestKey();
        await settle();

        host.denyKeyRequest(joiner.memberId);
        await settle();

        assertEqual(joiner.key, null, 'denial must leave the joiner without a key');

        // And a later approval attempt for the same id must find nothing pending.
        assertEqual(await host.approveKeyRequest(joiner.memberId), false);
        await settle();
        assertEqual(joiner.key, null);
    });

    test('a key grant addressed to someone else is ignored', async () => {
        const host = await makeSession({ key: await C().generateJourneyKey(), name: 'Host' });
        const joiner = await makeSession({ key: null, name: 'Joiner' });
        const settle = connectPair(host, joiner);

        await joiner.requestKey();
        await settle();

        // Approve, but rewrite the grant to name a different recipient.
        const original = host.sendHandshake.bind(host);
        host.sendHandshake = (message) =>
            original({ ...message, forMemberId: 'm_ffffffffffff' });

        await host.approveKeyRequest(joiner.memberId);
        await settle();

        assertEqual(joiner.key, null, 'a grant for another member must not apply');
    });

    test('handshake frames stay outside the sealed envelope', async () => {
        const joiner = await makeSession({ key: null, name: 'Riya' });
        const sent = [];
        joiner.rawSend = (frame) => { sent.push(frame); return true; };

        await joiner.requestKey();

        assertEqual(sent.length, 1);
        assert(sent[0].hs, 'a key request must travel as a handshake frame');
        assertEqual(sent[0].iv, undefined, 'it cannot be sealed — there is no key yet');
        assertEqual(sent[0].hs.type, 'key_request');
    });

    test('stale members are dropped once past the timeout', async () => {
        const key = await C().generateJourneyKey();
        const host = await makeSession({ key, name: 'Host' });
        const peer = await makeSession({ key, name: 'Peer' });
        const settle = connectPair(host, peer);

        await peer.announce();
        await settle();
        assertEqual(host.roster().length, 1);

        const entry = host.members.get(peer.memberId);
        entry.lastSeen = Date.now() - (J().DROP_MS + 1000);

        host.pruneRoster();
        assertEqual(host.roster().length, 0, 'a long-silent member should be dropped');
    });

    test('joining mid-journey learns the names already present', async () => {
        // Regression: position frames carry no name, so someone who joined
        // after everyone else would show as an unnamed row forever.
        const key = await C().generateJourneyKey();
        const host = await makeSession({ key, name: 'Alex' });
        const guest = await makeSession({ key, name: 'Riya' });
        const settle = connectPair(host, guest);

        await guest.announce();
        await settle();

        const seen = guest.roster().find((m) => m.memberId === host.memberId);
        assert(seen, 'the host should be on the roster');
        assertEqual(seen.name, 'Alex', 'and the host should have a name');
    });

    test('introductions do not echo back and forth', async () => {
        const key = await C().generateJourneyKey();
        const host = await makeSession({ key, name: 'Alex' });
        const guest = await makeSession({ key, name: 'Riya' });

        let frames = 0;
        const inflight = [];
        host.rawSend = (frame) => {
            frames += 1;
            inflight.push(guest.handleFrame(JSON.stringify(frame)));
            return true;
        };
        guest.rawSend = (frame) => {
            frames += 1;
            inflight.push(host.handleFrame(JSON.stringify(frame)));
            return true;
        };

        await guest.announce();
        for (let pass = 0; pass < 20 && inflight.length; pass += 1) {
            await Promise.all(inflight.splice(0));
        }

        // hello out, then a single reply back. A reply that triggered another
        // reply would run away here instead of settling.
        assert(frames <= 4, `introductions should settle quickly, saw ${frames} frames`);
    });

    test('a quick message reaches peers carrying our own preset text', async () => {
        const key = await C().generateJourneyKey();
        const host = await makeSession({ key, name: 'Host' });
        const peer = await makeSession({ key, name: 'Peer' });
        const settle = connectPair(host, peer);

        let received = null;
        host.on('quick_message', (message) => { received = message; });

        await peer.sendQuickMessage('need-fuel');
        await settle();

        assert(received !== null, 'the message should arrive');
        assertEqual(received.presetId, 'need-fuel');
        assertEqual(received.text, 'Need fuel');
        assertEqual(received.memberId, peer.memberId);
    });

    test('an unknown preset never reaches a handler', async () => {
        const key = await C().generateJourneyKey();
        const host = await makeSession({ key, name: 'Host' });
        const peer = await makeSession({ key, name: 'Peer' });
        const settle = connectPair(host, peer);

        let received = null;
        host.on('quick_message', (message) => { received = message; });

        // Sealed with the right key, so it decrypts — validation is the only
        // thing standing between this and the UI.
        await peer.sendSealed({
            type: 'quick_message',
            memberId: peer.memberId,
            presetId: '<img src=x onerror=alert(1)>',
            text: 'anything at all',
            ts: Date.now()
        });
        await settle();

        assertNull(received, 'an unlisted preset must be discarded');
    });

    test('a peer cannot dictate the text shown for a preset', async () => {
        const key = await C().generateJourneyKey();
        const host = await makeSession({ key, name: 'Host' });
        const peer = await makeSession({ key, name: 'Peer' });
        const settle = connectPair(host, peer);

        let received = null;
        host.on('quick_message', (message) => { received = message; });

        await peer.sendSealed({
            type: 'quick_message',
            memberId: peer.memberId,
            presetId: 'need-fuel',
            text: '<img src=x onerror=alert(1)>',
            ts: Date.now()
        });
        await settle();

        assertEqual(received.text, 'Need fuel', 'text comes from our table');
    });

    test('you appear in your own group before any GPS fix', async () => {
        // Members were only ever added by traffic, and your own position is
        // what puts you there. Until the first fix arrives you were missing
        // from your own group list, and the header undercounted by one.
        const key = await C().generateJourneyKey();
        const solo = await makeSession({ key, name: 'Alex' });
        solo.rawSend = () => true;

        await solo.connect();

        const roster = solo.roster();
        assertEqual(roster.length, 1, 'you are on the journey even with no position');
        assertEqual(roster[0].name, 'Alex');
        assert(roster[0].isSelf, 'and marked as you');
        assertEqual(roster[0].status, 'live');
        assertEqual(roster[0].lat, undefined, 'with no position yet');

        solo.close();
    });

    test('the roster puts you first', async () => {
        const key = await C().generateJourneyKey();
        const host = await makeSession({ key, name: 'Zara' });
        const peer = await makeSession({ key, name: 'Aarav' });
        const settle = connectPair(host, peer);

        host.trackSelf({ lat: 0, lng: 0 });
        await peer.announce();
        await settle();

        const roster = host.roster();
        assertEqual(roster.length, 2);
        assert(roster[0].isSelf, 'you should sort to the top regardless of name');
    });

    // =====================================================================
    // export
    // =====================================================================

    const X = () => window.WayseraExport;

    const SAMPLE_JOURNEY = {
        code: 'ABC234',
        destination: { name: 'Gateway of India', lat: 18.922, lng: 72.834 },
        createdAt: 1700000000000,
        expiresAt: 1700010000000
    };

    const SAMPLE_POINTS = [
        { memberId: 'm_aaaaaaaaaaaa', ts: 1700000000000, lat: 19.0, lng: 72.8, heading: 90, speed: 12 },
        { memberId: 'm_bbbbbbbbbbbb', ts: 1700000001000, lat: 19.1, lng: 72.9, heading: null, speed: null },
        { memberId: 'm_aaaaaaaaaaaa', ts: 1700000002000, lat: 19.2, lng: 72.7, heading: 180, speed: 9 }
    ];

    const SAMPLE_EVENTS = [
        { ts: 1700000000000, kind: 'joined', data: { memberId: 'm_aaaaaaaaaaaa', name: 'Alex' } },
        { ts: 1700000001500, kind: 'quick_message', data: { memberId: 'm_aaaaaaaaaaaa', presetId: 'need-fuel', text: 'Need fuel' } }
    ];

    test('points group by person in order', () => {
        const tracks = X().groupByMember(SAMPLE_POINTS);
        assertEqual(tracks.size, 2);
        assertEqual(tracks.get('m_aaaaaaaaaaaa').length, 2);
        assertEqual(tracks.get('m_aaaaaaaaaaaa')[0].lat, 19.0);
        assertEqual(tracks.get('m_aaaaaaaaaaaa')[1].lat, 19.2);
    });

    test('names are recovered from the event log', () => {
        const names = X().namesFromEvents(SAMPLE_EVENTS);
        assertEqual(names.get('m_aaaaaaaaaaaa'), 'Alex');
        assertEqual(names.get('m_bbbbbbbbbbbb'), undefined, 'unknown people stay unnamed');
    });

    test('JSON export round-trips the track', () => {
        const parsed = JSON.parse(X().toJSON(SAMPLE_JOURNEY, SAMPLE_POINTS, SAMPLE_EVENTS));
        assertEqual(parsed.format, 'waysera.journey');
        assertEqual(parsed.journey.code, 'ABC234');
        assertEqual(parsed.journey.destination.name, 'Gateway of India');
        assertEqual(parsed.points.length, 3);
        assertEqual(parsed.points[0].lat, 19.0);
        assertEqual(parsed.events.length, 2);
        assertEqual(parsed.people[0].name, 'Alex');
    });

    test('JSON export never contains the journey key', () => {
        const withKey = { ...SAMPLE_JOURNEY, key: 'super-secret-key-material' };
        const text = X().toJSON(withKey, SAMPLE_POINTS, SAMPLE_EVENTS);
        assert(!text.includes('super-secret-key-material'), 'the key must not be exported');
        assert(!text.includes('"key"'), 'no key field at all');
        // Exporting it would hand over live access, not just history.
        assertEqual(JSON.parse(text).journey.key, undefined);
    });

    test('GPX has one track per person, named', () => {
        const gpx = X().toGPX(SAMPLE_JOURNEY, SAMPLE_POINTS, SAMPLE_EVENTS);
        assertEqual((gpx.match(/<trk>/g) || []).length, 2);
        assert(gpx.includes('<name>Alex</name>'), 'known person named');
        assert(gpx.includes('<name>Someone</name>'), 'unknown person gets a neutral label');
        assertEqual((gpx.match(/<trkpt /g) || []).length, 3);
        assert(gpx.includes('lat="19"') || gpx.includes('lat="19.0"'), 'coordinates present');
    });

    test('GPX parses as XML', () => {
        const gpx = X().toGPX(SAMPLE_JOURNEY, SAMPLE_POINTS, SAMPLE_EVENTS);
        const doc = new DOMParser().parseFromString(gpx, 'application/xml');
        assertEqual(doc.querySelector('parsererror'), null, 'must be well-formed XML');
        assertEqual(doc.documentElement.nodeName, 'gpx');
    });

    test('a hostile name cannot break out of the GPX', () => {
        const events = [{
            ts: 1,
            kind: 'joined',
            data: { memberId: 'm_aaaaaaaaaaaa', name: '</name></trk><script>alert(1)</script>' }
        }];
        const gpx = X().toGPX(SAMPLE_JOURNEY, SAMPLE_POINTS, events);

        assert(!gpx.includes('<script>'), 'no raw markup may survive');
        const doc = new DOMParser().parseFromString(gpx, 'application/xml');
        assertEqual(doc.querySelector('parsererror'), null, 'must still be well-formed');
    });

    test('an ampersand in a destination does not corrupt the GPX', () => {
        const journey = { ...SAMPLE_JOURNEY, destination: { name: 'Bed & Breakfast', lat: 1, lng: 1 } };
        const gpx = X().toGPX(journey, SAMPLE_POINTS, SAMPLE_EVENTS);
        const doc = new DOMParser().parseFromString(gpx, 'application/xml');
        assertEqual(doc.querySelector('parsererror'), null);
        assert(gpx.includes('Bed &amp; Breakfast'));
    });

    // =====================================================================
    // replay interpolation
    // =====================================================================

    const R = () => window.WayseraReplayInternals;

    const TRACK = [
        { ts: 1000, lat: 10, lng: 20 },
        { ts: 2000, lat: 12, lng: 22 },
        { ts: 4000, lat: 16, lng: 26 }
    ];

    test('replay interpolates between recorded points', () => {
        const midway = R().positionAt(TRACK, 1500);
        assertEqual(midway.lat, 11, 'halfway between 10 and 12');
        assertEqual(midway.lng, 21);
    });

    test('replay holds at the last known point', () => {
        const after = R().positionAt(TRACK, 99999);
        assertEqual(after.lat, 16);
    });

    test('replay shows nobody before their first point', () => {
        // People join mid-journey, so a track does not span the whole timeline —
        // returning the first point here would park them at the start instead.
        assertNull(R().positionAt(TRACK, 500));
    });

    test('replay handles an exact point timestamp', () => {
        assertEqual(R().positionAt(TRACK, 2000).lat, 12);
    });

    // =====================================================================
    // destination search
    // =====================================================================

    const Q = () => window.WayseraSearch;

    function feature(properties, lon = 72.8, lat = 19.0) {
        return { properties, geometry: { coordinates: [lon, lat] } };
    }

    test('a named place puts its name first and address second', () => {
        const r = Q().formatResult(feature({
            name: 'Gateway of India', street: 'Apollo Bandar',
            city: 'Mumbai', state: 'Maharashtra', country: 'India',
            osm_value: 'attraction'
        }));
        assertEqual(r.primary, 'Gateway of India');
        assertEqual(r.category, 'Attraction');
        assert(r.secondary.includes('Mumbai'), 'city belongs in the second line');
        assert(r.secondary.startsWith('Apollo Bandar'), 'street leads the context');
    });

    test('an address with no name falls back to the street line', () => {
        const r = Q().formatResult(feature({
            housenumber: '221B', street: 'Baker Street', city: 'London', country: 'UK'
        }));
        assertEqual(r.primary, '221B Baker Street');
        assert(!r.secondary.includes('Baker Street'), 'street must not repeat');
        assert(r.secondary.includes('London'));
    });

    test('context never repeats the primary line', () => {
        const r = Q().formatResult(feature({
            name: 'Mumbai', city: 'Mumbai', state: 'Maharashtra', country: 'India'
        }));
        assertEqual(r.primary, 'Mumbai');
        assert(!r.secondary.split(', ').includes('Mumbai'), 'no echo of the name');
    });

    test('coordinates come back as lat/lng, not GeoJSON order', () => {
        // Photon returns [lon, lat]. Getting this backwards puts every
        // destination in the wrong hemisphere.
        const r = Q().formatResult(feature({ name: 'X' }, 72.8777, 19.076));
        assertEqual(r.lat, 19.076);
        assertEqual(r.lng, 72.8777);
    });

    test('a place with nothing usable still renders', () => {
        const r = Q().formatResult(feature({}));
        assertEqual(r.primary, 'Unnamed place');
        assertEqual(r.secondary, '');
    });

    test('unmapped categories are made readable rather than dropped', () => {
        assertEqual(Q().categoryFor({ osm_value: 'fuel' }), 'Petrol station');
        assertEqual(Q().categoryFor({ osm_value: 'ice_cream' }), 'Ice cream');
        assertEqual(Q().categoryFor({}), '');
    });

    test('distance reads sensibly at every scale', () => {
        assertEqual(Q().distanceLabel(0.4), '400 m');
        assertEqual(Q().distanceLabel(2.34), '2.3 km');
        assertEqual(Q().distanceLabel(47.6), '48 km');
        assertEqual(Q().distanceLabel(null), '');
        assertEqual(Q().distanceLabel(NaN), '');
    });

    test('a search near somewhere sends the bias parameters', () => {
        const url = Q().buildUrl('station', { lat: 19.076, lng: 72.8777 });
        const params = new URLSearchParams(url.split('?')[1]);
        assertEqual(params.get('q'), 'station');
        assertEqual(params.get('lat'), '19.076');
        assertEqual(params.get('lon'), '72.8777', 'Photon wants lon, not lng');
        assert(params.get('location_bias_scale'), 'bias strength must be set');
    });

    test('a search with no known position omits them entirely', () => {
        const params = new URLSearchParams(Q().buildUrl('station', null).split('?')[1]);
        assertNull(params.get('lat'));
        assertNull(params.get('lon'));
    });

    test('the remembered position round-trips and can be cleared', () => {
        Q().forgetPosition();
        assertNull(Q().recallPosition());

        Q().rememberPosition(19.076, 72.8777);
        const back = Q().recallPosition();
        assertEqual(back.lat, 19.076);
        assertEqual(back.lng, 72.8777);

        Q().forgetPosition();
        assertNull(Q().recallPosition());
    });

    test('a corrupt remembered position is ignored, not thrown on', () => {
        localStorage.setItem('waysera.lastPosition', 'not json at all');
        assertNull(Q().recallPosition());
        localStorage.setItem('waysera.lastPosition', '{"lat":"x","lng":null}');
        assertNull(Q().recallPosition());
        Q().forgetPosition();
    });

    // =====================================================================
    // runner
    // =====================================================================

    async function run() {
        for (const { name, fn } of tests) {
            const started = performance.now();
            try {
                await fn();
                results.push({ name, ok: true, ms: performance.now() - started });
            } catch (error) {
                results.push({
                    name,
                    ok: false,
                    ms: performance.now() - started,
                    error: error && error.message ? error.message : String(error)
                });
            }
        }

        try {
            await S().clearAll();
        } catch (error) {
            /* best effort */
        }

        const passed = results.filter((r) => r.ok).length;
        const summary = { total: results.length, passed, failed: results.length - passed, results };

        render(summary);

        // Hand results to the runner when one is listening, so the suite can be
        // driven from the command line instead of read off the screen.
        try {
            await fetch('/__results', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(summary)
            });
        } catch (error) {
            /* opened directly in a browser; on-page output is enough */
        }

        return summary;
    }

    function render(summary) {
        const root = document.getElementById('results');
        if (!root) return;

        const head = document.createElement('h2');
        head.textContent = summary.failed === 0
            ? `All ${summary.total} tests passed`
            : `${summary.failed} of ${summary.total} tests failed`;
        head.className = summary.failed === 0 ? 'pass' : 'fail';
        root.appendChild(head);

        for (const result of summary.results) {
            const row = document.createElement('div');
            row.className = `row ${result.ok ? 'pass' : 'fail'}`;

            const label = document.createElement('span');
            label.textContent = `${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`;
            row.appendChild(label);

            if (!result.ok) {
                const detail = document.createElement('pre');
                detail.textContent = result.error;
                row.appendChild(detail);
            }
            root.appendChild(row);
        }
    }

    window.addEventListener('load', run);
})();
