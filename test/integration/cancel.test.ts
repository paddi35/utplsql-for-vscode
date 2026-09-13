import assert from 'node:assert/strict';
import { Connection } from 'oracledb';
import { buildProduceSql, cancelConsumer, newReporterId, openConsumer, streamRows } from '../../src/db/realtimeDao';
import { parseEvent } from '../../src/model/eventParser';
import { CancellationSignal, runWithReporter } from '../../src/db/reporterDao';
import { getTestPool, recycleTestPool, closeTestPool, canReadSessionView, TEST_OWNER } from './support/db';
import { installFixture } from './support/fixture';
import { installPerfFixtureObjects, generatePerfFixture, dropPerfFixture, setSleepScale } from '../perf/support/perfFixture';

/**
 * The plan's checklist item: "Abbruch während eines langlaufenden Tests
 * beendet den TestRun und lässt keine Verbindung im Pool zurück." Two real
 * bugs surfaced while building this test against a live utPLSQL 3.2.3
 * instance (both fixed in src/, see their doc comments):
 *
 *  - realtimeDao.streamRows() used to let the NJS-018 ("invalid ResultSet")
 *    that cancelConsumer()'s break()+drop leaves on the next getRow() call
 *    propagate out of the for-await loop instead of ending the stream
 *    cleanly.
 *  - Connection.break() (node-oracledb 6.10 Thin mode) poisons the *whole
 *    pool* it was called through, not just the broken connection: every
 *    later connection obtained from that same pool fails its very first
 *    statement with ORA-01013 ("User requested cancel of current
 *    operation"), even though the broken connection itself was already
 *    closed with drop:true. src/db/pool.ts's recyclePool() works around
 *    this by dropping and recreating the cached pool after a cancellation;
 *    this test reproduces the same drop-and-recreate step directly (via
 *    recycleTestPool(), db/pool.ts itself cannot be imported outside the
 *    extension host since it needs vscode.SecretStorage).
 */
describe('cancelling a run does not leak or poison the connection pool [integration]', function () {
    this.timeout(30000);

    afterEach(async () => {
        await closeTestPool();
    });

    it('cancelConsumer() ends the event stream cleanly instead of throwing NJS-018', async () => {
        const pool = await getTestPool();
        const producerConn = await pool.getConnection();
        const consumerConn = await pool.getConnection();
        await installFixture(producerConn);

        const id = newReporterId();
        const rs = await openConsumer(consumerConn, id);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const produced = buildProduceSql(id, [`${TEST_OWNER}:test_calc_pkg`]);
        const producePromise = producerConn.execute(produced.sql);

        const received: string[] = [];
        for await (const row of streamRows(rs)) {
            received.push(row.itemType);
            const event = parseEvent(row.itemType, row.text);
            if (event?.type === 'pre-test' && event.test.id === 'test_calc_pkg.test_slow') {
                // Cancel mid-flight, before the 2s test_slow finishes.
                await cancelConsumer(consumerConn);
            }
        }

        assert.ok(received.includes('pre-test'), 'expected to have received at least one event before cancelling');
        assert.ok(!received.slice(received.indexOf('pre-test') + 1).includes('post-run'), 'expected the stream to end before post-run, i.e. actually cancelled');

        // The DB session keeps running server-side by design (see
        // cancelConsumer()'s doc comment) — wait for it so it doesn't leak
        // into the next test.
        await producePromise;
        await producerConn.close();
    });

    it('a pool poisoned by break() is unusable until recycled, and healthy again afterward', async () => {
        const pool = await getTestPool();
        const consumerConn = await pool.getConnection();
        await cancelConsumer(consumerConn); // break() + close({drop:true}) on an idle connection is enough to poison the pool

        const poisoned = await pool.getConnection();
        await assert.rejects(
            () => poisoned.execute('SELECT 1 FROM dual'),
            /ORA-01013/,
            'expected the pool to still be poisoned before recycling — if this fails, node-oracledb no longer has this bug and recyclePool() may be removable'
        );
        await poisoned.close({ drop: true });

        await recycleTestPool();

        const fresh = await (await getTestPool()).getConnection();
        const result = await fresh.execute<{ '1': number }>('SELECT 1 FROM dual');
        assert.equal(result.rows?.length, 1);
        await fresh.close();
    });

    it('running to completion normally (no cancellation) leaves the pool healthy for the next run', async () => {
        const pool = await getTestPool();
        const conn = await pool.getConnection();
        const result = await conn.execute<{ '1': number }>('SELECT 1 FROM dual');
        assert.equal(result.rows?.length, 1);
        await conn.close();
    });
});

