import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { UtplsqlContext } from '../../../src/testing/model';
import { runCoverage, loadDetailedCoverage } from '../../../src/testing/coverage';
import { VIRTUAL_SOURCE_SCHEME } from '../../../src/workspace/virtualSource';
import { XSS_PAYLOAD } from '../../integration/support/fixture';

/**
 * Issue #28: `runCoverage` (src/testing/coverage.ts) is the one run profile
 * that had no end-to-end coverage at all before this file — everything that
 * only exists inside a real extension host (vscode.TestRun.addCoverage, the
 * FileCoverage/StatementCoverage construction in applyCoverage,
 * loadDetailedCoverage's WeakMap<TestRun, …> detail store, the pathToUri
 * gating, and the virtual utplsql-source:// mapping) was previously only
 * exercised indirectly through test/integration/coverage.test.ts's raw XML
 * parsing. Built the same way sourceIndexCases.ts factors its own coherent
 * group of cases: a `buildCoverageCases` function returning `[name, fn]`
 * pairs for testExplorer.e2e.test.ts's own run()/failure-collection loop.
 *
 * Uses its own fixture pair (coverage_local_pkg/test_coverage_local_pkg,
 * appended to test/integration/support/fixture.sql) rather than
 * calc_pkg/test_calc_pkg: those two need to keep their current "no local
 * workspace file" state for as long as they do — the virtual-source case
 * below reuses that state directly, and sourceIndexCases.ts controls
 * test_calc_pkg.pkb's local-file lifecycle for its own, unrelated #20/#26
 * cases. test/e2e/support/copyFixtures.js stages a matching
 * coverage_local_pkg.pkb into the e2e workspace *before* the extension host
 * starts, so SourceIndex maps it to a local file from activation onward —
 * the "local workspace file" shape these cases need is present from the
 * start, not created mid-run the way sourceIndexCases.ts's test_calc_pkg.pkb
 * is.
 *
 * Where the exact database-reporter behaviour is uncertain (e.g. what
 * fallback path string ut_coverage_sonar_reporter invents for an object with
 * no a_source_file_mappings entry), the assertions are written to hold
 * regardless of that specific behaviour — see each case's own comment. These
 * cases have since been run against a real utPLSQL 3.2.3 instance; where that
 * contradicted an assumption, the case says so rather than the assumption
 * being quietly kept (see the HTML-report XSS case).
 */

/** utplsql.coverage.excludeObjects value used across these cases — see withExcludedFramework below. */
const FRAMEWORK_EXCLUDE_OBJECTS = ['UT', 'UT_EXPECTATION'];

function findChild(collection: vscode.TestItemCollection, label: string): vscode.TestItem | undefined {
    let found: vscode.TestItem | undefined;
    collection.forEach((item) => {
        if (item.label === label) {
            found = item;
        }
    });
    return found;
}

async function resolveItem(controller: vscode.TestController, item: vscode.TestItem | undefined): Promise<void> {
    await controller.resolveHandler?.(item);
}

interface CapturedRun {
    run: vscode.TestRun;
    fileCoverages: vscode.FileCoverage[];
}

/**
 * runCoverage creates its own TestRun internally and never hands it back to
 * the caller, so the only way to observe what it recorded (addCoverage
 * calls, and the TestRun object loadDetailedCoverage's WeakMap is keyed by)
 * is to wrap ctx.controller.createTestRun and the run it returns — the same
 * "there is no read-back API, so wrap the method" mechanic
 * testExplorer.e2e.test.ts already uses for ctx.output.appendLine.
 * TestController/TestRun are plain interfaces (unlike the vscode.window
 * namespace, see the save-dialog stubs below), so reassigning a method here
 * is an ordinary, unforced property write.
 */
