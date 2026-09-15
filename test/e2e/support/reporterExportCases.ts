import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';
import { UtplsqlContext } from '../../../src/testing/model';
import { runReporterExport } from '../../../src/testing/reporterProfile';

/**
 * Issue #98: utplsql.runWithReporter's coverage-reporter export
 * (ut_coverage_html_reporter/ut_coverage_sonar_reporter/
 * ut_coverage_cobertura_reporter) had no end-to-end coverage before this
 * file — everything that only exists inside a real extension host (the
 * "Export with Reporter" run profile's TestRun.errored/appendOutput calls,
 * the QuickPick flow, cancellation against a real streaming export) was
 * only exercised indirectly through test/integration/reporter.test.ts's raw
 * DAO calls. Built the same way coverageCases.ts factors its own coherent
 * group of cases: a `buildReporterExportCases` function returning `[name,
 * fn]` pairs for testExplorer.e2e.test.ts's own run()/failure-collection
 * loop.
 *
 * Reuses coverageCases.ts's fixture pair (coverage_local_pkg has a local
 * workspace file; calc_pkg/`pkg` does not) rather than adding a third one,
 * and the same utplsql.coverage.excludeObjects trick to keep the UT/
 * UT_EXPECTATION framework packages out of the derived scope.
 */

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

/**
 * runReporterExport prompts twice via vscode.window.showQuickPick (reporter,
 * then output target) before ever touching a connection — a real,
 * interactive dialog that would hang a headless run forever. vscode.window
 * is a namespace, not an interface (see coverageCases.ts's
 * testCoberturaAdditionalReporterProducesFile for the same cast reasoning),
 * so both prompts are answered by one stub that tells apart the reporter
 * QuickPick (its items are {label, description} objects, per
 * reporterProfile.ts's own QuickPickItem mapping) from the output-target one
 * (a plain ['Show in Output Channel', 'Save to File'] string array) purely
 * by shape.
 */
function stubReporterAndTargetPicks(reporterLabelIncludes: string): () => void {
    const original = vscode.window.showQuickPick;
    (vscode.window as unknown as { showQuickPick: typeof vscode.window.showQuickPick }).showQuickPick = (async (items: unknown) => {
        const resolved = (Array.isArray(items) ? items : await items) as unknown[];
        if (resolved.length > 0 && typeof resolved[0] === 'string') {
            return (resolved as string[]).find((s) => s === 'Show in Output Channel');
        }
        const objs = resolved as Array<{ label: string }>;
        return objs.find((o) => o.label.toUpperCase().includes(reporterLabelIncludes.toUpperCase()));
    }) as typeof vscode.window.showQuickPick;
    return () => {
        (vscode.window as unknown as { showQuickPick: typeof vscode.window.showQuickPick }).showQuickPick = original;
    };
}

interface CapturedExportRun {
    outputs: string[];
    erroredMessages: string[];
}

/**
 * runReporterExport creates its own TestRun internally and never hands it
 * back to the caller — same "there is no read-back API, so wrap the method"
 * mechanic coverageCases.ts's runCoverageCaptured uses for addCoverage, here
 * for appendOutput (the exported report text) and errored (the fail-fast
 * message for a reporter pick with no resolvable dependencies).
 */
