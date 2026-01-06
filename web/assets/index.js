// ============= HOME PAGE LOGIC =============
// CONFIG is defined in app.js

async function createRoom() {
    try {
        const name = document.getElementById('destName').value;
        const lat = parseFloat(document.getElementById('destLat').value);
        const lng = parseFloat(document.getElementById('destLng').value);
        const duration = parseInt(document.getElementById('duration').value) || 180;

        console.log('Creating room:', { name, lat, lng, duration });

        if (!name || isNaN(lat) || isNaN(lng)) {
            alert('Please fill in all fields');
            return;
        }

        // Create room
        const createResponse = await fetch(`${CONFIG.API_BASE}/rooms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                destination_name: name,
                destination_lat: lat,
                destination_lng: lng,
                duration_minutes: duration
            })
        });

        if (!createResponse.ok) {
            throw new Error(`Failed to create room: ${createResponse.status}`);
        }

        const roomData = await createResponse.json();
        console.log('✅ Room created:', roomData);

        // Show result with invite link
        const resultDiv = document.getElementById('createResult');
        resultDiv.innerHTML = `
            <div style="padding: 16px; background: #e8f5e9; border-radius: 8px;">
                <h3>✅ Room Created!</h3>
                <p><strong>Code:</strong> ${roomData.room_id}</p>
                <p><strong>Invite Link:</strong></p>
                <input type="text" readonly value="${window.location.origin}?room=${roomData.room_id}" 
                       style="width: 100%; padding: 8px; margin: 8px 0; border: 1px solid #ddd; border-radius: 4px;">
                <p style="margin-top: 12px;"><strong>Enter your name to join:</strong></p>
                <input type="text" id="creatorName" placeholder="Your name" 
                       style="width: 100%; padding: 8px; margin: 8px 0; border: 1px solid #ddd; border-radius: 4px;">
                <button class="btn btn-primary" onclick="joinCreatedRoom('${roomData.room_id}')">
                    🗺️ Join Room
                </button>
            </div>
        `;
        resultDiv.style.display = 'block';

    } catch (error) {
        console.error('❌ Error creating room:', error);
        alert('Error creating room: ' + error.message);
    }
}

async function joinCreatedRoom(roomCode) {
    try {
        const name = document.getElementById('creatorName').value.trim();
        
        if (!name) {
            alert('Please enter your name');
            return;
        }

        // Join the room
        const joinResponse = await fetch(`${CONFIG.API_BASE}/rooms/${roomCode}/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });

        if (!joinResponse.ok) {
            throw new Error(`Failed to join room: ${joinResponse.status}`);
        }

        const joinData = await joinResponse.json();
        console.log('✅ Joined created room:', joinData);

        // Store credentials
        localStorage.setItem('member_id', joinData.member_id);
        localStorage.setItem('token', joinData.token);
        localStorage.setItem('room_code', roomCode);

        // Redirect to room page
        window.location.href = `/?room=${roomCode}`;
        
    } catch (error) {
        console.error('❌ Error joining created room:', error);
        alert('Error joining room: ' + error.message);
    }
}

function goToRoom(roomCode) {
    console.log('📍 Going to room:', roomCode);
    window.location.href = `/?room=${roomCode}`;
}