/**
 * Minimal fake of vscode.CancellationToken for driving runWithReporter's
 * cancellation from a plain integration test — this suite runs outside the
 * extension host for the same reason support/db.ts's pool bypasses
 * src/db/pool.ts (see that file's own doc comment), so a real
 * vscode.CancellationTokenSource is not available here either.
 */
function fakeToken(): { signal: CancellationSignal; cancel: () => void } {
    let cancelled = false;
    let listener: (() => void) | undefined;
    return {
        signal: {
            get isCancellationRequested() {
                return cancelled;
            },
            onCancellationRequested(l: () => void) {
                listener = l;
                return { dispose: () => (listener = undefined) };
            }
        },
        cancel: () => {
            cancelled = true;
            listener?.();
        }
    };
}

/**
 * A session is identified by sid *and* serial#, never by sid alone:
 * Oracle hands a freed sid straight to the next session that logs on, so
 * a sid-only check reports a long-gone session as "still there" as soon
 * as anything else -- the checking connection included -- lands in the
 * same slot.
 */
interface SessionId {
    sid: number;
    serial: number;
}

async function currentSession(conn: Connection): Promise<SessionId> {
    const result = await conn.execute<{ SID: number; SERIAL: number }>(
        `SELECT sid AS SID, serial# AS SERIAL FROM v$session WHERE sid = SYS_CONTEXT('USERENV', 'SID')`
    );
    const row = result.rows?.[0];
    assert.ok(row, "expected v$session to report the calling connection's own session");
    return { sid: Number(row!.SID), serial: Number(row!.SERIAL) };
}

