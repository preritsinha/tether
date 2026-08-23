/**
 * Interaction polish for the Android build.
 *
 * Loaded last. Everything here wraps existing behaviour from the outside
 * rather than editing it, so the underlying flows keep working unchanged if a
 * plugin is missing or a selector moves.
 *
 * Three additions, in descending order of how much they matter:
 *
 *   1. Haptics. The single largest contributor to an app feeling native rather
 *      than like a web page in a frame. A confirmation you can feel lets you
 *      keep your eyes on the road, which for this app is the entire point.
 *
 *   2. Skeletons while searching. A centred spinner gives no indication of
 *      what is coming and causes a layout jump when results replace it.
 *
 *   3. Rubber-banding on the sheet. Dragging past a limit should resist rather
 *      than stop dead; hitting a hard wall reads as a bug.
 */

(() => {
    'use strict';

    const Haptics = window.Capacitor
        && window.Capacitor.Plugins
        && window.Capacitor.Plugins.Haptics;

    /**
     * Fire a haptic, ignoring failures.
     *
     * Never awaited: feedback that arrives after the thing it describes is
     * worse than none, and a device with haptics disabled must not stall a
     * user action.
     */
    function tap(style) {
        if (!Haptics) return;
        try {
            if (style === 'success' || style === 'warning' || style === 'error') {
                Haptics.notification({ type: style.toUpperCase() });
            } else {
                Haptics.impact({ style: (style || 'medium').toUpperCase() });
            }
        } catch (error) {
            /* no haptic motor, or permission withheld */
        }
    }

    window.wayseraHaptic = tap;

    // Light tick on anything tappable. Delegated from the document so
    // controls rendered later are covered without re-binding.
    document.addEventListener('pointerdown', (event) => {
        const control = event.target.closest(
            '.btn, .quick-message, .tab-btn, .suggestion-item, ' +
            '.nav-exit-btn, .nav-voice-btn, .room-code-btn, .search-back-btn'
        );
        if (control && !control.disabled) tap('light');
    }, { passive: true });

    /**
     * Wrap a global function so it also fires a haptic.
     *
     * Preserves the return value, because several of these are async and the
     * caller awaits them.
     */
    function withHaptic(name, style, when = 'after') {
        const original = window[name];
        if (typeof original !== 'function') return;
        window[name] = function (...args) {
            if (when === 'before') tap(style);
            const result = original.apply(this, args);
            if (when === 'after') {
                if (result && typeof result.then === 'function') {
                    result.then(() => tap(style), () => tap('error'));
                } else {
                    tap(style);
                }
            }
            return result;
        };
    }

    window.addEventListener('load', () => {
        // Deferred a tick so index.js has finished defining these.
        setTimeout(() => {
            withHaptic('createJourney', 'success');
            withHaptic('sendQuickMessage', 'light', 'before');
            withHaptic('startNavigation', 'medium', 'before');
            withHaptic('stopNavigation', 'light', 'before');
        }, 0);
    }, { once: true });

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

    /**
     * Escalating haptics as the group completes.
     *
     * Arrival is the one moment worth celebrating, and it is also the moment
     * the phone is most likely to be in a pocket.
     */
    function installArrivalFeedback() {
        const originalToast = window.showToast;
        if (typeof originalToast !== 'function') return;

        window.showToast = function (title, body, variant) {
            const text = String(title || '');
            if (/everyone/i.test(text)) {
                tap('success');
                setTimeout(() => tap('success'), 140);
                setTimeout(() => tap('success'), 280);
            } else if (/arrived|joined/i.test(text)) {
                tap('success');
            } else if (variant === 'toast-notice') {
                tap('warning');
            }
            return originalToast.apply(this, arguments);
        };
    }

    window.addEventListener('load', () => {
        installSkeletons();
        installRubberBand();
        setTimeout(installArrivalFeedback, 0);
    }, { once: true });
})();