async function joinRoom() {
    try {
        const name = document.getElementById('joinName').value;
        const roomCode = document.getElementById('roomCode').value.toUpperCase();

        console.log('Joining room:', { name, roomCode });

        if (!name || !roomCode) {
            alert('Please enter name and room code');
            return;
        }

        // Fetch room to verify it exists
        const roomResponse = await fetch(`${CONFIG.API_BASE}/rooms/${roomCode}`);
        if (!roomResponse.ok) {
            throw new Error(`Room not found: ${roomCode}`);
        }

        const roomData = await roomResponse.json();
        console.log('✅ Room found:', roomData);

        // Join room
        const joinResponse = await fetch(`${CONFIG.API_BASE}/rooms/${roomCode}/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });

        if (!joinResponse.ok) {
            throw new Error(`Failed to join room: ${joinResponse.status}`);
        }

        const joinData = await joinResponse.json();
        console.log('✅ Joined room:', joinData);

        // Store member info
        localStorage.setItem('member_id', joinData.member_id);
        localStorage.setItem('token', joinData.token);
        localStorage.setItem('room_code', roomCode);

        // Navigate to room
        window.location.href = `/?room=${roomCode}`;

    } catch (error) {
        console.error('❌ Error joining room:', error);
        alert('Error joining room: ' + error.message);
    }
}

// ============= ROOM PAGE LOGIC =============

let currentRoom = null;
let currentMemberId = null;
let currentToken = null;
let map = null;
let markers = {};
let destMarker = null;
let ws = null;
let locationInterval = null;
let demoMode = false;
let demoSimulator = null;
let routingControls = {};
let showDirections = false;

// Navigation state
let navigationActive = false;
let navigationRoute = null;
let navigationRoutingControl = null;
let currentUserLocation = null;
let lastKnownLocation = null;
let currentHeading = 0;
let currentSpeed = 0;
let userLocationMarker = null;
let routeUpdateThrottle = null;
let lastRouteUpdate = 0;

async function loadRoomPage(roomCode, memberId, token) {
    try {
        console.log('📍 Loading room:', roomCode);
        
        currentMemberId = memberId;
        currentToken = token;
        
        // Hide home page, show room page
        document.getElementById('homePage').style.display = 'none';
        document.getElementById('roomPage').style.display = 'block';
        
        // Fetch room data
        const response = await fetch(`${CONFIG.API_BASE}/rooms/${roomCode}`);
        if (!response.ok) {
            throw new Error(`Failed to load room: ${response.status}`);
        }

        currentRoom = await response.json();
        console.log('✅ Room loaded:', currentRoom);

        // Update UI
        document.getElementById('destNameDisplay').textContent = currentRoom.destination.name;
        document.getElementById('roomCodeDisplay').textContent = `Code: ${currentRoom.room_id}`;
        document.getElementById('memberCount').textContent = `${currentRoom.members_count} ${currentRoom.members_count === 1 ? 'member' : 'members'}`;
        
        // Initialize map
        initializeMap();
        
        // Connect WebSocket
        connectWebSocket(roomCode, memberId, token);
        
        // Start timer
        startTimer();
        
        // Set initial navigation button state
        updateNavigationButtonState();
        
        // Check if we should show location permission banner
        checkLocationPermissionStatus();
        
        // Start location tracking
        setTimeout(() => startLocationTracking(), 1000);
        
    } catch (error) {
        console.error('❌ Error loading room:', error);
        alert('Failed to load room: ' + error.message);
        leaveRoom();
    }
}

function initializeMap() {
    try {
        console.log('🗺️ Initializing map...');
        
        if (map) {
            map.remove();
            map = null;
        }

        const destination = currentRoom.destination;
        
        // Create map with optimized settings for 60fps performance
        map = L.map('map', {
            zoomControl: true,
            zoomAnimation: true,
            fadeAnimation: true,
            markerZoomAnimation: true,
            preferCanvas: true,  // Use canvas for better performance
            tap: true,
            tapTolerance: 15,  // Better touch precision
            touchZoom: true,
            scrollWheelZoom: true, 
            doubleClickZoom: true,
            boxZoom: true,
            dragging: true,
            keyboard: true,
            zoomSnap: 0.25,  // Ultra-smooth zoom transitions
            zoomDelta: 0.5,
            trackResize: true,
            inertia: true,  // Smooth panning with momentum
            inertiaDeceleration: 2500,  // Optimized deceleration
            inertiaMaxSpeed: 2000,
            easeLinearity: 0.2,  // Smoother easing
            worldCopyJump: false,
            maxBoundsViscosity: 0.3,
            wheelPxPerZoomLevel: 120,  // Smoother wheel zoom
            zoomAnimationThreshold: 4  // Smooth zoom at all levels
        }).setView([destination.lat, destination.lng], 13);
        
        // Smart tile selection: OpenStreetMap for localhost (no restrictions), Mapbox for production
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const useMapbox = !isLocalhost || (window.TETHER_CONFIG && window.TETHER_CONFIG.USE_MAPBOX_ON_LOCALHOST);
        
        if (!useMapbox) {
            // Free OpenStreetMap tiles for local testing (no token needed)
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                maxZoom: 19,
                detectRetina: true,
                updateWhenIdle: false,
                updateWhenZooming: false,
                keepBuffer: 4
            }).addTo(map);
            console.log('🗺️ Using OpenStreetMap tiles (localhost)');
        } else {
            // Mapbox for production - Token stored in config.js
            const MAPBOX_TOKEN = window.TETHER_CONFIG ? window.TETHER_CONFIG.MAPBOX_TOKEN : 'pk.eyJ1IjoicHJlcml0c2luaGEiLCJhIjoiY21rMmo3dnRrMGdoNzNjc2I4dXd3ZHFxayJ9.XfdNuGp4DPvzEA5hVqY2YA';
            L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/{z}/{x}/{y}?access_token=${MAPBOX_TOKEN}`, {
                attribution: '© Mapbox © OpenStreetMap',
                tileSize: 512,
                zoomOffset: -1,
                maxZoom: 20,
                minZoom: 2,
                detectRetina: true,
                updateWhenIdle: false,
                updateWhenZooming: false,
                keepBuffer: 4,
                crossOrigin: true
            }).addTo(map);
            console.log('🗺️ Using Mapbox tiles (production)');
        }
        
        // Add destination marker (red)
        destMarker = L.marker([destination.lat, destination.lng], {
            icon: L.icon({
                iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
                shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                iconSize: [25, 41],
                iconAnchor: [12, 41],
                popupAnchor: [1, -34],
                shadowSize: [41, 41]
            })
        }).addTo(map);
        destMarker.bindPopup(`<b>${destination.name}</b><br>📍 Destination`);
        
        // Smooth invalidateSize for proper rendering
        setTimeout(() => {
            map.invalidateSize();
        }, 100);
        
        console.log('✅ Map initialized');
        
    } catch (error) {
        console.error('❌ Map initialization error:', error);
    }
}

function connectWebSocket(roomCode, memberId, token) {
    try {
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsHost = CONFIG.API_BASE.replace('http://', '').replace('https://', '');
        const wsUrl = `${wsProtocol}//${wsHost}/ws/rooms/${roomCode}?member_id=${memberId}&token=${token}`;
        
        console.log('🔌 Connecting WebSocket:', wsUrl);
        
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('✅ WebSocket connected');
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                if (data.type === 'state') {
                    // Update room state
                    updateRoomState(data);
                } else if (data.type === 'ended') {
                    alert('Room has ended: ' + data.reason);
                    leaveRoom();
                }
                
            } catch (error) {
                console.error('❌ Error processing WebSocket message:', error);
            }
        };

        ws.onerror = (error) => {
            console.error('❌ WebSocket error:', error);
        };

        ws.onclose = () => {
            console.log('⚠️ WebSocket closed');
        };

    } catch (error) {
        console.error('❌ WebSocket connection error:', error);
    }
}

function updateRoomState(state) {
    try {
        // Update member count
        document.getElementById('memberCount').textContent = `${state.members.length} ${state.members.length === 1 ? 'member' : 'members'}`;
        
        // Store updated member data
        if (!currentRoom.members) {
            currentRoom.members = {};
        }
        
        // Update markers and member data
        for (const member of state.members) {
            // Store member data for routing
            currentRoom.members[member.member_id] = {
                member_id: member.member_id,
                name: member.name,
                last_location: member.last_location,
                status: member.status
            };
            
            if (member.last_location) {
                const status = member.status.toLowerCase();
                updateMemberMarker(member.member_id, member.name, member.initials, member.last_location, status);
            }
        }
        
        // Update riders list
        updateRidersList(state.members);
        
        // Redraw routes if directions are shown
        if (showDirections) {
            drawAllRoutes();
        }
        
    } catch (error) {
        console.error('❌ Error updating room state:', error);
    }
}

