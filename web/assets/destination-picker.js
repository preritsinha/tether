/**
 * Destination search — Google Maps-style full-screen overlay.
 *
 * Tapping the search field opens a full-screen panel with:
 *   - a back arrow to dismiss
 *   - recent searches shown immediately (localStorage)
 *   - live results with category icon, place name, address, distance
 *
 * All string content is set via textContent — never innerHTML.
 */

(() => {
    'use strict';

    const DEBOUNCE_MS   = 200;
    const MIN_QUERY     = 2;
    const MAX_RECENT    = 5;
    const RECENT_KEY    = 'waysera.recentSearches';

    const CATEGORY_ICONS = {
        Airport: '✈️', Station: '🚉', 'Bus station': '🚌', Metro: '🚇',
        Restaurant: '🍽️', Cafe: '☕', 'Fast food': '🍔', Bar: '🍺', Pub: '🍺',
        Hospital: '🏥', Clinic: '🏥', Pharmacy: '💊', Hotel: '🏨',
        Parking: '🅿️', 'Petrol station': '⛽', 'Charging point': '🔋',
        School: '🏫', College: '🎓', University: '🎓',
        Supermarket: '🛒', 'Shopping centre': '🛍️',
        Park: '🌳', Beach: '🏖️', Stadium: '🏟️', Museum: '🏛️',
        'Place of worship': '🕌', Attraction: '🎡', Viewpoint: '🏔️',
        City: '🌆', Town: '🏘️', Village: '🏡',
        Neighbourhood: '📍', Address: '📍', Street: '🛣️',
    };

    function iconFor(category) {
        return CATEGORY_ICONS[category] || '📍';
    }

    // ── Recent searches ──────────────────────────────────────────────────────

    function getRecent() {
        try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
        catch { return []; }
    }

    function saveRecent(result) {
        try {
            const list = getRecent().filter(r => r.primary !== result.primary);
            list.unshift({ primary: result.primary, secondary: result.secondary,
                           category: result.category, lat: result.lat, lng: result.lng });
            localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
        } catch {}
    }

    // ── State ─────────────────────────────────────────────────────────────────

    let inputEl, coordsDisplay, nearButton;
    let overlay, overlayInput, overlayResults;
    let results = [], activeIndex = -1;
    let debounceTimer = null, inFlight = null;
    let near = null, overlayOpen = false;

    // ── Init ─────────────────────────────────────────────────────────────────

    function init() {
        inputEl       = document.getElementById('destName');
        coordsDisplay = document.getElementById('coordsDisplay');
        nearButton    = document.getElementById('useMyLocation');
        if (!inputEl) return;

        near = WayseraSearch.recallPosition();
        if (nearButton) {
            nearButton.style.display = near ? 'none' : 'inline-flex';
            nearButton.addEventListener('click', askForLocation);
        }

        buildOverlay();
        inputEl.addEventListener('focus', openOverlay);
        inputEl.addEventListener('click', openOverlay);
        // Read-only visual; actual value is set in choose()
        inputEl.setAttribute('readonly', 'true');
    }

    // ── Overlay build ─────────────────────────────────────────────────────────

    function buildOverlay() {
        overlay = document.createElement('div');
        overlay.className = 'search-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-label', 'Search destination');

        // Header row
        const header = document.createElement('div');
        header.className = 'search-overlay-header';

        const backBtn = document.createElement('button');
        backBtn.className = 'search-back-btn';
        backBtn.setAttribute('aria-label', 'Cancel');
        backBtn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M19 12H5M5 12l7-7M5 12l7 7"
                  stroke="currentColor" stroke-width="2.2"
                  stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
        backBtn.addEventListener('click', closeOverlay);

        overlayInput = document.createElement('input');
        overlayInput.type = 'text';
        overlayInput.className = 'search-overlay-input';
        overlayInput.placeholder = 'Search for a place…';
        overlayInput.autocomplete = 'off';
        overlayInput.spellcheck = false;
        overlayInput.setAttribute('role', 'combobox');
        overlayInput.setAttribute('aria-expanded', 'false');
        overlayInput.setAttribute('aria-autocomplete', 'list');

        const clearBtn = document.createElement('button');
        clearBtn.className = 'search-clear-btn';
        clearBtn.setAttribute('aria-label', 'Clear search');
        clearBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.2"/>
            <path d="M15 9l-6 6M9 9l6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>`;
        clearBtn.style.display = 'none';
        clearBtn.addEventListener('mousedown', e => {
            e.preventDefault();
            overlayInput.value = '';
            clearBtn.style.display = 'none';
            renderRecent();
            overlayInput.focus();
        });

        overlayInput.addEventListener('input', () => {
            clearBtn.style.display = overlayInput.value ? '' : 'none';
            onOverlayInput();
        });
        overlayInput.addEventListener('keydown', onKeyDown);

        header.append(backBtn, overlayInput, clearBtn);

        // Results pane
        overlayResults = document.createElement('div');
        overlayResults.className = 'search-overlay-results';
        overlayResults.setAttribute('role', 'listbox');

        overlay.append(header, overlayResults);
        document.body.appendChild(overlay);
    }

    // ── Open / close ──────────────────────────────────────────────────────────

    function openOverlay() {
        if (overlayOpen) return;
        overlayOpen = true;
        // Refresh location — it may have arrived after init() ran
        near = WayseraSearch.recallPosition() || near;
        overlay.classList.add('is-open');
        overlayInput.value = inputEl.value;
        document.body.style.overflow = 'hidden';

        requestAnimationFrame(async () => {
            overlayInput.focus();

            const query = overlayInput.value.trim();
            if (query.length >= MIN_QUERY) {
                run(query);
                return;
            }

            // If we already have a location, show nearby immediately
            if (near) {
                loadNearby();
                return;
            }

            // Location is being fetched — show a gentle status and wait
            renderStatus('Finding places near you…');
            if (window._wayseraLocation) {
                const loc = await window._wayseraLocation;
                if (!overlayOpen) return;           // user dismissed while waiting
                if (loc) {
                    near = loc;
                    loadNearby();
                } else {
                    renderRecent();
                }
            } else {
                renderRecent();
            }
        });
    }

    function closeOverlay() {
        if (!overlayOpen) return;
        overlayOpen = false;
        overlay.classList.remove('is-open');
        overlayResults.replaceChildren();
        document.body.style.overflow = '';
        activeIndex = -1;
    }

    // ── Input handling ────────────────────────────────────────────────────────

    function onOverlayInput() {
        clearTimeout(debounceTimer);
        const query = overlayInput.value.trim();
        if (query.length < MIN_QUERY) { renderRecent(); return; }
        debounceTimer = setTimeout(() => run(query), DEBOUNCE_MS);
    }

    async function run(query) {
        if (inFlight) inFlight.abort();
        inFlight = new AbortController();
        renderStatus('Searching…');
        try {
            results = await WayseraSearch.search(query, { near, signal: inFlight.signal });
            renderResults();
        } catch (err) {
            if (err.name === 'AbortError') return;
            renderStatus('Could not reach search service. Check your connection.');
        }
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    function renderResults() {
        overlayResults.replaceChildren();
        if (!results.length) {
            renderStatus('No places found. Try a different search.');
            return;
        }
        results.forEach((r, i) => overlayResults.appendChild(makeItem(r, false, () => choose(r))));
        overlayInput.setAttribute('aria-expanded', 'true');
    }

    async function loadNearby() {
        if (inFlight) inFlight.abort();
        inFlight = new AbortController();
        renderStatus('Finding places near you…');
        try {
            const nearby = await WayseraSearch.searchNearby(near, inFlight.signal);
            if (!nearby.length) { renderRecent(); return; }

            overlayResults.replaceChildren();

            const recent = getRecent();
            if (recent.length) {
                const recLabel = document.createElement('div');
                recLabel.className = 'search-section-label';
                recLabel.textContent = 'Recent';
                overlayResults.appendChild(recLabel);
                recent.forEach(r => overlayResults.appendChild(makeItem(r, true, () => choose(r))));
            }

            const nearLabel = document.createElement('div');
            nearLabel.className = 'search-section-label';
            nearLabel.textContent = 'Near you';
            overlayResults.appendChild(nearLabel);

            results = nearby;
            nearby.forEach(r => overlayResults.appendChild(makeItem(r, false, () => choose(r))));
        } catch (err) {
            if (err.name === 'AbortError') return;
            renderRecent();
        }
    }

    function renderRecent() {
        overlayResults.replaceChildren();
        results = [];
        activeIndex = -1;

        const recent = getRecent();
        if (!recent.length) {
            const hint = document.createElement('div');
            hint.className = 'search-hint';
            hint.textContent = 'Search for a city, landmark, or address';
            overlayResults.appendChild(hint);
            return;
        }

        const label = document.createElement('div');
        label.className = 'search-section-label';
        label.textContent = 'Recent';
        overlayResults.appendChild(label);

        recent.forEach(r => {
            const item = makeItem(r, true, () => choose(r));
            overlayResults.appendChild(item);
        });
    }

    function renderStatus(msg) {
        overlayResults.replaceChildren();
        const div = document.createElement('div');
        div.className = 'search-hint';
        div.textContent = msg;
        overlayResults.appendChild(div);
        overlayInput.setAttribute('aria-expanded', 'false');
    }

    function makeItem(result, isRecent, onChoose) {
        const item = document.createElement('div');
        item.className = 'suggestion-item';

        // Icon bubble
        const iconWrap = document.createElement('div');
        iconWrap.className = 'suggestion-icon-wrap';
        iconWrap.textContent = isRecent ? '🕐' : iconFor(result.category);

        // Text block
        const main = document.createElement('div');
        main.className = 'suggestion-main';

        const primary = document.createElement('div');
        primary.className = 'suggestion-text';
        primary.textContent = result.primary;

        const secondary = document.createElement('div');
        secondary.className = 'suggestion-coords';
        secondary.textContent = [result.category, result.secondary].filter(Boolean).join(' · ');

        main.append(primary, secondary);

        // Distance
        if (result.distance && !isRecent) {
            const dist = document.createElement('div');
            dist.className = 'suggestion-distance';
            dist.textContent = result.distance;
            item.append(iconWrap, main, dist);
        } else {
            item.append(iconWrap, main);
        }

        item.addEventListener('mousedown', e => { e.preventDefault(); onChoose(); });
        item.addEventListener('touchend',  e => { e.preventDefault(); onChoose(); });
        return item;
    }

    // ── Choose ────────────────────────────────────────────────────────────────

    function choose(result) {
        inputEl.value = result.primary;
        document.getElementById('destLat').value = result.lat.toFixed(6);
        document.getElementById('destLng').value = result.lng.toFixed(6);

        if (coordsDisplay) {
            coordsDisplay.textContent =
                [result.primary, result.secondary].filter(Boolean).join(' · ');
            coordsDisplay.style.display = 'block';
        }

        saveRecent(result);
        closeOverlay();
        results = [];
    }

    // ── Keyboard navigation ───────────────────────────────────────────────────

    function onKeyDown(event) {
        if (event.key === 'Escape') { closeOverlay(); return; }
        if (!results.length) return;

        const items = overlayResults.querySelectorAll('.suggestion-item');
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            activeIndex = (activeIndex + 1) % results.length;
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            activeIndex = (activeIndex - 1 + results.length) % results.length;
        } else if (event.key === 'Enter' && activeIndex >= 0) {
            event.preventDefault();
            choose(results[activeIndex]);
            return;
        } else return;

        items.forEach((el, i) => el.classList.toggle('is-active', i === activeIndex));
        if (items[activeIndex]) items[activeIndex].scrollIntoView({ block: 'nearest' });
    }

    // ── Location bias ─────────────────────────────────────────────────────────

    function askForLocation() {
        if (!navigator.geolocation) return;
        nearButton.disabled = true;
        nearButton.textContent = 'Finding you…';
        navigator.geolocation.getCurrentPosition(
            pos => {
                near = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                WayseraSearch.rememberPosition(near.lat, near.lng);
                nearButton.disabled = false;
                nearButton.style.display = 'none';
                if (overlayOpen && overlayInput.value.trim().length >= MIN_QUERY) {
                    run(overlayInput.value.trim());
                }
            },
            () => { nearButton.disabled = false; nearButton.textContent = 'Search near me'; },
            { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
        );
    }

    // If location arrives while the overlay is already open with no query typed,
    // automatically load nearby places without the user doing anything.
    window.addEventListener('waysera:location', ({ detail }) => {
        near = detail;
        if (overlayOpen && overlayInput.value.trim().length < MIN_QUERY) {
            loadNearby();
        }
        // Also update the "Search near me" button visibility
        if (nearButton) nearButton.style.display = 'none';
    });

    window.addEventListener('load', init);
})();
