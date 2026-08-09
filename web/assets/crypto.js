/**
 * Waysera crypto.
 *
 * Everything that crosses the relay is AES-GCM ciphertext. The relay forwards
 * opaque frames and cannot read them, because the key never reaches it: it
 * travels in the invite link's URL fragment, which browsers do not transmit.
 *
 * Two ways to obtain the journey key:
 *   1. Open an invite link — the key is in the fragment.
 *   2. Type a journey code — no key, so an existing member must hand it over.
 *      That handoff is an ECDH exchange gated by a human approval tap; see
 *      the key_request / key_grant flow in the relay protocol.
 *
 * Plain script with a global namespace, matching the rest of the app. No build
 * step, no modules.
 */

const WayseraCrypto = (() => {
    'use strict';

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Deliberately excludes O/0 and I/1. Journey codes get read aloud in a car,
    // so visual and spoken ambiguity costs more than the lost alphabet size.
    // 32^6 is ~1.07 billion combinations.
    const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const CODE_LENGTH = 6;

    // ---------------------------------------------------------------- base64url

    function bytesToBase64Url(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i += 1) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function base64UrlToBytes(value) {
        const normalised = String(value).replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    // ------------------------------------------------------------ journey codes

    function generateJourneyCode(length = CODE_LENGTH) {
        const random = new Uint32Array(length);
        crypto.getRandomValues(random);

        let code = '';
        for (let i = 0; i < length; i += 1) {
            // Modulo bias across 2^32 over a 32-character alphabet is nil:
            // 2^32 is an exact multiple of 32.
            code += CODE_ALPHABET[random[i] % CODE_ALPHABET.length];
        }
        return code;
    }

    function normaliseCode(code) {
        return String(code || '').trim().toUpperCase();
    }

    function isValidCode(code) {
        const normalised = normaliseCode(code);
        if (normalised.length !== CODE_LENGTH) return false;
        for (const character of normalised) {
            if (!CODE_ALPHABET.includes(character)) return false;
        }
        return true;
    }

    /**
     * Channel id = SHA-256 of the journey code, lowercase hex.
     *
     * This keeps the code itself off the wire, but it is obfuscation rather
     * than a security boundary — a six-character code is roughly 30 bits and
     * trivially precomputed. The journey key is what actually protects the
     * traffic. The relay independently refuses anything that is not a digest.
     */
    async function deriveChannelId(code) {
        const digest = await crypto.subtle.digest(
            'SHA-256',
            encoder.encode(normaliseCode(code))
        );
        return Array.from(new Uint8Array(digest))
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
    }

    // -------------------------------------------------------------- journey key

    async function generateJourneyKey() {
        // Extractable because the key has to be shareable: it goes into the
        // invite fragment and gets wrapped for code-only joiners.
        return crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
        );
    }

    async function exportJourneyKey(key) {
        const raw = await crypto.subtle.exportKey('raw', key);
        return bytesToBase64Url(new Uint8Array(raw));
    }

    async function importJourneyKey(encoded) {
        const raw = base64UrlToBytes(encoded);
        if (raw.length !== 32) {
            throw new Error('journey key must be 256 bits');
        }
        return crypto.subtle.importKey(
            'raw',
            raw,
            { name: 'AES-GCM' },
            true,
            ['encrypt', 'decrypt']
        );
    }

    // ------------------------------------------------------------- envelope I/O

    /** Encrypt a message into the {iv, ct} envelope the relay forwards. */
    async function seal(key, message) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            encoder.encode(JSON.stringify(message))
        );
        return {
            iv: bytesToBase64Url(iv),
            ct: bytesToBase64Url(new Uint8Array(ciphertext))
        };
    }

    /**
     * Decrypt an envelope. Returns null rather than throwing on anything
     * malformed or unauthentic — a hostile peer can put whatever it likes on
     * the channel, and a failed open is an ordinary event, not an exception.
     */
    async function open(key, envelope) {
        if (!envelope || typeof envelope.iv !== 'string' || typeof envelope.ct !== 'string') {
            return null;
        }
        try {
            const plaintext = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: base64UrlToBytes(envelope.iv) },
                key,
                base64UrlToBytes(envelope.ct)
            );
            return JSON.parse(decoder.decode(plaintext));
        } catch (error) {
            // Wrong key, tampered ciphertext, or non-JSON plaintext.
            return null;
        }
    }

    // ------------------------------------------------------- ECDH key handoff

    async function generateHandoffKeyPair() {
        return crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            ['deriveKey']
        );
    }

    async function exportHandoffPublicKey(keyPair) {
        const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
        return bytesToBase64Url(new Uint8Array(raw));
    }

    async function importHandoffPublicKey(encoded) {
        return crypto.subtle.importKey(
            'raw',
            base64UrlToBytes(encoded),
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            []
        );
    }

    /** Shared AES-GCM key derived from our private half and their public half. */
    async function deriveHandoffSecret(privateKey, peerPublicKey) {
        return crypto.subtle.deriveKey(
            { name: 'ECDH', public: peerPublicKey },
            privateKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    /** Wrap the journey key for a specific joiner. */
    async function wrapJourneyKey(handoffSecret, journeyKey) {
        const raw = await crypto.subtle.exportKey('raw', journeyKey);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const wrapped = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            handoffSecret,
            raw
        );
        return {
            iv: bytesToBase64Url(iv),
            ct: bytesToBase64Url(new Uint8Array(wrapped))
        };
    }

    /** Unwrap a journey key granted by a peer. Returns null if it does not open. */
    async function unwrapJourneyKey(handoffSecret, wrapped) {
        if (!wrapped || typeof wrapped.iv !== 'string' || typeof wrapped.ct !== 'string') {
            return null;
        }
        try {
            const raw = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: base64UrlToBytes(wrapped.iv) },
                handoffSecret,
                base64UrlToBytes(wrapped.ct)
            );
            return crypto.subtle.importKey(
                'raw',
                raw,
                { name: 'AES-GCM' },
                true,
                ['encrypt', 'decrypt']
            );
        } catch (error) {
            return null;
        }
    }

    // -------------------------------------------------------------- invite links

    /**
     * Build an invite link. Both the code and the key live in the fragment, so
     * neither is sent to the static host or the relay in any request.
     */
    function buildInviteLink(origin, code, encodedKey) {
        const base = String(origin).replace(/\/+$/, '');
        return `${base}/#/j/${normaliseCode(code)}?k=${encodedKey}`;
    }

    /** Parse `#/j/CODE?k=KEY`. Returns null when the fragment is not an invite. */
    function parseInviteFragment(fragment) {
        const raw = String(fragment || '').replace(/^#/, '');
        const match = raw.match(/^\/j\/([^?/]+)(?:\?(.*))?$/);
        if (!match) return null;

        const code = normaliseCode(decodeURIComponent(match[1]));
        if (!isValidCode(code)) return null;

        let key = null;
        if (match[2]) {
            const value = new URLSearchParams(match[2]).get('k');
            if (value) key = value;
        }
        return { code, key };
    }

    return {
        CODE_ALPHABET,
        CODE_LENGTH,
        bytesToBase64Url,
        base64UrlToBytes,
        generateJourneyCode,
        normaliseCode,
        isValidCode,
        deriveChannelId,
        generateJourneyKey,
        exportJourneyKey,
        importJourneyKey,
        seal,
        open,
        generateHandoffKeyPair,
        exportHandoffPublicKey,
        importHandoffPublicKey,
        deriveHandoffSecret,
        wrapJourneyKey,
        unwrapJourneyKey,
        buildInviteLink,
        parseInviteFragment
    };
})();

window.WayseraCrypto = WayseraCrypto;
