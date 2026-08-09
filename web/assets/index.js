// ============= WAYSERA JOURNEY LIFECYCLE =============
// CONFIG lives in app.js. Crypto, storage, validation and the relay session
// live in crypto.js / store.js / validate.js / journey.js.
//
// There is no server to ask about a journey any more. A journey is created on
// this device, its key travels in the invite fragment, and everything else
// arrives from peers over the relay.

const NAME_KEY = 'waysera.name';

// The view model deliberately keeps the shape the map, routing and navigation
// code already expects, so none of that had to change: room_id, destination,
// and a members map keyed by id with last_location.
let currentRoom = null;
let currentMemberId = null;
let session = null;

let map = null;
let markers = {};
let destMarker = null;
let routingControls = {};
let showDirections = false;

// Geolocation and demo mode used to share one variable, which meant leaveRoom()
// called clearInterval on a watchPosition id and silently left GPS running.
// They are separate handles now, cleared with the matching API.
let geoWatchId = null;
let demoIntervalId = null;
let demoMode = false;

// Navigation state
let navigationActive = false;
let navigationRoute = null;
let navigationRoutingControl = null;
let currentUserLocation = null;
let lastKnownLocation = null;
let currentHeading = 0;
let currentSpeed = 0;
let userLocationMarker = null;
let lastRouteUpdate = 0;

// ---------------------------------------------------------------- helpers

function rememberName(name) {
    try { localStorage.setItem(NAME_KEY, name); } catch (error) { /* private mode */ }
}

function recallName() {
    try { return localStorage.getItem(NAME_KEY) || ''; } catch (error) { return ''; }
}

function relayBase() {
    return CONFIG.API_BASE;
}

function personCount(count) {
    return `${count} ${count === 1 ? 'person' : 'people'}`;
}

function formatEndsIn(expiresAt) {
    if (!expiresAt) return '';
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) return 'This journey has ended';

    const minutes = Math.floor(remaining / 60000);
    const hours = Math.floor(minutes / 60);
    return hours > 0 ? `Ends in ${hours}h ${minutes % 60}m` : `Ends in ${minutes}m`;
}

// ------------------------------------------------------------ create journey

async function createJourney() {
    const nameInput = document.getElementById('destName');
    const destination = {
        name: WayseraValidate.cleanName(nameInput.value),
        lat: parseFloat(document.getElementById('destLat').value),
        lng: parseFloat(document.getElementById('destLng').value)
    };
    const duration = parseInt(document.getElementById('duration').value, 10) || 180;

    if (!destination.name || !Number.isFinite(destination.lat) || !Number.isFinite(destination.lng)) {
        showError('createResult', 'Add a destination and its coordinates to start.');
        return;
    }

    const code = WayseraCrypto.generateJourneyCode();
    const key = await WayseraCrypto.generateJourneyKey();
    const encodedKey = await WayseraCrypto.exportJourneyKey(key);

    const journey = {
        code,
        key,
        destination,
        createdAt: Date.now(),
        expiresAt: Date.now() + duration * 60000
    };
    await WayseraStore.putJourney(journey);

    const inviteLink = WayseraCrypto.buildInviteLink(window.location.origin, code, encodedKey);
    renderJourneyReady(code, inviteLink);
}

function renderJourneyReady(code, inviteLink) {
    const panel = document.getElementById('createResult');
    panel.className = 'result success';
    panel.style.display = 'block';
    panel.replaceChildren();

    const heading = document.createElement('h3');
    heading.textContent = 'Your journey is ready';

    const hint = document.createElement('p');
    hint.textContent = 'Share this journey code with your group:';

    const codeBox = document.createElement('div');
    codeBox.className = 'journey-code-display';
    codeBox.textContent = code;

    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'btn btn-secondary btn-full';
    share.textContent = 'Share invite';
    share.onclick = () => shareInvite(inviteLink);

    const namePrompt = document.createElement('p');
    namePrompt.textContent = 'Enter your name to join the journey.';

    const nameField = document.createElement('input');
    nameField.type = 'text';
    nameField.className = 'form-control';
    nameField.placeholder = 'Your name';
    nameField.value = recallName();

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn btn-primary btn-full';
    go.textContent = 'Join journey';
    go.onclick = () => {
        const name = WayseraValidate.cleanName(nameField.value);
        if (!name) {
            showError('createResult', 'Add your name so your group knows who you are.');
            return;
        }
        rememberName(name);
        startJourney(code, name);
    };

    panel.append(heading, hint, codeBox, share, namePrompt, nameField, go);
}

