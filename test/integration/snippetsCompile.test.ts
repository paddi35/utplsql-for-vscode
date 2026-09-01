import assert from 'node:assert/strict';
import { Connection } from 'oracledb';
import { escalateStatus } from '../../src/model/tree';
import { getTestPool, closeTestPool, TEST_OWNER } from './support/db';
import { installSnippetsFixture, SNIPPETS_FIXTURE_OWNER_OBJECT } from './support/fixture';
import * as dao from '../../src/db/utplsqlDao';
import { runPathsAndCollect } from './support/runProfile';

/**
 * M12/M13/M14's real test: every non-trivial snippet body in
 * snippets/utplsql.code-snippets, compiled and run for real
 * (support/snippetsFixture.sql) against a live utPLSQL 3.2.3 instance. The
 * annotation/matcher names were verified by reading the installed source and
 * userguide, but the a_tags bug (see runOptions.test.ts) is a reminder that
 * reading the API is not the same as compiling and running it — every
 * snippet gets one real assertion here, not just a doc citation.
 */
describe('snippet bodies compile and behave as documented against a real schema [integration]', function () {
    this.timeout(30000);
    let producerConn: Connection;
    let consumerConn: Connection;

    before(async () => {
        const pool = await getTestPool();
        producerConn = await pool.getConnection();
        consumerConn = await pool.getConnection();
        // installSnippetsFixture is itself the compile check: a CREATE OR
        // REPLACE with a PL/SQL syntax error throws here, before any test
        // even runs.
        await installSnippetsFixture(producerConn);
    });

    after(async () => {
        await producerConn.close();
        await consumerConn.close();
        await closeTestPool();
    });

    it('discovers the %tags/%context/%name/%beforetest/%aftertest annotations without warnings', async () => {
        const rows = await dao.getSuitesInfo(producerConn, TEST_OWNER, SNIPPETS_FIXTURE_OWNER_OBJECT);
        const byItemName = new Map(rows.map((r) => [r.itemName, r]));
        // --%tags(snippet_check) sits at suite level (alongside --%suite),
        // so it lands on the UT_SUITE row itself — get_suites_info does not
        // propagate a suite's tags down onto its child test rows.
        const suite = rows.find((r) => r.itemType === 'UT_SUITE');
        assert.match(suite?.tags ?? '', /snippet_check/);

        const contexts = rows.filter((r) => r.itemType === 'UT_SUITE_CONTEXT');
        assert.equal(contexts.length, 1);
        const nested = byItemName.get('TEST_IN_CONTEXT');
        assert.ok(nested);
        assert.match(nested!.path, /demo_context\.test_in_context$/, `--%name(demo_context) should rename the context segment, got path "${nested!.path}"`);
    });

    it('every matcher/annotation test passes or fails exactly as the snippet documents', async () => {
        const { events } = await runPathsAndCollect(producerConn, consumerConn, [`${TEST_OWNER}:${SNIPPETS_FIXTURE_OWNER_OBJECT.toLowerCase()}`]);
        const postTests = events.map((e) => e.event).filter((e): e is Extract<typeof e, { type: 'post-test' }> => e.type === 'post-test');
        const statusById = new Map(postTests.map((e) => [e.id, escalateStatus(e.counter)]));
        const idFor = (name: string) => `${SNIPPETS_FIXTURE_OWNER_OBJECT.toLowerCase()}.${name}`;

        // Numeric, string, cursor, JSON and NLS-cursor matcher snippets all pass.
        assert.equal(statusById.get(idFor('test_numeric_matchers')), 'passed');
        assert.equal(statusById.get(idFor('test_string_matchers')), 'passed');
        assert.equal(statusById.get(idFor('test_cursor_matchers')), 'passed');
        assert.equal(statusById.get(idFor('test_cursor_equal_modifiers')), 'passed');
        assert.equal(statusById.get(idFor('test_json_matcher')), 'passed');
        assert.equal(statusById.get(idFor('test_nls_cursor')), 'passed');

        // ut.fail unconditionally fails, exactly as documented.
        assert.equal(statusById.get(idFor('test_fail')), 'failed');
        const failEvent = postTests.find((e) => e.id === idFor('test_fail'))!;
        assert.match(failEvent.failedExpectations[0]?.message ?? '', /deliberate failure/);

        // --%throws(no_data_found) catches the raised predefined exception.
        assert.equal(statusById.get(idFor('test_throws')), 'passed');

        // --%beforetest/--%aftertest actually ran before the test observed them.
        assert.equal(statusById.get(idFor('test_before_after_test')), 'passed');

        // the context-nested test still runs under its --%name'd context.
        assert.equal(statusById.get('test_snippets_pkg.demo_context.test_in_context'), 'passed');
    });
});