async function runCoverageCaptured(ctx: UtplsqlContext, items: vscode.TestItem[], token: vscode.CancellationToken): Promise<CapturedRun> {
    const fileCoverages: vscode.FileCoverage[] = [];
    let capturedRun: vscode.TestRun | undefined;

    const originalCreateTestRun = ctx.controller.createTestRun.bind(ctx.controller);
    ctx.controller.createTestRun = (request, name, persist) => {
        const run = originalCreateTestRun(request, name, persist);
        capturedRun = run;
        const originalAddCoverage = run.addCoverage.bind(run);
        run.addCoverage = (fileCoverage: vscode.FileCoverage): void => {
            fileCoverages.push(fileCoverage);
            originalAddCoverage(fileCoverage);
        };
        return run;
    };

    try {
        await runCoverage(ctx, new vscode.TestRunRequest(items), token);
    } finally {
        ctx.controller.createTestRun = originalCreateTestRun;
    }

    assert.ok(capturedRun, 'runCoverage never called ctx.controller.createTestRun');
    return { run: capturedRun!, fileCoverages };
}

/** utplsql.coverage.excludeObjects, set/restored around a case — see its own use below for why. */
async function withExcludedFramework<T>(fn: () => Promise<T>): Promise<T> {
    const cfg = vscode.workspace.getConfiguration('utplsql');
    const previous = cfg.get<string[]>('coverage.excludeObjects');
    await cfg.update('coverage.excludeObjects', FRAMEWORK_EXCLUDE_OBJECTS, vscode.ConfigurationTarget.Global);
    try {
        return await fn();
    } finally {
        await cfg.update('coverage.excludeObjects', previous, vscode.ConfigurationTarget.Global);
    }
}

function listCoverageHtmlFiles(): Set<string> {
    return new Set(fs.readdirSync(os.tmpdir()).filter((f) => /^utplsql-coverage-.*\.html$/.test(f)));
}

/**
 * The one FileCoverage entry, its plausible covered/total split, the
 * detailed StatementCoverage split, *and* what does NOT show up:
 * coverage_unmapped_fn (a real dependency of test_add_only that is
 * deliberately not a PACKAGE/PACKAGE BODY — dao.getPackageObjectTypes only
 * recognises those two, see resolveFileMappings in coverage.ts) stays in
 * a_include_objects but never gets a pathToUri entry, and
 * test_coverage_local_pkg (the test package itself) is reported via
 * a_test_file_mappings, whose own pathToUri is discarded by
 * buildCoverageOptions before applyCoverage ever sees it. Both are exactly
 * the "an executed object has no matching a_source_file_mappings entry"
 * case parseSonarCoverage's onUnknownPath gate exists for — but *which*
 * synthetic fallback path (if any) the reporter invents for either of them
 * is exactly the kind of live-instance detail this environment cannot
 * verify (see coverage.ts's own doc comment: observed as e.g.
 * "package ut3.calc_pkg" against a live utPLSQL 3.2.3 instance). Asserting
 * "exactly one FileCoverage entry, for coverage_local_pkg's local file"
 * holds regardless of whichever way that resolves — onUnknownPath drops an
 * unmatched path either way, so no FileCoverage entry for either object can
 * ever appear here, whether or not the reporter tried to report one.
 * excludeObjects removes the UT/UT_EXPECTATION framework packages every
 * test's ut.expect(...) call pulls in as a dependency (see coverage.ts's own
 * comment on that), so this schema's exact test/framework installation
 * layout can't turn this into more than one legitimately-mapped entry.
 */
