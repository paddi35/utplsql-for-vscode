import assert from 'node:assert/strict';
import { Connection } from 'oracledb';
import { escalateStatus } from '../../src/model/tree';
import { buildProduceSql, newReporterId } from '../../src/db/realtimeDao';
import { formatProduceSqlLine, formatRunFailureLines, formatRunPathsLine, summarizeRun } from '../../src/testing/runLogging';
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

    /**
     * Issue #23: runOneProfile()'s pre-run output-channel logging must stay
     * bounded on the untraced (default) path and only grow with the full
     * a_paths/produce-SQL detail behind utplsql.trace. runHandler.ts itself
     * can't be exercised here (it imports 'vscode', see support/db.ts's own
     * comment on the same constraint), so this reproduces exactly what
     * runOneProfile writes to ctx.output — summarizeRun() unconditionally,
     * formatRunPathsLine()/formatProduceSqlLine() only under trace() — using
     * the real formatters against a real produce SQL from a real run of the
     * fixture, rather than asserting on the formatters in isolation the way
     * test/unit/runLogging.test.ts does.
     */
    it('keeps the untraced pre-run output to a single bounded summary line', async () => {
        const runPaths = [`${TEST_OWNER}:test_calc_pkg`];
        const selectedItems = [{ id: `conn:it/path:${TEST_OWNER}:test_calc_pkg` }];

        const { events } = await runPathsAndCollect(producerConn, consumerConn, runPaths);
        assert.ok(events.some((e) => e.event.type === 'post-run'), 'sanity check: the run this test double-checks the logging shape for must actually complete');

        const traceEnabled = false;
        const output: string[] = [summarizeRun('it', runPaths, selectedItems)];
        if (traceEnabled) {
            output.push(formatRunPathsLine('it', runPaths, selectedItems));
        }

        assert.deepEqual(output, ["utPLSQL: running 1 path(s) for 'it' (1 selected item(s))"]);
        assert.ok(!output.some((l) => l.includes('run paths for')));
        assert.ok(!output.some((l) => l.includes('produce SQL:')));
    });

    it('adds the detailed run-paths line and the produce SQL, byte-identical to the SQL actually executed, when tracing is on', async () => {
        const runPaths = [`${TEST_OWNER}:test_calc_pkg`];
        const selectedItems = [{ id: `conn:it/path:${TEST_OWNER}:test_calc_pkg` }];

        // `produced` here is the exact ProduceSql this call sent to
        // producerConn (see support/runProfile.ts) — comparing against it,
        // not against a second, separately built buildProduceSql() call,
        // is what makes the byte-identical assertion below meaningful: a
        // second call would embed a different, freshly generated reporter
        // id and therefore never match byte-for-byte regardless of whether
        // formatProduceSqlLine is correct.
        const { events, produced } = await runPathsAndCollect(producerConn, consumerConn, runPaths);
        assert.ok(events.some((e) => e.event.type === 'post-run'));

        const traceEnabled = true;
        const output: string[] = [summarizeRun('it', runPaths, selectedItems)];
        if (traceEnabled) {
            output.push(formatRunPathsLine('it', runPaths, selectedItems), formatProduceSqlLine(produced.sql));
        }

        assert.equal(output.length, 3);
        assert.ok(output[1].includes(selectedItems[0].id), 'expected the detailed run-paths line to include the selected item id');
        assert.equal(output[2], `utPLSQL: produce SQL:\n${produced.sql}`, "the logged SQL must be byte-identical to buildProduceSql's actual output for this run");
    });

    it('logs the produce SQL in the failure path even with tracing off, for a deliberately invalid path', async () => {
        // Same failure utplsql.runWithTags hits when a_tags excludes
        // everything in scope (runOptions.test.ts's "raises ORA-20204, same
        // as an unmatched suite path") — confirmed there against a live
        // utPLSQL 3.2.3 instance to be a producer-side exception, not a
        // silent empty run, and fast enough to observe well within this
        // suite's 30s timeout.
        const invalidPath = `${TEST_OWNER}:this_suite_does_not_exist`;
        const id = newReporterId();
        // Pinning `id` (support/runProfile.ts's runPathsAndCollect accepts
        // it as an override) means this locally rebuilt `produced` is
        // byte-identical to what the call below actually sent — needed here
        // because, unlike the two cases above, a rejected call never gets a
        // chance to return its own `produced` from inside RunResult.
        const produced = buildProduceSql(id, [invalidPath], {});

        let caught: unknown;
        try {
            await runPathsAndCollect(producerConn, consumerConn, [invalidPath], {}, id);
        } catch (err) {
            caught = err;
        }
        assert.ok(caught, 'expected the invalid path to make the producer fail');
        assert.match(String(caught), /ORA-20204/);

        // runOneProfile's catch block's exact situation: `produced` was
        // already built before the failure, so formatRunFailureLines
        // includes its SQL unconditionally — regardless of utplsql.trace,
        // which is off here (the default) and would otherwise have
        // suppressed it entirely, same as the untraced case above.
        const lines = formatRunFailureLines('it', caught, produced.sql);
        assert.equal(lines.length, 2);
        assert.equal(lines[1], `utPLSQL: produce SQL:\n${produced.sql}`);
    });
});
