import assert from 'node:assert/strict';
import { Connection } from 'oracledb';
import * as dao from '../../src/db/utplsqlDao';
import { computeCoverageScope, CoverageScopeItem } from '../../src/testing/coverageScope';
import { getTestConnection, closeTestPool, TEST_OWNER } from '../integration/support/db';
import { installPerfFixtureObjects, generatePerfFixture, dropPerfFixture, setSleepScale, PERF_PACKAGE_PREFIX } from './support/perfFixture';
import { timed, recordMeasurement } from './support/timing';

/**
 * On-demand only, same reasoning as discovery.perf.test.ts and
 * run.perf.test.ts. Closes the coverage half of docs/performance.md's "Open
 * follow-ups" ("Coverage runs (runCoverage) are still open").
 *
 * Builds the same shape buildCoverageOptions (coverage.ts) hands
 * computeCoverageScope for a "Run All with Coverage" over the whole
 * 1000-package/~15,000-test fixture: one item per suite/context/test row
 * get_suites_info returns (groupRequest selects every path-bearing
 * descendant, not just leaves), all sharing this fixture's single owner
 * (TEST_OWNER). Before issue #21's fix, that meant one *_dependencies
 * round trip per *row* -- on the order of 16,000 for this fixture. The
 * batched fix reduces that to one round trip per distinct *owner* in the
 * selection, which for this single-schema fixture is exactly 1, however
 * many thousands of rows and however many hundreds of distinct package
 * names it carries -- and that one call's `name IN (:n0, :n1, ...)` bind
 * list ends up with roughly one bind variable per distinct package (~1000),
 * the same scale discovery.perf.test.ts's getPackageObjectTypes case already
 * confirmed does not hit ORA-01795.
 */
describe('coverage scope building at 1000-package scale [perf]', function () {
    this.timeout(20 * 60 * 1000);
    let conn: Connection;

    before(async () => {
        conn = await getTestConnection();
        await installPerfFixtureObjects(conn);
        await generatePerfFixture(conn, { packages: 1000, seed: 42 });
        await setSleepScale(conn, 0);
    });

    after(async () => {
        await dropPerfFixture(conn);
        await conn.close();
        await closeTestPool();
    });

    it('batches one *_dependencies query for the whole fixture instead of one per selected suite/context/test row', async () => {
        const rows = await dao.getSuitesInfo(conn, TEST_OWNER);
        const perfRows = rows.filter((r) => r.objectName.startsWith(PERF_PACKAGE_PREFIX));
        assert.ok(perfRows.length > 11000, `expected > 11000 suite-info rows for the 1000-package perf fixture, got ${perfRows.length}`);

        const items: CoverageScopeItem[] = perfRows.map((r) => ({ owner: r.objectOwner, objectName: r.objectName }));

        let roundTrips = 0;
        const includesFn = async (owner: string, names: string[]) => {
            roundTrips++;
            return dao.includes(conn, owner, names, 'perf');
        };

        const { result: scope, ms } = await timed(() =>
            computeCoverageScope(items, includesFn, { excludeObjects: [], schemesOverride: [], includeObjectsOverride: [] })
        );
        recordMeasurement({
            name: 'computeCoverageScope(1000 packages)',
            unit: 'ms',
            value: ms,
            meta: { items: items.length, roundTrips, distinctTestObjects: scope.testObjects.size }
        });

        // The whole point of the per-owner batching: this stays at 1 no
        // matter how many of the >11,000 rows above belong to it, instead of
        // growing with item count (~16,000 before the fix) or even with
        // distinct-package count (~1000, the issue's own minimum-suggestion
        // fix level).
        assert.equal(roundTrips, 1, `expected exactly one batched dependencies query for one owner, got ${roundTrips}`);
        assert.ok(scope.testObjects.size > 0);

        // Generous on purpose, same reasoning as the other perf suites: a
        // measurement, not a tight regression gate (see docs/performance.md).
        assert.ok(ms < 60000, `computeCoverageScope took ${ms.toFixed(0)}ms, expected well under 60s`);
    });
});