async function testLocalFileMappingDetailAndDroppedUnmapped(ctx: UtplsqlContext, coverageLocalTestPkg: vscode.TestItem, localFileUri: vscode.Uri): Promise<void> {
    await ctx.sourceIndex.buildFullIndex();

    const cts = new vscode.CancellationTokenSource();
    let captured: CapturedRun;
    try {
        captured = await withExcludedFramework(() => runCoverageCaptured(ctx, [coverageLocalTestPkg], cts.token));
    } finally {
        cts.dispose();
    }

    assert.equal(
        captured.fileCoverages.length,
        1,
        `expected exactly one FileCoverage entry (coverage_local_pkg's local file) — neither the unmapped standalone-function dependency nor the test package itself should produce one, got URIs: ${captured.fileCoverages.map((f) => f.uri.toString()).join(', ')}`
    );
    const [fileCoverage] = captured.fileCoverages;
    assert.equal(fileCoverage.uri.toString(), localFileUri.toString(), "expected the FileCoverage URI to be coverage_local_pkg's local workspace file");
    assert.ok(fileCoverage.statementCoverage.total > 0, 'expected a plausible (non-zero) total statement count');
    assert.ok(
        fileCoverage.statementCoverage.covered > 0 && fileCoverage.statementCoverage.covered <= fileCoverage.statementCoverage.total,
        `expected a plausible covered/total split, got ${fileCoverage.statementCoverage.covered}/${fileCoverage.statementCoverage.total}`
    );

    const detailCts = new vscode.CancellationTokenSource();
    const details = await loadDetailedCoverage(captured.run, fileCoverage, detailCts.token);
    detailCts.dispose();
    assert.ok(details.length > 0, 'expected loadDetailedCoverage to return at least one StatementCoverage entry');
    for (const detail of details) {
        assert.ok(detail instanceof vscode.StatementCoverage, 'expected every detail entry to be a StatementCoverage (applyCoverage only ever constructs those)');
        const position = (detail as vscode.StatementCoverage).location;
        const start = position instanceof vscode.Position ? position : position.start;
        assert.ok(start.line >= 0, 'expected a 0-based (non-negative) line position');
    }
    const executed = (details as vscode.StatementCoverage[]).map((d) => Boolean(d.executed));
    assert.ok(executed.some((e) => e === true), 'expected at least one executed statement (add_numbers, called by test_add_only)');
    assert.ok(executed.some((e) => e === false), 'expected at least one unexecuted statement (never_called, called by nothing in the whole fixture)');
}

/**
 * calc_pkg/test_calc_pkg have no local workspace file anywhere in this run
 * (see this module's own doc comment) — the DB-as-sole-source-of-truth case
 * the feature was built for. Runs the whole `pkg` (not just test_add) since
 * this case doesn't need a specific covered/uncovered split, only a virtual
 * FileCoverage entry that opens to real source.
 */
async function testVirtualSourceFallbackForUnmappedPackage(ctx: UtplsqlContext, pkg: vscode.TestItem): Promise<void> {
    const cts = new vscode.CancellationTokenSource();
    let captured: CapturedRun;
    try {
        captured = await withExcludedFramework(() => runCoverageCaptured(ctx, [pkg], cts.token));
    } finally {
        cts.dispose();
    }

    const virtualEntry = captured.fileCoverages.find((f) => f.uri.scheme === VIRTUAL_SOURCE_SCHEME);
    assert.ok(
        virtualEntry,
        `expected a virtual ${VIRTUAL_SOURCE_SCHEME}:// FileCoverage entry for calc_pkg (no local workspace file) — got URIs: ${captured.fileCoverages.map((f) => f.uri.toString()).join(', ')}`
    );
    const doc = await vscode.workspace.openTextDocument(virtualEntry!.uri);
    assert.ok(
        doc.getText().toUpperCase().includes('ADD_NUMBERS'),
        'expected the virtual document, served through the registered TextDocumentContentProvider, to contain real package source'
    );
}

/**
 * Same shape as testExplorer.e2e.test.ts's testCancellationLeavesStateUsable,
 * one level up: cancelling a *coverage* run mid-stream must not attach
 * partial/bogus coverage, and must leave the pool usable for the next
 * coverage run on the same profile. runOneProfile (runHandler.ts) only
 * returns coverageXml when the token was not cancelled by the time it would
 * consume the reporter, so applyCoverage — and therefore addCoverage — is
 * never reached at all for the cancelled run.
 */
