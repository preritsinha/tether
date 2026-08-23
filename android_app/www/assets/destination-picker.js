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

    // Category glyphs, drawn rather than typed. Emoji render differently on
    // every platform and vendor, sit inconsistently on the baseline, and read
    // as casual next to a map. These are one flat 24px path each, tinted by CSS.
    const GLYPHS = {
        transport: 'M4 16V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10M4 16h16M4 16v2h3v-2M17 18h3v-2M7 8h10M7 12h4',
        food:      'M6 3v8a2 2 0 0 0 2 2v8M6 3v5M9 3v5M17 3c-1.5 2-2 4-2 7h4c0-3-.5-5-2-7ZM17 10v11',
        lodging:   'M3 20V9l9-5 9 5v11M9 20v-6h6v6',
        health:    'M12 6v12M6 12h12',
        education: 'M12 4 2 9l10 5 10-5-10-5ZM6 11.5V17c0 1.7 2.7 3 6 3s6-1.3 6-3v-5.5',
        shopping:  'M6 7h12l-1 13H7L6 7ZM9 7V5a3 3 0 0 1 6 0v2',
        leisure:   'M12 3v18M12 9 6.5 5M12 12l6-4M12 15l-5.5-3.5',
        fuel:      'M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M4 12h10M17 8l3 3v7a2 2 0 0 1-4 0V8Z',
        parking:   'M8 19V5h5a4 4 0 0 1 0 8H8',
        place:     'M4 20V9l5-3 5 3v11M14 20V12l5-3v11M8 13h2M8 16h2M17 13h1',
        pin:       'M12 21s7-6.3 7-11a7 7 0 0 0-14 0c0 4.7 7 11 7 11ZM12 12a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z',
        recent:    'M12 7v5l3.5 2M21 12a9 9 0 1 1-9-9'
    };

    const CATEGORY_GLYPH = {
        Airport: 'transport', Station: 'transport', 'Bus station': 'transport', Metro: 'transport',
        Restaurant: 'food', Cafe: 'food', 'Fast food': 'food', Bar: 'food', Pub: 'food',
        Hotel: 'lodging',
        Hospital: 'health', Clinic: 'health', Pharmacy: 'health',
        School: 'education', College: 'education', University: 'education',
        Supermarket: 'shopping', 'Shopping centre': 'shopping',
        Park: 'leisure', Beach: 'leisure', Stadium: 'leisure', Museum: 'leisure',
        Attraction: 'leisure', Viewpoint: 'leisure', 'Place of worship': 'leisure',
        'Petrol station': 'fuel', 'Charging point': 'fuel',
        Parking: 'parking',
        City: 'place', Town: 'place', Village: 'place', Neighbourhood: 'place',
        Address: 'pin', Street: 'pin'
    };

    function glyphSvg(name) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '19');
        svg.setAttribute('height', '19');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('aria-hidden', 'true');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', GLYPHS[name] || GLYPHS.pin);
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-width', '1.7');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');

        svg.appendChild(path);
        return svg;
    }

    function iconFor(category) {
        return glyphSvg(CATEGORY_GLYPH[category] || 'pin');
    }

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

    let inputEl, coordsDisplay, nearButton;
    let overlay, overlayInput, overlayResults;
    let results = [], activeIndex = -1;
    let debounceTimer = null, inFlight = null;
    let near = null, overlayOpen = false;

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
        iconWrap.appendChild(isRecent ? glyphSvg('recent') : iconFor(result.category));

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