function updateMemberMarker(memberId, memberName, initials, location, status) {
    try {
        // Special handling for current user with heading indicator
        if (memberId === currentMemberId) {
            updateUserLocationMarker(location, status);
            return;
        }

        // Remove old marker if exists
        if (markers[memberId]) {
            map.removeLayer(markers[memberId]);
        }

        // Create marker with status color
        const iconColor = status === 'live' ? 'green' : status === 'stale' ? 'orange' : 'grey';
        const iconUrl = `https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-${iconColor}.png`;

        const marker = L.marker([location.lat, location.lng], {
            icon: L.icon({
                iconUrl: iconUrl,
                shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                iconSize: [25, 41],
                iconAnchor: [12, 41],
                popupAnchor: [1, -34],
                shadowSize: [41, 41]
            })
        }).addTo(map);

        marker.bindPopup(`<b>${memberName}</b><br><small>${initials}</small><br>Status: ${status}`);
        markers[memberId] = marker;

    } catch (error) {
        console.error(`❌ Error updating marker for ${memberId}:`, error);
    }
}

function updateUserLocationMarker(location, status) {
    try {
        const iconColor = status === 'live' ? '#1A73E8' : status === 'stale' ? '#FF9500' : '#8E8E93';
        
        // Create custom SVG icon with heading indicator
        const svgIcon = `
            <svg width="48" height="48" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
                <!-- Outer glow -->
                <circle cx="24" cy="24" r="22" fill="${iconColor}" opacity="0.2"/>
                <!-- Main circle -->
                <circle cx="24" cy="24" r="16" fill="${iconColor}" opacity="0.8" stroke="white" stroke-width="3"/>
                <!-- Direction arrow -->
                <path d="M24 8 L28 16 L24 14 L20 16 Z" fill="white" opacity="0.9"/>
                <!-- Center dot -->
                <circle cx="24" cy="24" r="4" fill="white"/>
            </svg>
        `;
        
        const icon = L.divIcon({
            html: svgIcon,
            className: 'user-location-marker',
            iconSize: [48, 48],
            iconAnchor: [24, 24]
        });

        if (userLocationMarker) {
            // Update existing marker position and rotation
            userLocationMarker.setLatLng([location.lat, location.lng]);
            if (currentHeading !== null && currentHeading !== undefined) {
                userLocationMarker.setRotationAngle(currentHeading);
            }
        } else {
            // Create new marker with rotation capability
            userLocationMarker = L.marker([location.lat, location.lng], {
                icon: icon,
                rotationAngle: currentHeading || 0,
                rotationOrigin: 'center center',
                zIndexOffset: 1000
            }).addTo(map);
            
            userLocationMarker.bindPopup(`<b>You</b><br>Status: ${status}`);
        }

        // Smooth animation for marker updates
        if (userLocationMarker._icon) {
            userLocationMarker._icon.style.transition = 'transform 0.5s ease-out';
        }

    } catch (error) {
        console.error('❌ Error updating user location marker:', error);
    }
}

function updateRidersList(members) {
    const list = document.getElementById('ridersList');
    
    const html = members.map(member => {
        const status = member.status.toLowerCase();
        const statusEmoji = status === 'live' ? '🟢' : status === 'stale' ? '🟡' : '🔴';
        
        let locationText = 'No location';
        let distanceText = 'N/A';
        let etaText = '';
        
        if (member.last_location) {
            locationText = `${member.last_location.lat.toFixed(4)}, ${member.last_location.lng.toFixed(4)}`;
            const distance = haversineDistance(
                member.last_location.lat,
                member.last_location.lng,
                currentRoom.destination.lat,
                currentRoom.destination.lng
            );
            distanceText = `${distance.toFixed(2)} km`;
            
            // Calculate ETA assuming average speed of 30 km/h
            const avgSpeed = 30; // km/h
            const etaHours = distance / avgSpeed;
            const etaMinutes = Math.round(etaHours * 60);
            
            if (etaMinutes < 1) {
                etaText = '<div>⏱️ ETA: < 1 min</div>';
            } else if (etaMinutes < 60) {
                etaText = `<div>⏱️ ETA: ${etaMinutes} min</div>`;
            } else {
                const hours = Math.floor(etaMinutes / 60);
                const mins = etaMinutes % 60;
                etaText = `<div>⏱️ ETA: ${hours}h ${mins}m</div>`;
            }
        }

        return `
            <div style="padding: 12px; border-bottom: 1px solid #eee; border-left: 3px solid ${getRouteColor(member.member_id)};">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                    <strong>${member.name}</strong>
                    <span>${statusEmoji} ${status}</span>
                </div>
                <div style="font-size: 12px; color: #666;">
                    <div>📏 Distance: ${distanceText}</div>
                    ${etaText}
                </div>
            </div>
        `;
    }).join('');

    list.innerHTML = html || '<p style="padding: 12px; color: #999;">No members</p>';
}

function startTimer() {
    if (!currentRoom) return;

    const expiresAt = new Date(currentRoom.expires_at);
    
    const timerInterval = setInterval(() => {
        const now = new Date();
        const remaining = expiresAt - now;

        if (remaining <= 0) {
            clearInterval(timerInterval);
            document.getElementById('timer').textContent = 'Expired';
            return;
        }

        const hours = Math.floor(remaining / (1000 * 60 * 60));
        const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((remaining % (1000 * 60)) / 1000);

        document.getElementById('timer').textContent = `${hours}h ${minutes}m ${seconds}s`;
    }, 1000);
}

function startLocationTracking() {
    if (!navigator.geolocation) {
        console.warn('⚠️ Geolocation not supported, using demo mode');
        showLocationAlert('Geolocation not supported on this device. Using demo mode.');
        startDemoMode();
        return;
    }
    
    console.log('📍 Requesting geolocation permission...');
    
    // For mobile, we need to be more explicit about requesting permissions
    navigator.geolocation.getCurrentPosition(
        (position) => {
            console.log('✅ Geolocation permission granted');
            
            // Send first location immediately
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            console.log('📍 First location:', lat.toFixed(6), lng.toFixed(6));
            sendLocationUpdate(lat, lng, position.coords.heading, position.coords.speed);
            
            // Start watching position
            console.log('👀 Starting position watch...');
            locationInterval = navigator.geolocation.watchPosition(
                (pos) => {
                    const lat = pos.coords.latitude;
                    const lng = pos.coords.longitude;
                    console.log('📍 Location update:', lat.toFixed(6), lng.toFixed(6));
                    sendLocationUpdate(lat, lng, pos.coords.heading, pos.coords.speed);
                },
                (error) => {
                    console.warn('⚠️ Geolocation error:', error.message, 'Code:', error.code);
                    handleLocationError(error);
                },
                { 
                    enableHighAccuracy: true, 
                    maximumAge: 0, 
                    timeout: 10000  // Increased timeout for mobile
                }
            );
        },
        (error) => {
            console.warn('⚠️ Geolocation permission denied or error:', error.message, 'Code:', error.code);
            handleLocationError(error);
        },
        {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: 10000  // Increased timeout for mobile
        }
    );
}

