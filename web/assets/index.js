// ============= WAYSERA JOURNEY LIFECYCLE =============
// CONFIG lives in app.js. Crypto, storage, validation and the relay session
// live in crypto.js / store.js / validate.js / journey.js.
//
// There is no server to ask about a journey any more. A journey is created on
// this device, its key travels in the invite fragment, and everything else
// arrives from peers over the relay.

const NAME_KEY = 'waysera.name';

// The view model keeps the shape the map, routing and navigation code already
// expects (room_id, destination, and a members map keyed by id with
// last_location), so none of that needed rewriting.
let currentRoom = null;
let currentMemberId = null;
let session = null;

let map = null;
let markers = {};
let destMarker = null;
let routingControls = {};
let showDirections = false;

// Geolocation and demo mode once shared a single variable, so leaving a journey
// called clearInterval on a watchPosition id, which does nothing, and left GPS
// running. They are separate handles now, each cleared with its matching API.
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
            // Cancelled, or unsupported here. Fall through to copying instead.
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
    renderQuickMessages();
    announcedArrivals.clear();
    startRecording();

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

    activeSession.on('position', (message) => {
        recordPosition(message.memberId, message);
        checkPeerArrival(message);
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
        setQuickMessagesEnabled(true);
        showToast('You are in', 'Waiting for journey details…');
    });

    activeSession.on('awaiting_key', () => {
        WayseraValidate.setText(
            document.getElementById('destNameDisplay'),
            'Waiting for someone to let you in…'
        );
    });

    activeSession.on('key_request', (request) => showJoinRequest(request));

    activeSession.on('quick_message', (message) => {
        const member = currentRoom.members[message.memberId];
        // message.text comes from our own frozen preset table, never the sender.
        showToast(member ? member.name : 'Someone', message.text, 'toast-message');
        recordEvent('quick_message', {
            memberId: message.memberId,
            presetId: message.presetId,
            text: message.text
        });
    });

    activeSession.on('joined', (message) => {
        showToast(`${message.name} joined`, '', 'toast-message');
        recordEvent('joined', { memberId: message.memberId, name: message.name });
    });

    activeSession.on('left', (message) => {
        const member = currentRoom.members[message.memberId];
        recordEvent('left', { memberId: message.memberId, name: member ? member.name : null });
    });

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
        // The token lives in exactly one place, WAYSERA_CONFIG in config.js, so
        // rotating it is a single edit. No hardcoded fallback copy lives here;
        // a second copy is how a rotation silently half-applies.
        const mapboxToken = (window.WAYSERA_CONFIG && window.WAYSERA_CONFIG.MAPBOX_TOKEN) || '';
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const mapboxAllowedHere = !isLocalhost || (window.WAYSERA_CONFIG && window.WAYSERA_CONFIG.USE_MAPBOX_ON_LOCALHOST);
        const useMapbox = Boolean(mapboxToken) && mapboxAllowedHere;

        if (!useMapbox) {
            if (mapboxAllowedHere && !mapboxToken) {
                console.warn('No Mapbox token configured. Falling back to OpenStreetMap tiles.');
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
        // A DOM node, not a template string. The destination name reaches us
        // over the relay in journey_config, so bindPopup would parse a peer's
        // text as markup.
        const destPopup = document.createElement('div');
        const destTitle = document.createElement('strong');
        destTitle.textContent = destination.name;
        const destLabel = document.createElement('div');
        destLabel.textContent = 'Destination';
        destPopup.append(destTitle, destLabel);
        destMarker.bindPopup(destPopup);
        window.destMarker = destMarker; // reachable for the popup safety check
        
        // Smooth invalidateSize for proper rendering
        setTimeout(() => {
            map.invalidateSize();
        }, 100);
        
        
    } catch (error) {
        console.error('Could not initialise the map', error);
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
        // Your own marker uses the brand indigo when live; stale and offline
        // stay semantic rather than becoming brand colours.
        const iconColor = status === 'live' ? '#4F46E5' : status === 'stale' ? '#FF9500' : '#64748B';
        
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
        console.error('Could not update your marker', error);
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

/** How far this person is from you, which is what a convoy actually asks. */
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

            // watchPosition returns a watch id, cleared with clearWatch, not an
            // interval id. Keeping it in its own variable is what stops
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
    recordPosition(currentMemberId, { ...position, ts: Date.now() });
    rememberSearchOrigin(position);

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
        1: 'Location is off for this site, so your group cannot see you. Using demo mode.',
        2: 'We could not get a GPS fix. Using demo mode for now.',
        3: 'Locating took too long. Using demo mode for now.'
    };
    showLocationAlert(messages[error.code] || 'We could not read your location. Using demo mode.');
    if (!demoMode) startDemoMode();
}

