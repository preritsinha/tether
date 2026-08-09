/**
 * Waysera peer-input validation.
 *
 * Every message arriving over the relay is treated as hostile. There is no
 * server-side validation layer any more — the relay forwards bytes it cannot
 * read — so this file is the only thing between another participant and the
 * DOM. Decryption proves a message came from someone holding the journey key;
 * it proves nothing about whether they are well behaved.
 *
 * Validators return a freshly built, sanitised object or null. They never
 * repair a malformed message and never pass the original through.
 */

const WayseraValidate = (() => {
    'use strict';

    const MAX_NAME_LENGTH = 32;
    const MEMBER_ID = /^[A-Za-z0-9_-]{8,64}$/;
    const BASE64URL = /^[A-Za-z0-9_-]+$/;

    // C0 and C1 control characters, plus the bidirectional overrides that let
    // a display name render as something other than what it actually is.
    // Written as escapes on purpose: the literal characters are invisible in
    // a diff and trivially mangled by an editor.
    const CONTROL_AND_BIDI =
        /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

    // Quick messages are chosen from this list by id. Free text is never
    // accepted, which keeps the feature tap-only and means nothing arbitrary
    // ever crosses the wire.
    const QUICK_MESSAGES = Object.freeze({
        'pulling-over': 'Pulling over',
        'need-fuel': 'Need fuel',
        'go-ahead': 'Go ahead without me',
        'food-stop': 'Stopping to eat',
        'almost-there': 'Almost there',
        'need-help': 'Need help'
    });

    const MESSAGE_TYPES = Object.freeze([
        'hello',
        'position',
        'quick_message',
        'journey_config',
        'key_request',
        'key_grant',
        'bye'
    ]);

    // ------------------------------------------------------------------ escaping

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** Preferred over escapeHtml where the DOM allows it — no parsing at all. */
    function setText(element, value) {
        if (element) element.textContent = String(value);
    }

    // ------------------------------------------------------------------ scalars

    function cleanName(value) {
        if (typeof value !== 'string') return null;

        const stripped = value
            // C0/C1 controls, and the bidi overrides that let a name render as
            // something other than what it is.
            .replace(CONTROL_AND_BIDI, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (!stripped) return null;
        return stripped.slice(0, MAX_NAME_LENGTH);
    }

    function finiteNumber(value) {
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    function boundedNumber(value, min, max) {
        const number = finiteNumber(value);
        if (number === null || number < min || number > max) return null;
        return number;
    }

    function latitude(value) {
        return boundedNumber(value, -90, 90);
    }

    function longitude(value) {
        return boundedNumber(value, -180, 180);
    }

    function heading(value) {
        const number = finiteNumber(value);
        if (number === null) return null;
        // Wrap rather than reject: devices legitimately report 360 or small
        // negatives, and a heading is cosmetic.
        return ((number % 360) + 360) % 360;
    }

    function speed(value) {
        // Metres per second. 400 m/s is far past any road vehicle and well
        // short of a number that would break the UI.
        return boundedNumber(value, 0, 400);
    }

    function accuracy(value) {
        return boundedNumber(value, 0, 100000);
    }

    function timestamp(value) {
        // Milliseconds. Bounded loosely — this is a sanity check, not a trust
        // decision, and peer clocks are not authoritative for anything.
        return boundedNumber(value, 0, 4102444800000);
    }

    function memberId(value) {
        return typeof value === 'string' && MEMBER_ID.test(value) ? value : null;
    }

    function base64urlField(value, maxLength) {
        if (typeof value !== 'string') return null;
        if (value.length === 0 || value.length > maxLength) return null;
        return BASE64URL.test(value) ? value : null;
    }

    function envelopeField(value) {
        if (!value || typeof value !== 'object') return null;
        const iv = base64urlField(value.iv, 64);
        const ct = base64urlField(value.ct, 4096);
        if (!iv || !ct) return null;
        return { iv, ct };
    }

    // ----------------------------------------------------------------- messages

    function validateHello(message) {
        const id = memberId(message.memberId);
        const name = cleanName(message.name);
        if (!id || !name) return null;

        return {
            type: 'hello',
            memberId: id,
            name,
            // Marks a hello sent *in answer to* someone else's. Replies are
            // never answered in turn, which is what stops a join from starting
            // an endless round of introductions.
            reply: message.reply === true,
            ts: timestamp(message.ts) ?? Date.now()
        };
    }

    function validatePosition(message) {
        const id = memberId(message.memberId);
        const lat = latitude(message.lat);
        const lng = longitude(message.lng);
        if (!id || lat === null || lng === null) return null;

        return {
            type: 'position',
            memberId: id,
            lat,
            lng,
            heading: heading(message.heading),
            speed: speed(message.speed),
            accuracy: accuracy(message.accuracy),
            ts: timestamp(message.ts) ?? Date.now()
        };
    }

    function validateQuickMessage(message) {
        const id = memberId(message.memberId);
        const presetId = typeof message.presetId === 'string' ? message.presetId : null;
        // Membership in the frozen preset table is the whole check. Anything
        // outside it — including free text smuggled in as presetId — is dropped.
        if (!id || !presetId || !Object.prototype.hasOwnProperty.call(QUICK_MESSAGES, presetId)) {
            return null;
        }

        return {
            type: 'quick_message',
            memberId: id,
            presetId,
            text: QUICK_MESSAGES[presetId],
            ts: timestamp(message.ts) ?? Date.now()
        };
    }

    function validateJourneyConfig(message) {
        const destination = message.destination;
        if (!destination || typeof destination !== 'object') return null;

        const name = cleanName(destination.name);
        const lat = latitude(destination.lat);
        const lng = longitude(destination.lng);
        if (!name || lat === null || lng === null) return null;

        return {
            type: 'journey_config',
            destination: { name, lat, lng },
            expiresAt: timestamp(message.expiresAt),
            ts: timestamp(message.ts) ?? Date.now()
        };
    }

    function validateKeyRequest(message) {
        const id = memberId(message.memberId);
        const name = cleanName(message.name);
        const pub = base64urlField(message.pub, 256);
        if (!id || !name || !pub) return null;

        return {
            type: 'key_request',
            memberId: id,
            name,
            pub,
            ts: timestamp(message.ts) ?? Date.now()
        };
    }

    function validateKeyGrant(message) {
        const id = memberId(message.memberId);
        const forMemberId = memberId(message.forMemberId);
        const pub = base64urlField(message.pub, 256);
        const wrapped = envelopeField(message.wrapped);
        if (!id || !forMemberId || !pub || !wrapped) return null;

        return {
            type: 'key_grant',
            memberId: id,
            forMemberId,
            pub,
            wrapped,
            ts: timestamp(message.ts) ?? Date.now()
        };
    }

    function validateBye(message) {
        const id = memberId(message.memberId);
        if (!id) return null;
        return { type: 'bye', memberId: id, ts: timestamp(message.ts) ?? Date.now() };
    }

    const VALIDATORS = Object.freeze({
        hello: validateHello,
        position: validatePosition,
        quick_message: validateQuickMessage,
        journey_config: validateJourneyConfig,
        key_request: validateKeyRequest,
        key_grant: validateKeyGrant,
        bye: validateBye
    });

    /**
     * Validate a decrypted peer message.
     * Returns a new sanitised object, or null if anything is off.
     */
    function validatePeerMessage(message) {
        if (!message || typeof message !== 'object' || Array.isArray(message)) return null;

        const type = message.type;
        if (typeof type !== 'string' || !MESSAGE_TYPES.includes(type)) return null;

        // hasOwnProperty guards against a payload named after an Object
        // prototype member resolving to a function.
        if (!Object.prototype.hasOwnProperty.call(VALIDATORS, type)) return null;

        try {
            return VALIDATORS[type](message);
        } catch (error) {
            return null;
        }
    }

    return {
        MAX_NAME_LENGTH,
        QUICK_MESSAGES,
        MESSAGE_TYPES,
        escapeHtml,
        setText,
        cleanName,
        latitude,
        longitude,
        heading,
        speed,
        timestamp,
        memberId,
        validatePeerMessage
    };
})();

window.WayseraValidate = WayseraValidate;