function handleLocationError(error) {
    let message = '';
    
    switch(error.code) {
        case error.PERMISSION_DENIED:
            message = '📍 Location permission denied.\n\nTo use real location:\n1. Go to browser settings\n2. Allow location for this site\n3. Refresh the page\n\nUsing demo mode for now.';
            break;
        case error.POSITION_UNAVAILABLE:
            message = '📍 Location unavailable.\n\nTry:\n- Moving to a location with better GPS signal\n- Enabling location services\n\nUsing demo mode for now.';
            break;
        case error.TIMEOUT:
            message = '📍 Location request timed out.\n\nTry:\n- Checking your GPS/location settings\n- Moving outside or near a window\n\nUsing demo mode for now.';
            break;
        default:
            message = '📍 Location error.\n\nUsing demo mode for now.';
    }
    
    showLocationAlert(message);
    
    if (!demoMode) {
        startDemoMode();
    }
}

function showLocationAlert(message) {
    // Show a non-intrusive notification
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(255, 152, 0, 0.95);
        color: white;
        padding: 16px 24px;
        border-radius: 12px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        font-size: 14px;
        z-index: 10001;
        max-width: 90%;
        text-align: center;
        animation: slideIn 0.3s ease-out;
    `;
    notification.textContent = message.split('\n')[0]; // Show first line only
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => notification.remove(), 300);
    }, 5000);
}

function startDemoMode() {
    if (demoMode) return;
    
    console.log('🎮 Starting demo mode - simulating location');
    demoMode = true;
    
    const destination = currentRoom.destination;
    let angle = Math.random() * Math.PI * 2;
    const radius = 0.01; // ~1km

    locationInterval = setInterval(() => {
        angle += (Math.random() - 0.5) * 0.5;
        
        const lat = destination.lat + (radius * Math.cos(angle));
        const lng = destination.lng + (radius * Math.sin(angle));

        sendLocationUpdate(lat, lng, angle * 180 / Math.PI, 15);
    }, 3000);
}

function sendLocationUpdate(lat, lng, heading, speed) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('⚠️ WebSocket not ready');
        return;
    }

    try {
        // Store heading and speed
        currentHeading = heading || 0;
        currentSpeed = speed || 0;
        
        ws.send(JSON.stringify({
            type: 'location',
            lat: lat,
            lng: lng,
            heading: currentHeading,
            speed: currentSpeed,
            ts: Date.now()
        }));
        
        // Store location for navigation - CRITICAL!
        const isFirstLocation = !lastKnownLocation;
        lastKnownLocation = { lat, lng };
        currentUserLocation = { lat, lng };
        
        if (isFirstLocation) {
            console.log('✅ First location stored for navigation:', lat.toFixed(6), lng.toFixed(6));
            updateNavigationButtonState();
        }
        
        // Update own marker immediately with heading
        updateMemberMarker(currentMemberId, 'You', 'ME', { lat, lng }, 'live');
        
        // Update navigation if active (throttled)
        if (navigationActive) {
            updateNavigationProgressThrottled();
        }
        
    } catch (error) {
        console.error('❌ Error sending location:', error);
    }
}

function toggleDirections() {
    showDirections = !showDirections;
    const btn = document.getElementById('directionsBtn');
    
    console.log('🧭 Toggling directions:', showDirections ? 'ON' : 'OFF');
    
    if (showDirections) {
        btn.textContent = '🧭 Hide Directions';
        btn.classList.add('btn-primary');
        btn.classList.remove('btn-secondary');
        drawAllRoutes();
    } else {
        btn.textContent = '🧭 Show Directions';
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-secondary');
        clearAllRoutes();
    }
}

function drawAllRoutes() {
    if (!currentRoom || !map) {
        console.warn('⚠️ Cannot draw routes: currentRoom or map not ready');
        return;
    }
    
    const destination = currentRoom.destination;
    const members = currentRoom.members || {};
    const memberCount = Object.keys(members).length;
    
    console.log(`🗺️ Drawing routes for ${memberCount} members`);
    
    // Draw route for each member with a location
    for (const [memberId, member] of Object.entries(members)) {
        if (member.last_location) {
            console.log(`  → Drawing route for ${member.name || memberId}`);
            drawRoute(memberId, member.last_location, destination);
        } else {
            console.log(`  → Skipping ${member.name || memberId} (no location)`);
        }
    }
}

function drawRoute(memberId, fromLocation, toDestination) {
    // Remove existing route if any
    if (routingControls[memberId]) {
        map.removeControl(routingControls[memberId]);
        delete routingControls[memberId];
    }
    
    try {
        // Create routing control with reliable server
        const routingControl = L.Routing.control({
            waypoints: [
                L.latLng(fromLocation.lat, fromLocation.lng),
                L.latLng(toDestination.lat, toDestination.lng)
            ],
            routeWhileDragging: false,
            addWaypoints: false,
            draggableWaypoints: false,
            fitSelectedRoutes: false,
            show: false,
            lineOptions: {
                styles: [{
                    color: getRouteColor(memberId),
                    opacity: 0.6,
                    weight: 4
                }]
            },
            createMarker: function() { return null; }, // Don't create default markers
            router: L.Routing.osrmv1({
                serviceUrl: 'https://routing.openstreetmap.de/routed-car/route/v1',
                timeout: 30000
            })
        }).addTo(map);
        
        // Store the control
        routingControls[memberId] = routingControl;
        
        // Add error handler for fallback
        routingControl.on('routingerror', function(e) {
            console.warn('⚠️ Routing error for', memberId, '- showing direct line instead');
            
            // Remove the failed routing control
            if (routingControls[memberId]) {
                try {
                    map.removeControl(routingControls[memberId]);
                } catch (err) {
                    console.warn('Could not remove control:', err);
                }
            }
            
            // Draw simple direct line as fallback
            const directLine = L.polyline([
                [fromLocation.lat, fromLocation.lng],
                [toDestination.lat, toDestination.lng]
            ], {
                color: getRouteColor(memberId),
                weight: 3,
                opacity: 0.5,
                dashArray: '10, 10'
            }).addTo(map);
            
            // Store the polyline instead
            routingControls[memberId] = { _line: directLine };
        });
        
        console.log('✅ Route drawn for', memberId, 'color:', getRouteColor(memberId));
        
    } catch (error) {
        console.error('❌ Error drawing route for', memberId, error);
        
        // Fallback: Draw direct line
        try {
            const directLine = L.polyline([
                [fromLocation.lat, fromLocation.lng],
                [toDestination.lat, toDestination.lng]
            ], {
                color: getRouteColor(memberId),
                weight: 3,
                opacity: 0.5,
                dashArray: '10, 10'
            }).addTo(map);
            
            routingControls[memberId] = { _line: directLine };
            console.log('✅ Direct line drawn for', memberId, '(fallback)');
        } catch (fallbackError) {
            console.error('❌ Even fallback failed:', fallbackError);
        }
    }
}

function getRouteColor(memberId) {
    // Generate a consistent color for each member
    const colors = ['#3388ff', '#ff5733', '#33ff57', '#ff33a1', '#a133ff', '#33fff5'];
    const hash = memberId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[hash % colors.length];
}

function clearAllRoutes() {
    // Remove all routing controls and lines
    for (const [memberId, control] of Object.entries(routingControls)) {
        if (control && map) {
            try {
                // If it's a routing control
                if (control.removeFrom) {
                    map.removeControl(control);
                }
                // If it's a fallback polyline
                else if (control._line && control._line.remove) {
                    control._line.remove();
                }
            } catch (error) {
                console.warn('Error removing route for', memberId, error);
            }
        }
    }
    routingControls = {};
}

// ============= NAVIGATION FEATURE =============

function startNavigation() {
    if (!currentRoom || !map) {
        alert('Cannot start navigation');
        return;
    }
    
    // Get current location
    if (!lastKnownLocation) {
        alert('📍 Acquiring your location...\n\nPlease wait a moment while we get your GPS position, then try again.\n\nTip: Make sure location permissions are enabled!');
        
        // Try to trigger location update
        if (!locationInterval && !demoMode) {
            console.log('🔄 Attempting to start location tracking...');
            startLocationTracking();
        }
        return;
    }
    
    console.log('🧭 Starting FUTURISTIC navigation mode');
    navigationActive = true;
    
    // Update UI - show full-screen navigation panel
    document.getElementById('startNavBtn').style.display = 'none';
    document.getElementById('stopNavBtn').style.display = 'inline-flex';
    document.getElementById('navigationPanel').style.display = 'block';
    
    // Hide bottom sheet and header for full-screen experience
    const sheet = document.querySelector('.bottom-sheet');
    const header = document.querySelector('.room-header');
    if (sheet) {
        sheet.style.transform = 'translateY(100%)';
        sheet.style.transition = 'transform 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
    }
    if (header) {
        header.style.opacity = '0';
        header.style.transition = 'opacity 0.3s';
    }
    
    // Create navigation route
    createNavigationRoute(lastKnownLocation, currentRoom.destination);
    
    // Center map on user location
    map.setView([lastKnownLocation.lat, lastKnownLocation.lng], 16, {
        animate: true,
        duration: 0.5
    });
}

function stopNavigation() {
    console.log('🛑 Stopping navigation');
    navigationActive = false;
    
    // Update UI
    document.getElementById('startNavBtn').style.display = 'inline-flex';
    document.getElementById('stopNavBtn').style.display = 'none';
    
    // Fade out navigation panel
    const navPanel = document.getElementById('navigationPanel');
    if (navPanel) {
        navPanel.style.opacity = '0';
        navPanel.style.transition = 'opacity 0.3s';
        setTimeout(() => {
            navPanel.style.display = 'none';
            navPanel.style.opacity = '1';
        }, 300);
    }
    
    // Hide lane guidance
    const laneGuidance = document.getElementById('laneGuidance');
    if (laneGuidance) {
        laneGuidance.style.display = 'none';
    }
    
    // Remove navigation route
    if (navigationRoutingControl && map) {
        map.removeControl(navigationRoutingControl);
        navigationRoutingControl = null;
    }
    navigationRoute = null;
    
    // Show bottom sheet and header again
    const sheet = document.querySelector('.bottom-sheet');
    const header = document.querySelector('.room-header');
    if (sheet) {
        sheet.style.transform = 'translateY(0)';
    }
    if (header) {
        header.style.opacity = '1';
    }
    
    // Reset map view
    if (currentRoom && map) {
        map.setView([currentRoom.destination.lat, currentRoom.destination.lng], 13, {
            animate: true,
            duration: 0.5
        });
    }
}

function createNavigationRoute(fromLocation, toDestination) {
    // Remove existing navigation route smoothly
    if (navigationRoutingControl && map) {
        try {
            map.removeControl(navigationRoutingControl);
        } catch (e) {
            console.warn('Error removing old route:', e);
        }
    }
    
    try {
        console.log('📍 Creating navigation route from', fromLocation, 'to', toDestination);
        
        // Show loading state
        document.getElementById('navInstruction').textContent = 'Calculating optimal route...';
        document.getElementById('navInstructionDistance').textContent = 'Please wait';
        
        // Create navigation routing control with optimized settings
        navigationRoutingControl = L.Routing.control({
            waypoints: [
                L.latLng(fromLocation.lat, fromLocation.lng),
                L.latLng(toDestination.lat, toDestination.lng)
            ],
            routeWhileDragging: false,
            addWaypoints: false,
            draggableWaypoints: false,
            fitSelectedRoutes: navigationRoute ? false : true, // Only fit on first route
            show: false, // Hide default instruction panel
            lineOptions: {
                styles: [{
                    color: '#1A73E8',
                    opacity: 0.9,
                    weight: 6,
                    className: 'nav-route-line'
                }],
                extendToWaypoints: true,
                missingRouteTolerance: 10
            },
            createMarker: function() { return null; }, // Don't create default markers
            router: L.Routing.osrmv1({
                serviceUrl: 'https://routing.openstreetmap.de/routed-car/route/v1',
                timeout: 30000  // 30 second timeout for reliability
            }),
            containerClassName: 'leaflet-routing-container-hidden',
            summaryTemplate: '<div></div>',
            show: false,
            collapsible: false
        }).addTo(map);
        
        // Listen for route found event
        navigationRoutingControl.on('routesfound', function(e) {
            const routes = e.routes;
            if (routes && routes.length > 0) {
                navigationRoute = routes[0];
                console.log('✅ Navigation route found:', navigationRoute);
                
                // Add smooth fade-in animation to route line
                setTimeout(() => {
                    const routeLines = document.querySelectorAll('.nav-route-line');
                    routeLines.forEach(line => {
                        line.style.animation = 'routeFadeIn 0.6s ease-out';
                    });
                }, 50);
                
                // Update UI with route information
                updateNavigationUI(navigationRoute);
            }
        });
        
        navigationRoutingControl.on('routingerror', function(e) {
            console.error('❌ Routing error:', e);
            
            // Show simple route line as fallback
            const routeLine = L.polyline([
                [fromLocation.lat, fromLocation.lng],
                [toDestination.lat, toDestination.lng]
            ], {
                color: '#1A73E8',
                weight: 4,
                opacity: 0.7,
                dashArray: '10, 10'
            }).addTo(map);
            
            // Calculate straight-line distance and basic ETA
            const distance = haversineDistance(
                fromLocation.lat, fromLocation.lng,
                toDestination.lat, toDestination.lng
            );
            const estimatedTime = Math.ceil((distance / 50) * 60); // Assuming 50 km/h average
            
            // Update UI with basic info
            document.getElementById('navInstruction').textContent = 'Direct route shown';
            document.getElementById('navInstructionDistance').textContent = 'Turn-by-turn unavailable';
            document.getElementById('navDistance').textContent = `${distance.toFixed(1)} km`;
            document.getElementById('navETA').textContent = `~${estimatedTime} min`;
            document.getElementById('navSpeed').textContent = '-';
            
            // Hide lane guidance
            const laneGuidance = document.getElementById('laneGuidance');
            if (laneGuidance) {
                laneGuidance.style.display = 'none';
            }
            
            // Show notification
            showNavigationError('Routing service unavailable. Showing direct route instead.');
        });
        
    } catch (error) {
        console.error('❌ Error creating navigation route:', error);
        showNavigationError('Failed to start navigation. Please try again.');
    }
}

function showNavigationError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = `
        position: fixed;
        top: 120px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(255, 152, 0, 0.95);
        color: white;
        padding: 16px 24px;
        border-radius: 12px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
        font-size: 14px;
        font-weight: 600;
        z-index: 10001;
        text-align: center;
        animation: slideIn 0.3s ease-out;
        max-width: 80%;
        backdrop-filter: blur(10px);
    `;
    errorDiv.innerHTML = `
        <div style="font-size: 24px; margin-bottom: 8px;">ℹ️</div>
        <div>${message}</div>
    `;
    document.body.appendChild(errorDiv);
    
    setTimeout(() => {
        errorDiv.style.opacity = '0';
        errorDiv.style.transition = 'opacity 0.3s';
        setTimeout(() => errorDiv.remove(), 300);
    }, 4000);
}

function updateNavigationUI(route) {
    if (!route) return;
    
    // Calculate total distance and time
    const distanceKm = (route.summary.totalDistance / 1000).toFixed(1);
    const timeMin = Math.ceil(route.summary.totalTime / 60);
    
    // Update stats with animation
    updateStatWithAnimation('navDistance', `${distanceKm} km`);
    updateStatWithAnimation('navETA', `${timeMin} min`);
    
    // Update speed if available
    if (currentSpeed !== null && currentSpeed > 0) {
        const speedKmh = (currentSpeed * 3.6).toFixed(0); // Convert m/s to km/h
        updateStatWithAnimation('navSpeed', `${speedKmh} km/h`);
    } else {
        document.getElementById('navSpeed').textContent = '-';
    }
    
    // Get next instruction
    if (route.instructions && route.instructions.length > 0) {
        const instruction = route.instructions[0];
        const instructionText = instruction.text || 'Continue on route';
        const instructionDistance = instruction.distance ? 
            (instruction.distance < 1000 ? 
                `in ${instruction.distance.toFixed(0)} m` : 
                `in ${(instruction.distance / 1000).toFixed(1)} km`) : '';
        
        document.getElementById('navInstruction').textContent = instructionText;
        document.getElementById('navInstructionDistance').textContent = instructionDistance;
        
        // Update direction arrow SVG based on instruction type
        updateDirectionArrow(instruction.type);
        
        // Update lane guidance if available
        updateLaneGuidance(instruction);
    }
}

function updateStatWithAnimation(elementId, value) {
    const element = document.getElementById(elementId);
    if (!element) return;
    
    const currentValue = element.textContent;
    if (currentValue !== value) {
        element.classList.add('updating');
        element.textContent = value;
        setTimeout(() => {
            element.classList.remove('updating');
        }, 300);
    }
}

function updateDirectionArrow(instructionType) {
    const arrowElement = document.getElementById('navDirectionIcon');
    if (!arrowElement) return;
    
    // Define SVG paths for different direction types
    const arrowPaths = {
        'Straight': 'M50 10 L50 90 M50 10 L30 30 M50 10 L70 30',
        'Right': 'M30 50 L90 50 L90 30 M90 50 L90 70',
        'Left': 'M70 50 L10 50 L10 30 M10 50 L10 70',
        'SlightRight': 'M30 70 L80 20 L60 20 M80 20 L80 40',
        'SlightLeft': 'M70 70 L20 20 L40 20 M20 20 L20 40',
        'SharpRight': 'M30 10 L70 10 L70 90 L50 90 M70 90 L90 90',
        'SharpLeft': 'M70 10 L30 10 L30 90 L50 90 M30 90 L10 90',
        'TurnAround': 'M70 30 Q90 30 90 50 Q90 70 70 70 L30 70 L30 50 M30 70 L30 90',
        'WaypointReached': 'M50 20 L80 80 L20 80 Z',
        'DestinationReached': 'M50 10 L90 90 L50 70 L10 90 Z'
    };
    
    const path = arrowPaths[instructionType] || arrowPaths['Straight'];
    
    // Update SVG with smooth transition
    arrowElement.innerHTML = `
        <path d="${path}" stroke="currentColor" stroke-width="8" fill="none" 
              stroke-linecap="round" stroke-linejoin="round"
              style="transition: d 0.3s ease-out;"/>
    `;
    
    // Add animation class
    const iconWrapper = arrowElement.closest('.nav-icon-wrapper');
    if (iconWrapper) {
        iconWrapper.style.animation = 'none';
        setTimeout(() => {
            iconWrapper.style.animation = 'navIconFloat 3s ease-in-out infinite';
        }, 10);
    }
}

function updateLaneGuidance(instruction) {
    // Parse lane information from instruction if available
    // This is a simplified version - real implementation would parse OSRM lane data
    const laneGuidance = document.getElementById('laneGuidance');
    const laneArrows = document.getElementById('laneArrows');
    
    if (!laneGuidance || !laneArrows) return;
    
    // For demonstration, show lane guidance for turn instructions
    const showLanes = ['Right', 'Left', 'SlightRight', 'SlightLeft', 'SharpRight', 'SharpLeft'].includes(instruction.type);
    
    if (showLanes) {
        laneGuidance.style.display = 'block';
        
        // Generate lane arrows (simplified - in production, use actual lane data)
        const numLanes = 3;
        const activeLane = instruction.type.includes('Right') ? numLanes - 1 : 0;
        
        let lanesHTML = '';
        for (let i = 0; i < numLanes; i++) {
            const isActive = i === activeLane;
            const arrowDirection = instruction.type.includes('Right') ? '↗' : 
                                  instruction.type.includes('Left') ? '↖' : '↑';
            lanesHTML += `
                <div class="lane-arrow ${isActive ? 'active' : ''}">
                    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <text x="12" y="18" text-anchor="middle" font-size="20">${arrowDirection}</text>
                    </svg>
                </div>
            `;
        }
        laneArrows.innerHTML = lanesHTML;
    } else {
        laneGuidance.style.display = 'none';
    }
}

function updateNavigationProgressThrottled() {
    // Throttle route updates to avoid excessive recalculations (max once per 2 seconds)
    const now = Date.now();
    if (now - lastRouteUpdate < 2000) {
        // Just update UI without recalculating route
        if (navigationRoute) {
            updateNavigationUI(navigationRoute);
        }
        return;
    }
    
    updateNavigationProgress();
}

function updateNavigationProgress() {
    if (!navigationActive || !navigationRoute || !lastKnownLocation) {
        return;
    }
    
    lastRouteUpdate = Date.now();
    
    // Check if we need to recalculate route (if moved significantly off-route)
    const distanceFromRoute = calculateDistanceFromRoute(lastKnownLocation);
    
    if (distanceFromRoute > 50) { // 50 meters off route
        console.log('🔄 Recalculating route (off course by', distanceFromRoute.toFixed(0), 'm)');
        createNavigationRoute(lastKnownLocation, currentRoom.destination);
    } else {
        // Update navigation UI with current position
        if (navigationRoute) {
            updateNavigationUI(navigationRoute);
        }
    }
    
    // Check if we've arrived (within 50m of destination)
    const distanceToDestination = haversineDistance(
        lastKnownLocation.lat,
        lastKnownLocation.lng,
        currentRoom.destination.lat,
        currentRoom.destination.lng
    );
    
    if (distanceToDestination < 0.05) { // Less than 50 meters
        console.log('🏁 Arrived at destination!');
        showArrivalNotification();
        stopNavigation();
    } else if (navigationActive && map) {
        // Keep user location centered during navigation (smooth follow mode)
        map.panTo([lastKnownLocation.lat, lastKnownLocation.lng], {
            animate: true,
            duration: 0.5,
            easeLinearity: 0.25
        });
    }
}

function calculateDistanceFromRoute(location) {
    // Simplified: calculate distance to destination
    // In a real implementation, would calculate perpendicular distance to route polyline
    if (!navigationRoute || !navigationRoute.coordinates) {
        return 0;
    }
    
    // Find closest point on route
    let minDistance = Infinity;
    for (const coord of navigationRoute.coordinates) {
        const distance = haversineDistance(
            location.lat,
            location.lng,
            coord.lat,
            coord.lng
        ) * 1000; // Convert to meters
        
        if (distance < minDistance) {
            minDistance = distance;
        }
    }
    
    return minDistance;
}

function showArrivalNotification() {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: linear-gradient(135deg, #34A853 0%, #1A73E8 100%);
        color: white;
        padding: 32px 48px;
        border-radius: 24px;
        box-shadow: 0 8px 40px rgba(0, 0, 0, 0.4),
                    0 0 0 4px rgba(52, 168, 83, 0.2);
        font-size: 22px;
        font-weight: 700;
        z-index: 10001;
        text-align: center;
        animation: arrivalBounce 0.6s cubic-bezier(0.68, -0.55, 0.265, 1.55);
        backdrop-filter: blur(10px);
        border: 2px solid rgba(255, 255, 255, 0.3);
    `;
    notification.innerHTML = `
        <div style="font-size: 48px; margin-bottom: 12px;">🏁</div>
        <div>You have arrived!</div>
        <div style="font-size: 16px; font-weight: 400; margin-top: 8px; opacity: 0.9;">
            Welcome to your destination
        </div>
    `;
    document.body.appendChild(notification);
    
    // Add arrival animation
    const style = document.createElement('style');
    style.textContent = `
        @keyframes arrivalBounce {
            0% {
                opacity: 0;
                transform: translate(-50%, -50%) scale(0.5) rotate(-5deg);
            }
            50% {
                transform: translate(-50%, -50%) scale(1.05) rotate(2deg);
            }
            100% {
                opacity: 1;
                transform: translate(-50%, -50%) scale(1) rotate(0deg);
            }
        }
    `;
    document.head.appendChild(style);
    
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => {
            notification.remove();
            style.remove();
        }, 300);
    }, 3500);
}