async function shareInvite(inviteLink) {
    if (navigator.share) {
        try {
            await navigator.share({ title: 'Waysera', text: 'Join my journey', url: inviteLink });
            return;
        } catch (error) {
            // Cancelled, or unsupported in this context — fall through to copy.
        }
    }
    copyToClipboard(inviteLink);
    alert('Invite link copied.');
}

// -------------------------------------------------------------- join journey

async function joinJourney() {
    const name = WayseraValidate.cleanName(document.getElementById('joinName').value);
    const code = WayseraCrypto.normaliseCode(document.getElementById('roomCode').value);

    if (!name) {
        showError('joinResult', 'Add your name so your group knows who you are.');
        return;
    }
    if (!WayseraCrypto.isValidCode(code)) {
        showError('joinResult', 'That journey code does not look right. Check it and try again.');
        return;
    }

    rememberName(name);
    startJourney(code, name);
}

// ----------------------------------------------------------- journey session

async function startJourney(code, name) {
    const stored = await WayseraStore.getJourney(code);

    currentRoom = {
        room_id: code,
        destination: stored && stored.destination ? stored.destination : null,
        expires_at: stored ? stored.expiresAt : null,
        members: {}
    };

    session = new WayseraJourney.Session({
        code,
        key: stored ? stored.key : null,
        name,
        relayBase: relayBase(),
        destination: currentRoom.destination,
        expiresAt: currentRoom.expires_at
    });
    currentMemberId = session.memberId;

    wireSession(session);

    document.getElementById('homePage').style.display = 'none';
    document.getElementById('roomPage').style.display = 'block';

    WayseraValidate.setText(document.getElementById('roomCodeDisplay'), `Journey code: ${code}`);
    WayseraValidate.setText(
        document.getElementById('destNameDisplay'),
        currentRoom.destination ? currentRoom.destination.name : 'Waiting for your group…'
    );

    WayseraStore.setActiveJourney(code);

    if (currentRoom.destination) initializeMap();
    await session.connect();

    startTimer();
    updateNavigationButtonState();
    checkLocationPermissionStatus();
    setTimeout(() => startLocationTracking(), 1000);
}

function wireSession(activeSession) {
    activeSession.on('roster', (roster) => {
        // Keep the legacy members map in step so routing and navigation, which
        // read currentRoom.members, keep working unchanged.
        currentRoom.members = {};
        for (const member of roster) {
            currentRoom.members[member.memberId] = {
                member_id: member.memberId,
                name: member.isSelf ? 'You' : member.name,
                last_location:
                    member.lat === undefined || member.lat === null
                        ? null
                        : { lat: member.lat, lng: member.lng },
                status: member.status
            };
            if (member.lat !== undefined && member.lat !== null && map) {
                updateMemberMarker(
                    member.memberId,
                    member.isSelf ? 'You' : member.name,
                    { lat: member.lat, lng: member.lng },
                    member.status
                );
            }
        }

        WayseraValidate.setText(
            document.getElementById('memberCount'),
            personCount(roster.length)
        );
        renderGroup(roster);

        if (showDirections) drawAllRoutes();
    });

    activeSession.on('journey_config', async (message) => {
        currentRoom.destination = message.destination;
        currentRoom.expires_at = message.expiresAt;
        WayseraValidate.setText(
            document.getElementById('destNameDisplay'),
            message.destination.name
        );

        // Persist so a reload does not depend on a peer being online.
        const stored = (await WayseraStore.getJourney(currentRoom.room_id)) || {
            code: currentRoom.room_id,
            createdAt: Date.now()
        };
        stored.destination = message.destination;
        stored.expiresAt = message.expiresAt;
        stored.key = activeSession.key;
        await WayseraStore.putJourney(stored);

        if (!map) initializeMap();
        startTimer();
    });

    activeSession.on('key_granted', async ({ key }) => {
        const stored = (await WayseraStore.getJourney(currentRoom.room_id)) || {
            code: currentRoom.room_id,
            createdAt: Date.now()
        };
        stored.key = key;
        await WayseraStore.putJourney(stored);
        showLocationAlert('You are in. Waiting for journey details…');
    });

    activeSession.on('awaiting_key', () => {
        WayseraValidate.setText(
            document.getElementById('destNameDisplay'),
            'Waiting for someone to let you in…'
        );
    });

    activeSession.on('key_request', (request) => showJoinRequest(request));

    activeSession.on('refused', ({ reason }) => {
        alert(
            reason === 'channel full'
                ? 'This journey already has the maximum number of people.'
                : 'We could not join that journey.'
        );
        leaveJourney();
    });
}

// ------------------------------------------------------- join approval prompt

