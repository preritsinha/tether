/**
 * Waysera local store.
 *
 * All journey data lives here, on the device. The relay keeps nothing, so this
 * is the only copy: journey metadata and key, the position track of everyone
 * seen during a journey, and the event log behind replay.
 *
 * IndexedDB rather than localStorage. A three-hour journey with ten people runs
 * to tens of thousands of points, which localStorage can neither hold nor write
 * without blocking the main thread. localStorage keeps a single pointer to the
 * active journey and nothing else.
 */

const WayseraStore = (() => {
    'use strict';

    const DB_NAME = 'waysera';
    const DB_VERSION = 1;
    const ACTIVE_JOURNEY_KEY = 'waysera.activeJourney';

    // Roughly three hours at one point every three seconds. On overflow the
    // track is halved rather than truncated, so a long journey loses
    // resolution evenly instead of losing its beginning.
    const MAX_POINTS_PER_MEMBER = 4000;

    let dbPromise = null;

    function request(idbRequest) {
        return new Promise((resolve, reject) => {
            idbRequest.onsuccess = () => resolve(idbRequest.result);
            idbRequest.onerror = () => reject(idbRequest.error);
        });
    }

    function transactionDone(transaction) {
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
    }

    function open() {
        if (dbPromise) return dbPromise;

        dbPromise = new Promise((resolve, reject) => {
            const openRequest = indexedDB.open(DB_NAME, DB_VERSION);

            openRequest.onupgradeneeded = (event) => {
                const db = openRequest.result;

                if (!db.objectStoreNames.contains('journeys')) {
                    db.createObjectStore('journeys', { keyPath: 'code' });
                }

                if (!db.objectStoreNames.contains('points')) {
                    const points = db.createObjectStore('points', {
                        keyPath: 'id',
                        autoIncrement: true
                    });
                    points.createIndex('byJourney', ['code', 'ts']);
                    points.createIndex('byMember', ['code', 'memberId', 'ts']);
                }

                if (!db.objectStoreNames.contains('events')) {
                    const events = db.createObjectStore('events', {
                        keyPath: 'id',
                        autoIncrement: true
                    });
                    events.createIndex('byJourney', ['code', 'ts']);
                }
            };

            openRequest.onsuccess = () => resolve(openRequest.result);
            openRequest.onerror = () => reject(openRequest.error);
        });

        return dbPromise;
    }

    async function withStore(storeNames, mode, work) {
        const db = await open();
        const transaction = db.transaction(storeNames, mode);
        const stores = Array.isArray(storeNames)
            ? storeNames.map((name) => transaction.objectStore(name))
            : transaction.objectStore(storeNames);

        const result = await work(stores, transaction);
        await transactionDone(transaction);
        return result;
    }

    // ----------------------------------------------------------------- journeys

    /**
     * Journeys hold the CryptoKey object directly. IndexedDB structured-clones
     * it, which keeps raw key bytes out of application memory and out of any
     * accidental JSON serialisation.
     */
    async function putJourney(journey) {
        return withStore('journeys', 'readwrite', (store) =>
            request(store.put(journey))
        );
    }

    async function getJourney(code) {
        return withStore('journeys', 'readonly', (store) =>
            request(store.get(code))
        );
    }

    async function listJourneys() {
        return withStore('journeys', 'readonly', (store) => request(store.getAll()));
    }

    async function deleteJourney(code) {
        // Cascades: keeping a journey's track after deleting the journey would
        // leave orphaned position data on the device indefinitely.
        //
        // Requests are issued without awaiting between them on purpose. An IDB
        // transaction commits once its pending requests drain and control
        // returns to the event loop, so awaiting mid-transaction risks a
        // TransactionInactiveError on the next request. transactionDone() is
        // what we wait on instead.
        return withStore(
            ['journeys', 'points', 'events'],
            'readwrite',
            ([journeys, points, events]) => {
                journeys.delete(code);
                deleteByJourney(points, 'byJourney', code);
                deleteByJourney(events, 'byJourney', code);
                return Promise.resolve();
            }
        );
    }

    /** Issues a cursor walk inside the caller's transaction. Does not await. */
    function deleteByJourney(store, indexName, code) {
        const range = IDBKeyRange.bound([code, -Infinity], [code, Infinity]);
        const cursorRequest = store.index(indexName).openCursor(range);

        cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            cursor.delete();
            cursor.continue();
        };
    }

    // ------------------------------------------------------------------- points

    async function appendPoint(code, point) {
        return appendPoints(code, [point]);
    }

    async function appendPoints(code, points) {
        if (!points || points.length === 0) return;

        await withStore('points', 'readwrite', (store) => {
            for (const point of points) {
                store.put({
                    code,
                    memberId: point.memberId,
                    ts: point.ts,
                    lat: point.lat,
                    lng: point.lng,
                    heading: point.heading ?? null,
                    speed: point.speed ?? null
                });
            }
            return Promise.resolve();
        });
    }

    function readIndex(storeName, indexName, range) {
        return withStore(storeName, 'readonly', (store) =>
            request(store.index(indexName).getAll(range))
        );
    }

    async function getPoints(code) {
        return readIndex(
            'points',
            'byJourney',
            IDBKeyRange.bound([code, -Infinity], [code, Infinity])
        );
    }

    async function getPointsByMember(code, memberId) {
        return readIndex(
            'points',
            'byMember',
            IDBKeyRange.bound([code, memberId, -Infinity], [code, memberId, Infinity])
        );
    }

    async function countPointsByMember(code, memberId) {
        return withStore('points', 'readonly', (store) =>
            request(
                store
                    .index('byMember')
                    .count(
                        IDBKeyRange.bound(
                            [code, memberId, -Infinity],
                            [code, memberId, Infinity]
                        )
                    )
            )
        );
    }

    /**
     * Halve a member's track when it exceeds the cap, dropping every second
     * point. Resolution degrades evenly across the whole journey rather than
     * the earliest stretch disappearing, which is what a plain cap would do.
     * Returns the number of points removed.
     */
    async function pruneMemberPoints(code, memberId, maxPoints = MAX_POINTS_PER_MEMBER) {
        const count = await countPointsByMember(code, memberId);
        if (count <= maxPoints) return 0;

        return withStore('points', 'readwrite', (store) =>
            new Promise((resolve, reject) => {
                const range = IDBKeyRange.bound(
                    [code, memberId, -Infinity],
                    [code, memberId, Infinity]
                );
                const cursorRequest = store.index('byMember').openCursor(range);
                let index = 0;
                let removed = 0;

                cursorRequest.onsuccess = () => {
                    const cursor = cursorRequest.result;
                    if (!cursor) {
                        resolve(removed);
                        return;
                    }
                    // Keep the first and last points regardless: they anchor
                    // the replay timeline.
                    if (index % 2 === 1 && index !== count - 1) {
                        cursor.delete();
                        removed += 1;
                    }
                    index += 1;
                    cursor.continue();
                };
                cursorRequest.onerror = () => reject(cursorRequest.error);
            })
        );
    }

    // ------------------------------------------------------------------- events

    async function appendEvent(code, event) {
        return withStore('events', 'readwrite', (store) =>
            request(store.put({ code, ts: event.ts, kind: event.kind, data: event.data ?? null }))
        );
    }

    async function getEvents(code) {
        return readIndex(
            'events',
            'byJourney',
            IDBKeyRange.bound([code, -Infinity], [code, Infinity])
        );
    }

    // ------------------------------------------------------------ active pointer

    function setActiveJourney(code) {
        try {
            localStorage.setItem(ACTIVE_JOURNEY_KEY, code);
        } catch (error) {
            // Private browsing can refuse localStorage. The journey still works;
            // it just will not resume automatically on reload.
        }
    }

    function getActiveJourney() {
        try {
            return localStorage.getItem(ACTIVE_JOURNEY_KEY);
        } catch (error) {
            return null;
        }
    }

    function clearActiveJourney() {
        try {
            localStorage.removeItem(ACTIVE_JOURNEY_KEY);
        } catch (error) {
            // Nothing to do.
        }
    }

    // --------------------------------------------------------------------- test

    async function clearAll() {
        return withStore(
            ['journeys', 'points', 'events'],
            'readwrite',
            ([journeys, points, events]) => {
                journeys.clear();
                points.clear();
                events.clear();
                return Promise.resolve();
            }
        );
    }

    function closeForTests() {
        if (!dbPromise) return Promise.resolve();
        return dbPromise.then((db) => {
            db.close();
            dbPromise = null;
        });
    }

    return {
        DB_NAME,
        MAX_POINTS_PER_MEMBER,
        open,
        putJourney,
        getJourney,
        listJourneys,
        deleteJourney,
        appendPoint,
        appendPoints,
        getPoints,
        getPointsByMember,
        countPointsByMember,
        pruneMemberPoints,
        appendEvent,
        getEvents,
        setActiveJourney,
        getActiveJourney,
        clearActiveJourney,
        clearAll,
        closeForTests
    };
})();

window.WayseraStore = WayseraStore;
