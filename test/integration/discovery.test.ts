import assert from 'node:assert/strict';
import { Connection } from 'oracledb';
import * as dao from '../../src/db/utplsqlDao';
import { getTestConnection, closeTestPool, TEST_OWNER } from './support/db';
import { installFixture, FIXTURE_OWNER_OBJECT } from './support/fixture';

/**
 * Exercises utplsqlDao (src/db/utplsqlDao.ts) against a real utPLSQL schema —
 * the DB-Integration checklist item from the plan: "Discovery liefert den
 * erwarteten Baum inkl. Contexts, disabled-Flags und Tags." Needs a running
 * utPLSQL-equipped Oracle instance; see test/integration/support/db.ts for
 * how to point it at one other than the local docker-compose container.
 */
describe('utplsqlDao discovery against a real schema [integration]', function () {
    this.timeout(30000);
    let conn: Connection;

    before(async () => {
        conn = await getTestConnection();
        await installFixture(conn);
    });

    after(async () => {
        await conn.close();
        await closeTestPool();
    });

    it('reports a version at least as new as get_suites_info requires', async () => {
        const version = await dao.getVersion(conn);
        assert.ok(
            version.normalized >= dao.VERSION_GET_SUITES_INFO,
            `expected normalized version >= ${dao.VERSION_GET_SUITES_INFO}, got ${version.normalized} (raw "${version.raw}")`
        );
    });

    it('has_suites is true for the fixture owner', async () => {
        assert.equal(await dao.hasSuites(conn, TEST_OWNER), true);
    });

    it('discovers the fixture suite tree with a context, a disabled test and a tag', async () => {
        const rows = await dao.getSuitesInfo(conn, TEST_OWNER, FIXTURE_OWNER_OBJECT);
        const byItemName = new Map(rows.map((r) => [r.itemName, r]));

        const suite = rows.find((r) => r.itemType === 'UT_SUITE');
        assert.ok(suite, 'expected exactly one UT_SUITE row');
        assert.equal(suite!.objectOwner, TEST_OWNER);
        assert.equal(suite!.objectName, FIXTURE_OWNER_OBJECT);
        assert.equal(suite!.path, 'test_calc_pkg');

        const contexts = rows.filter((r) => r.itemType === 'UT_SUITE_CONTEXT');
        assert.equal(contexts.length, 1, 'expected the one nested --%context to show up as UT_SUITE_CONTEXT');

        const tests = rows.filter((r) => r.itemType === 'UT_TEST');
        assert.equal(tests.length, 6);
        for (const t of tests) {
            assert.ok(t.itemLineNo && t.itemLineNo > 0, `${t.itemName} should carry a positive item_line_no`);
        }

        // disabled_flag: node-oracledb returns this column as a JS number
        // (0/1), not 'Y'/'N' — see utplsqlDao.ts's parseDisabledFlag() doc
        // comment for the bug this guards against.
        const disabledRows = rows.filter((r) => r.disabledFlag);
        assert.equal(disabledRows.length, 1);
        assert.equal(disabledRows[0].itemName, 'TEST_DISABLED_CASE');
        assert.equal(byItemName.get('TEST_ADD')?.disabledFlag, false);

        assert.match(byItemName.get('TEST_SLOW')?.tags ?? '', /slow/i);
        assert.equal(byItemName.get('TEST_ADD')?.tags, undefined);

        const nested = byItemName.get('TEST_NESTED');
        assert.ok(nested, 'expected the test nested under --%context to be discovered');
        assert.equal(nested!.path, 'test_calc_pkg.nested_context_#1.test_nested');
    });

    it('lists output reporters including the realtime and documentation reporters', async () => {
        const reporters = await dao.getReportersList(conn);
        const names = reporters.map((r) => r.reporterObjectName.toUpperCase());
        assert.ok(names.some((n) => n.endsWith('UT_REALTIME_REPORTER')), `expected a realtime reporter in ${JSON.stringify(names)}`);
        assert.ok(names.some((n) => n.endsWith('UT_DOCUMENTATION_REPORTER')));
        assert.ok(reporters.every((r) => r.isOutputReporter), 'getReportersList() already filters to is_output_reporter = Y');
    });

    it('lists calc_pkg as a testable unit for AP9 test generation', async () => {
        const units = await dao.testables(conn, TEST_OWNER);
        assert.ok(units.some((u) => u.objectName === 'CALC_PKG' && u.objectType === 'PACKAGE'));
    });

    it('includes() reads dependencies forwards: calc_pkg does not list its own test package', async () => {
        // The complement of coverage.test.ts's forward-direction check, and a
        // regression guard for the backwards *_dependencies query described
        // there: while includes() still queried
        // referenced_owner/referenced_name, this call returned
        // TEST_CALC_PKG — that being what references CALC_PKG rather than
        // what CALC_PKG references. This assertion was written against that
        // old behaviour and kept asserting it after the query was fixed,
        // which no CI run ever caught, because the integration job has so
        // far always timed out during Oracle's first-time DB creation.
        // The fixture only ever points test_calc_pkg -> calc_pkg, so the
        // reverse direction must stay free of it.
        const deps = await dao.includes(conn, TEST_OWNER, 'CALC_PKG');
        assert.ok(
            !deps.some((d) => d.name === FIXTURE_OWNER_OBJECT),
            `expected ${FIXTURE_OWNER_OBJECT} NOT among calc_pkg's dependencies, got ${JSON.stringify(deps)}`
        );
    });
});
