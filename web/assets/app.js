// Shared configuration and small helpers.
//
// Most of what used to live here went with the REST API. What is left is the
// relay address, clipboard handling, the inline error line on the home page,
// and the distance function the group list and navigation both use.

/**
 * Where the relay lives.
 *
 * Set RELAY_URL in config.js once the relay is deployed. Without it the app
 * assumes the relay is on port 8000 of whatever host served the page, which is
 * right for local work and for testing on a phone over the LAN, and wrong for
 * anything hosted.
 */
const getApiBase = () => {
    const configured = window.WAYSERA_CONFIG && window.WAYSERA_CONFIG.RELAY_URL;
    if (configured) return configured;

    const { hostname, protocol } = window.location;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return 'http://localhost:8000';
    }
    return `${protocol}//${hostname}:8000`;
};

const CONFIG = {
    API_BASE: getApiBase()
};

if (!window.WAYSERA_CONFIG || !window.WAYSERA_CONFIG.RELAY_URL) {
    console.warn(
        'No RELAY_URL configured. Falling back to ' + CONFIG.API_BASE +
        ', which only works locally. Set it in assets/config.js before deploying.'
    );
}

function copyToClipboard(text) {
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
        return;
    }
    fallbackCopy(text);
}

function fallbackCopy(text) {
    // execCommand is obsolete, but it is the only option on older mobile
    // browsers and on pages served without a secure context.
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        document.execCommand('copy');
    } catch (error) {
        console.warn('Could not copy to the clipboard', error);
    }
    textarea.remove();
}

/** Inline message under a form. */
function showError(elementId, message) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.className = 'result error';
    el.textContent = message;
    el.style.display = 'block';
}

/** Great-circle distance in kilometres. */
function haversineDistance(lat1, lng1, lat2, lng2) {
    const earthRadiusKm = 6371;
    const toRad = (degrees) => (degrees * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

    return earthRadiusKm * 2 * Math.asin(Math.sqrt(a));
}