async function runReporterExportCaptured(
    ctx: UtplsqlContext,
    items: vscode.TestItem[],
    reporterLabelIncludes: string,
    token: vscode.CancellationToken
): Promise<CapturedExportRun> {
    const outputs: string[] = [];
    const erroredMessages: string[] = [];

    const originalCreateTestRun = ctx.controller.createTestRun.bind(ctx.controller);
    ctx.controller.createTestRun = (request, name, persist) => {
        const run = originalCreateTestRun(request, name, persist);
        const originalAppendOutput = run.appendOutput.bind(run);
        run.appendOutput = (output: string, location?: vscode.Location, testItem?: vscode.TestItem): void => {
            outputs.push(output);
            originalAppendOutput(output, location, testItem);
        };
        const originalErrored = run.errored.bind(run);
        run.errored = (testItem: vscode.TestItem, message: vscode.TestMessage | readonly vscode.TestMessage[], duration?: number): void => {
            for (const m of Array.isArray(message) ? message : [message]) {
                erroredMessages.push(typeof m.message === 'string' ? m.message : String(m.message));
            }
            originalErrored(testItem, message, duration);
        };
        return run;
    };

    const unstub = stubReporterAndTargetPicks(reporterLabelIncludes);
    try {
        await runReporterExport(ctx, new vscode.TestRunRequest(items), token);
    } finally {
        unstub();
        ctx.controller.createTestRun = originalCreateTestRun;
    }
    return { outputs, erroredMessages };
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

/**
 * ut_coverage_sonar_reporter, picked via the "Export with Reporter" profile
 * for a package with a local workspace file: the exported text must be
 * well-formed SonarQube generic coverage XML with a non-empty <file> list —
 * the exact shape the export path could never produce before issue #98,
 * since it never sent a_source_file_mappings for any reporter.
 */
async function testSonarExportProducesWellFormedXmlWithFileEntries(ctx: UtplsqlContext, coverageLocalTestPkg: vscode.TestItem): Promise<void> {
    const cts = new vscode.CancellationTokenSource();
    let captured: CapturedExportRun;
    try {
        captured = await withExcludedFramework(() => runReporterExportCaptured(ctx, [coverageLocalTestPkg], 'SONAR', cts.token));
    } finally {
        cts.dispose();
    }

    assert.equal(captured.erroredMessages.length, 0, `expected no errored items, got: ${JSON.stringify(captured.erroredMessages)}`);
    const xmlOutput = captured.outputs.find((o) => /<coverage[\s>]/i.test(o));
    assert.ok(xmlOutput, `expected one appendOutput call to carry Sonar coverage XML, got: ${JSON.stringify(captured.outputs)}`);

    const doc = xmlParser.parse(xmlOutput!) as Record<string, unknown>;
    const root = doc.coverage as Record<string, unknown> | undefined;
    assert.ok(root, 'expected a <coverage> root element');
    const files = root!.file;
    const fileList = Array.isArray(files) ? files : [files];
    assert.ok(fileList.length > 0 && fileList[0] !== undefined, 'expected at least one <file> entry in the exported Sonar XML');
}

/** Same export, ut_coverage_cobertura_reporter — a different XML dialect (a <coverage> root with <packages>/<classes>, not <file>), so this only pins non-empty, well-formed-looking output rather than Sonar's specific shape. */
async function testCoberturaExportProducesNonEmptyOutput(ctx: UtplsqlContext, coverageLocalTestPkg: vscode.TestItem): Promise<void> {
    const cts = new vscode.CancellationTokenSource();
    let captured: CapturedExportRun;
    try {
        captured = await withExcludedFramework(() => runReporterExportCaptured(ctx, [coverageLocalTestPkg], 'COBERTURA', cts.token));
    } finally {
        cts.dispose();
    }

    assert.equal(captured.erroredMessages.length, 0, `expected no errored items, got: ${JSON.stringify(captured.erroredMessages)}`);
    const xmlOutput = captured.outputs.find((o) => /<coverage[\s>]/i.test(o));
    assert.ok(xmlOutput, `expected one appendOutput call to carry Cobertura coverage XML, got: ${JSON.stringify(captured.outputs)}`);
}

/** ut_coverage_html_reporter — an HTML document rather than XML; only non-emptiness is checked. */
async function testHtmlExportProducesNonEmptyOutput(ctx: UtplsqlContext, coverageLocalTestPkg: vscode.TestItem): Promise<void> {
    const cts = new vscode.CancellationTokenSource();
    let captured: CapturedExportRun;
    try {
        captured = await withExcludedFramework(() => runReporterExportCaptured(ctx, [coverageLocalTestPkg], 'HTML', cts.token));
    } finally {
        cts.dispose();
    }

    assert.equal(captured.erroredMessages.length, 0, `expected no errored items, got: ${JSON.stringify(captured.erroredMessages)}`);
    const htmlOutput = captured.outputs.find((o) => o.length > 200);
    assert.ok(htmlOutput, `expected one appendOutput call to carry a non-trivial HTML report, got lengths: ${captured.outputs.map((o) => o.length)}`);
}

/**
 * `pkg` (calc_pkg/test_calc_pkg) has no local workspace file anywhere in
 * this run — the DB-as-sole-source-of-truth case computeCoverageExportScope
 * shares with the live "Run with Coverage" profile via resolveFileMappings'
 * virtual utplsql-source:// fallback. Exporting coverage for it must still
 * produce a real report instead of an empty a_source_file_mappings.
 */
async function testExportSucceedsWithNoLocalFile(ctx: UtplsqlContext, pkg: vscode.TestItem): Promise<void> {
    const cts = new vscode.CancellationTokenSource();
    let captured: CapturedExportRun;
    try {
        captured = await withExcludedFramework(() => runReporterExportCaptured(ctx, [pkg], 'SONAR', cts.token));
    } finally {
        cts.dispose();
    }

    assert.equal(captured.erroredMessages.length, 0, `expected no errored items, got: ${JSON.stringify(captured.erroredMessages)}`);
    const xmlOutput = captured.outputs.find((o) => /<coverage[\s>]/i.test(o));
    assert.ok(xmlOutput, `expected non-empty Sonar coverage XML for a package with no local workspace file, got: ${JSON.stringify(captured.outputs)}`);
}

/**
 * Same shape as coverageCases.ts's testCancellingCoverageRunLeavesStateUsable,
 * one level up: cancelling a coverage-reporter *export* mid-stream must end
 * cleanly (no ORA-20215, no wedged connection) and leave the pool usable for
 * a subsequent, uncancelled export on the same profile — the pool-recycle
 * contract runWithReporterDao's doc comment (reporterDao.ts) describes.
 * `pkg` (the whole calc_pkg suite, including a ~2s test_slow) gives a wide,
 * reliable window in which the export is genuinely still streaming when
 * cancellation fires, the same reasoning testCancellationLeavesStateUsable
 * (testExplorer.e2e.test.ts) and testCancellingCoverageRunLeavesStateUsable
 * (coverageCases.ts) use.
 */
async function testCancellingExportLeavesStateUsable(ctx: UtplsqlContext, pkg: vscode.TestItem): Promise<void> {
    const cts = new vscode.CancellationTokenSource();
    const cancelledExport = withExcludedFramework(() => runReporterExportCaptured(ctx, [pkg], 'SONAR', cts.token));
    await new Promise((resolve) => setTimeout(resolve, 300));
    cts.cancel();
    const captured = await cancelledExport;
    cts.dispose();

    assert.ok(
        captured.outputs.some((o) => /export cancelled/.test(o)),
        `expected a "... export cancelled ..." line, got: ${JSON.stringify(captured.outputs)}`
    );
    assert.ok(
        !captured.outputs.some((o) => /<coverage[\s>]/i.test(o)),
        'a cancelled export must not present a truncated report as if it were the finished one'
    );

    const cts2 = new vscode.CancellationTokenSource();
    try {
        const after = await runReporterExportCaptured(ctx, [pkg], 'UT_DOCUMENTATION', cts2.token);
        assert.equal(after.erroredMessages.length, 0, `expected the follow-up plain-text export to succeed, got: ${JSON.stringify(after.erroredMessages)}`);
        assert.ok(
            after.outputs.some((o) => o.length > 0),
            'expected a subsequent, uncancelled plain-text export on the same profile to still produce output'
        );
    } finally {
        cts2.dispose();
    }
}

/**
 * A coverage reporter pick whose derived scope has no resolvable
 * dependencies must fail fast with a clear error instead of attempting a
 * run doomed to time out. utplsql.coverage.includeObjects, when non-empty,
 * replaces the *_dependencies-derived include set entirely (computeCoverageScope,
 * coverageScope.ts) — pointed at a name that exists nowhere lets this case
 * force an empty a_source_file_mappings deterministically, independent of
 * `pkg`'s real dependency graph.
 */
async function testFailsFastWithNoResolvableDependencies(ctx: UtplsqlContext, pkg: vscode.TestItem): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('utplsql');
    const previous = cfg.get<string[]>('coverage.includeObjects');
    await cfg.update('coverage.includeObjects', ['UTPLSQL_VSC_DOES_NOT_EXIST'], vscode.ConfigurationTarget.Global);

    const cts = new vscode.CancellationTokenSource();
    let captured: CapturedExportRun;
    try {
        captured = await runReporterExportCaptured(ctx, [pkg], 'SONAR', cts.token);
    } finally {
        cts.dispose();
        await cfg.update('coverage.includeObjects', previous, vscode.ConfigurationTarget.Global);
    }

    assert.ok(
        captured.erroredMessages.some((m) => /no resolvable dependencies/.test(m)),
        `expected a "no resolvable dependencies" error, got: ${JSON.stringify(captured.erroredMessages)}`
    );
    assert.ok(
        !captured.outputs.some((o) => /<coverage[\s>]/i.test(o)),
        'expected no report to be produced once the coverage scope was found to be empty'
    );
}

