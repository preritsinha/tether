// Waysera runtime configuration.
// Plain script so the app needs no build step.

const WAYSERA_CONFIG = {
    // Where the relay is reachable. Leave blank for local work; the app then
    // assumes port 8000 on the host that served the page. Set it to the full
    // origin once the relay is deployed, for example:
    //   RELAY_URL: 'https://waysera-relay.onrender.com'
    RELAY_URL: '',

    // Mapbox publishable token. This is served to every visitor by design, so
    // its protection is the URL restriction list at
    // mapbox.com/account/access-tokens, not secrecy. Add each domain there
    // before you serve the app from it.
    MAPBOX_TOKEN: 'pk.eyJ1IjoicHJlcml0c2luaGEiLCJhIjoiY21zbGFyeWVxMDZmYjJ4cXRxeXNqaHc0NSJ9.O2SfJuG0l8gPpIw1NQcIVw',

    // Mapbox tiles are skipped on localhost unless the token allows it.
    USE_MAPBOX_ON_LOCALHOST: false
};

window.WAYSERA_CONFIG = WAYSERA_CONFIG;
