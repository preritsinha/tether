// Configuration for Tether Map
// This file can be easily modified for different environments

const TETHER_CONFIG = {
    // Mapbox token - Set URL restrictions at mapbox.com/account/access-tokens
    MAPBOX_TOKEN: 'pk.eyJ1IjoicHJlcml0c2luaGEiLCJhIjoiY21rMmo3dnRrMGdoNzNjc2I4dXd3ZHFxayJ9.XfdNuGp4DPvzEA5hVqY2YA',
    
    // Map settings
    USE_MAPBOX_ON_LOCALHOST: false, // Set to true if you add localhost to token restrictions
};

// Export for use in other scripts
window.TETHER_CONFIG = TETHER_CONFIG;