export function buildReporterExportCases(ctx: UtplsqlContext, schema: vscode.TestItem, pkg: vscode.TestItem): Array<[string, () => Promise<void>]> {
    const coverageLocalTestPkg = findChild(schema.children, 'utplsql-vsc coverage e2e fixture');

    return [
        [
            'Export with Reporter — ut_coverage_sonar_reporter produces well-formed Sonar XML with a non-empty <file> list (issue #98)',
            () => {
                assert.ok(coverageLocalTestPkg, "fixture package 'utplsql-vsc coverage e2e fixture' not found under the schema — did installFixture run?");
                return testSonarExportProducesWellFormedXmlWithFileEntries(ctx, coverageLocalTestPkg!);
            }
        ],
        [
            'Export with Reporter — ut_coverage_cobertura_reporter produces non-empty coverage XML (issue #98)',
            () => {
                assert.ok(coverageLocalTestPkg, "fixture package 'utplsql-vsc coverage e2e fixture' not found under the schema — did installFixture run?");
                return testCoberturaExportProducesNonEmptyOutput(ctx, coverageLocalTestPkg!);
            }
        ],
        [
            'Export with Reporter — ut_coverage_html_reporter produces a non-empty HTML report (issue #98)',
            () => {
                assert.ok(coverageLocalTestPkg, "fixture package 'utplsql-vsc coverage e2e fixture' not found under the schema — did installFixture run?");
                return testHtmlExportProducesNonEmptyOutput(ctx, coverageLocalTestPkg!);
            }
        ],
        [
            'Export with Reporter — a coverage export for a package with no local workspace file still succeeds via the virtual utplsql-source:// mapping (issue #98)',
            () => testExportSucceedsWithNoLocalFile(ctx, pkg)
        ],
        [
            'Export with Reporter — cancelling a coverage export mid-stream ends cleanly and leaves the pool usable for a subsequent export (issue #98)',
            () => testCancellingExportLeavesStateUsable(ctx, pkg)
        ],
        [
            'Export with Reporter — a coverage reporter pick with no resolvable dependencies fails fast instead of timing out (issue #98)',
            () => testFailsFastWithNoResolvableDependencies(ctx, pkg)
        ]
    ];
}
