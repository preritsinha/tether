/**
 * Waysera journey export.
 *
 * Konvoyage shares a replay as a link, which means the track sits on a server
 * for the recipient to fetch. Waysera has no server to put it on, so sharing is
 * a file you send however you like, so the journey never leaves your control
 * unless you choose to send it.
 *
 * JSON is the full-fidelity form and can be read back in. GPX opens in any
 * mapping tool.
 */

const WayseraExport = (() => {
    'use strict';

    const FORMAT_VERSION = 1;

    /** XML has no tolerance for raw ampersands or angle brackets, and display
     *  names come from other people's devices. */
    function escapeXml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    function isoTime(ms) {
        return new Date(ms).toISOString();
    }

    /** Group a flat, time-ordered point list by person, preserving order. */
    function groupByMember(points) {
        const tracks = new Map();
        for (const point of points) {
            if (!tracks.has(point.memberId)) tracks.set(point.memberId, []);
            tracks.get(point.memberId).push(point);
        }
        return tracks;
    }

    /**
     * Names are not stored on every point, so they are recovered from the
     * event log. Anyone who never produced a join event stays anonymous rather
     * than being given a fabricated label.
     */
    function namesFromEvents(events) {
        const names = new Map();
        for (const event of events) {
            const data = event.data || {};
            if (data.memberId && data.name) names.set(data.memberId, data.name);
        }
        return names;
    }

    function toJSON(journey, points, events) {
        return JSON.stringify(
            {
                format: 'waysera.journey',
                version: FORMAT_VERSION,
                exportedAt: isoTime(Date.now()),
                journey: {
                    code: journey.code,
                    destination: journey.destination || null,
                    createdAt: journey.createdAt || null,
                    expiresAt: journey.expiresAt || null
                },
                // No journey key here. Exporting it would hand over live access
                // to a journey rather than just its history.
                people: Array.from(namesFromEvents(events), ([memberId, name]) => ({
                    memberId,
                    name
                })),
                points: points.map((point) => ({
                    memberId: point.memberId,
                    ts: point.ts,
                    lat: point.lat,
                    lng: point.lng,
                    heading: point.heading ?? null,
                    speed: point.speed ?? null
                })),
                events: events.map((event) => ({
                    ts: event.ts,
                    kind: event.kind,
                    data: event.data ?? null
                }))
            },
            null,
            2
        );
    }

    function toGPX(journey, points, events) {
        const names = namesFromEvents(events);
        const tracks = groupByMember(points);
        const title = journey.destination
            ? `Waysera — ${journey.destination.name}`
            : `Waysera — ${journey.code}`;

        const segments = [];
        for (const [memberId, track] of tracks) {
            const label = names.get(memberId) || 'Someone';
            const trackpoints = track
                .map((point) => {
                    const extras = [];
                    if (point.speed !== null && point.speed !== undefined) {
                        extras.push(`<speed>${point.speed}</speed>`);
                    }
                    if (point.heading !== null && point.heading !== undefined) {
                        extras.push(`<course>${point.heading}</course>`);
                    }
                    return (
                        `      <trkpt lat="${point.lat}" lon="${point.lng}">` +
                        `<time>${isoTime(point.ts)}</time>${extras.join('')}</trkpt>`
                    );
                })
                .join('\n');

            segments.push(
                `  <trk>\n    <name>${escapeXml(label)}</name>\n` +
                `    <trkseg>\n${trackpoints}\n    </trkseg>\n  </trk>`
            );
        }

        return (
            '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<gpx version="1.1" creator="Waysera" xmlns="http://www.topografix.com/GPX/1/1">\n' +
            `  <metadata>\n    <name>${escapeXml(title)}</name>\n` +
            `    <time>${isoTime(Date.now())}</time>\n  </metadata>\n` +
            `${segments.join('\n')}\n</gpx>\n`
        );
    }

    function download(filename, mimeType, text) {
        const blob = new Blob([text], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        // Revoked on the next tick so the click has been handled first.
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    return { FORMAT_VERSION, escapeXml, groupByMember, namesFromEvents, toJSON, toGPX, download };
})();

window.WayseraExport = WayseraExport;