async function testCancellingCoverageRunLeavesStateUsable(ctx: UtplsqlContext, pkg: vscode.TestItem): Promise<void> {
    const cts = new vscode.CancellationTokenSource();
    const cancelledRun = withExcludedFramework(() => runCoverageCaptured(ctx, [pkg], cts.token));
    // Same reasoning as the plain-run cancellation case: test_slow's 2s sleep
    // gives a wide, reliable window in which the run is genuinely still
    // streaming when cancellation fires.
    await new Promise((resolve) => setTimeout(resolve, 300));
    cts.cancel();
    const captured = await cancelledRun;
    cts.dispose();

    assert.equal(captured.fileCoverages.length, 0, 'expected no coverage to be attached for a coverage run cancelled mid-stream');

    const cts2 = new vscode.CancellationTokenSource();
    try {
        const after = await withExcludedFramework(() => runCoverageCaptured(ctx, [pkg], cts2.token));
        assert.ok(after.fileCoverages.length > 0, 'expected a subsequent, uncancelled coverage run on the same profile to still succeed and attach coverage');
    } finally {
        cts2.dispose();
    }
}

/**
 * utplsql.coverage.reporter = 'cobertura' requests a second reporter
 * (offerAdditionalCoverageFile in coverage.ts) that is always offered via
 * vscode.window.showSaveDialog — a real, interactive dialog that would hang
 * a headless run forever, hence the issue's own "(stub the save dialog)"
 * instruction. vscode.window is a *namespace*, not an interface — TypeScript
 * treats its function exports as non-writable, unlike ctx.output.appendLine
 * (an OutputChannel instance method) or ctx.controller.createTestRun (a
 * TestController instance method) elsewhere in this file, so the assignment
 * below goes through an object-shape cast to sidestep that compile-time
 * restriction; the underlying extension-host object is an ordinary,
 * genuinely reassignable JS object either way.
 */
async function testCoberturaAdditionalReporterProducesFile(ctx: UtplsqlContext, pkg: vscode.TestItem): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('utplsql');
    const previousReporter = cfg.get<string>('coverage.reporter');
    await cfg.update('coverage.reporter', 'cobertura', vscode.ConfigurationTarget.Global);

    const targetPath = path.join(os.tmpdir(), `utplsql-e2e-cobertura-${Date.now()}.xml`);
    const targetUri = vscode.Uri.file(targetPath);
    const originalShowSaveDialog = vscode.window.showSaveDialog;
    (vscode.window as unknown as { showSaveDialog: typeof vscode.window.showSaveDialog }).showSaveDialog = async () => targetUri;

    const cts = new vscode.CancellationTokenSource();
    try {
        await withExcludedFramework(() => runCoverage(ctx, new vscode.TestRunRequest([pkg]), cts.token));
    } finally {
        cts.dispose();
        (vscode.window as unknown as { showSaveDialog: typeof vscode.window.showSaveDialog }).showSaveDialog = originalShowSaveDialog;
        await cfg.update('coverage.reporter', previousReporter, vscode.ConfigurationTarget.Global);
    }

    assert.ok(fs.existsSync(targetPath), 'expected offerAdditionalCoverageFile to write the Cobertura XML to the stubbed save-dialog target');
    const xml = fs.readFileSync(targetPath, 'utf8');
    fs.rmSync(targetPath, { force: true });
    assert.ok(xml.length > 0, 'expected non-empty Cobertura XML');
    assert.ok(/<coverage[\s>]/i.test(xml), `expected the saved file to look like Cobertura XML (a <coverage> root element), got: ${xml.slice(0, 200)}`);
}

/**
 * From the agent that fixed issue #13 (coverage.ts's showHtmlReport now
 * writes a temp file and offers to open it in the browser, instead of
 * rendering the report in an extension-host webview) — adapted to this
 * file's helper style and fixed to diff the temp directory's contents
 * before/after the run instead of `files.sort().pop()`: the written
 * filenames are `utplsql-coverage-${randomUUID()}.html`, and a random UUID's
 * lexicographic sort order has no relationship to write order, so
 * `.sort().pop()` does not reliably name the file *this* run just wrote,
 * especially once a second HTML-report case (the XSS variant below) runs
 * later in the same suite and leaves its own file behind in the same
 * directory.
 */
