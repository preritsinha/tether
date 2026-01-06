// ============= CONFIGURATION =============

// Auto-detect API base URL
const getApiBase = () => {
    // Production: Update with your actual domain
    if (window.location.hostname.includes('onrender.com')) {
        // Update this with your actual backend URL
        return 'https://tether-backend-ivfz.onrender.com';  // Your production URL
    }
    
    // Local development
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        return 'http://localhost:8000';
    }
    
    // Mobile testing on local network
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    return `${protocol}//${hostname}:8000`;
};

const CONFIG = {
    API_BASE: getApiBase(),
    FRONTEND_BASE_URL: window.location.origin,
    LOCATION_UPDATE_INTERVAL: 3000,           // Send location every 3 seconds
    ROOM_STATE_BROADCAST_INTERVAL: 1000,      // Server broadcasts state every second
    MEMBER_STATUS_THRESHOLDS: {
        live: 10,                             // Green if updated ≤10 secs ago
        stale: 30                             // Yellow if 11-30 secs, red after that
    },
    DEMO_MODE_INTERVAL: 2000,                 // Update demo location every 2 sec
    DEMO_RADIUS_KM: 5                         // Move in a 5km circle around destination
};

console.log('📍 Tether Config:', CONFIG.API_BASE);

// ============= UTILITIES =============

function showNotification(message, type = 'info') {
    console.log(`[${type.toUpperCase()}] ${message}`);
}

function setPageVisibility(pageName, visible) {
    const page = document.getElementById(pageName);
    if (page) {
        page.style.display = visible ? 'block' : 'none';
    }
}

function getUrlParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name) || (window.location.hash ? window.location.hash.split('#')[1].split('=')[1] : null);
}

function copyToClipboard(text) {
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
            showNotification('Copied to clipboard!', 'success');
        });
    } else {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showNotification('Copied to clipboard!', 'success');
    }
}

function showError(elementId, message) {
    const el = document.getElementById(elementId);
    if (el) {
        el.className = 'result error';
        el.textContent = '❌ ' + message;
        el.style.display = 'block';
    }
}

function showSuccess(elementId, message) {
    const el = document.getElementById(elementId);
    if (el) {
        el.className = 'result success';
        el.innerHTML = '✅ ' + message;
        el.style.display = 'block';
    }
}

function showInfo(elementId, message) {
    const el = document.getElementById(elementId);
    if (el) {
        el.className = 'result info';
        el.innerHTML = 'ℹ️ ' + message;
        el.style.display = 'block';
    }
}

// ============= API HELPERS =============

async function apiCall(endpoint, method = 'GET', body = null) {
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json'
        }
    };

    if (body) {
        options.body = JSON.stringify(body);
    }

    try {
        const response = await fetch(`${CONFIG.API_BASE}${endpoint}`, options);
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        console.error('API Error:', error);
        throw error;
    }
}

// ============= GEOLOCATION =============

let geolocationWatchId = null;

function requestGeolocation(callback) {
    if (!navigator.geolocation) {
        showNotification('Geolocation not supported', 'warning');
        return false;
    }

    navigator.geolocation.watchPosition(
        (position) => {
            const { latitude, longitude, heading, speed } = position.coords;
            callback({
                lat: latitude,
                lng: longitude,
                heading: heading || null,
                speed: speed || null
            });
        },
        (error) => {
            console.warn('Geolocation error:', error);
            showNotification('Location permission denied. Using demo mode.', 'warning');
            return false;
        },
        {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0
        }
    );

    return true;
}

function stopGeolocation() {
    if (geolocationWatchId !== null) {
        navigator.geolocation.clearWatch(geolocationWatchId);
        geolocationWatchId = null;
    }
}

// ============= DEMO MODE (Simulated Movement) =============

class DemoModeSimulator {
    constructor(destination_lat, destination_lng) {
        this.destination_lat = destination_lat;
        this.destination_lng = destination_lng;
        this.current_lat = destination_lat + (Math.random() * 0.05 - 0.025);
        this.current_lng = destination_lng + (Math.random() * 0.05 - 0.025);
        this.angle = Math.random() * Math.PI * 2;
        this.speed = Math.random() * 10 + 5; // km/h
    }

    getNextLocation() {
        // Move in circular pattern around destination
        const radiusKm = CONFIG.DEMO_RADIUS_KM;
        const radiusDegrees = radiusKm / 111; // ~111 km per degree
        
        this.angle += (Math.random() - 0.5) * 0.3; // Random walk
        
        this.current_lat = this.destination_lat + radiusDegrees * Math.cos(this.angle);
        this.current_lng = this.destination_lng + radiusDegrees * Math.sin(this.angle);
        
        return {
            lat: this.current_lat,
            lng: this.current_lng,
            heading: this.angle * (180 / Math.PI),
            speed: this.speed
        };
    }
}

// ============= HAVERSINE DISTANCE =============

function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // Earth radius in km
    const toRad = (deg) => deg * Math.PI / 180;
    
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.asin(Math.sqrt(a));
    
    return R * c;
}

// ============= TIME FORMATTING =============

function formatTimeAgo(seconds) {
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
}

function formatCountdown(expiresAtISO) {
    const expires = new Date(expiresAtISO);
    const now = new Date();
    const diffMs = expires - now;
    
    if (diffMs <= 0) return 'Expired';
    
    const minutes = Math.floor((diffMs / 1000) / 60);
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    
    if (hours > 0) return `${hours}h ${mins}m left`;
    return `${mins}m left`;
}
