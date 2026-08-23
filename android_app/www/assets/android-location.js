/**
 * Location tracking backed by a foreground service.
 *
 * Replaces startLocationTracking/stopLocationTracking when the native plugin is
 * present. In a browser the plugin is absent and this file does nothing, so the
 * page behaves exactly as the web build.
 *
 * navigator.geolocation stops delivering the moment Android suspends the
 * WebView, which is whenever the screen turns off or the user switches apps —
 * precisely when a group most needs to see each other moving. Android only
 * allows indefinite location access from a foreground service, and such a
 * service must show a permanent notification. Passing backgroundMessage is what
 * starts it.
 */

(() => {
    'use strict';

    const plugin = window.Capacitor
        && window.Capacitor.Plugins
        && window.Capacitor.Plugins.BackgroundGeolocation;

    if (!plugin) return;

    // Captured before the reassignments below; reading them afterwards returns
    // these overrides and the fallback path calls itself forever.
    const webStart = window.startLocationTracking;
    const webStop = window.stopLocationTracking;

    if (typeof webStart !== 'function') {
        console.warn('[waysera] index.js has not loaded; leaving location tracking alone');
        return;
    }

    let watcherId = null;

    /**
     * The plugin calls compass direction `bearing`; the web API calls it
     * `heading`. Absent values stay null rather than 0, since 0 is due north
     * and would point every marker the same way.
     */
    function toCoords(location) {
        return {
            latitude: location.latitude,
            longitude: location.longitude,
            heading: Number.isFinite(location.bearing) ? location.bearing : null,
            speed: Number.isFinite(location.speed) ? location.speed : null,
            accuracy: Number.isFinite(location.accuracy) ? location.accuracy : null
        };
    }

    window.startLocationTracking = function startLocationTrackingAndroid() {
        if (watcherId !== null) return;

        const started = plugin.addWatcher(
            {
                backgroundMessage: 'Sharing your position with your group.',
                backgroundTitle: 'Waysera journey active',
                requestPermissions: true,
                stale: false,
                // The relay caps a socket at 20 messages/sec and the recorder
                // thins to one point per 2.5s, so every fix would be wasted.
                distanceFilter: 10
            },
            (location, error) => {
                if (error) {
                    if (error.code === 'NOT_AUTHORIZED') {
                        showLocationAlert(
                            'Location permission was turned off. Your group can no longer see you.'
                        );
                    }
                    handleLocationError(error);
                    return;
                }
                if (location) publishPosition(toCoords(location));
            }
        );

        // Capacitor returns a callback id synchronously for plugin methods that
        // take a callback; older versions returned a Promise. Assuming either
        // shape leaves watcherId null, and a watcher that cannot be removed
        // keeps the GPS and its notification alive after the journey ends.
        if (started && typeof started.then === 'function') {
            started.then(
                (id) => { watcherId = id; },
                (error) => {
                    console.warn('[waysera] background watcher failed, foreground only', error);
                    watcherId = null;
                    webStart();
                }
            );
        } else if (started) {
            watcherId = started;
        } else {
            console.warn('[waysera] background watcher returned no id, foreground only');
            webStart();
        }
    };

    window.stopLocationTracking = function stopLocationTrackingAndroid() {
        if (watcherId !== null) {
            const id = watcherId;
            watcherId = null;
            // Removing the watcher is what dismisses the service notification.
            const removed = plugin.removeWatcher({ id });
            if (removed && typeof removed.catch === 'function') removed.catch(() => {});
        }
        webStop();
    };
})();
