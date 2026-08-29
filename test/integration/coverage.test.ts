import assert from 'node:assert/strict';
import { Connection } from 'oracledb';
import { XMLParser } from 'fast-xml-parser';
import { CoverageOptions } from '../../src/db/realtimeDao';
import { getPackageObjectTypes, includes } from '../../src/db/utplsqlDao';
import { getTestPool, closeTestPool, TEST_OWNER } from './support/db';
import { installFixture } from './support/fixture';
import { runPathsAndCollect } from './support/runProfile';

/**
 * The plan's checklist item: "Coverage-Lauf erzeugt FileCoverage für eine
 * Workspace-Datei mit plausiblen Zeilentreffern." src/testing/coverage.ts
 * turns this same ut_coverage_sonar_reporter XML into vscode.FileCoverage,
 * but that module imports 'vscode' and can't load outside the extension
 * host, so this parses the XML with the same fast-xml-parser dependency
 * coverage.ts uses and checks the line hits directly instead.
 *
 * A real bug surfaced while building this test against a live utPLSQL 3.2.3
 * instance and is fixed in src/db/realtimeDao.ts (see buildProduceSql's /
 * reportersClause's doc comments): set_reporter_id() takes a RAW parameter,
 * so the coverage/html reporters' ids used to break with ORA-06502 ("hex to
 * raw conversion error") the moment they were derived by string-suffixing
 * the primary (valid-hex) reporter id with '_cov'/'_html' — i.e. every
 * coverage run was broken, not just the file-path edge cases the plan's
 * open point 3 flagged.
 */
describe('coverage reporting against a real schema [integration]', function () {
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

    it('resolves what the test package depends on, not what depends on the test package', async () => {
        // dao.includes(owner, name) used to query *_dependencies backwards
        // (WHERE referenced_owner/referenced_name = :owner/:name), which
        // finds objects that reference TEST_CALC_PKG instead of objects
        // TEST_CALC_PKG references — in practice returning just
        // TEST_CALC_PKG itself (its body implicitly depends on its own
        // spec), so buildCoverageOptions() ended up scoping coverage to the
        // test package instead of CALC_PKG and producing an empty
        // a_source_file_mappings, i.e. no coverage was ever reported.
        const deps = await includes(producerConn, TEST_OWNER, 'TEST_CALC_PKG');
        assert.ok(
            deps.some((d) => d.owner === TEST_OWNER && d.name === 'CALC_PKG'),
            `expected CALC_PKG among TEST_CALC_PKG's dependencies, got ${JSON.stringify(deps)}`
        );
    });

    it('resolves PACKAGE BODY over PACKAGE, and omits names that are neither', async () => {
        // Backs coverage.ts's and controller.ts's virtual-source fallback
        // (used when there is no local workspace file for an object): both
        // need to know whether to point at the body or the spec, and to
        // simply skip names that aren't a package/package body at all
        // (e.g. a typo, or an object type this feature doesn't support).
        const types = await getPackageObjectTypes(producerConn, TEST_OWNER, ['CALC_PKG', 'TEST_CALC_PKG', 'DOES_NOT_EXIST']);
        assert.equal(types.get('CALC_PKG'), 'PACKAGE BODY');
        assert.equal(types.get('TEST_CALC_PKG'), 'PACKAGE BODY');
        assert.equal(types.has('DOES_NOT_EXIST'), false);
    });

    it('reports the workspace-relative file path and plausible line hits for the executed test only', async () => {
        const coverage: CoverageOptions = {
            reporter: 'ut_coverage_sonar_reporter',
            schemes: [TEST_OWNER],
            includeObjects: ['CALC_PKG'],
            excludeObjects: ['TEST_CALC_PKG'],
            fileMappings: [{ file: 'db/calc_pkg.pkb', owner: TEST_OWNER, name: 'CALC_PKG', type: 'PACKAGE BODY' }]
        };

        // Only test_add runs, which calls add_numbers() but not divide() —
        // so add_numbers' line should come back covered and divide's should
        // come back present but NOT covered, proving this is real per-line
        // coverage and not just "the file was touched".
        const { coverageXml } = await runPathsAndCollect(producerConn, consumerConn, [`${TEST_OWNER}:test_calc_pkg.test_add`], { coverage });
        assert.ok(coverageXml, 'expected coverage XML to be produced');

        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
        const doc = parser.parse(coverageXml!);
        const files = [doc.coverage.file].flat();
        const file = files.find((f: Record<string, unknown>) => f['@_path'] === 'db/calc_pkg.pkb');
        assert.ok(file, `expected a <file path="db/calc_pkg.pkb"> element, got ${coverageXml}`);

        const lines = [file.lineToCover].flat().map((l: Record<string, unknown>) => ({
            line: Number(l['@_lineNumber']),
            covered: l['@_covered'] === 'true'
        }));
        assert.ok(lines.length >= 2, `expected at least the two return statements to be listed, got ${JSON.stringify(lines)}`);
        assert.ok(lines.some((l: { covered: boolean }) => l.covered === true), 'expected at least one covered line (add_numbers was called)');
        assert.ok(lines.some((l: { covered: boolean }) => l.covered === false), 'expected at least one uncovered line (divide was never called)');
    });
});
