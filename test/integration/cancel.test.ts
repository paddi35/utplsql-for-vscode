import assert from 'node:assert/strict';
import { buildProduceSql, cancelConsumer, newReporterId, openConsumer, streamRows } from '../../src/db/realtimeDao';
import { parseEvent } from '../../src/model/eventParser';
import { getTestPool, recycleTestPool, closeTestPool, TEST_OWNER } from './support/db';
import { installFixture } from './support/fixture';

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
