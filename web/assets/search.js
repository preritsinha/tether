/**
 * Destination search.
 *
 * Backed by Photon, which is OSM data with a geocoder that accepts a lat/lon to
 * bias results toward. That bias is the whole point: someone starting a journey
 * is almost always heading somewhere near them, and a search for "station"
 * should not rank a village in Norway above the one down the road.
 *
 * Results are shown the way maps apps show them, on two lines: what the place
 * is called, then enough address to tell two identically named places apart,
 * plus a distance when we know roughly where the user is.
 */

const WayseraSearch = (() => {
    'use strict';

    const ENDPOINT = 'https://photon.komoot.io/api';
    const LIMIT = 8;

    // Photon's default bias is gentle. A navigation app wants it stronger:
    // nearby matters more here than it would for a general-purpose map search.
    const BIAS_SCALE = 0.6;

    const LAST_POSITION_KEY = 'waysera.lastPosition';

    // Free-form OSM values, mapped to something a person would recognise.
    // Anything not listed falls back to the raw value with underscores removed,
    // which reads acceptably for the long tail.
    const CATEGORY_LABELS = {
        aerodrome: 'Airport',
        bus_station: 'Bus station',
        railway_station: 'Station',
        station: 'Station',
        subway: 'Metro',
        halt: 'Station',
        fuel: 'Petrol station',
        charging_station: 'Charging point',
        restaurant: 'Restaurant',
        cafe: 'Cafe',
        fast_food: 'Fast food',
        bar: 'Bar',
        pub: 'Pub',
        hotel: 'Hotel',
        hospital: 'Hospital',
        clinic: 'Clinic',
        pharmacy: 'Pharmacy',
        school: 'School',
        college: 'College',
        university: 'University',
        parking: 'Parking',
        supermarket: 'Supermarket',
        mall: 'Shopping centre',
        park: 'Park',
        stadium: 'Stadium',
        museum: 'Museum',
        place_of_worship: 'Place of worship',
        attraction: 'Attraction',
        viewpoint: 'Viewpoint',
        beach: 'Beach',
        city: 'City',
        town: 'Town',
        village: 'Village',
        suburb: 'Neighbourhood',
        neighbourhood: 'Neighbourhood',
        house: 'Address',
        street: 'Street'
    };

    // ------------------------------------------------------ remembered position

    /**
     * The last place we saw the user, kept so the very first search can be
     * biased without asking for permission. Written rarely on purpose: this is
     * a hint for ranking, not a track.
     */
    function rememberPosition(lat, lng) {
        try {
            localStorage.setItem(
                LAST_POSITION_KEY,
                JSON.stringify({ lat, lng, ts: Date.now() })
            );
        } catch (error) {
            // Private mode. Search still works, just without the bias.
        }
    }

    function recallPosition() {
        try {
            const raw = localStorage.getItem(LAST_POSITION_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!Number.isFinite(parsed.lat) || !Number.isFinite(parsed.lng)) return null;
            return parsed;
        } catch (error) {
            return null;
        }
    }

    function forgetPosition() {
        try {
            localStorage.removeItem(LAST_POSITION_KEY);
        } catch (error) {
            // Nothing to do.
        }
    }

    // -------------------------------------------------------------- formatting

    function categoryFor(properties) {
        const value = properties.osm_value || properties.type;
        if (!value) return '';
        if (CATEGORY_LABELS[value]) return CATEGORY_LABELS[value];
        return String(value).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    }

    /**
     * Split a result into the two lines a maps app shows.
     *
     * The first line is what the place is called. The second is whatever
     * address context is left over, which is what tells two branches of the
     * same chain apart. Parts already used on the first line are not repeated.
     */
    function formatResult(feature) {
        const properties = feature.properties || {};
        const [lon, lat] = (feature.geometry && feature.geometry.coordinates) || [];

        const streetLine = [properties.housenumber, properties.street]
            .filter(Boolean)
            .join(' ');

        const primary =
            properties.name ||
            streetLine ||
            properties.city ||
            properties.state ||
            properties.country ||
            'Unnamed place';

        const context = [
            properties.name ? streetLine : '',
            properties.district,
            properties.city,
            properties.county,
            properties.state,
            properties.country
        ];

        const seen = new Set([primary.toLowerCase()]);
        const secondary = context
            .filter(Boolean)
            .filter((part) => {
                const key = String(part).toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .join(', ');

        return {
            primary,
            secondary,
            category: categoryFor(properties),
            lat,
            lng: lon
        };
    }

    function distanceLabel(km) {
        if (km === null || km === undefined || !Number.isFinite(km)) return '';
        if (km < 1) return `${Math.round(km * 1000)} m`;
        if (km < 10) return `${km.toFixed(1)} km`;
        return `${Math.round(km)} km`;
    }

    // ------------------------------------------------------------------ search

    function buildUrl(query, near) {
        const params = new URLSearchParams({
            q: query,
            limit: String(LIMIT),
            lang: 'en'
        });
        if (near) {
            params.set('lat', String(near.lat));
            params.set('lon', String(near.lng));
            params.set('location_bias_scale', String(BIAS_SCALE));
        }
        return `${ENDPOINT}?${params.toString()}`;
    }

    /**
     * Run a search. Pass an AbortSignal so a slower earlier request cannot
     * overwrite the results of a later one, which is what makes typing feel
     * responsive rather than jumpy.
     */
    async function search(query, options = {}) {
        const trimmed = String(query || '').trim();
        if (trimmed.length < 2) return [];

        const response = await fetch(buildUrl(trimmed, options.near), {
            signal: options.signal,
            headers: { Accept: 'application/json' }
        });
        if (!response.ok) {
            throw new Error(`Search failed with ${response.status}`);
        }

        const body = await response.json();
        const features = Array.isArray(body.features) ? body.features : [];

        return features
            .map(formatResult)
            .filter((result) => Number.isFinite(result.lat) && Number.isFinite(result.lng))
            .map((result) => {
                const km = options.near
                    ? haversineDistance(options.near.lat, options.near.lng, result.lat, result.lng)
                    : null;
                return { ...result, distanceKm: km, distance: distanceLabel(km) };
            });
    }

    return {
        ENDPOINT,
        CATEGORY_LABELS,
        rememberPosition,
        recallPosition,
        forgetPosition,
        categoryFor,
        formatResult,
        distanceLabel,
        buildUrl,
        search
    };
})();

window.WayseraSearch = WayseraSearch;