// ---------------------------------------------------------------- toasts

function toastStack() {
    let stack = document.getElementById('toastStack');
    if (!stack) {
        stack = document.createElement('div');
        stack.id = 'toastStack';
        stack.className = 'toast-stack';
        // Announced politely: a quick message should be heard by a screen
        // reader without stealing focus from someone who is driving.
        stack.setAttribute('role', 'status');
        stack.setAttribute('aria-live', 'polite');
        document.body.appendChild(stack);
    }
    return stack;
}

function showToast(title, body, variant = '') {
    const toast = document.createElement('div');
    toast.className = `toast ${variant}`.trim();

    const titleLine = document.createElement('div');
    titleLine.className = 'toast-title';
    // textContent: titles carry peer-supplied display names.
    titleLine.textContent = title;
    toast.appendChild(titleLine);

    if (body) {
        const bodyLine = document.createElement('div');
        bodyLine.className = 'toast-body';
        bodyLine.textContent = body;
        toast.appendChild(bodyLine);
    }

    toastStack().appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
}

function showLocationAlert(message) {
    showToast(message, '', 'toast-notice');
}

// -------------------------------------------------------- quick messages

function renderQuickMessages() {
    const host = document.getElementById('quickMessages');
    if (!host) return;

    host.replaceChildren();
    for (const [presetId, label] of Object.entries(WayseraValidate.QUICK_MESSAGES)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'quick-message';
        button.textContent = label;
        button.onclick = () => sendQuickMessage(presetId);
        host.appendChild(button);
    }
    setQuickMessagesEnabled(Boolean(session && session.key));
}

function setQuickMessagesEnabled(enabled) {
    const host = document.getElementById('quickMessages');
    if (!host) return;
    for (const button of host.children) button.disabled = !enabled;
}

async function sendQuickMessage(presetId) {
    if (!session || !session.key) return;

    await session.sendQuickMessage(presetId);

    // The relay never echoes to the sender, so our own message is shown and
    // recorded locally rather than waiting for it to come back.
    const text = WayseraValidate.QUICK_MESSAGES[presetId];
    showToast('You', text, 'toast-message');
    recordEvent('quick_message', { memberId: currentMemberId, presetId, text });
}

function recordEvent(kind, data) {
    if (!currentRoom) return;
    // Fire and forget: a failed local write must never interrupt a journey.
    WayseraStore.appendEvent(currentRoom.room_id, { ts: Date.now(), kind, data })
        .catch((error) => console.warn('waysera: could not record event', error));
}

// Keeps destination search biased toward wherever you were last, so the first
// search on a later visit ranks nearby places first without asking permission
// up front. Throttled hard because it is a hint, not a position log.
const SEARCH_ORIGIN_INTERVAL_MS = 60000;
let lastSearchOriginSavedAt = 0;

function rememberSearchOrigin(position) {
    const now = Date.now();
    if (now - lastSearchOriginSavedAt < SEARCH_ORIGIN_INTERVAL_MS) return;
    lastSearchOriginSavedAt = now;
    if (window.WayseraSearch) {
        WayseraSearch.rememberPosition(position.lat, position.lng);
    }
}

// -------------------------------------------------------- peer arrivals

const ARRIVAL_RADIUS_KM = 0.05;
const announcedArrivals = new Set();

/**
 * Announce someone else reaching the destination.
 *
 * Announced once per person per journey. Positions keep arriving after someone
 * parks, and repeating it every three seconds would be maddening.
 */
function checkPeerArrival(message) {
    if (!currentRoom || !currentRoom.destination) return;
    if (announcedArrivals.has(message.memberId)) return;

    const distance = haversineDistance(
        message.lat, message.lng,
        currentRoom.destination.lat, currentRoom.destination.lng
    );
    if (distance > ARRIVAL_RADIUS_KM) return;

    announcedArrivals.add(message.memberId);

    const member = currentRoom.members[message.memberId];
    const name = member && member.name ? member.name : 'Someone';
    showToast(`${name} has arrived.`, '', 'toast-message');
    recordEvent('arrived', { memberId: message.memberId, name });

    const waiting = Object.keys(currentRoom.members).length - announcedArrivals.size;
    if (waiting <= 0) showToast('Everyone has arrived.', '', 'toast-message');
}

// ------------------------------------------------------------- recording

