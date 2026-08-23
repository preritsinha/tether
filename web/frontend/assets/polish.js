/**
 * Interaction polish.
 *
 * Loaded last. Everything here wraps existing behaviour from the outside
 * rather than editing it, so the underlying flows keep working unchanged if a
 * plugin is missing or a selector moves.
 *
 * Three additions, in descending order of how much they matter:
 *
 *   1. Skeletons while searching. A centred spinner gives no indication of
 *      what is coming and causes a layout jump when results replace it.
 *
 *   2. Rubber-banding on the sheet. Dragging past a limit should resist rather
 *      than stop dead; hitting a hard wall reads as a bug.
 */

(() => {
    'use strict';

    /**
     * Swap the search overlay's "Searching…" line for skeleton rows.
     *
     * Done by observing the results container rather than by editing
     * destination-picker.js, so the picker keeps full ownership of its own
     * rendering and this degrades to a no-op if its markup changes.
     */
    function installSkeletons() {
        const results = document.querySelector('.search-overlay-results');
        if (!results) return;

        const observer = new MutationObserver(() => {
            const hint = results.querySelector('.search-hint');
            if (!hint) return;
            const text = hint.textContent || '';
            if (!/searching|finding places/i.test(text)) return;

            const skeleton = document.createDocumentFragment();
            for (let i = 0; i < 5; i += 1) {
                const row = document.createElement('div');
                row.className = 'skeleton-row';

                const circle = document.createElement('div');
                circle.className = 'skeleton-circle';

                const stack = document.createElement('div');
                stack.className = 'skeleton-stack';

                const wide = document.createElement('div');
                wide.className = 'skeleton-line';

                const short = document.createElement('div');
                short.className = 'skeleton-line is-short';

                stack.append(wide, short);
                row.append(circle, stack);
                skeleton.appendChild(row);
            }
            results.replaceChildren(skeleton);
        });

        observer.observe(results, { childList: true });
    }

    /**
     * Add resistance past the sheet's travel limits.
     *
     * The existing drag handler clamps hard at both ends. Clamping feels like
     * a fault; resistance feels like a boundary. Applied as a capture-phase
     * listener that only adjusts the transform the other handler set.
     */
    function installRubberBand() {
        const sheet = document.getElementById('bottomSheet');
        if (!sheet) return;

        const RESISTANCE = 0.32;

        sheet.addEventListener('touchmove', () => {
            const matrix = new DOMMatrixReadOnly(getComputedStyle(sheet).transform);
            const y = matrix.m42;
            if (y >= 0) return;              // within range

            // Past the top: let it move, but only a third as far.
            sheet.style.transform = `translateY(${y * RESISTANCE}px)`;
        }, { passive: true, capture: false });
    }

    window.addEventListener('load', () => {
        installSkeletons();
        installRubberBand();
    }, { once: true });
})();
