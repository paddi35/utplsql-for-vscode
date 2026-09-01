import assert from 'node:assert/strict';
import { Connection } from 'oracledb';
import * as dao from '../../src/db/utplsqlDao';
import { dedupPathList, OwnedPath } from '../../src/testing/ids';
import { getTestPool, getTestConnection, closeTestPool, TEST_OWNER } from '../integration/support/db';
import { installPerfFixtureObjects, generatePerfFixture, dropPerfFixture, setSleepScale } from './support/perfFixture';
import { runPathsAndCollect } from '../integration/support/runProfile';
import { timed, recordMeasurement } from './support/timing';

/**
 * On-demand only, same reasoning as discovery.perf.test.ts. Reproduces the
 * real "Run All" flow end to end against the 1000-package/~15,000-test perf
 * fixture: discover every suite/test path (dao.getSuitesInfo, as
 * controller.ts does), reduce the full selection down to the top-level
 * paths ut_runner.run actually needs (dedupPathList, as
 * runHandler.ts's groupRequest does -- see
 * test/unit/dedupPathList.perf.test.ts for that step's own CPU cost in
 * isolation), then stream the run the same way runOneProfile() does
 * (test/integration/support/runProfile.ts).
 *
 * Run at sleep_scale=0 ("tree" mode -- see perfFixture.sql/docs/performance.md):
 * every generated test's own sleep collapses to ~0s, so the measured wall
 * time is (close to) pure event-streaming overhead -- one DB round-trip per
 * pre-/post- event at fetchArraySize=1 (src/db/realtimeDao.ts's
 * openConsumer doc comment explains why that fetch size is mandatory for
 * live streaming) across ~30,000+ events for ~15,000 tests. That overhead,
 * not test execution time, is what this measures.
 */
describe('a full run at 1000-package scale, sleep_scale=0 [perf]', function () {
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

    it('streams every pre-/post- event for the whole fixture without dropping any', async () => {
        const rows = await dao.getSuitesInfo(conn, TEST_OWNER);
        const perfRows = rows.filter((r) => r.objectName.startsWith('UT_PERF_TEST_'));

        const allPaths: OwnedPath[] = perfRows.map((r) => ({ owner: TEST_OWNER, suitepath: r.path }));
        const runPaths = dedupPathList(allPaths).map((p) => `${p.owner}:${p.suitepath}`);
        // A handful of top-level entries: one per package not inside a
        // --%suitepath group, plus one per top-level suitepath group (see
        // perfFixture.sql) -- everything else collapses away as covered.
        assert.ok(runPaths.length > 0 && runPaths.length < perfRows.length, `expected dedup to collapse ${perfRows.length} rows to a small top-level set, got ${runPaths.length}`);

        const pool = await getTestPool();
        const producerConn = await pool.getConnection();
        const consumerConn = await pool.getConnection();
        let events: Awaited<ReturnType<typeof runPathsAndCollect>>['events'];
        try {
            const { result, ms } = await timed(() => runPathsAndCollect(producerConn, consumerConn, runPaths));
            events = result.events;
            const postTestCount = events.filter((e) => e.event.type === 'post-test').length;
            const eventsPerSecond = events.length / (ms / 1000);
            recordMeasurement({
                name: 'run(1000 packages, sleep_scale=0)',
                unit: 'ms',
                value: ms,
                meta: { totalEvents: events.length, postTestCount, eventsPerSecond, runPathCount: runPaths.length }
            });
        } finally {
            await producerConn.close();
            await consumerConn.close();
        }

        const testCount = perfRows.filter((r) => r.itemType === 'UT_TEST').length;
        const postTestEvents = events.filter((e) => e.event.type === 'post-test');
        assert.equal(postTestEvents.length, testCount, `expected one post-test event per discovered test (${testCount}), got ${postTestEvents.length}`);

        const postRun = events.find((e) => e.event.type === 'post-run');
        assert.ok(postRun, 'expected a post-run event to close out the run');
        const counter = (postRun!.event as { counter: { success: number; failure: number; error: number; disabled: number } }).counter;
        assert.equal(counter.success + counter.failure + counter.error + counter.disabled, testCount);

        // The outcome mix baked in by perfFixture.sql: ~75% pass, ~10% fail,
        // ~5% error, ~10% disabled. Loose bounds (not exact percentages) --
        // this asserts the fixture is wired up end to end, not the RNG.
        assert.ok(counter.success / testCount > 0.65, `expected most tests to pass, got ${counter.success}/${testCount}`);
        assert.ok(counter.disabled / testCount > 0.03, `expected some disabled tests, got ${counter.disabled}/${testCount}`);
        assert.ok(counter.failure > 0, 'expected at least one failing test');
        assert.ok(counter.error > 0, 'expected at least one errored test');
    });
});
