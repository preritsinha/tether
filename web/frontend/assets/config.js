// Waysera runtime configuration.
// Plain script so the app needs no build step.

const WAYSERA_CONFIG = {
    // Where the relay is reachable. Leave blank for local work; the app then
    // assumes port 8000 on the host that served the page. Set it to the full
    // origin once the relay is deployed, for example:
    //   RELAY_URL: 'https://waysera-relay.onrender.com'
    RELAY_URL: '',

    // Map tiles come from CARTO, which needs no key, so nothing secret or
    // rate-limited is shipped to visitors. There is no tile token to rotate.
};

window.WAYSERA_CONFIG = WAYSERA_CONFIG;