function updateNavigationButtonState() {
    const startBtn = document.getElementById('startNavBtn');
    if (!startBtn || navigationActive) return;
    
    if (lastKnownLocation) {
        startBtn.innerHTML = '🧭 Start Navigation';
        startBtn.disabled = false;
        startBtn.style.opacity = '1';
    } else {
        startBtn.innerHTML = '📍 Getting Location...';
        startBtn.disabled = true;
        startBtn.style.opacity = '0.6';
    }
}

function copyRoomCode() {
    if (!currentRoom) return;
    copyToClipboard(currentRoom.room_id);
    alert('✅ Room code copied: ' + currentRoom.room_id);
}

function copyInviteLink() {
    if (!currentRoom) return;
    const link = `${window.location.origin}?room=${currentRoom.room_id}`;
    copyToClipboard(link);
    alert('✅ Invite link copied!');
}

function leaveRoom() {
    // Stop navigation if active
    if (navigationActive) {
        stopNavigation();
    }
    
    // Clean up
    clearAllRoutes();
    
    if (ws) {
        ws.close();
        ws = null;
    }
    if (locationInterval) {
        clearInterval(locationInterval);
        locationInterval = null;
    }
    if (userLocationMarker && map) {
        map.removeLayer(userLocationMarker);
        userLocationMarker = null;
    }
    if (map) {
        map.remove();
        map = null;
    }
    
    // Clear storage
    localStorage.removeItem('member_id');
    localStorage.removeItem('token');
    localStorage.removeItem('room_code');
    
    // Reset state
    currentRoom = null;
    currentMemberId = null;
    currentToken = null;
    markers = {};
    routingControls = {};
    demoMode = false;
    showDirections = false;
    navigationActive = false;
    navigationRoute = null;
    navigationRoutingControl = null;
    currentUserLocation = null;
    lastKnownLocation = null;
    currentHeading = 0;
    currentSpeed = 0;
    lastRouteUpdate = 0;
    
    // Go back to home
    window.location.href = '/';
}

