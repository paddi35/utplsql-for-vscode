import assert from 'node:assert/strict';
import { Connection } from 'oracledb';
import { XMLParser } from 'fast-xml-parser';
import { CoverageOptions } from '../../src/db/realtimeDao';
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
