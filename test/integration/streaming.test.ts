import assert from 'node:assert/strict';
import { Connection } from 'oracledb';
import { getTestPool, closeTestPool, TEST_OWNER } from './support/db';
import { installFixture } from './support/fixture';
import { runPathsAndCollect } from './support/runProfile';

/**
 * The "Streaming-Spike" from the plan's open points: fetchArraySize=1 must
 * make events arrive live as each test finishes, not bundled at the end
 * once the whole ut_runner.run block returns. test_slow (fixture.sql) sleeps
 * ~2s so a bundled implementation and a streaming one are trivially
 * distinguishable by wall-clock arrival time — this is the
 * RealtimeReporterFetchSizeTest.delayFreeStreamingConsumtion() equivalent
 * the plan asks for, driven against a real utPLSQL instance instead of a
 * mock.
 */
describe('realtime event streaming is live, not bundled [integration]', function () {
    this.timeout(30000);
    let producerConn: Connection;
    let consumerConn: Connection;

    before(async () => {
        const pool = await getTestPool();
        producerConn = await pool.getConnection();
        consumerConn = await pool.getConnection();
        await installFixture(producerConn);
    });

    after(async () => {
        await producerConn.close();
        await consumerConn.close();
        await closeTestPool();
    });

    it('delivers the pre-test/post-test pair for a 2s test ~2s apart, not all at once at the end', async () => {
        const { events } = await runPathsAndCollect(producerConn, consumerConn, [`${TEST_OWNER}:test_calc_pkg`]);

        const preSlow = events.find((e) => e.event.type === 'pre-test' && (e.event as { test: { id: string } }).test.id === 'test_calc_pkg.test_slow');
        const postSlow = events.find((e) => e.event.type === 'post-test' && (e.event as { id: string }).id === 'test_calc_pkg.test_slow');
        assert.ok(preSlow && postSlow);

        const gapMs = postSlow!.elapsedMs - preSlow!.elapsedMs;
        assert.ok(gapMs >= 1800, `expected the post-test event for test_slow to arrive ~2s after its pre-test event, got a ${gapMs}ms gap`);

        // If events were bundled at the end instead of streamed, every event
        // — including the four tests that run (and finish) before test_slow
        // even starts — would arrive clustered around the same timestamp as
        // the final post-run event. Streamed, they land right after
        // pre-test.test_slow instead, roughly 2s before post-run.
        // (test_nested runs *after* test_slow per the fixture's suite order,
        // so it is deliberately excluded here — its own event lands close to
        // post-run regardless of streaming.)
        const fastTestIds = ['test_calc_pkg.test_add', 'test_calc_pkg.test_fail_on_purpose', 'test_calc_pkg.test_raises_error', 'test_calc_pkg.test_disabled_case'];
        const fastTestEvents = events.filter((e) => e.event.type === 'post-test' && fastTestIds.includes((e.event as { id: string }).id));
        assert.equal(fastTestEvents.length, fastTestIds.length);
        // Measured against postSlow rather than preSlow, and as a gap rather
        // than a strict ordering: test_disabled_case is skipped, so its
        // post-test event and the pre-test event for test_slow that follows
        // it routinely land in the same millisecond, which made
        // `e.elapsedMs < preSlow.elapsedMs` fail roughly two runs in three
        // even though the order was right. The 2s gap to postSlow is what
        // actually distinguishes streamed events from bundled ones — if the
        // cursor delivered everything at the end, these would arrive
        // alongside postSlow, not ~2s before it.
        for (const e of fastTestEvents) {
            const leadMs = postSlow!.elapsedMs - e.elapsedMs;
            assert.ok(
                leadMs >= 1800,
                `expected ${(e.event as { id: string }).id} to have finished ~2s before test_slow did, got a ${leadMs}ms lead (elapsedMs=${e.elapsedMs}, post-test.test_slow=${postSlow!.elapsedMs})`
            );
        }
    });
});
