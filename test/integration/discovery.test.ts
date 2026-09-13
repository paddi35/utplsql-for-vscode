import assert from 'node:assert/strict';
import { Connection } from 'oracledb';
import * as dao from '../../src/db/utplsqlDao';
import { createSingleFlightCache } from '../../src/testing/singleFlight';
import { createObjectTypeCache, ObjectType } from '../../src/testing/objectTypeCache';
import { getTestConnection, closeTestPool, TEST_OWNER } from './support/db';
import {
    installFixture,
    FIXTURE_OWNER_OBJECT,
    SUITEPATH_GROUP_PATH,
    SUITEPATH_FIXTURE_OBJECT,
    installDeepTagsFixture,
    DEEP_TAGS_FIXTURE_OWNER_OBJECT,
    DEEP_TAGS_SUITEPATH_GROUP_PATH,
    DEEP_TAGS_TAG,
    DEEP_TAGS_TAGGED_TEST,
    DEEP_TAGS_UNTAGGED_TEST
} from './support/fixture';

const KNOWN_ITEM_TYPES = new Set(['UT_SUITE', 'UT_SUITE_CONTEXT', 'UT_TEST', 'UT_LOGICAL_SUITE']);

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
        await installDeepTagsFixture(conn);
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

    it('reports a --%suitepath group as itemType UT_LOGICAL_SUITE (issue #27)', async () => {
        const rows = await dao.getSuitesInfo(conn, TEST_OWNER, SUITEPATH_FIXTURE_OBJECT);
        const group = rows.find((r) => r.path === SUITEPATH_GROUP_PATH);
        assert.ok(group, `expected a row at path '${SUITEPATH_GROUP_PATH}' for the --%suitepath group, got ${JSON.stringify(rows)}`);
        assert.equal(
            group!.itemType,
            'UT_LOGICAL_SUITE',
            'pins the docs/performance.md Findings observation — a utPLSQL version change that alters this should fail loudly here'
        );
        assert.ok(rows.some((r) => r.itemType === 'UT_TEST' && r.path === `${SUITEPATH_GROUP_PATH}.test_in_group`));
    });

    it('never reports an unrecognised item_type against the live utPLSQL version under test (cheap guard against a future 5th kind)', async () => {
        const unknown: unknown[] = [];
        const rows = await dao.getSuitesInfo(conn, TEST_OWNER, undefined, (raw) => unknown.push(raw));
        assert.deepEqual(
            unknown,
            [],
            `get_suites_info returned an item_type this extension does not declare — extend SuiteInfoRow['itemType'] and KNOWN_ITEM_TYPES in utplsqlDao.ts: ${JSON.stringify(unknown)}`
        );
        // Belt-and-braces: parseItemType's fallback means an unknown type
        // would already have been coerced to 'UT_SUITE' above rather than
        // violate this, so the assertion with teeth is onUnknownItemType
        // firing (or not) — this just also documents the union it's checked
        // against.
        assert.ok(rows.every((r) => KNOWN_ITEM_TYPES.has(r.itemType)));
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
        const deps = await dao.includes(conn, TEST_OWNER, ['CALC_PKG'], 'integration');
        assert.ok(
            !deps.some((d) => d.name === FIXTURE_OWNER_OBJECT),
            `expected ${FIXTURE_OWNER_OBJECT} NOT among calc_pkg's dependencies, got ${JSON.stringify(deps)}`
        );
    });

    it('single-flights concurrent getSuitesInfo calls for the same profile into exactly one DB round trip (issue #17)', async () => {
        // Exercises the real createSingleFlightCache (src/testing/
        // singleFlight.ts) wrapped around the real dao.getSuitesInfo against
        // a live connection, the same composition controller.ts's
        // fetchSuiteRows uses — a call counter around the wrapped fetch is
        // this test's "the DB saw one execution" signal, cheaper and more
        // portable than a v$sql.executions lookup (which also needs a
        // privilege this suite's user may not have).
        const cache = createSingleFlightCache<dao.SuiteInfoRow[]>();
        let calls = 0;
        const fetchForProfile = () =>
            cache.get('integration-profile', async () => {
                calls++;
                return dao.getSuitesInfo(conn, TEST_OWNER, FIXTURE_OWNER_OBJECT);
            });

        const [r1, r2, r3] = await Promise.all([fetchForProfile(), fetchForProfile(), fetchForProfile()]);

        assert.equal(calls, 1, 'three concurrent callers for the same profile must share exactly one getSuitesInfo round trip');
        assert.ok(r1.length > 0);
        assert.deepEqual(r1, r2);
        assert.deepEqual(r2, r3);

        // A call issued after the batch resolved must hit the value cache,
        // not trigger a fourth round trip.
        await fetchForProfile();
        assert.equal(calls, 1);
    });

    it('primes an owner\'s object types once and reuses them across every resolved level, instead of once per level (issue #22)', async () => {
        // Every distinct suitepath/context/suitepath-group level across the
        // whole owner's rows -- the same partition materializeLevel's
        // children index produces -- used here only to drive N separate
        // resolve() calls, one per level, the way N separate
        // materializeLevel invocations of the real tree would.
        const rows = await dao.getSuitesInfo(conn, TEST_OWNER);
        const levels = new Set(
            rows.map((r) => {
                const dot = r.path.lastIndexOf('.');
                return dot === -1 ? '' : r.path.slice(0, dot);
            })
        );
        assert.ok(levels.size >= 2, `expected at least two distinct levels across the fixture (test_calc_pkg's context plus test_suitepath_pkg's group), got ${JSON.stringify([...levels])}`);

        const cache = createObjectTypeCache();
        let calls = 0;
        // "No local source files available to the index" (the issue's own
        // framing): every level's priming set is the full owner name list,
        // exactly what allMissingNamesForOwner (controller.ts) computes when
        // nothing resolves locally.
        const allNames = [...new Set(rows.map((r) => r.objectName))];
        const fetchAll = (toFetch: string[]): Promise<Map<string, ObjectType>> => {
            calls++;
            return dao.getPackageObjectTypes(conn, TEST_OWNER, toFetch, 'integration');
        };

        for (const _level of levels) {
            await cache.resolve('integration-profile', TEST_OWNER, allNames, fetchAll);
        }

        assert.equal(calls, 1, `expected exactly one getPackageObjectTypes call priming ${levels.size} resolved levels of the same owner, got ${calls}`);
    });

    it('discovers a --%tags(...) annotation nested under a --%suitepath group and a --%context, and collectTags surfaces it, without any tree ever being built (issue #18)', async () => {
        // The whole point of issue #18's fix: getSuitesInfo/collectTags are
        // called directly here, exactly as controller.ts's getSuiteRows +
        // dao.collectTags are from commands/index.ts's runWithTags -- no
        // vscode.TestItem, no MetaStore, nothing resolved/expanded above this
        // row at all. Before the fix, the equivalent MetaStore-based query in
        // runWithTags could only ever see this tag if the suitepath group AND
        // the context had both already been expanded in the Test Explorer.
        const rows = await dao.getSuitesInfo(conn, TEST_OWNER, DEEP_TAGS_FIXTURE_OWNER_OBJECT);

        const group = rows.find((r) => r.path === DEEP_TAGS_SUITEPATH_GROUP_PATH);
        assert.ok(group, `expected a --%suitepath group row at path '${DEEP_TAGS_SUITEPATH_GROUP_PATH}', got ${JSON.stringify(rows)}`);
        assert.equal(group!.itemType, 'UT_LOGICAL_SUITE');

        const tagged = rows.find((r) => r.itemName.toUpperCase() === DEEP_TAGS_TAGGED_TEST);
        assert.ok(tagged, `expected to discover ${DEEP_TAGS_TAGGED_TEST}, got ${JSON.stringify(rows.map((r) => r.itemName))}`);
        assert.equal(tagged!.itemType, 'UT_TEST');
        assert.ok(
            tagged!.path.startsWith(`${DEEP_TAGS_SUITEPATH_GROUP_PATH}.`) && tagged!.path !== `${DEEP_TAGS_SUITEPATH_GROUP_PATH}.${DEEP_TAGS_TAGGED_TEST.toLowerCase()}`,
            `expected ${DEEP_TAGS_TAGGED_TEST}'s path to be nested at least one level below the suitepath group itself (i.e. inside the --%context), got '${tagged!.path}'`
        );
        assert.match(tagged!.tags ?? '', new RegExp(DEEP_TAGS_TAG, 'i'));

        const untagged = rows.find((r) => r.itemName.toUpperCase() === DEEP_TAGS_UNTAGGED_TEST);
        assert.ok(untagged);
        assert.equal(untagged!.tags, undefined);

        assert.deepEqual(dao.collectTags(rows), [DEEP_TAGS_TAG]);
    });
});
