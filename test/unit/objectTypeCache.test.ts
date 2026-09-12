import assert from 'node:assert/strict';
import { createObjectTypeCache, ObjectType } from '../../src/testing/objectTypeCache';

describe('createObjectTypeCache', () => {
    it('resolves the same (profile, owner, name) twice but invokes the underlying fetch only once', async () => {
        const cache = createObjectTypeCache();
        let calls = 0;
        const fetchAll = async (names: string[]): Promise<Map<string, ObjectType>> => {
            calls++;
            return new Map(names.map((n) => [n, 'PACKAGE BODY' as ObjectType]));
        };

        const first = await cache.resolve('DEV', 'HR', ['CALC_PKG'], fetchAll);
        const second = await cache.resolve('DEV', 'HR', ['CALC_PKG'], fetchAll);

        assert.equal(calls, 1);
        assert.equal(first.get('CALC_PKG'), 'PACKAGE BODY');
        assert.equal(second.get('CALC_PKG'), 'PACKAGE BODY');
    });

    it('remembers a name absent from the fetched batch as a confirmed miss, instead of retrying it on every subsequent level', async () => {
        const cache = createObjectTypeCache();
        let calls = 0;
        const fetchAll = async (names: string[]): Promise<Map<string, ObjectType>> => {
            calls++;
            // Only CALC_PKG actually exists as a package/package body --
            // NOT_A_PACKAGE (e.g. a --%suitepath group's synthetic
            // objectName, see issue #27) never comes back.
            return new Map(names.filter((n) => n === 'CALC_PKG').map((n) => [n, 'PACKAGE BODY' as ObjectType]));
        };

        const firstLevel = await cache.resolve('DEV', 'HR', ['CALC_PKG', 'NOT_A_PACKAGE'], fetchAll);
        assert.equal(firstLevel.has('NOT_A_PACKAGE'), false);

        const laterLevel = await cache.resolve('DEV', 'HR', ['NOT_A_PACKAGE'], fetchAll);
        assert.equal(calls, 1, 'a name already known to be absent must not trigger a second fetch');
        assert.equal(laterLevel.has('NOT_A_PACKAGE'), false);
    });

    it('keeps different owners and different profiles in separate cache entries, each fetching independently', async () => {
        const cache = createObjectTypeCache();
        const fetchCallsByKey: string[] = [];
        const fetchFor = (label: string) => async (names: string[]): Promise<Map<string, ObjectType>> => {
            fetchCallsByKey.push(label);
            return new Map(names.map((n) => [n, 'PACKAGE' as ObjectType]));
        };

        await cache.resolve('DEV', 'HR', ['A'], fetchFor('DEV/HR'));
        await cache.resolve('DEV', 'SCOTT', ['A'], fetchFor('DEV/SCOTT'));
        await cache.resolve('PROD', 'HR', ['A'], fetchFor('PROD/HR'));

        assert.deepEqual(fetchCallsByKey.sort(), ['DEV/HR', 'DEV/SCOTT', 'PROD/HR']);
    });

    it('clearing the cache forces exactly one re-query for a name it had already resolved', async () => {
        const cache = createObjectTypeCache();
        let calls = 0;
        const fetchAll = async (names: string[]): Promise<Map<string, ObjectType>> => {
            calls++;
            return new Map(names.map((n) => [n, 'PACKAGE BODY' as ObjectType]));
        };

        await cache.resolve('DEV', 'HR', ['CALC_PKG'], fetchAll);
        cache.clear();
        await cache.resolve('DEV', 'HR', ['CALC_PKG'], fetchAll);

        assert.equal(calls, 2);
    });

    it('clearing one owner leaves other owners cached', async () => {
        const cache = createObjectTypeCache();
        let calls = 0;
        const fetchAll = async (names: string[]): Promise<Map<string, ObjectType>> => {
            calls++;
            return new Map(names.map((n) => [n, 'PACKAGE BODY' as ObjectType]));
        };

        await cache.resolve('DEV', 'HR', ['A'], fetchAll);
        await cache.resolve('DEV', 'SCOTT', ['A'], fetchAll);

        cache.clear('DEV', 'HR');

        await cache.resolve('DEV', 'HR', ['A'], fetchAll); // re-fetches
        await cache.resolve('DEV', 'SCOTT', ['A'], fetchAll); // still cached

        assert.equal(calls, 3);
    });

    it('single-flights concurrent resolves for the same owner requesting the same names into exactly one underlying call', async () => {
        const cache = createObjectTypeCache();
        let calls = 0;
        let releaseFetch!: () => void;
        const fetchAll = (names: string[]): Promise<Map<string, ObjectType>> => {
            calls++;
            return new Promise((resolve) => {
                releaseFetch = () => resolve(new Map(names.map((n) => [n, 'PACKAGE BODY' as ObjectType])));
            });
        };

        const p1 = cache.resolve('DEV', 'HR', ['CALC_PKG', 'OTHER_PKG'], fetchAll);
        const p2 = cache.resolve('DEV', 'HR', ['CALC_PKG', 'OTHER_PKG'], fetchAll);
        releaseFetch();
        const [r1, r2] = await Promise.all([p1, p2]);

        assert.equal(calls, 1, 'two concurrent resolves for the same owner must share one underlying fetch');
        assert.equal(r1.get('CALC_PKG'), 'PACKAGE BODY');
        assert.equal(r2.get('OTHER_PKG'), 'PACKAGE BODY');
    });

    it('normalizes name case, so a lowercase lookup still hits an uppercase-cached answer', async () => {
        const cache = createObjectTypeCache();
        let calls = 0;
        const fetchAll = async (names: string[]): Promise<Map<string, ObjectType>> => {
            calls++;
            return new Map(names.map((n) => [n, 'PACKAGE BODY' as ObjectType]));
        };

        await cache.resolve('DEV', 'hr', ['calc_pkg'], fetchAll);
        const result = await cache.resolve('DEV', 'HR', ['CALC_PKG'], fetchAll);

        assert.equal(calls, 1);
        assert.equal(result.get('CALC_PKG'), 'PACKAGE BODY');
    });
});