function toggleBottomSheet() {
    const content = document.querySelector('.sheet-content');
    const icon = document.querySelector('.collapse-icon');
    
    if (content && icon) {
        const isHidden = content.style.display === 'none';
        content.style.display = isHidden ? 'block' : 'none';
        icon.style.transform = isHidden ? 'none' : 'rotate(180deg)';
    }
}

// ============= PAGE INITIALIZATION =============

// Check if user is joining from link or loading room
window.addEventListener('load', () => {
    console.log('🏠 Page loaded');
    
    const params = new URLSearchParams(window.location.search);
    const roomCode = params.get('room');
    const joinCode = params.get('join');
    
    // If room code in URL and we have credentials, load room
    if (roomCode) {
        const memberId = localStorage.getItem('member_id');
        const token = localStorage.getItem('token');
        const storedRoom = localStorage.getItem('room_code');
        
        if (memberId && token && storedRoom === roomCode) {
            console.log('📍 Loading room:', roomCode);
            loadRoomPage(roomCode, memberId, token);
            return;
        } else {
            // Clear invalid credentials
            localStorage.removeItem('member_id');
            localStorage.removeItem('token');
            localStorage.removeItem('room_code');
            // Pre-fill join form
            document.getElementById('roomCode').value = roomCode;
            document.getElementById('joinName').focus();
        }
    }
    
    // If join code detected, pre-fill join form
    if (joinCode) {
        console.log('📍 Detected join code:', joinCode);
        document.getElementById('roomCode').value = joinCode;
        document.getElementById('joinName').focus();
    }
});