function showJoinRequest(request) {
    const host = document.createElement('div');
    host.className = 'join-request';

    const title = document.createElement('div');
    title.className = 'join-request-title';
    // textContent, not innerHTML: this string came from another device.
    title.textContent = `${request.name} wants to join`;

    const body = document.createElement('div');
    body.className = 'join-request-body';
    body.textContent = 'Only allow this if you recognise the name.';

    const actions = document.createElement('div');
    actions.className = 'join-request-actions';

    const allow = document.createElement('button');
    allow.type = 'button';
    allow.className = 'btn btn-primary';
    allow.textContent = 'Allow';
    allow.onclick = () => {
        session.approveKeyRequest(request.memberId);
        host.remove();
    };

    const deny = document.createElement('button');
    deny.type = 'button';
    deny.className = 'btn btn-secondary';
    deny.textContent = 'Not now';
    deny.onclick = () => {
        session.denyKeyRequest(request.memberId);
        host.remove();
    };

    actions.append(allow, deny);
    host.append(title, body, actions);
    document.body.appendChild(host);
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
        
        // Tile source: OpenStreetMap locally (no token required), Mapbox in production.
        // The token lives in exactly one place — WAYSERA_CONFIG in config.js — so
        // rotating it is a single edit. There is deliberately no hardcoded fallback
        // copy here; a second copy is how a rotation silently half-applies.
        const mapboxToken = (window.WAYSERA_CONFIG && window.WAYSERA_CONFIG.MAPBOX_TOKEN) || '';
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const mapboxAllowedHere = !isLocalhost || (window.WAYSERA_CONFIG && window.WAYSERA_CONFIG.USE_MAPBOX_ON_LOCALHOST);
        const useMapbox = Boolean(mapboxToken) && mapboxAllowedHere;

        if (!useMapbox) {
            if (mapboxAllowedHere && !mapboxToken) {
                console.warn('No Mapbox token configured — falling back to OpenStreetMap tiles.');
            }
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
            L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/{z}/{x}/{y}?access_token=${mapboxToken}`, {
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

// The relay socket, roster and state fan-out all live in journey.js now.
// What used to be connectWebSocket + updateRoomState is wireSession() above.


function updateMemberMarker(memberId, memberName, location, status) {
    try {
        if (memberId === currentMemberId) {
            updateUserLocationMarker(location, status);
            return;
        }

        if (markers[memberId]) {
            map.removeLayer(markers[memberId]);
        }

        const iconColor = status === 'live' ? 'green' : status === 'stale' ? 'orange' : 'grey';
        const marker = L.marker([location.lat, location.lng], {
            icon: L.icon({
                iconUrl: `https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-${iconColor}.png`,
                shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                iconSize: [25, 41],
                iconAnchor: [12, 41],
                popupAnchor: [1, -34],
                shadowSize: [41, 41]
            })
        }).addTo(map);

        // Popups take a DOM node rather than an HTML string: memberName came
        // from another device, and bindPopup would parse it as markup.
        const popup = document.createElement('div');
        const nameLine = document.createElement('strong');
        nameLine.textContent = memberName || 'Someone';
        const statusLine = document.createElement('div');
        statusLine.textContent = status;
        popup.append(nameLine, statusLine);
        marker.bindPopup(popup);

        markers[memberId] = marker;
    } catch (error) {
        console.error(`Could not update marker for ${memberId}`, error);
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

function renderGroup(roster) {
    const list = document.getElementById('ridersList');
    if (!list) return;

    list.replaceChildren();

    if (roster.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'group-empty';
        empty.textContent = 'Waiting for your group to join…';
        list.appendChild(empty);
        return;
    }

    for (const member of roster) {
        list.appendChild(renderGroupMember(member));
    }
}

function renderGroupMember(member) {
    const row = document.createElement('div');
    row.className = `group-member status-${member.status}`;
    row.style.borderLeftColor = getRouteColor(member.memberId);

    const head = document.createElement('div');
    head.className = 'group-member-head';

    const name = document.createElement('strong');
    // textContent throughout: every name here arrived from another device.
    name.textContent = member.isSelf ? 'You' : member.name || 'Someone';

    const status = document.createElement('span');
    status.className = `group-status group-status-${member.status}`;
    status.textContent = member.status;

    head.append(name, status);
    row.appendChild(head);

    const facts = document.createElement('div');
    facts.className = 'group-member-facts';

    if (member.lat === undefined || member.lat === null) {
        facts.textContent = 'No location yet';
    } else {
        facts.append(
            fact(`${distanceToDestination(member).toFixed(1)} km to go`),
            fact(distanceFromMe(member)),
            fact(formatSpeed(member.speed)),
            fact(formatHeading(member.heading))
        );
    }

    row.appendChild(facts);
    return row;
}

function fact(text) {
    const span = document.createElement('span');
    span.className = 'group-fact';
    span.textContent = text;
    return span;
}

function distanceToDestination(member) {
    if (!currentRoom || !currentRoom.destination) return 0;
    return haversineDistance(
        member.lat, member.lng,
        currentRoom.destination.lat, currentRoom.destination.lng
    );
}

/** Distance between this person and you — the thing a convoy actually asks. */
function distanceFromMe(member) {
    if (member.isSelf || !lastKnownLocation) return '';
    const km = haversineDistance(
        lastKnownLocation.lat, lastKnownLocation.lng, member.lat, member.lng
    );
    return km < 1 ? `${Math.round(km * 1000)} m from you` : `${km.toFixed(1)} km from you`;
}

function formatSpeed(speed) {
    if (speed === null || speed === undefined) return '';
    return `${Math.round(speed * 3.6)} km/h`;
}

function formatHeading(heading) {
    if (heading === null || heading === undefined) return '';
    const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return points[Math.round(heading / 45) % 8];
}

let timerInterval = null;

function startTimer() {
    if (timerInterval) clearInterval(timerInterval);
    if (!currentRoom || !currentRoom.expires_at) return;

    const tick = () => {
        const label = formatEndsIn(currentRoom.expires_at);
        WayseraValidate.setText(document.getElementById('timer'), label);
        if (label === 'This journey has ended') clearInterval(timerInterval);
    };

    tick();
    timerInterval = setInterval(tick, 1000);
}


function startLocationTracking() {
    if (!navigator.geolocation) {
        showLocationAlert('This device cannot share location. Using demo mode.');
        startDemoMode();
        return;
    }

    const options = { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 };

    navigator.geolocation.getCurrentPosition(
        (position) => {
            publishPosition(position.coords);

            // watchPosition returns a watch id, cleared with clearWatch — not
            // an interval id. Keeping it in its own variable is what stops
            // leaveJourney() from leaving GPS running.
            geoWatchId = navigator.geolocation.watchPosition(
                (pos) => publishPosition(pos.coords),
                handleLocationError,
                options
            );
        },
        handleLocationError,
        options
    );
}

function publishPosition(coords) {
    const position = {
        lat: coords.latitude,
        lng: coords.longitude,
        heading: Number.isFinite(coords.heading) ? coords.heading : null,
        speed: Number.isFinite(coords.speed) ? coords.speed : null,
        accuracy: Number.isFinite(coords.accuracy) ? coords.accuracy : null
    };

    const first = !lastKnownLocation;
    lastKnownLocation = { lat: position.lat, lng: position.lng };
    currentUserLocation = lastKnownLocation;
    currentHeading = position.heading || 0;
    currentSpeed = position.speed || 0;

    if (session) session.sendPosition(position);
    if (map) updateUserLocationMarker(lastKnownLocation, 'live');

    if (first) updateNavigationButtonState();
    if (navigationActive) updateNavigationProgressThrottled();
}

function stopLocationTracking() {
    if (geoWatchId !== null) {
        navigator.geolocation.clearWatch(geoWatchId);
        geoWatchId = null;
    }
    if (demoIntervalId !== null) {
        clearInterval(demoIntervalId);
        demoIntervalId = null;
    }
    demoMode = false;
}

function handleLocationError(error) {
    const messages = {
        1: 'Location is turned off for this site. Your group cannot see you — using demo mode.',
        2: 'We could not get a GPS fix. Using demo mode for now.',
        3: 'Locating took too long. Using demo mode for now.'
    };
    showLocationAlert(messages[error.code] || 'We could not read your location. Using demo mode.');
    if (!demoMode) startDemoMode();
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
    if (!currentRoom || !currentRoom.destination) return;

    demoMode = true;
    const destination = currentRoom.destination;
    let angle = Math.random() * Math.PI * 2;
    const radiusDegrees = 0.01; // roughly a kilometre

    demoIntervalId = setInterval(() => {
        angle += (Math.random() - 0.5) * 0.5;
        publishPosition({
            latitude: destination.lat + radiusDegrees * Math.cos(angle),
            longitude: destination.lng + radiusDegrees * Math.sin(angle),
            heading: (angle * 180) / Math.PI,
            speed: 15,
            accuracy: 20
        });
    }, 3000);
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
    
    if (!lastKnownLocation) {
        showLocationAlert('Finding your position — try again in a moment.');
        if (geoWatchId === null && !demoMode) startLocationTracking();
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

function copyJourneyCode() {
    if (!currentRoom) return;
    copyToClipboard(currentRoom.room_id);
    alert('Journey code copied.');
}

async function shareCurrentInvite() {
    if (!currentRoom || !session || !session.key) return;
    const encodedKey = await WayseraCrypto.exportJourneyKey(session.key);
    const link = WayseraCrypto.buildInviteLink(
        window.location.origin, currentRoom.room_id, encodedKey
    );
    shareInvite(link);
}

function leaveJourney() {
    if (navigationActive) stopNavigation();
    clearAllRoutes();
    stopLocationTracking();

    if (session) {
        session.close();
        session = null;
    }
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    if (userLocationMarker && map) {
        map.removeLayer(userLocationMarker);
        userLocationMarker = null;
    }
    if (map) {
        map.remove();
        map = null;
    }

    // The journey record and its track stay on the device — leaving is not
    // deleting. Only the pointer to the active journey is cleared.
    WayseraStore.clearActiveJourney();

    currentRoom = null;
    currentMemberId = null;
    markers = {};
    routingControls = {};
    showDirections = false;
    navigationActive = false;
    navigationRoute = null;
    navigationRoutingControl = null;
    currentUserLocation = null;
    lastKnownLocation = null;
    currentHeading = 0;
    currentSpeed = 0;
    lastRouteUpdate = 0;

    window.location.href = window.location.pathname;
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

// ============= PAGE INITIALISATION =============

window.addEventListener('load', async () => {
    const invite = WayseraCrypto.parseInviteFragment(window.location.hash);

    if (invite) {
        await enterFromInvite(invite);
        return;
    }

    // Resume an active journey after a reload, if we still hold its key.
    const active = WayseraStore.getActiveJourney();
    if (active) {
        const stored = await WayseraStore.getJourney(active);
        const name = recallName();
        if (stored && stored.key && name) {
            startJourney(active, name);
            return;
        }
        WayseraStore.clearActiveJourney();
    }

    prefillName();
});

async function enterFromInvite(invite) {
    if (invite.key) {
        // The key rode in the fragment, so nothing has to be requested from a
        // peer and no approval is involved.
        try {
            const key = await WayseraCrypto.importJourneyKey(invite.key);
            const stored = (await WayseraStore.getJourney(invite.code)) || {
                code: invite.code,
                createdAt: Date.now()
            };
            stored.key = key;
            await WayseraStore.putJourney(stored);
        } catch (error) {
            showError('joinResult', 'That invite link looks damaged. Ask for a new one.');
        }
    }

    document.getElementById('roomCode').value = invite.code;
    prefillName();

    const name = recallName();
    if (name) {
        startJourney(invite.code, name);
    } else {
        document.getElementById('joinName').focus();
    }
}

function prefillName() {
    const field = document.getElementById('joinName');
    if (field && !field.value) field.value = recallName();
}

// ============= GLOBAL HANDLERS FOR MARKUP =============

window.createJourney = createJourney;
window.joinJourney = joinJourney;
window.shareInvite = shareInvite;
window.shareCurrentInvite = shareCurrentInvite;
window.copyJourneyCode = copyJourneyCode;
window.leaveJourney = leaveJourney;
window.toggleDirections = toggleDirections;
window.toggleBottomSheet = toggleBottomSheet;
window.startNavigation = startNavigation;
window.stopNavigation = stopNavigation;

// ============= LOCATION PERMISSION =============

function checkLocationPermissionStatus() {
    setTimeout(() => {
        if (!lastKnownLocation && !demoMode) showLocationBanner();
    }, 5000);
}

function showLocationBanner() {
    const banner = document.getElementById('locationBanner');
    if (banner) banner.style.display = 'block';
}

function dismissLocationBanner() {
    const banner = document.getElementById('locationBanner');
    if (banner) banner.style.display = 'none';
    if (!demoMode) startDemoMode();
}

function requestLocationPermission() {
    dismissLocationBanner();

    if (!navigator.geolocation) {
        showLocationAlert('This device cannot share location.');
        startDemoMode();
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (position) => {
            stopLocationTracking();
            publishPosition(position.coords);
            showLocationAlert('Location is on. Your group can see where you are.');
            startLocationTracking();
        },
        handleLocationError,
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
}

window.requestLocationPermission = requestLocationPermission;
window.dismissLocationBanner = dismissLocationBanner;

// Tell peers we are going rather than making them wait for the roster timeout.
window.addEventListener('pagehide', () => {
    if (session) session.close();
});