async function testCoverageHtmlReportWritesFileInsteadOfWebview(ctx: UtplsqlContext, pkg: vscode.TestItem): Promise<void> {
    await vscode.workspace.getConfiguration('utplsql').update('coverage.htmlReport', true, vscode.ConfigurationTarget.Global);
    const tabsBefore = vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
    const before = listCoverageHtmlFiles();
    const cts = new vscode.CancellationTokenSource();
    try {
        await withExcludedFramework(() => runCoverage(ctx, new vscode.TestRunRequest([pkg]), cts.token));
    } finally {
        cts.dispose();
        await vscode.workspace.getConfiguration('utplsql').update('coverage.htmlReport', false, vscode.ConfigurationTarget.Global);
    }

    assert.equal(vscode.window.tabGroups.all.flatMap((g) => g.tabs).length, tabsBefore, 'no webview panel/tab should be created');
    const after = listCoverageHtmlFiles();
    const newFiles = [...after].filter((f) => !before.has(f));
    assert.equal(newFiles.length, 1, `expected exactly one new utplsql-coverage-*.html file under the OS temp dir, got: ${JSON.stringify(newFiles)}`);
    const content = fs.readFileSync(path.join(os.tmpdir(), newFiles[0]), 'utf8');
    assert.ok(content.includes('Content-Security-Policy'), 'expected the hardened CSP meta tag in the written file');
}

/**
 * A coverage run over a schema containing an object whose name is a quoted
 * identifier: test_xss_pkg's payload-named dependency
 * (test/integration/support/xssFixture.sql).
 *
 * Written originally to prove the payload reached disk verbatim, on the
 * assumption that ut_coverage_html_reporter passes its input through
 * unescaped. The first real run refuted both halves of that. utPLSQL 3.2.3
 * escapes its output (test/integration/coverage.test.ts pins that at the DB
 * level). And the payload never got that far anyway: the derived coverage
 * scope put the object into a_include_objects, realtimeDao's
 * validateIdentifier refused the name while building the SQL, and the entire
 * coverage run failed with "invalid include object" -- so one legally-named
 * Oracle object cost coverage for everything else in the schema.
 *
 * computeCoverageScope now drops such a name from the derived set and
 * reports it, which is what this case pins: the run completes, the report is
 * a file with the hardened CSP and no webview anywhere on the path, and the
 * user is told which object was left out and why.
 */
async function testCoverageHtmlReportPreservesXssPayload(ctx: UtplsqlContext, xssPkg: vscode.TestItem): Promise<void> {
    await vscode.workspace.getConfiguration('utplsql').update('coverage.htmlReport', true, vscode.ConfigurationTarget.Global);
    const before = listCoverageHtmlFiles();
    const cts = new vscode.CancellationTokenSource();
    // The extension reports a failed coverage run into its output channel and
    // carries on, so without capturing it a failure here is just "no file",
    // with no way to tell a broken run apart from a reporter that produced
    // nothing. Captured for the assertion message only.
    const logged: string[] = [];
    const originalAppendLine = ctx.output.appendLine.bind(ctx.output);
    ctx.output.appendLine = (value: string): void => {
        logged.push(value);
        originalAppendLine(value);
    };
    try {
        // withExcludedFramework, exactly as the case above: this fixture
        // installs utPLSQL into the same schema as the tests, so without
        // excluding UT/UT_EXPECTATION the derived coverage scope swallows the
        // framework itself.
        await withExcludedFramework(() => runCoverage(ctx, new vscode.TestRunRequest([xssPkg]), cts.token));
    } finally {
        ctx.output.appendLine = originalAppendLine;
        cts.dispose();
        await vscode.workspace.getConfiguration('utplsql').update('coverage.htmlReport', false, vscode.ConfigurationTarget.Global);
    }

    const after = listCoverageHtmlFiles();
    const newFiles = [...after].filter((f) => !before.has(f));
    assert.equal(
        newFiles.length,
        1,
        `expected exactly one new utplsql-coverage-*.html file for the XSS-fixture run, got: ${JSON.stringify(newFiles)}.` +
            ` Extension output during the run:\n${logged.join('\n')}`
    );
    const content = fs.readFileSync(path.join(os.tmpdir(), newFiles[0]), 'utf8');
    assert.ok(content.includes('Content-Security-Policy'), 'expected the hardened CSP meta tag in the written file');

    // The object was dropped deliberately and the user was told why. A
    // silent drop would be worse than the crash it replaced: coverage would
    // simply be missing for that object with nothing to explain it.
    assert.ok(
        logged.some((line) => line.includes(XSS_PAYLOAD) && line.includes('not a plain identifier')),
        `expected the run to report excluding the payload-named object from the coverage scope. Output was:\n${logged.join('\n')}`
    );

    // Excluded from the scope means absent from the report -- neither
    // verbatim nor escaped. The point of this case is that the *run*
    // survives a hostile object name, not that the name reaches disk.
    assert.ok(
        !content.includes(XSS_PAYLOAD),
        'the payload-named object is excluded from the coverage scope, so it must not appear in the report at all'
    );
}