/** Polls v$session rather than checking once: PMON's cleanup of a dropped session is not guaranteed instantaneous. */
async function sessionsStillPresent(conn: Connection, sessions: SessionId[], timeoutMs = 10000): Promise<SessionId[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const result = await conn.execute<{ SID: number; SERIAL: number }>(
            `SELECT sid AS SID, serial# AS SERIAL FROM v$session WHERE (sid, serial#) IN (${sessions
                .map((_, i) => `(:s${i}, :n${i})`)
                .join(', ')})`,
            Object.fromEntries(sessions.flatMap((s, i) => [[`s${i}`, s.sid] as const, [`n${i}`, s.serial] as const]))
        );
        const remaining = (result.rows ?? []).map((r) => ({ sid: Number(r.SID), serial: Number(r.SERIAL) }));
        if (remaining.length === 0 || Date.now() > deadline) {
            return remaining;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}

/**
 * Issue #24: the export path (utplsql.runWithReporter / "Export with
 * Reporter") used to have no way to interrupt a running export short of
 * waiting out the consumer's full 3600s a_timeout_sec. The fix
 * (src/db/reporterDao.ts's runWithReporter) mirrors runOneProfile's own
 * cancellation closely enough that it hits exactly the same pool-poisoning
 * failure mode verified above for the run path: cancelConsumer()'s break()
 * poisons the whole pool, not just the export's own connections, until
 * recyclePool() runs.
 *
 * Uses the perf fixture's "slow" tier (test/perf/support/perfFixture.ts)
 * rather than the tiny regular fixture's single 2s test_slow: a suite that
 * takes tens of seconds to run to completion makes "cancel after ~1s"
 * observably different from "let it run out", which is the scenario the
 * issue is actually worried about (a large export, not a handful of tests).
 * A small package count keeps generating it fast — this is not the
 * dedicated 1000-package/20-minute perf suite (test/perf/run.perf.test.ts).
 */
describe('cancelling a reporter export does not leak or poison the connection pool [integration]', function () {
    this.timeout(180000);
    before(async () => {
        const setupConn = await (await getTestPool()).getConnection();
        try {
            await installPerfFixtureObjects(setupConn);
            await generatePerfFixture(setupConn, { packages: 3, seed: 42 });
            await setSleepScale(setupConn, 1); // full 2-10s "slow" tier, see perfFixture.sql
        } finally {
            await setupConn.close();
        }
    });

    /**
     * Deliberately takes a *fresh* connection rather than reusing one held
     * since before(): both tests here cancel an export and then call
     * recycleTestPool(), whose pool.close(0) force-closes every one of that
     * pool's connections -- including any the suite was still holding. A
     * teardown built on such a connection fails with NJS-500 ("connection
     * to Oracle Database was closed or broken") no matter what it does.
     */
    after(async () => {
        const teardownConn = await (await getTestPool()).getConnection();
        try {
            await dropPerfFixture(teardownConn);
            await setSleepScale(teardownConn, 0);
        } finally {
            await teardownConn.close();
            await closeTestPool();
        }
    });

    it('cancelling ~1s into an export returns well under the 3600s consumer timeout, and a following export on the same profile still succeeds', async () => {
        const pool = await getTestPool();
        const { signal, cancel } = fakeToken();
        const producerConn = await pool.getConnection();
        const consumerConn = await pool.getConnection();

        const start = Date.now();
        setTimeout(() => cancel(), 1000);
        const result = await runWithReporter(producerConn, consumerConn, 'ut_documentation_reporter', [TEST_OWNER], {}, signal);
        const elapsedMs = Date.now() - start;

        assert.equal(result.cancelled, true);
        // Generous on purpose: the producer keeps running to completion by
        // design (cancelConsumer()'s doc comment), so the call only returns
        // once it does, not the instant cancel() fires. What matters is that
        // this is nowhere near the 3600s consumer timeout the issue is about.
        assert.ok(elapsedMs < 300000, `expected cancellation to avoid the 3600s consumer timeout entirely, took ${elapsedMs}ms`);

        await producerConn.close().catch(() => undefined);
        // Already broken+drop-closed by runWithReporter's cancelConsumer().
        await consumerConn.close().catch(() => undefined);
        await recycleTestPool();

        // The exact failure mode recyclePool() exists for: without it, this
        // second export — on a profile that never touched the cancelled
        // connections itself — would fail with ORA-01013.
        const pool2 = await getTestPool();
        const producerConn2 = await pool2.getConnection();
        const consumerConn2 = await pool2.getConnection();
        try {
            const second = await runWithReporter(producerConn2, consumerConn2, 'ut_documentation_reporter', [`${TEST_OWNER}:test_calc_pkg.test_add`]);
            assert.match(second.output, /adds two numbers correctly/);
        } finally {
            await producerConn2.close();
            await consumerConn2.close();
        }
    });

    it('leaves no session behind in v$session for either connection after a cancelled export', async function () {
        const pool = await getTestPool();
        const { signal, cancel } = fakeToken();
        const producerConn = await pool.getConnection();
        const consumerConn = await pool.getConnection();
        if (!(await canReadSessionView(producerConn))) {
            // No v$session grant here -- see canReadSessionView().
            await producerConn.close();
            await consumerConn.close();
            this.skip();
        }
        const producerSession = await currentSession(producerConn);
        const consumerSession = await currentSession(consumerConn);

        setTimeout(() => cancel(), 1000);
        await runWithReporter(producerConn, consumerConn, 'ut_documentation_reporter', [TEST_OWNER], {}, signal);

        await producerConn.close().catch(() => undefined);
        await consumerConn.close().catch(() => undefined);
        // recyclePool()'s pool.close(0) is what actually tears down the
        // producer's now-idle pooled session — a plain close() only returns
        // it to the pool, it does not by itself end the session.
        await recycleTestPool();

        const checkConn = await (await getTestPool()).getConnection();
        try {
            const remaining = await sessionsStillPresent(checkConn, [producerSession, consumerSession]);
            assert.deepEqual(remaining, [], `expected neither session to remain in v$session, still found: ${JSON.stringify(remaining)}`);
        } finally {
            await checkConn.close();
        }
    });
});