// Positions arrive faster than a replay needs, and writing each one straight
// through would put an IndexedDB transaction on the main thread next to map
// rendering. Points are thinned per person, buffered, and flushed in batches.
const RECORD_MIN_GAP_MS = 2500;
const RECORD_FLUSH_MS = 5000;

let pointBuffer = [];
let lastRecordedAt = new Map();
let recordFlushTimer = null;

function startRecording() {
    if (recordFlushTimer) clearInterval(recordFlushTimer);
    pointBuffer = [];
    lastRecordedAt = new Map();
    recordFlushTimer = setInterval(flushPoints, RECORD_FLUSH_MS);
}

function stopRecording() {
    if (recordFlushTimer) {
        clearInterval(recordFlushTimer);
        recordFlushTimer = null;
    }
    flushPoints();
}

function recordPosition(memberId, point) {
    if (!currentRoom) return;

    const previous = lastRecordedAt.get(memberId) || 0;
    if (point.ts - previous < RECORD_MIN_GAP_MS) return;
    lastRecordedAt.set(memberId, point.ts);

    pointBuffer.push({
        memberId,
        ts: point.ts,
        lat: point.lat,
        lng: point.lng,
        heading: point.heading ?? null,
        speed: point.speed ?? null
    });
}

async function flushPoints() {
    if (!currentRoom || pointBuffer.length === 0) return;

    const batch = pointBuffer.splice(0);
    const code = currentRoom.room_id;

    try {
        await WayseraStore.appendPoints(code, batch);
        // Prune the people who just gained points, so a long journey loses
        // resolution evenly rather than growing without bound.
        for (const memberId of new Set(batch.map((point) => point.memberId))) {
            await WayseraStore.pruneMemberPoints(code, memberId);
        }
    } catch (error) {
        console.warn('waysera: could not record positions', error);
    }
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
    
    
    if (showDirections) {
        btn.textContent = 'Hide directions';
        btn.classList.add('btn-primary');
        btn.classList.remove('btn-secondary');
        drawAllRoutes();
    } else {
        btn.textContent = 'Show directions';
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-secondary');
        clearAllRoutes();
    }
}

function drawAllRoutes() {
    if (!currentRoom || !map) {
        console.warn('Routes requested before the map was ready');
        return;
    }
    
    const destination = currentRoom.destination;
    const members = currentRoom.members || {};
    const memberCount = Object.keys(members).length;
    
    
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
            console.warn('Routing failed for', memberId, '- falling back to a straight line');
            
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
        
        
    } catch (error) {
        console.error('Could not draw a route for', memberId, error);
        
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
        } catch (fallbackError) {
            console.error('Straight-line fallback failed too', fallbackError);
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

// ============= VOICE GUIDANCE AND WAKE LOCK =============

const VOICE_KEY = 'waysera.voice';
let lastSpokenInstruction = '';
let wakeLock = null;

function voiceEnabled() {
    try {
        return localStorage.getItem(VOICE_KEY) !== 'off';
    } catch (error) {
        return true;
    }
}

function setVoiceEnabled(enabled) {
    try {
        localStorage.setItem(VOICE_KEY, enabled ? 'on' : 'off');
    } catch (error) {
        // Private mode. The setting just will not persist.
    }
    if (!enabled && window.speechSynthesis) window.speechSynthesis.cancel();
    updateVoiceButton();
}

function toggleVoice() {
    setVoiceEnabled(!voiceEnabled());
}

function updateVoiceButton() {
    const button = document.getElementById('voiceToggle');
    if (!button) return;
    const on = voiceEnabled();
    button.textContent = on ? 'Voice on' : 'Voice off';
    button.setAttribute('aria-pressed', String(on));
}

/**
 * Speak a navigation instruction.
 *
 * Only called when the instruction text actually changes. Announcing on every
 * position tick would talk over itself several times a second.
 */
function speak(text) {
    if (!text || !voiceEnabled()) return;
    if (!('speechSynthesis' in window)) return;
    if (text === lastSpokenInstruction) return;

    lastSpokenInstruction = text;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    // Replace anything queued rather than building a backlog of stale turns.
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
}

async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (error) {
        // Denied, or the tab is not visible. Navigation still works.
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
    }
}

// A wake lock is dropped whenever the tab is hidden, so it has to be retaken
// when the user comes back rather than assuming it survived.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigationActive && !wakeLock) {
        acquireWakeLock();
    }
});