/**
 * Issue #15's cache-ordering fix (src/db/utplsqlDao.ts's dbaViewAccessible
 * map, now keyed by profile), exercised end-to-end through runCoverage
 * instead of the raw DAO calls test/integration/dbaView.test.ts already
 * covers. Folded into this coverage group rather than the discovery/caching
 * one: buildCoverageOptions (coverage.ts) is the actual call site most of
 * this issue's impact section is about (dao.includes/getPackageObjectTypes
 * both take the dba_/all_-deciding path).
 *
 * Needs a second, deliberately unprivileged DB user that test/integration's
 * own fixture does not provision (see test/integration/support/db.ts's
 * UNPRIV_TEST_USER doc comment) — self-skips (a console message, not a
 * failure) when UTPLSQL_IT_UNPRIV_USER/UTPLSQL_IT_UNPRIV_PASSWORD are unset,
 * the same condition test/integration/dbaView.test.ts skips itself on via
 * mocha's this.skip(); this file's cases are plain functions in a custom
 * run()/failure-collection loop with no equivalent skip state, so an early
 * return (logged, not thrown) is the closest honest equivalent.
 */
async function testCrossProfileDbaViewCacheOrderingDoesNotBreakCoverage(
    ctx: UtplsqlContext,
    connInfo: { user: string; password: string; connectString: string; owner: string },
    packageLabel: string
): Promise<void> {
    const unprivUser = process.env.UTPLSQL_IT_UNPRIV_USER;
    const unprivPassword = process.env.UTPLSQL_IT_UNPRIV_PASSWORD;
    if (!unprivUser || !unprivPassword) {
        console.log('[e2e] SKIP: cross-profile dba-view cache ordering — UTPLSQL_IT_UNPRIV_USER/UTPLSQL_IT_UNPRIV_PASSWORD not set');
        return;
    }

    const unprivProfileName = 'e2e-test-coverage-unpriv';
    const cfg = vscode.workspace.getConfiguration('utplsql');
    const previousConnections = cfg.get<Array<Record<string, unknown>>>('connections', []);
    await cfg.update(
        'connections',
        [...previousConnections, { name: unprivProfileName, user: unprivUser, connectString: connInfo.connectString, defaultSchema: connInfo.owner }],
        vscode.ConfigurationTarget.Global
    );
    await ctx.secrets.store(`utplsql.password.${unprivProfileName}`, unprivPassword);

    const lines: string[] = [];
    const originalAppendLine = ctx.output.appendLine.bind(ctx.output);
    ctx.output.appendLine = (value: string): void => {
        lines.push(value);
        originalAppendLine(value);
    };

    try {
        // The privileged profile's schema was already resolved long before
        // this case runs (testExplorer.e2e.test.ts's own setup does this
        // before any case starts) — that ordering (privileged probed first)
        // is exactly the adversarial one issue #15 describes: a profile-
        // unaware cache would let that decide dba_ for every profile,
        // including the unprivileged one resolved below.
        await resolveItem(ctx.controller, undefined);
        const unprivRoot = findChild(ctx.controller.items, unprivProfileName);
        assert.ok(unprivRoot, `no root TestItem for the unprivileged profile '${unprivProfileName}'`);

        await resolveItem(ctx.controller, unprivRoot!);
        const unprivSchema = findChild(unprivRoot!.children, connInfo.owner);
        assert.ok(unprivSchema, `no schema TestItem for '${connInfo.owner}' via the unprivileged profile`);

        await resolveItem(ctx.controller, unprivSchema!);
        const unprivPkg = findChild(unprivSchema!.children, packageLabel);
        assert.ok(unprivPkg, `fixture package '${packageLabel}' not found via the unprivileged profile`);

        const cts = new vscode.CancellationTokenSource();
        try {
            await assert.doesNotReject(
                runCoverage(ctx, new vscode.TestRunRequest([unprivPkg!]), cts.token),
                "expected a coverage run against the unprivileged profile to complete without throwing, even though the privileged profile's schema resolved first"
            );
        } finally {
            cts.dispose();
        }
    } finally {
        ctx.output.appendLine = originalAppendLine;
    }

    const ora00942Lines = lines.filter((l) => /ORA-00942/.test(l));
    assert.equal(
        ora00942Lines.length,
        0,
        `expected no ORA-00942 ('table or view does not exist') from the unprivileged profile being forced onto dba_ views instead of all_, got: ${JSON.stringify(ora00942Lines)}`
    );
}

