import assert from 'node:assert/strict';
import { Connection } from 'oracledb';
import { XMLParser } from 'fast-xml-parser';
import { CoverageOptions } from '../../src/db/realtimeDao';
import { getPackageObjectTypes, includes } from '../../src/db/utplsqlDao';
import { getTestPool, closeTestPool, TEST_OWNER } from './support/db';
import { installFixture, installXssFixture, XSS_PAYLOAD, XSS_TEST_PATH } from './support/fixture';
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
        await installXssFixture(producerConn);
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
        const deps = await includes(producerConn, TEST_OWNER, ['TEST_CALC_PKG'], 'integration');
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
        const types = await getPackageObjectTypes(producerConn, TEST_OWNER, ['CALC_PKG', 'TEST_CALC_PKG', 'DOES_NOT_EXIST'], 'integration');
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

    /**
     * Issue #13 assumed ut_coverage_html_reporter would hand a live
     * "</script><script>...</script>" payload straight through, which is what
     * would make rendering its output in a webview with unsafe-inline
     * dangerous. Run against a real utPLSQL 3.2.3 instance, that is not what
     * happens: the reporter HTML-escapes the payload (it appears as
     * "&lt;/script&gt;&lt;script&gt;..." in both the summary link and the
     * source-file header), so the payload never survives verbatim.
     *
     * The mitigation is still right -- the extension does not get to assume a
     * database-side reporter escapes on its behalf, at this or any other
     * version, and the coverage HTML is built from schema-controlled object
     * names. What changes is the justification: this is defence in depth, not
     * a fix for a payload observed reaching the renderer.
     *
     * So this test pins the escaping instead of the pass-through. If a future
     * utPLSQL version stops escaping, the first assertion fails and says so
     * loudly, which is exactly when the premise behind
     * test/unit/coverageHtml.test.ts stops being theoretical.
     *
     * installXssFixture() (test/integration/support/xssFixture.sql) installs a
     * package whose *name* is an Oracle quoted identifier containing the
     * payload, and whose body also carries it as a plain source comment;
     * test_xss_pkg.test_calls_payload_pkg calls that package so it is actually
     * exercised (and therefore reported) under coverage, scoped by schema
     * (a_coverage_schemes) rather than by naming the payload package in
     * a_include_objects/a_source_file_mappings -- this suite's own
     * dao.validateIdentifier-guarded SQL builder (src/db/realtimeDao.ts)
     * rightly refuses a bind value that isn't a plain identifier, and routing
     * the payload through it would be testing this extension's own SQL
     * construction, not utPLSQL's reporter output.
     */
    it('has ut_coverage_html_reporter HTML-escape a <script> payload rather than pass it through', async () => {
        const coverage: CoverageOptions = {
            reporter: 'ut_coverage_sonar_reporter',
            schemes: [TEST_OWNER],
            fileMappings: [],
            htmlReport: true
        };

        const { htmlReport } = await runPathsAndCollect(producerConn, consumerConn, [`${TEST_OWNER}:${XSS_TEST_PATH}`], { coverage });
        assert.ok(htmlReport, 'expected the html coverage reporter to produce output');

        const verbatim = htmlReport!.split(XSS_PAYLOAD).length - 1;
        assert.equal(
            verbatim,
            0,
            `ut_coverage_html_reporter no longer escapes its output: the payload appeared verbatim ${verbatim} time(s). The extension's own hardening (src/testing/coverageHtml.ts) now guards a live payload, not a theoretical one.`
        );

        // Without this the assertion above would also pass on an empty or
        // failed report -- the escaped form is the proof that the payload
        // package really was covered and really did reach the reporter's
        // output.
        const escaped = XSS_PAYLOAD.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        assert.ok(
            htmlReport!.includes(escaped),
            `expected the escaped payload in the report, so the payload package was demonstrably covered; got: ${htmlReport}`
        );
    });
});
