import assert from 'node:assert/strict';
import { forgetProfile, ProfileCacheHandles } from '../../src/testing/profileCaches';
import { reconcileRoots } from '../../src/testing/rootReconciliation';
import { rootId } from '../../src/testing/ids';

describe('forgetProfile (profileCaches)', () => {
    function makeCountingHandles(): { handles: ProfileCacheHandles; calls: Record<keyof ProfileCacheHandles, string[]> } {
        const calls: Record<keyof ProfileCacheHandles, string[]> = {
            clearSuiteRows: [],
            clearObjectTypes: [],
            clearChildrenIndex: [],
            clearVersion: [],
            clearDbaView: [],
            closePool: []
        };
        const handles: ProfileCacheHandles = {
            clearSuiteRows: (p) => void calls.clearSuiteRows.push(p),
            clearObjectTypes: (p) => void calls.clearObjectTypes.push(p),
            clearChildrenIndex: (p) => void calls.clearChildrenIndex.push(p),
            clearVersion: (p) => void calls.clearVersion.push(p),
            clearDbaView: (p) => void calls.clearDbaView.push(p),
            closePool: async (p) => void calls.closePool.push(p)
        };
        return { handles, calls };
    }

    it('calls every one of the five operations exactly once, with the given profile', async () => {
        const { handles, calls } = makeCountingHandles();
        await forgetProfile('DEV', handles);
        for (const key of Object.keys(calls) as (keyof ProfileCacheHandles)[]) {
            assert.deepEqual(calls[key], ['DEV'], `expected '${key}' to have been called exactly once, with 'DEV'`);
        }
    });

    it("clears the suite-row cache, children index, version cache and DBA-view cache for that profile only, leaving another profile's entries intact", async () => {
        const suiteRows = new Map([
            ['DEV', ['row']],
            ['PROD', ['row']]
        ]);
        const objectTypes = new Map([
            ['DEV', 'PACKAGE'],
            ['PROD', 'PACKAGE']
        ]);
        const childrenIndex = new Map([
            ['DEV:HR', 'idx'],
            ['PROD:HR', 'idx']
        ]);
        const version = new Map([
            ['DEV', '3.1.13'],
            ['PROD', '3.1.13']
        ]);
        const dbaView = new Map([
            ['DEV', true],
            ['PROD', true]
        ]);
        let poolClosedFor: string | undefined;

        await forgetProfile('DEV', {
            clearSuiteRows: (p) => void suiteRows.delete(p),
            clearObjectTypes: (p) => void objectTypes.delete(p),
            clearChildrenIndex: (p) => {
                const prefix = `${p}:`;
                for (const key of [...childrenIndex.keys()]) {
                    if (key.startsWith(prefix)) {
                        childrenIndex.delete(key);
                    }
                }
            },
            clearVersion: (p) => void version.delete(p),
            clearDbaView: (p) => void dbaView.delete(p),
            closePool: async (p) => void (poolClosedFor = p)
        });

        assert.ok(!suiteRows.has('DEV') && suiteRows.has('PROD'));
        assert.ok(!objectTypes.has('DEV') && objectTypes.has('PROD'));
        assert.ok(!childrenIndex.has('DEV:HR') && childrenIndex.has('PROD:HR'));
        assert.ok(!version.has('DEV') && version.has('PROD'));
        assert.ok(!dbaView.has('DEV') && dbaView.has('PROD'));
        assert.equal(poolClosedFor, 'DEV');
    });
});

describe('reconcileRoots', () => {
    it('adds one root id and removes one root id when a change adds one profile and removes another', () => {
        const existingIds = [rootId('DEV'), rootId('OLD')];
        const result = reconcileRoots(existingIds, ['DEV', 'NEW']);
        assert.deepEqual(result.added, [rootId('NEW')]);
        assert.deepEqual(result.removed, [rootId('OLD')]);
    });

    it('reports nothing to add or remove when the configured profiles match the existing roots', () => {
        const existingIds = [rootId('DEV'), rootId('PROD')];
        const result = reconcileRoots(existingIds, ['PROD', 'DEV']);
        assert.deepEqual(result, { added: [], removed: [] });
    });

    it('adds a root for every profile when no roots exist yet (the initial resolveHandler(undefined) case)', () => {
        const result = reconcileRoots([], ['DEV', 'PROD']);
        assert.deepEqual(new Set(result.added), new Set([rootId('DEV'), rootId('PROD')]));
        assert.deepEqual(result.removed, []);
    });

    it('removes every root when every profile disappears', () => {
        const result = reconcileRoots([rootId('DEV'), rootId('PROD')], []);
        assert.deepEqual(new Set(result.removed), new Set([rootId('DEV'), rootId('PROD')]));
        assert.deepEqual(result.added, []);
    });
});
