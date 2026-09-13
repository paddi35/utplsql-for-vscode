import assert from 'node:assert/strict';
import { computeCoverageScope, CoverageScopeItem, CoverageScopeOptions, IncludesFn, ObjectRef } from '../../src/testing/coverageScope';

const noOverrides: CoverageScopeOptions = { excludeObjects: [], schemesOverride: [], includeObjectsOverride: [] };

/** An includesFn that never returns any dependency and just counts its own invocations, per owner. */
function countingIncludesFn(): { fn: IncludesFn; callsByOwner: Map<string, number>; totalCalls: () => number } {
    const callsByOwner = new Map<string, number>();
    const fn: IncludesFn = async (owner) => {
        callsByOwner.set(owner, (callsByOwner.get(owner) ?? 0) + 1);
        return [];
    };
    return { fn, callsByOwner, totalCalls: () => [...callsByOwner.values()].reduce((a, b) => a + b, 0) };
}

describe('computeCoverageScope', () => {
    it('20 item metas that all belong to one package call includesFn exactly once (issue #21: this called it 20 times before the fix)', async () => {
        const items: CoverageScopeItem[] = Array.from({ length: 20 }, () => ({ owner: 'HR', objectName: 'CALC_PKG' }));
        const { fn, totalCalls } = countingIncludesFn();

        const scope = await computeCoverageScope(items, fn, noOverrides);

        assert.equal(totalCalls(), 1, 'expected exactly one includesFn call for 20 rows of the same package');
        assert.equal(scope.testObjects.size, 1);
        assert.deepEqual(scope.testObjects.get('HR.CALC_PKG'), { owner: 'HR', name: 'CALC_PKG' });
    });

    it('items spanning 3 packages across 2 owners call includesFn once per distinct owner — batched further than the issue\'s own minimum suggestion (once per (owner, name) pair, i.e. three times)', async () => {
        // The issue's suggested unit test asks for "once per distinct
        // (owner, name) pair — three times". This implementation goes one
        // level further (dao.includes batches an owner's whole name list
        // into one bind-list query, mirroring dao.getPackageObjectTypes —
        // see coverageScope.ts's doc comment), so the actually-implemented,
        // more aggressive batching calls it once per owner instead: twice,
        // not three times, for 3 packages across 2 owners.
        const items: CoverageScopeItem[] = [
            { owner: 'HR', objectName: 'CALC_PKG' },
            { owner: 'HR', objectName: 'OTHER_PKG' },
            { owner: 'SCOTT', objectName: 'EMP_PKG' }
        ];
        const namesSeenByOwner = new Map<string, string[]>();
        const fn: IncludesFn = async (owner, names) => {
            namesSeenByOwner.set(owner, names);
            if (owner === 'HR' && names.includes('CALC_PKG')) {
                return [{ owner: 'HR', name: 'DEP_OF_CALC' }];
            }
            if (owner === 'SCOTT') {
                return [{ owner: 'SCOTT', name: 'DEP_OF_EMP' }];
            }
            return [];
        };

        const scope = await computeCoverageScope(items, fn, noOverrides);

        assert.equal(namesSeenByOwner.size, 2, 'expected exactly one call per distinct owner');
        assert.deepEqual([...(namesSeenByOwner.get('HR') ?? [])].sort(), ['CALC_PKG', 'OTHER_PKG']);
        assert.deepEqual(namesSeenByOwner.get('SCOTT'), ['EMP_PKG']);

        assert.equal(scope.testObjects.size, 3);
        assert.deepEqual([...scope.includeObjects.values()].sort((a, b) => a.name.localeCompare(b.name)), [
            { owner: 'HR', name: 'DEP_OF_CALC' },
            { owner: 'SCOTT', name: 'DEP_OF_EMP' }
        ]);
    });

    it('resolves owners strictly one after another, never starting a second owner\'s call before the first settles (a single Connection cannot run concurrent execute() calls)', async () => {
        const order: string[] = [];
        let releaseHr!: () => void;
        const fn: IncludesFn = async (owner) => {
            order.push(`start:${owner}`);
            if (owner === 'HR') {
                await new Promise<void>((resolve) => {
                    releaseHr = resolve;
                });
            }
            order.push(`end:${owner}`);
            return [];
        };
        const items: CoverageScopeItem[] = [
            { owner: 'HR', objectName: 'A' },
            { owner: 'SCOTT', objectName: 'B' }
        ];

        const pending = computeCoverageScope(items, fn, noOverrides);
        // Let the microtask queue drain up to HR's own await point.
        await Promise.resolve();
        await Promise.resolve();
        assert.deepEqual(order, ['start:HR'], 'SCOTT must not start before HR settles');

        releaseHr();
        await pending;
        assert.deepEqual(order, ['start:HR', 'end:HR', 'start:SCOTT', 'end:SCOTT']);
    });

    it('duplicate dependency rows returned for different owners are deduplicated in the final include set', async () => {
        const items: CoverageScopeItem[] = [
            { owner: 'HR', objectName: 'CALC_PKG' },
            { owner: 'SCOTT', objectName: 'EMP_PKG' }
        ];
        const shared: ObjectRef = { owner: 'UTIL', name: 'SHARED_PKG' };
        const fn: IncludesFn = async () => [shared];

        const scope = await computeCoverageScope(items, fn, noOverrides);

        assert.equal(scope.includeObjects.size, 1, `expected the shared dependency to be deduplicated, got ${JSON.stringify([...scope.includeObjects.values()])}`);
        assert.deepEqual(scope.includeObjects.get('UTIL.SHARED_PKG'), shared);
    });

    it('utplsql.coverage.excludeObjects entries are removed case-insensitively', async () => {
        const items: CoverageScopeItem[] = [{ owner: 'HR', objectName: 'CALC_PKG' }];
        const fn: IncludesFn = async () => [
            { owner: 'SYS', name: 'UT' },
            { owner: 'HR', name: 'DEP_PKG' }
        ];

        const scope = await computeCoverageScope(items, fn, { ...noOverrides, excludeObjects: ['ut'] });

        assert.equal(scope.includeObjects.has('SYS.UT'), false, 'expected a lowercase excludeObjects entry to still exclude an uppercase dependency name');
        assert.ok(scope.includeObjects.has('HR.DEP_PKG'), 'expected an unrelated dependency to survive exclusion');
    });

    it('utplsql.coverage.schemes replaces the owner set derived from items, uppercased', async () => {
        const items: CoverageScopeItem[] = [{ owner: 'HR', objectName: 'CALC_PKG' }];
        const fn: IncludesFn = async () => [];

        const scope = await computeCoverageScope(items, fn, { ...noOverrides, schemesOverride: ['other_schema'] });

        assert.deepEqual(scope.schemes, ['OTHER_SCHEMA']);
    });

    it('utplsql.coverage.includeObjects set non-empty replaces the derived include set entirely, and is expanded across every scheme', async () => {
        const items: CoverageScopeItem[] = [
            { owner: 'HR', objectName: 'CALC_PKG' },
            { owner: 'SCOTT', objectName: 'EMP_PKG' }
        ];
        const fn: IncludesFn = async () => [{ owner: 'HR', name: 'SHOULD_BE_REPLACED' }];

        const scope = await computeCoverageScope(items, fn, { ...noOverrides, includeObjectsOverride: ['forced_pkg'] });

        assert.equal(scope.includeObjects.has('HR.SHOULD_BE_REPLACED'), false, 'the derived dependency set must be replaced entirely, not merged');
        assert.deepEqual(
            [...scope.includeObjects.values()].sort((a, b) => a.owner.localeCompare(b.owner)),
            [
                { owner: 'HR', name: 'FORCED_PKG' },
                { owner: 'SCOTT', name: 'FORCED_PKG' }
            ]
        );
    });

    it('an empty item list makes no includesFn calls and returns empty scope data', async () => {
        const { fn, totalCalls } = countingIncludesFn();

        const scope = await computeCoverageScope([], fn, noOverrides);

        assert.equal(totalCalls(), 0);
        assert.equal(scope.testObjects.size, 0);
        assert.equal(scope.includeObjects.size, 0);
        assert.deepEqual(scope.schemes, []);
    });
});
