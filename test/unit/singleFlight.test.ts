import assert from 'node:assert/strict';
import { createSingleFlightCache } from '../../src/testing/singleFlight';

/** A fetch whose resolution/rejection the test controls explicitly, to force two calls to genuinely overlap. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('createSingleFlightCache', () => {
    it('two concurrent calls for the same key invoke the fetch exactly once and both resolve to the same value', async () => {
        const cache = createSingleFlightCache<string[]>();
        let calls = 0;
        const d = deferred<string[]>();
        const fetch = () => {
            calls++;
            return d.promise;
        };

        const p1 = cache.get('DEV', fetch);
        const p2 = cache.get('DEV', fetch);
        d.resolve(['a', 'b']);
        const [r1, r2] = await Promise.all([p1, p2]);

        assert.equal(calls, 1);
        assert.deepEqual(r1, ['a', 'b']);
        assert.deepEqual(r2, ['a', 'b']);
    });

    it('a call issued after the first resolved hits the value cache and invokes the fetch no further', async () => {
        const cache = createSingleFlightCache<string[]>();
        let calls = 0;
        const fetch = async () => {
            calls++;
            return ['a'];
        };

        await cache.get('DEV', fetch);
        await cache.get('DEV', fetch);
        await cache.get('DEV', fetch);

        assert.equal(calls, 1);
    });

    it('concurrent calls for two different keys invoke the fetch twice, once per key', async () => {
        const cache = createSingleFlightCache<string>();
        let calls = 0;
        const fetch = async (key: string) => {
            calls++;
            return `value-${key}`;
        };

        const [a, b] = await Promise.all([cache.get('DEV', () => fetch('DEV')), cache.get('PROD', () => fetch('PROD'))]);

        assert.equal(calls, 2);
        assert.equal(a, 'value-DEV');
        assert.equal(b, 'value-PROD');
    });

    it('when the fetch rejects, every concurrent caller rejects, and a subsequent call retries instead of reusing the rejection', async () => {
        const cache = createSingleFlightCache<string[]>();
        let calls = 0;
        const d = deferred<string[]>();
        const failingFetch = () => {
            calls++;
            return d.promise;
        };

        const p1 = cache.get('DEV', failingFetch);
        const p2 = cache.get('DEV', failingFetch);
        d.reject(new Error('transient failure'));

        await assert.rejects(p1, /transient failure/);
        await assert.rejects(p2, /transient failure/);
        assert.equal(calls, 1, 'both concurrent callers must have shared the one failing fetch');

        const result = await cache.get('DEV', async () => {
            calls++;
            return ['recovered'];
        });
        assert.deepEqual(result, ['recovered']);
        assert.equal(calls, 2, 'the retry after a rejection must call fetch again, not reuse the dropped in-flight entry');
    });

    it('clearing mid-flight never resurrects a stale value: a call issued after clear() joins the still-running fetch instead of returning pre-clear rows', async () => {
        const cache = createSingleFlightCache<string[]>();
        // Prime the cache with an old value first.
        await cache.get('DEV', async () => ['stale']);

        const d = deferred<string[]>();
        let calls = 0;
        const fetch = () => {
            calls++;
            return d.promise;
        };

        cache.clear('DEV');
        const p1 = cache.get('DEV', fetch); // starts a fresh fetch, since the value cache was just cleared
        const p2 = cache.get('DEV', fetch); // must join p1's fetch, not read back 'stale'
        d.resolve(['fresh']);
        const [r1, r2] = await Promise.all([p1, p2]);

        assert.equal(calls, 1);
        assert.deepEqual(r1, ['fresh']);
        assert.deepEqual(r2, ['fresh']);
    });

    it('clear() with no key clears every key', async () => {
        const cache = createSingleFlightCache<number>();
        let calls = 0;
        const fetch = async () => {
            calls++;
            return calls;
        };
        await cache.get('A', fetch);
        await cache.get('B', fetch);

        cache.clear();

        await cache.get('A', fetch);
        await cache.get('B', fetch);
        assert.equal(calls, 4);
    });

    it('peek() returns the cached value without ever invoking fetch, and undefined before one exists', async () => {
        const cache = createSingleFlightCache<string[]>();
        assert.equal(cache.peek('DEV'), undefined);
        await cache.get('DEV', async () => ['a']);
        assert.deepEqual(cache.peek('DEV'), ['a']);
    });
});
