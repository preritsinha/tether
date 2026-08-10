/**
 * The destination field on the home page.
 *
 * Behaves the way a maps search box is expected to: results appear as you
 * type, biased toward wherever you are, navigable with the arrow keys, and
 * showing enough address to tell two similarly named places apart.
 *
 * Every request carries an AbortSignal. Without that, a slow early request can
 * land after a fast later one and replace good results with stale ones, which
 * is what makes a search box feel like it is fighting you.
 */

(() => {
    'use strict';

    const DEBOUNCE_MS = 250;
    const MIN_QUERY = 2;

    let input;
    let list;
    let chosenLine;
    let nearButton;

    let results = [];
    let activeIndex = -1;
    let debounceTimer = null;
    let inFlight = null;
    let near = null;

    function init() {
        input = document.getElementById('destName');
        list = document.getElementById('searchSuggestions');
        chosenLine = document.getElementById('coordsDisplay');
        nearButton = document.getElementById('useMyLocation');
        if (!input || !list) return;

        near = WayseraSearch.recallPosition();
        updateNearButton();

        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-expanded', 'false');
        input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-controls', 'searchSuggestions');
        list.setAttribute('role', 'listbox');

        input.addEventListener('input', onInput);
        input.addEventListener('keydown', onKeyDown);
        input.addEventListener('focus', () => {
            if (results.length) open();
        });

        if (nearButton) nearButton.addEventListener('click', askForLocation);

        document.addEventListener('click', (event) => {
            if (!event.target.closest('.search-box') && !event.target.closest('.search-near')) {
                close();
            }
        });
    }

    // ------------------------------------------------------------------ input

    function onInput() {
        clearChoice();
        clearTimeout(debounceTimer);

        const query = input.value.trim();
        if (query.length < MIN_QUERY) {
            results = [];
            close();
            return;
        }

        debounceTimer = setTimeout(() => run(query), DEBOUNCE_MS);
    }

    async function run(query) {
        // Drop whatever is still in flight; its answer is already out of date.
        if (inFlight) inFlight.abort();
        inFlight = new AbortController();

        renderStatus('Searching…');

        try {
            results = await WayseraSearch.search(query, {
                near,
                signal: inFlight.signal
            });
            render();
        } catch (error) {
            if (error.name === 'AbortError') return; // Superseded, not failed.
            results = [];
            renderStatus('Could not reach the search service. Check your connection.');
        }
    }

    // --------------------------------------------------------------- keyboard

    function onKeyDown(event) {
        if (!results.length) return;

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            move(1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            move(-1);
        } else if (event.key === 'Enter') {
            if (activeIndex >= 0) {
                event.preventDefault();
                choose(activeIndex);
            }
        } else if (event.key === 'Escape') {
            close();
        }
    }

    function move(delta) {
        activeIndex = (activeIndex + delta + results.length) % results.length;
        highlight();
        const row = list.children[activeIndex];
        if (row) row.scrollIntoView({ block: 'nearest' });
    }

    function highlight() {
        Array.from(list.children).forEach((row, index) => {
            const isActive = index === activeIndex;
            row.classList.toggle('is-active', isActive);
            row.setAttribute('aria-selected', String(isActive));
        });
        input.setAttribute(
            'aria-activedescendant',
            activeIndex >= 0 ? `suggestion-${activeIndex}` : ''
        );
    }

    // ---------------------------------------------------------------- results

    function render() {
        activeIndex = -1;
        list.replaceChildren();

        if (!results.length) {
            renderStatus('No places found. Try a different search.');
            return;
        }

        results.forEach((result, index) => {
            const row = document.createElement('div');
            row.className = 'suggestion-item';
            row.id = `suggestion-${index}`;
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', 'false');
            row.addEventListener('mousedown', (event) => {
                // mousedown, not click: the input blurs first and the list
                // would already be closed by the time a click landed.
                event.preventDefault();
                choose(index);
            });

            const main = document.createElement('div');
            main.className = 'suggestion-main';

            const primary = document.createElement('div');
            primary.className = 'suggestion-text';
            // Place names come from a third-party geocoder, so text only.
            primary.textContent = result.primary;

            const secondary = document.createElement('div');
            secondary.className = 'suggestion-coords';
            secondary.textContent = [result.category, result.secondary]
                .filter(Boolean)
                .join(' · ');

            main.append(primary, secondary);
            row.appendChild(main);

            if (result.distance) {
                const distance = document.createElement('div');
                distance.className = 'suggestion-distance';
                distance.textContent = result.distance;
                row.appendChild(distance);
            }

            list.appendChild(row);
        });

        open();
    }

    function renderStatus(message) {
        list.replaceChildren();
        const row = document.createElement('div');
        row.className = 'suggestion-status';
        row.textContent = message;
        list.appendChild(row);
        open();
    }

    function choose(index) {
        const result = results[index];
        if (!result) return;

        input.value = result.primary;
        document.getElementById('destLat').value = result.lat.toFixed(6);
        document.getElementById('destLng').value = result.lng.toFixed(6);

        if (chosenLine) {
            chosenLine.replaceChildren();
            const label = document.createElement('span');
            label.textContent = [result.primary, result.secondary].filter(Boolean).join(' · ');
            chosenLine.appendChild(label);
            chosenLine.style.display = 'block';
        }

        results = [];
        close();
    }

    function clearChoice() {
        if (chosenLine) chosenLine.style.display = 'none';
    }

    function open() {
        list.classList.add('show');
        input.setAttribute('aria-expanded', 'true');
    }

    function close() {
        list.classList.remove('show');
        input.setAttribute('aria-expanded', 'false');
        activeIndex = -1;
    }

    // ---------------------------------------------------------------- near me

    function updateNearButton() {
        if (!nearButton) return;
        // Hidden when we already have a position to bias by, so nobody is
        // asked for a permission we do not need.
        nearButton.style.display = near ? 'none' : 'inline-flex';
    }

    function askForLocation() {
        if (!navigator.geolocation) return;

        nearButton.disabled = true;
        nearButton.textContent = 'Finding you…';

        navigator.geolocation.getCurrentPosition(
            (position) => {
                near = { lat: position.coords.latitude, lng: position.coords.longitude };
                WayseraSearch.rememberPosition(near.lat, near.lng);
                nearButton.disabled = false;
                nearButton.textContent = 'Search near me';
                updateNearButton();
                if (input.value.trim().length >= MIN_QUERY) run(input.value.trim());
            },
            () => {
                nearButton.disabled = false;
                nearButton.textContent = 'Search near me';
            },
            { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
        );
    }

    window.addEventListener('load', init);
})();
