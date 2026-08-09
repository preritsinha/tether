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
    // crypto — encoding
    // =====================================================================

    test('base64url round-trips arbitrary bytes', () => {
        const bytes = new Uint8Array([0, 1, 2, 251, 252, 253, 254, 255]);
        const encoded = C().bytesToBase64Url(bytes);
        assert(!/[+/=]/.test(encoded), 'must be url-safe with no padding');
        const decoded = C().base64UrlToBytes(encoded);
        assertEqual(Array.from(decoded).join(','), Array.from(bytes).join(','));
    });

    // =====================================================================
    // crypto — journey codes
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
    // crypto — channel derivation
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
    // crypto — sealing
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
    // crypto — ECDH handoff
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
    // crypto — invite links
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
    // validate — escaping
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
    // validate — names
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
    // validate — messages
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
