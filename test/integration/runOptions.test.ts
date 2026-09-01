import assert from 'node:assert/strict';
import { Connection } from 'oracledb';
import { getTestPool, closeTestPool, TEST_OWNER } from './support/db';
import { installFixture } from './support/fixture';
import { runPathsAndCollect } from './support/runProfile';

/**
 * Exercises the two run options this milestone wires from
 * src/db/realtimeDao.ts's buildProduceSql() all the way through a real
 * ut_runner.run() call: a_tags (utplsql.runWithTags) and
 * a_random_test_order/a_random_test_order_seed (utplsql.run.randomOrder*).
 * Both were previously built by buildProduceSql but never actually passed
 * by any caller — see runHandler.ts's RunOneProfileOptions.
 */
describe('a_tags and a_random_test_order against a real schema [integration]', function () {
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

    it('a_tags narrows a whole-suite run down to only the tagged test', async () => {
        const { events } = await runPathsAndCollect(producerConn, consumerConn, [`${TEST_OWNER}:test_calc_pkg`], {
            tags: ['slow']
        });
        const preRun = events.find((e) => e.event.type === 'pre-run');
        assert.ok(preRun);
        assert.equal((preRun!.event as { totalNumberOfTests: number }).totalNumberOfTests, 1);

        const postTests = events.map((e) => e.event).filter((e): e is Extract<typeof e, { type: 'post-test' }> => e.type === 'post-test');
        assert.equal(postTests.length, 1);
        assert.equal(postTests[0].id, 'test_calc_pkg.test_slow');
    });

    it('a_tags with a tag no test carries raises ORA-20204, same as an unmatched suite path', async () => {
        // Confirmed against a live utPLSQL 3.2.3 instance: ut_runner.run
        // does not just run zero tests when a_tags excludes everything in
        // scope, it raises the same "no suite packages found" error as an
        // unmatched a_paths entry. runOneProfile (runHandler.ts) already
        // surfaces a producer failure like this as an errored TestItem, so
        // this documents the exception rather than a silent empty run.
        await assert.rejects(
            runPathsAndCollect(producerConn, consumerConn, [`${TEST_OWNER}:test_calc_pkg`], { tags: ['does_not_exist'] }),
            /ORA-20204/
        );
    });

    it('the same a_random_test_order_seed reproduces the identical test execution order', async () => {
        const runOnce = () =>
            runPathsAndCollect(producerConn, consumerConn, [`${TEST_OWNER}:test_calc_pkg`], {
                randomOrder: true,
                seed: 12345
            }).then(({ events }) =>
                events
                    .map((e) => e.event)
                    .filter((e): e is Extract<typeof e, { type: 'pre-test' }> => e.type === 'pre-test')
                    .map((e) => e.test.id)
            );

        const first = await runOnce();
        const second = await runOnce();

        assert.equal(first.length, 6);
        assert.deepEqual(second, first, 'the same seed should produce the same test order both times');
    });
});