function startNavigation() {
    if (!currentRoom || !map) {
        alert('Cannot start navigation');
        return;
    }
    
    if (!lastKnownLocation) {
        showLocationAlert('Still finding your position. Try again in a moment.');
        if (geoWatchId === null && !demoMode) startLocationTracking();
        return;
    }
    
    navigationActive = true;
    lastSpokenInstruction = '';
    acquireWakeLock();
    updateVoiceButton();

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
    navigationActive = false;
    releaseWakeLock();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    lastSpokenInstruction = '';
    
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
                    color: '#4F46E5',
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
            console.error('Routing failed', e);
            
            // Show simple route line as fallback
            const routeLine = L.polyline([
                [fromLocation.lat, fromLocation.lng],
                [toDestination.lat, toDestination.lng]
            ], {
                color: '#4F46E5',
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
            
            // Show notification
            showNavigationError('Routing service unavailable. Showing direct route instead.');
        });
        
    } catch (error) {
        console.error('Could not start navigation', error);
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

        // Distance stays out of the spoken line. It changes on every tick, and
        // including it would defeat the repeat guard in speak().
        speak(instructionText);
        
        // Update direction arrow SVG based on instruction type
        updateDirectionArrow(instruction.type);
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

// Lane guidance was removed rather than repaired.
//
// The previous implementation hardcoded three lanes and guessed the active one
// from the instruction text. That is invented data shown to someone who is
// driving, which is worse than showing nothing at all. Real lane data does exist in
// OSRM's response under step.intersections[].lanes, but leaflet-routing-machine
// copies only ten fields off each step (type, distance, time, road, direction,
// exit, index, mode, modifier, text) and discards the rest, so it never reaches
// us. Reinstating a lane graphic means querying OSRM directly rather than
// through the routing control.
//
// Genuine lane hints still reach the driver: the library folds OSRM's lane data
// into the instruction text itself ("use the left lane") when the road has it.


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
        speak("You've arrived.");
        recordEvent('arrived', { memberId: currentMemberId });
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
        background: linear-gradient(135deg, #4F46E5 0%, #0EA5E9 55%, #14B8A6 100%);
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
        
        <div>You&rsquo;ve arrived.</div>
        <div style="font-size: 16px; font-weight: 400; margin-top: 8px; opacity: 0.9;">
            Everyone can see you made it.
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
        startBtn.textContent = 'Start navigation';
        startBtn.disabled = false;
        startBtn.style.opacity = '1';
    } else {
        startBtn.textContent = 'Finding you…';
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
    stopRecording();

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

    // The journey record and its track stay on the device. Leaving is not
    // deleting; only the pointer to the active journey is cleared.
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
    renderPastJourneys();
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

// ============= PAST JOURNEYS =============

async function renderPastJourneys() {
    const section = document.getElementById('pastJourneysSection');
    const host = document.getElementById('pastJourneys');
    if (!section || !host) return;

    const journeys = (await WayseraStore.listJourneys())
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    if (journeys.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    host.replaceChildren();

    for (const journey of journeys) {
        host.appendChild(await renderJourneyListItem(journey));
    }
}

async function renderJourneyListItem(journey) {
    const row = document.createElement('div');
    row.className = 'journey-list-item';

    const main = document.createElement('div');
    main.className = 'journey-list-main';

    const name = document.createElement('div');
    name.className = 'journey-list-name';
    // textContent: a destination name can arrive from a peer.
    name.textContent = journey.destination ? journey.destination.name : journey.code;

    const meta = document.createElement('div');
    meta.className = 'journey-list-meta';
    const pointCount = (await WayseraStore.getPoints(journey.code)).length;
    meta.textContent = pointCount
        ? `${journey.code} · ${pointCount} recorded positions`
        : `${journey.code} · nothing recorded`;

    main.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'journey-list-actions';

    if (pointCount > 0) {
        const replay = document.createElement('a');
        replay.className = 'btn btn-secondary';
        replay.href = `replay.html?j=${encodeURIComponent(journey.code)}`;
        replay.textContent = 'Replay';
        actions.appendChild(replay);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-danger';
    remove.textContent = 'Delete';
    remove.onclick = async () => {
        // Deleting cascades to the track and the event log. This is the only
        // copy, so say so plainly rather than deleting quietly.
        const label = journey.destination ? journey.destination.name : journey.code;
        if (!confirm(`Delete "${label}" and everything recorded during it? This cannot be undone.`)) {
            return;
        }
        await WayseraStore.deleteJourney(journey.code);
        renderPastJourneys();
    };
    actions.appendChild(remove);

    row.append(main, actions);
    return row;
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
window.toggleVoice = toggleVoice;

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