export function buildCoverageCases(
    ctx: UtplsqlContext,
    schema: vscode.TestItem,
    pkg: vscode.TestItem,
    workspaceUri: vscode.Uri,
    connInfo: { user: string; password: string; connectString: string; owner: string },
    packageLabel: string
): Array<[string, () => Promise<void>]> {
    const coverageLocalTestPkg = findChild(schema.children, 'utplsql-vsc coverage e2e fixture');
    const xssPkg = findChild(schema.children, 'utplsql-vsc coverage html-reporter XSS passthrough fixture');
    const localFileUri = vscode.Uri.joinPath(workspaceUri, 'coverage_local_pkg.pkb');

    return [
        [
            'coverage maps a package with a local workspace file, splits executed/unexecuted statements, and drops an unmapped dependency plus the test package itself instead of inventing bogus FileCoverage entries',
            () => {
                assert.ok(coverageLocalTestPkg, "fixture package 'utplsql-vsc coverage e2e fixture' not found under the schema — did installFixture run?");
                return testLocalFileMappingDetailAndDroppedUnmapped(ctx, coverageLocalTestPkg!, localFileUri);
            }
        ],
        ['coverage falls back to a virtual utplsql-source:// document for a package with no local file, openable via the registered content provider', () => testVirtualSourceFallbackForUnmappedPackage(ctx, pkg)],
        ['cancelling a coverage run mid-stream attaches no coverage and leaves the pool usable for a subsequent coverage run', () => testCancellingCoverageRunLeavesStateUsable(ctx, pkg)],
        ['utplsql.coverage.reporter = cobertura produces additional, non-empty Cobertura XML via the (stubbed) save dialog', () => testCoberturaAdditionalReporterProducesFile(ctx, pkg)],
        ['the coverage HTML report is written to a temp file instead of an extension-host webview panel/tab', () => testCoverageHtmlReportWritesFileInsteadOfWebview(ctx, pkg)],
        [
            'a coverage run survives a schema object whose name is not a plain identifier, excluding just that object and saying so',
            () => {
                assert.ok(xssPkg, "fixture package 'utplsql-vsc coverage html-reporter XSS passthrough fixture' not found under the schema — did installXssFixture run?");
                return testCoverageHtmlReportPreservesXssPayload(ctx, xssPkg!);
            }
        ],
        [
            "a privileged profile's schema resolved first does not break a coverage run against the same schema via an unprivileged profile (issue #15)",
            () => testCrossProfileDbaViewCacheOrderingDoesNotBreakCoverage(ctx, connInfo, packageLabel)
        ]
    ];
}