// ============= EXPOSE FUNCTIONS TO GLOBAL SCOPE =============
// Required for onclick handlers in HTML to work
window.createRoom = createRoom;
window.joinRoom = joinRoom;
window.joinCreatedRoom = joinCreatedRoom;
window.toggleDirections = toggleDirections;
window.copyRoomCode = copyRoomCode;
window.copyInviteLink = copyInviteLink;
window.leaveRoom = leaveRoom;
window.toggleBottomSheet = toggleBottomSheet;
window.startNavigation = startNavigation;
window.stopNavigation = stopNavigation;

console.log('✅ Tether navigation loaded - version 2.0');
console.log('🧭 Navigation functions available:', typeof window.startNavigation, typeof window.stopNavigation);

// ============= LOCATION PERMISSION HELPERS =============

async function checkLocationPermissionStatus() {
    // For iOS/Safari, we can't reliably check permissions
    // Instead, we'll just try to get location and handle errors
    
    // Wait a bit, then check if location was acquired
    setTimeout(() => {
        if (!lastKnownLocation && !demoMode) {
            console.log('📍 Location not acquired yet - showing banner');
            showLocationBanner();
        }
    }, 5000); // Give 5 seconds for location to be acquired
}

function showLocationBanner() {
    const banner = document.getElementById('locationBanner');
    if (banner) {
        banner.style.display = 'block';
    }
}

