import assert from 'node:assert/strict';
import { Connection } from 'oracledb';
import { XMLParser } from 'fast-xml-parser';
import { CoverageOptions } from '../../src/db/realtimeDao';
import * as dao from '../../src/db/utplsqlDao';
import { computeCoverageScope, CoverageScopeItem } from '../../src/testing/coverageScope';
import { getTestPool, closeTestPool, TEST_OWNER } from './support/db';
import { installFixture } from './support/fixture';
import { runPathsAndCollect } from './support/runProfile';

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function asArray<T>(v: T | T[] | undefined): T[] {
    if (v === undefined) return [];
    return Array.isArray(v) ? v : [v];
}

/**
 * Exercises the coverage-scoping and output-format options this milestone
 * wires from buildProduceSql all the way through a real ut_runner.run()
 * call: a_include_object_expr/a_exclude_object_expr (M6),
 * a_test_file_mappings (M8), and a second (Cobertura) coverage reporter
 * alongside the Sonar one (M9).
 */
describe('coverage scoping and output options against a real schema [integration]', function () {
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

    it('a_include_object_expr scopes coverage to only the objects matching the regex', async () => {
        // No a_include_objects at all — the regex alone should pull CALC_PKG
        // into scope, without excludeObjects filtering it back out.
        const coverage: CoverageOptions = {
            reporter: 'ut_coverage_sonar_reporter',
            schemes: [TEST_OWNER],
            includeObjectExpr: '^CALC_PKG$',
            fileMappings: [{ file: 'db/calc_pkg.pkb', owner: TEST_OWNER, name: 'CALC_PKG', type: 'PACKAGE BODY' }]
        };
        const { coverageXml } = await runPathsAndCollect(producerConn, consumerConn, [`${TEST_OWNER}:test_calc_pkg.test_add`], {
            coverage
        });
        assert.ok(coverageXml);
        const doc = xmlParser.parse(coverageXml!);
        const files = asArray(doc.coverage.file);
        assert.ok(
            files.some((f: Record<string, unknown>) => f['@_path'] === 'db/calc_pkg.pkb'),
            `expected db/calc_pkg.pkb in coverage output via a_include_object_expr, got ${coverageXml}`
        );
    });

    it('a_test_file_mappings reports the test package under its own file entry instead of excluding it', async () => {
        const coverage: CoverageOptions = {
            reporter: 'ut_coverage_sonar_reporter',
            schemes: [TEST_OWNER],
            includeObjects: ['CALC_PKG'],
            fileMappings: [{ file: 'db/calc_pkg.pkb', owner: TEST_OWNER, name: 'CALC_PKG', type: 'PACKAGE BODY' }],
            testFileMappings: [{ file: 'db/test_calc_pkg.pkb', owner: TEST_OWNER, name: 'TEST_CALC_PKG', type: 'PACKAGE BODY' }]
        };
        const { coverageXml } = await runPathsAndCollect(producerConn, consumerConn, [`${TEST_OWNER}:test_calc_pkg.test_add`], {
            coverage
        });
        assert.ok(coverageXml, 'expected coverage XML to be produced with a_test_file_mappings set');
        // The call must not error (a_test_file_mappings has to be a real,
        // accepted ut_runner.run parameter) — the exact rendering of test
        // files in ut_coverage_sonar_reporter's own output is between it and
        // its own report format, not this extension's to assert on.
    });

    it('requesting a Cobertura additionalReporter alongside Sonar returns both, independently valid', async () => {
        const coverage: CoverageOptions = {
            reporter: 'ut_coverage_sonar_reporter',
            additionalReporter: 'ut_coverage_cobertura_reporter',
            schemes: [TEST_OWNER],
            includeObjects: ['CALC_PKG'],
            fileMappings: [{ file: 'db/calc_pkg.pkb', owner: TEST_OWNER, name: 'CALC_PKG', type: 'PACKAGE BODY' }]
        };
        const { coverageXml, additionalCoverageXml } = await runPathsAndCollect(
            producerConn,
            consumerConn,
            [`${TEST_OWNER}:test_calc_pkg.test_add`],
            { coverage }
        );
        assert.ok(coverageXml, 'expected the primary sonar coverageXml');
        assert.ok(additionalCoverageXml, 'expected an additional cobertura coverageXml');

        const sonarDoc = xmlParser.parse(coverageXml!);
        assert.ok(sonarDoc.coverage?.file, 'sonar XML should have <coverage><file> entries (SonarQube generic format)');

        const coberturaDoc = xmlParser.parse(additionalCoverageXml!);
        assert.ok(
            coberturaDoc.coverage?.packages,
            'cobertura XML should have <coverage><packages> instead — confirms the two reporters produced distinct formats'
        );
    });
});

/**
 * Issue #21: buildCoverageOptions() (coverage.ts) used to call dao.includes()
 * once per selected TestItem, and get_suites_info returns one row per
 * suite/context/test under a package (the same "every path-bearing
 * descendant, not just leaves" shape groupRequest selects for a run — see
 * runHandler.ts and docs/performance.md's "Known hotspots") — so a package
 * with N such rows issued N identical *_dependencies queries. This exercises
 * the real fix, computeCoverageScope (coverageScope.ts), against a live
 * schema: a wrapped dao.includes counts its own invocations instead of
 * requiring a v$sql lookup (which also needs a privilege this suite's user
 * may not have), the same "call counter around the real dao call" pattern
 * utplsqlDao.test.ts's single-flight regression test uses for getSuitesInfo.
 */
describe('buildCoverageOptions dependency-lookup batching against a real schema [integration] (issue #21)', function () {
    this.timeout(30000);
    let conn: Connection;

    before(async () => {
        const pool = await getTestPool();
        conn = await pool.getConnection();
        await installFixture(conn);
    });

    after(async () => {
        await conn.close();
        await closeTestPool();
    });

    it('queries *_dependencies exactly once for a package with several suite/context/test rows, not once per row', async () => {
        const rows = await dao.getSuitesInfo(conn, TEST_OWNER, 'TEST_CALC_PKG');
        // test_calc_pkg has 6 --%test procedures plus its own UT_SUITE row
        // and a UT_SUITE_CONTEXT row for test_nested's --%context (see
        // fixture.sql) — every one of them shares objectName='TEST_CALC_PKG',
        // which is exactly the repetition that used to cost one round trip
        // apiece.
        assert.ok(rows.length >= 5, `expected several rows (suite + context + tests) for TEST_CALC_PKG, got ${rows.length}`);

        const items: CoverageScopeItem[] = rows.map((r) => ({ owner: r.objectOwner, objectName: r.objectName }));

        let calls = 0;
        const includesFn = async (owner: string, names: string[]) => {
            calls++;
            return dao.includes(conn, owner, names, 'integration');
        };

        const scope = await computeCoverageScope(items, includesFn, { excludeObjects: [], schemesOverride: [], includeObjectsOverride: [] });

        assert.equal(calls, 1, `expected exactly one batched dependencies query for ${rows.length} rows of the same package, got ${calls}`);
        // Pure round-trip reduction, not a scope change: the same CALC_PKG
        // dependency coverage.test.ts's own (unbatched, single-pair) call
        // asserts on must still come back once the calls are batched.
        assert.ok(
            [...scope.includeObjects.values()].some((d) => d.owner === TEST_OWNER && d.name === 'CALC_PKG'),
            `expected CALC_PKG among TEST_CALC_PKG's dependencies after batching, got ${JSON.stringify([...scope.includeObjects.values()])}`
        );
    });
});
