import assert from 'node:assert/strict';
import { Connection } from 'oracledb';
import { runWithReporter } from '../../src/db/reporterDao';
import * as dao from '../../src/db/utplsqlDao';
import { getTestPool, closeTestPool, TEST_OWNER } from './support/db';
import { installFixture } from './support/fixture';

/**
 * The plan's checklist item: "Reporter-Export mit ut_documentation_reporter
 * erzeugt dieselbe Ausgabe wie utplsql run … -f=ut_documentation_reporter."
 * Exercises utplsql.runWithReporter's DAO (src/db/reporterDao.ts) end to end
 * against a real utPLSQL instance.
 */
describe('reporter export against a real schema [integration]', function () {
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

    it('ut_documentation_reporter renders the suite description, per-test outcomes and a failure summary', async () => {
        const output = await runWithReporter(producerConn, consumerConn, 'ut_documentation_reporter', [`${TEST_OWNER}:test_calc_pkg`]);

        assert.match(output, /utplsql-vsc integration fixture/);
        assert.match(output, /adds two numbers correctly/);
        assert.match(output, /fails on purpose to exercise the failed run state.*FAILED/);
        assert.match(output, /disabled test to exercise the skipped run state.*DISABLED/);
        assert.match(output, /6 tests, 1 failed, 1 errored, 1 disabled/);
    });

    it('the chosen reporter type name is one get_reporters_list() actually returns', async () => {
        const reporters = await dao.getReportersList(producerConn);
        assert.ok(
            reporters.some((r) => r.reporterObjectName.toUpperCase().endsWith('UT_DOCUMENTATION_REPORTER')),
            'ut_documentation_reporter should be among the reporters utplsql.runWithReporter offers in its quick-pick'
        );
    });

    it('a_color_console adds ANSI escape codes to the documentation reporter output', async () => {
        const plain = await runWithReporter(producerConn, consumerConn, 'ut_documentation_reporter', [`${TEST_OWNER}:test_calc_pkg.test_add`]);
        const ansiEscape = /\x1b\[/;
        assert.doesNotMatch(plain, ansiEscape, 'expected no ANSI escapes without a_color_console');

        const colored = await runWithReporter(producerConn, consumerConn, 'ut_documentation_reporter', [`${TEST_OWNER}:test_calc_pkg.test_add`], {
            colorConsole: true
        });
        assert.match(colored, ansiEscape, 'expected ANSI escapes with a_color_console => true');
    });

    it('accepts a_client_character_set without erroring', async () => {
        // Confirms the parameter name/type match the installed ut_runner.run
        // signature — the actual re-encoding is entirely server-side and not
        // observable from a UTF-8 Node.js client, so this is a compile/accept
        // smoke test rather than a byte-level assertion.
        await assert.doesNotReject(
            runWithReporter(producerConn, consumerConn, 'ut_documentation_reporter', [`${TEST_OWNER}:test_calc_pkg.test_add`], {
                clientCharacterSet: 'AL32UTF8'
            })
        );
    });

    it('runWithReporter accepts multiple run paths in one call, as the Export-with-Reporter profile needs for a multi-item selection', async () => {
        const output = await runWithReporter(producerConn, consumerConn, 'ut_documentation_reporter', [
            `${TEST_OWNER}:test_calc_pkg.test_add`,
            `${TEST_OWNER}:test_calc_pkg.nested_context_#1.test_nested`
        ]);
        assert.match(output, /adds two numbers correctly/);
        assert.match(output, /test nested inside a suite context/);
        assert.doesNotMatch(output, /fails on purpose/);
    });
});
