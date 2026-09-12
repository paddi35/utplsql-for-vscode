import assert from 'node:assert/strict';
import { Connection } from 'oracledb';
import * as dao from '../../src/db/utplsqlDao';
import { getTestConnection, closeTestPool, TEST_OWNER } from '../integration/support/db';
import { installPerfFixtureObjects, generatePerfFixture, dropPerfFixture, setSleepScale, PERF_PACKAGE_PREFIX } from './support/perfFixture';
import { timed, recordMeasurement, median, p95 } from './support/timing';

/**
 * On-demand only (see .github/workflows/performance.yml, mirroring
 * test/integration's separation from the push/PR critical path): needs the
 * same local Oracle+utPLSQL instance as the integration suite, plus a few
 * minutes to generate the 1000-package/~15,000-test fixture once. Measures
 * the DB side of the Test Explorer tree build -- dao.getSuitesInfo()
 * (controller.ts's fetchSuiteRows) and dao.getPackageObjectTypes()
 * (controller.ts's resolveVirtualTypes, used for every discovered package
 * with no matching local workspace source, which for this fixture -- a
 * pure DB fixture with no .sql files -- is all 1000 of them).
 *
 * sleep_scale is set to 0 for the whole suite: discovery never runs a
 * single test, so it is unaffected by it, and leaving it at the default
 * keeps this suite's own runtime independent of whatever scale a prior
 * test/perf/run.perf.test.ts run left behind.
 */
describe('discovery at 1000-package scale [perf]', function () {
    this.timeout(20 * 60 * 1000);
    let conn: Connection;

    before(async () => {
        conn = await getTestConnection();
        await installPerfFixtureObjects(conn);
        const { ms } = await timed(() => generatePerfFixture(conn, { packages: 1000, seed: 42 }));
        recordMeasurement({ name: 'generatePerfFixture(1000 packages)', unit: 'ms', value: ms });
        await setSleepScale(conn, 0);
    });

    after(async () => {
        await dropPerfFixture(conn);
        await conn.close();
        await closeTestPool();
    });

    it('getSuitesInfo returns the full ~15,000-test tree and completes in a bounded time', async () => {
        const samples: number[] = [];
        let rowCount = 0;
        for (let i = 0; i < 3; i++) {
            const { result, ms } = await timed(() => dao.getSuitesInfo(conn, TEST_OWNER));
            samples.push(ms);
            rowCount = result.filter((r) => r.objectName.startsWith(PERF_PACKAGE_PREFIX)).length;
        }
        recordMeasurement({
            name: 'getSuitesInfo(1000 packages)',
            unit: 'ms',
            value: median(samples),
            samples,
            meta: { p95: p95(samples), rowCount }
        });

        // 1000 packages x >=10 tests each, plus one UT_SUITE row per package
        // and a UT_SUITE_CONTEXT row for the ~20% of packages that nest one
        // (see perfFixture.sql) -- comfortably over 11,000 regardless of the
        // exact per-package test count the seed happened to draw.
        assert.ok(rowCount > 11000, `expected > 11000 suite-info rows for the 1000-package perf fixture, got ${rowCount}`);

        // Generous on purpose, same reasoning as dedupPathList.perf.test.ts:
        // a measurement, not a tight regression gate (see docs/performance.md).
        assert.ok(median(samples) < 60000, `getSuitesInfo took ${median(samples).toFixed(0)}ms median, expected well under 60s`);
    });

    it('getPackageObjectTypes resolves every package with no local workspace source in one batched call', async () => {
        const names = Array.from({ length: 1000 }, (_, i) => `${PERF_PACKAGE_PREFIX}${String(i + 1).padStart(4, '0')}`);

        const { result, ms } = await timed(() => dao.getPackageObjectTypes(conn, TEST_OWNER, names));
        recordMeasurement({ name: 'getPackageObjectTypes(1000 names)', unit: 'ms', value: ms, meta: { names: names.length } });

        // getPackageObjectTypes builds `object_name IN (:n0, :n1, ...)` with
        // one BIND VARIABLE per name (src/db/utplsqlDao.ts) rather than
        // inlining literals -- confirmed against a live Oracle 23ai
        // instance that this does NOT hit ORA-01795 ("maximum number of
        // expressions in a list is 1000"), even well past 1000 (tested up
        // to 5000 bind variables in one IN-list). That limit is specific to
        // *literal* IN-lists; this call is unaffected by it at the 1000
        // packages this extension asks for, or considerably beyond.
        assert.equal(result.size, 1000, `expected all 1000 UT_PERF_TEST_* packages to resolve to a PACKAGE BODY, got ${result.size}`);
        for (const type of result.values()) {
            assert.equal(type, 'PACKAGE BODY');
        }
    });
});
