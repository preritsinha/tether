// Waysera runtime configuration.
// Kept as a plain script so the app needs no build step.

const WAYSERA_CONFIG = {
    // Mapbox token. URL restrictions are set at mapbox.com/account/access-tokens —
    // add the Waysera domain there BEFORE switching production domains.
    MAPBOX_TOKEN: 'pk.eyJ1IjoicHJlcml0c2luaGEiLCJhIjoiY21rMmo3dnRrMGdoNzNjc2I4dXd3ZHFxayJ9.XfdNuGp4DPvzEA5hVqY2YA',

    // Map settings
    USE_MAPBOX_ON_LOCALHOST: false, // true only if localhost is added to the token restrictions
};

window.WAYSERA_CONFIG = WAYSERA_CONFIG;
