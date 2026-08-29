import assert from 'node:assert/strict';
import { Connection } from 'oracledb';
import { escalateStatus } from '../../src/model/tree';
import { getTestPool, closeTestPool, TEST_OWNER } from './support/db';
import { installFixture } from './support/fixture';
import { runPathsAndCollect } from './support/runProfile';

/**
 * Runs the full fixture suite through the real produce/consume realtime
 * protocol and checks the plan's checklist item: "Ein Lauf über eine Suite
 * mit Erfolg, Failure, Error und disabled-Test setzt alle vier
 * TestRun-Zustände korrekt." (escalateStatus() is the pure function
 * src/testing/runHandler.ts uses to turn a post-test/post-suite Counter into
 * one of those four states — vscode.TestRun itself can't be driven outside
 * the extension host, so this asserts on the same counters/escalation logic
 * runHandler.ts feeds into it.)
 */
describe('running the fixture suite end-to-end [integration]', function () {
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

    it('reports pre-run totalNumberOfTests matching the fixture', async () => {
        const { events } = await runPathsAndCollect(producerConn, consumerConn, [`${TEST_OWNER}:test_calc_pkg`]);
        const preRun = events.find((e) => e.event.type === 'pre-run');
        assert.ok(preRun);
        assert.equal((preRun!.event as { totalNumberOfTests: number }).totalNumberOfTests, 6);
    });

    it('produces all four TestRun states via escalateStatus, one test each', async () => {
        const { events } = await runPathsAndCollect(producerConn, consumerConn, [`${TEST_OWNER}:test_calc_pkg`]);
        const postTests = events
            .map((e) => e.event)
            .filter((e): e is Extract<typeof e, { type: 'post-test' }> => e.type === 'post-test');

        assert.equal(postTests.length, 6);
        const statusById = new Map(postTests.map((e) => [e.id, escalateStatus(e.counter)]));

        assert.equal(statusById.get('test_calc_pkg.test_add'), 'passed');
        assert.equal(statusById.get('test_calc_pkg.test_fail_on_purpose'), 'failed');
        assert.equal(statusById.get('test_calc_pkg.test_raises_error'), 'errored');
        assert.equal(statusById.get('test_calc_pkg.test_disabled_case'), 'skipped');
        assert.equal(statusById.get('test_calc_pkg.test_slow'), 'passed');
        assert.equal(statusById.get('test_calc_pkg.nested_context_#1.test_nested'), 'passed');

        const failed = postTests.find((e) => e.id === 'test_calc_pkg.test_fail_on_purpose')!;
        assert.equal(failed.failedExpectations.length, 1);
        assert.match(failed.failedExpectations[0].message, /was expected to equal/);
    });

    it('rolls the same counters up into the post-run summary', async () => {
        const { events } = await runPathsAndCollect(producerConn, consumerConn, [`${TEST_OWNER}:test_calc_pkg`]);
        const postRun = events.find((e) => e.event.type === 'post-run');
        assert.ok(postRun);
        const counter = (postRun!.event as { counter: { success: number; failure: number; error: number; disabled: number } }).counter;
        assert.deepEqual(counter, { success: 3, failure: 1, error: 1, disabled: 1, warning: 0 });
    });

    it('scopes a run to a single test path without running the rest of the suite', async () => {
        const { events } = await runPathsAndCollect(producerConn, consumerConn, [`${TEST_OWNER}:test_calc_pkg.test_add`]);
        const postTests = events.map((e) => e.event).filter((e) => e.type === 'post-test');
        assert.equal(postTests.length, 1);
        assert.equal((postTests[0] as { id: string }).id, 'test_calc_pkg.test_add');
    });
});
