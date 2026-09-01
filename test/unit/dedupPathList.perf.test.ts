import assert from 'node:assert/strict';
import { dedupPathList, OwnedPath } from '../../src/testing/ids';
import { timed, recordMeasurement } from '../perf/support/timing';

/**
 * CPU-only regression guard for dedupPathList (src/testing/ids.ts), run as
 * part of the normal unit suite (no DB needed) so a regression here shows
 * up on every push/PR rather than only in the DB-backed perf suite under
 * test/perf, which is on-demand only (see .github/workflows/performance.yml).
 *
 * "Run All" on a 1000-package/~15,000-test tree (see
 * test/perf/support/perfFixture.sql) selects every path-bearing TestItem --
 * suites, contexts *and* tests, ~16,000+ entries -- into groupRequest()'s
 * `paths` array (src/testing/runHandler.ts), which dedupPathList() then has
 * to reduce down to just the top-level, non-overlapping ones.
 * dedupPathList's current implementation is `unique.filter(c =>
 * unique.some(isCoveredBy))`: O(n^2) in the number of selected paths.
 *
 * This test builds a representative (smaller-scale, so it stays fast on the
 * critical path) shape of that same tree and only asserts (a) correctness
 * and (b) a generous ceiling that today's O(n^2) implementation still
 * clears comfortably -- it is a timing *measurement*, not a tight
 * regression gate (see docs/performance.md), so it stays green whether or
 * not dedupPathList has been optimized yet.
 */
describe('dedupPathList at scale', () => {
    it('reduces a large Run-All-shaped selection to just its top-level paths, without hanging', async () => {
        const owner = 'UT3';
        const paths: OwnedPath[] = [];
        const topLevelSuitepaths: string[] = [];

        const packages = 500; // representative subset of the full 1000-package fixture; see perfFixture.sql
        for (let pkg = 1; pkg <= packages; pkg++) {
            const suite = `ut_perf_test_${String(pkg).padStart(4, '0')}`;
            paths.push({ owner, suitepath: suite });
            topLevelSuitepaths.push(suite);

            const testCount = 10 + (pkg % 11); // 10..20, mirrors ut_perf_gen.generate()'s per-package range
            const hasContext = pkg % 5 === 0;
            for (let t = 1; t <= testCount; t++) {
                const test = `test_${String(t).padStart(2, '0')}`;
                if (hasContext && t === testCount) {
                    paths.push({ owner, suitepath: `${suite}.nested_context_#1` });
                    paths.push({ owner, suitepath: `${suite}.nested_context_#1.${test}` });
                } else {
                    paths.push({ owner, suitepath: `${suite}.${test}` });
                }
            }
        }

        const { result, ms } = await timed(() => Promise.resolve(dedupPathList(paths)));

        const resultSuitepaths = result.map((p) => p.suitepath).sort();
        assert.deepEqual(resultSuitepaths, [...topLevelSuitepaths].sort(), 'expected dedup to keep exactly the top-level suite paths');

        recordMeasurement({
            name: 'dedupPathList',
            unit: 'ms',
            value: ms,
            meta: { inputSize: paths.length, packages }
        });

        // Generous on purpose -- see the doc comment above. Tightening this
        // is the job of the (separate) O(n^2) fix, not this test.
        assert.ok(ms < 10000, `dedupPathList took ${ms.toFixed(0)}ms for ${paths.length} paths, expected well under 10s`);
    });
});