function dismissLocationBanner() {
    const banner = document.getElementById('locationBanner');
    if (banner) {
        banner.style.display = 'none';
    }
}

function requestLocationPermission() {
    dismissLocationBanner();
    
    console.log('📍 Manually requesting location permission...');
    
    // Force a fresh location request with high priority
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                console.log('✅ Location permission granted!');
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;
                
                // Stop demo mode if it was running
                if (demoMode && locationInterval) {
                    clearInterval(locationInterval);
                    demoMode = false;
                }
                
                sendLocationUpdate(lat, lng, position.coords.heading, position.coords.speed);
                
                showLocationAlert('✅ Location enabled! Your real position is now shown.');
                
                // Start continuous tracking
                if (!locationInterval) {
                    startLocationTracking();
                }
            },
            (error) => {
                console.warn('⚠️ Manual permission request failed:', error.message, 'Code:', error.code);
                
                let message = '';
                if (error.code === 1) {
                    // Permission denied
                    message = '❌ Location permission denied.\n\nTo fix:\n1. Go to Chrome Settings\n2. Site Settings → Location\n3. Allow for this site\n\nUsing demo mode for now.';
                } else if (error.code === 2) {
                    // Position unavailable
                    message = '⚠️ GPS unavailable.\n\nTry:\n- Moving outside\n- Near a window\n- Wait longer\n\nUsing demo mode.';
                } else if (error.code === 3) {
                    // Timeout
                    message = '⏱️ GPS timeout.\n\nTry again or use demo mode.';
                }
                
                showLocationAlert(message);
                
                if (!demoMode) {
                    startDemoMode();
                }
            },
            { 
                enableHighAccuracy: true, 
                timeout: 15000,  // 15 seconds for manual request
                maximumAge: 0 
            }
        );
    } else {
        showLocationAlert('❌ Geolocation not supported on this device.');
        startDemoMode();
    }
}

window.requestLocationPermission = requestLocationPermission;
window.dismissLocationBanner = dismissLocationBanner;
