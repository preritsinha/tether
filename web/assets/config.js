// Waysera runtime configuration.
// Kept as a plain script so the app needs no build step.

const WAYSERA_CONFIG = {
    // Mapbox token. URL restrictions are set at mapbox.com/account/access-tokens —
    // add the Waysera domain there BEFORE switching production domains.
    MAPBOX_TOKEN: 'pk.eyJ1IjoicHJlcml0c2luaGEiLCJhIjoiY21zbGFyeWVxMDZmYjJ4cXRxeXNqaHc0NSJ9.O2SfJuG0l8gPpIw1NQcIVw',

    // Map settings
    USE_MAPBOX_ON_LOCALHOST: false, // true only if localhost is added to the token restrictions
};

window.WAYSERA_CONFIG = WAYSERA_CONFIG;
