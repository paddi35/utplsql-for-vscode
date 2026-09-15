import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { Connection } from 'oracledb';
import { XMLParser } from 'fast-xml-parser';
import { getPool } from '../db/pool';
import { getProfile } from '../db/connections';
import * as dao from '../db/utplsqlDao';
import { CoverageOptions } from '../db/realtimeDao';
import { UtplsqlContext } from './model';
import { virtualSourceUri } from '../workspace/virtualSource';
import { groupRequest, runOneProfile, readRandomOrderConfig } from './runHandler';
import { withContentSecurityPolicy } from './coverageHtml';
import { computeCoverageScope, CoverageScopeItem, ObjectRef } from './coverageScope';
import { sharedObjectTypeCache } from './objectTypeCache';
import { measure } from '../perf';

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function asArray<T>(v: T | T[] | undefined): T[] {
    if (v === undefined) return [];
    return Array.isArray(v) ? v : [v];
}

interface FileLineHits {
    uri: vscode.Uri;
    lines: Map<number, boolean>;
}

/**
 * Parses ut_coverage_sonar_reporter's SonarQube generic coverage XML:
 * <coverage version="1"><file path="..."><lineToCover lineNumber="n" covered="true|false"/></file></coverage>
 *
 * pathToUri gates which <file path="..."> entries are trusted: when an
 * executed object has no matching a_source_file_mappings entry, the reporter
 * doesn't omit it — it falls back to a synthetic default path of its own
 * devising, observed as e.g. "package ut3.calc_pkg" against a live utPLSQL
 * 3.2.3 instance. Treating that as a real path used to make it show up as a
 * bogus FileCoverage entry that VS Code then fails to open ("Unable to open
 * 'package ut3.calc_pkg'") when the user inspects it. buildCoverageOptions
 * builds this map (local workspace URI or virtual DB-source URI, see
 * workspace/virtualSource.ts) for every path it actually sent, so anything
 * else is dropped (and logged) instead of resolved.
 */
function parseSonarCoverage(xml: string, pathToUri: ReadonlyMap<string, vscode.Uri>, onUnknownPath: (path: string) => void): FileLineHits[] {
    const doc = xmlParser.parse(xml) as Record<string, unknown>;
    const root = doc.coverage as Record<string, unknown> | undefined;
    if (!root) {
        return [];
    }
    const files = asArray(root.file as Record<string, unknown> | Record<string, unknown>[]);
    const result: FileLineHits[] = [];
    for (const file of files) {
        const path = String((file as Record<string, unknown>)['@_path'] ?? '');
        const uri = pathToUri.get(path);
        if (!uri) {
            onUnknownPath(path);
            continue;
        }
        const lines = new Map<number, boolean>();
        for (const l of asArray((file as Record<string, unknown>).lineToCover as Record<string, unknown> | Record<string, unknown>[])) {
            const lineNumber = Number((l as Record<string, unknown>)['@_lineNumber']);
            const covered = String((l as Record<string, unknown>)['@_covered']) === 'true';
            if (!Number.isNaN(lineNumber)) {
                lines.set(lineNumber, covered);
            }
        }
        result.push({ uri, lines });
    }
    return result;
}

const detailedCoverage = new WeakMap<vscode.TestRun, Map<string, vscode.StatementCoverage[]>>();

export async function runCoverage(ctx: UtplsqlContext, request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    const run = ctx.controller.createTestRun(request);
    const detailByUri = new Map<string, vscode.StatementCoverage[]>();
    detailedCoverage.set(run, detailByUri);
    const { randomOrder, randomOrderSeed } = readRandomOrderConfig();
    const htmlReportEnabled = vscode.workspace.getConfiguration('utplsql').get<boolean>('coverage.htmlReport');
    const reportsDir = vscode.Uri.joinPath(ctx.globalStorageUri, 'coverage-reports');
    try {
        if (htmlReportEnabled) {
            // Once per run, before any profile is processed — see
            // clearPreviousReports' own doc comment for why this can't
            // instead happen inside showHtmlReport, which runs once per
            // profile. Inside this try/finally (unlike the rest of the
            // function's setup above) so a failure here — e.g. reportsDir
            // can't be created — still reaches run.end() instead of leaving
            // the TestRun stuck "in progress" in the Test Explorer forever.
            await vscode.workspace.fs.createDirectory(reportsDir);
            await clearPreviousReports(ctx, reportsDir);
        }
        const grouped = await groupRequest(ctx, request);
        for (const [profile, group] of grouped) {
            if (token.isCancellationRequested) {
                group.items.forEach((i) => run.skipped(i));
                continue;
            }
            const built = await buildCoverageOptions(ctx, profile, group.items);
            const result = await runOneProfile(ctx, run, profile, group.items, group.paths, token, {
                coverage: built?.options,
                randomOrder,
                randomOrderSeed
            });
            if (result.coverageXml) {
                applyCoverage(ctx, run, detailByUri, result.coverageXml, built?.pathToUri ?? new Map());
            }
            if (result.htmlReport && htmlReportEnabled) {
                await showHtmlReport(ctx, result.htmlReport, reportsDir);
            }
            if (result.additionalCoverageXml) {
                await offerAdditionalCoverageFile(ctx, result.additionalCoverageXml);
            }
        }
    } finally {
        run.end();
    }
}

/**
 * utplsql.coverage.reporter = 'cobertura' runs ut_coverage_cobertura_reporter
 * alongside the sonar reporter the native Coverage view needs (see
 * CoverageOptions.additionalReporter) — offered as a save-to-file here,
 * since there is no native VS Code view for Cobertura XML to feed instead.
 */
async function offerAdditionalCoverageFile(ctx: UtplsqlContext, xml: string): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
        filters: { 'Cobertura XML': ['xml'] },
        saveLabel: 'Save Cobertura Coverage Report'
    });
    if (!uri) {
        return;
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(xml, 'utf8'));
    ctx.output.appendLine(`utPLSQL: Cobertura coverage report saved to ${uri.fsPath}`);
}

interface BuiltCoverage {
    options: CoverageOptions;
    pathToUri: Map<string, vscode.Uri>;
}

/**
 * Resolves owner.name pairs to source-file-mapping entries: a local
 * workspace file where the sourceIndex has one, otherwise a virtual
 * DB-source fallback. The DB fallback's object-type lookup is batched one
 * query per owner (via dao.getPackageObjectTypes, the same helper
 * controller.ts's resolveVirtualTypes uses) instead of one query per object:
 * a single oracledb Connection doesn't support concurrent execute() calls,
 * so Promise.all-ing a per-object dao.getPackageObjectType isn't a safe way
 * to avoid N sequential round trips — batching the bind list is. This
 * matters most for a project with no local source at all (the DB is the
 * sole source of truth), where every object previously fell through to its
 * own round trip.
 */
async function resolveFileMappings(
    ctx: UtplsqlContext,
    scopeConn: Connection,
    profile: string,
    objects: Iterable<{ owner: string; name: string }>
): Promise<{ fileMappings: CoverageOptions['fileMappings']; pathToUri: Map<string, vscode.Uri> }> {
    const fileMappings: CoverageOptions['fileMappings'] = [];
    const pathToUri = new Map<string, vscode.Uri>();

    const localByKey = new Map<string, { mapping: CoverageOptions['fileMappings'][number]; uri: vscode.Uri }>();
    const needsLookup = new Map<string, Set<string>>(); // owner -> object names still needing a DB round trip
    const uniqueObjects = [...objects];

    for (const { owner, name } of uniqueObjects) {
        const loc = ctx.sourceIndex.lookupPackage(name);
        if (loc) {
            const file = vscode.workspace.asRelativePath(loc.uri, false).replace(/\\/g, '/');
            ctx.output.appendLine(`utPLSQL: coverage — mapped '${owner}.${name}' to local file '${file}'`);
            localByKey.set(`${owner}.${name}`, { mapping: { file, owner, name, type: loc.isBody ? 'PACKAGE BODY' : 'PACKAGE' }, uri: loc.uri });
            continue;
        }
        const names = needsLookup.get(owner) ?? new Set<string>();
        names.add(name);
        needsLookup.set(owner, names);
    }

    // No local workspace file for these (e.g. this project keeps the DB as
    // the sole source of truth) — fall back to a virtual, DB-backed document
    // instead of dropping them from coverage entirely, so native gutters/the
    // Test Coverage panel still get something to point at.
    // Through the same cache controller.ts fills while materializing the
    // tree (issue #22), not a direct dao call: a coverage run asks about
    // objects the Test Explorer has usually just resolved, so this is
    // normally answered without a round trip at all. Sharing the instance
    // is what makes that safe -- refreshHandler and a profile change clear
    // it, which a cache private to this module would never see.
    const dbTypeByKey = new Map<string, 'PACKAGE BODY' | 'PACKAGE'>();
    for (const [owner, names] of needsLookup) {
        const types = await sharedObjectTypeCache.resolve(profile, owner, [...names], (toFetch) =>
            dao.getPackageObjectTypes(scopeConn, owner, toFetch, profile)
        );
        types.forEach((type, objectName) => dbTypeByKey.set(`${owner}.${objectName}`, type));
    }

    for (const { owner, name } of uniqueObjects) {
        const key = `${owner}.${name}`;
        const local = localByKey.get(key);
        if (local) {
            fileMappings.push(local.mapping);
            pathToUri.set(local.mapping.file, local.uri);
            continue;
        }
        const objType = dbTypeByKey.get(`${owner}.${name.toUpperCase()}`);
        if (!objType) {
            ctx.output.appendLine(
                `utPLSQL: coverage — '${owner}.${name}' has neither a local file nor a PACKAGE/PACKAGE BODY in the database, excluding it from the coverage file mappings`
            );
            continue;
        }
        const isBody = objType === 'PACKAGE BODY';
        const uri = virtualSourceUri(profile, owner, name, isBody);
        const file = `${owner}/${name}.${isBody ? 'pkb' : 'pks'}`;
        ctx.output.appendLine(`utPLSQL: coverage — no local source file for '${owner}.${name}', mapped to virtual DB source '${file}'`);
        fileMappings.push({ file, owner, name, type: objType });
        pathToUri.set(file, uri);
    }

    return { fileMappings, pathToUri };
}

export interface CoverageExportScope {
    schemes: string[];
    includeObjects: string[];
    fileMappings: CoverageOptions['fileMappings'];
    /** The scope's own test packages, reported via a_test_file_mappings — see resolveFileMappings' caller below for why. */
    testFileMappings: CoverageOptions['fileMappings'];
    pathToUri: Map<string, vscode.Uri>;
    /** *_dependencies-derived names that couldn't be embedded in the generated PL/SQL — see computeCoverageScope's own doc comment (coverageScope.ts). Already logged to ctx.output by the time this returns; a caller only needs this to decide whether an empty/reduced scope should also fail fast. */
    unusableNames: ObjectRef[];
    includeSchemaExpr?: string;
    includeObjectExpr?: string;
    excludeSchemaExpr?: string;
    excludeObjectExpr?: string;
}

/**
 * The *_dependencies-derived scope and local-file/utplsql-source:// file
 * mapping resolution shared between the live "Run with Coverage" profile
 * (buildCoverageOptions below) and the coverage-reporter export path added
 * for issue #98 (utplsql.runWithReporter's command handler and
 * testing/reporterProfile.ts's runReporterExport) — both need exactly the
 * same scope computation, only the reporter(s) that end up consuming it
 * differ (ut_realtime_reporter + a coverage reporter for a live run, vs. a
 * single coverage reporter picked in a QuickPick for an export).
 */
export async function computeCoverageExportScope(
    ctx: UtplsqlContext,
    scopeConn: Connection,
    profile: string,
    scopeItems: Iterable<CoverageScopeItem>
): Promise<CoverageExportScope> {
    const coverageCfg = vscode.workspace.getConfiguration('utplsql.coverage');
    const scope = await computeCoverageScope(scopeItems, (owner, names) => dao.includes(scopeConn, owner, names, profile), {
        excludeObjects: coverageCfg.get<string[]>('excludeObjects', []),
        schemesOverride: coverageCfg.get<string[]>('schemes', []),
        includeObjectsOverride: coverageCfg.get<string[]>('includeObjects', [])
    });

    // Reported, not swallowed: an object dropped here really is missing from
    // the coverage result, and the reason (a name that cannot be written
    // into the generated PL/SQL) is not something the user could work out
    // from the numbers alone. Before this was filtered, such a name failed
    // the entire run at SQL-build time.
    for (const dropped of scope.unusableNames) {
        ctx.output.appendLine(
            `utPLSQL: coverage — excluding '${dropped.owner}.${dropped.name}' from the coverage scope: its name is not a plain identifier and cannot be passed to ut_runner.run`
        );
    }

    const { fileMappings, pathToUri } = await resolveFileMappings(ctx, scopeConn, profile, scope.includeObjects.values());
    // The test packages themselves are reported via a_test_file_mappings
    // instead of a_exclude_objects: utPLSQL distinguishes "this file is
    // test code" from "this file was not measured at all", which
    // SonarQube/Cobertura consumers treat differently.
    const { fileMappings: testFileMappings } = await resolveFileMappings(ctx, scopeConn, profile, scope.testObjects.values());

    return {
        schemes: scope.schemes,
        includeObjects: [...scope.includeObjects.values()].map((v) => v.name),
        fileMappings,
        testFileMappings,
        pathToUri,
        unusableNames: scope.unusableNames,
        includeSchemaExpr: coverageCfg.get<string>('includeSchemaExpr', '') || undefined,
        includeObjectExpr: coverageCfg.get<string>('includeObjectExpr', '') || undefined,
        excludeSchemaExpr: coverageCfg.get<string>('excludeSchemaExpr', '') || undefined,
        excludeObjectExpr: coverageCfg.get<string>('excludeObjectExpr', '') || undefined
    };
}

async function buildCoverageOptions(ctx: UtplsqlContext, profile: string, items: vscode.TestItem[]): Promise<BuiltCoverage | undefined> {
    const cfg = getProfile(profile);
    if (!cfg) {
        return undefined;
    }
    const coverageCfg = vscode.workspace.getConfiguration('utplsql.coverage');
    const pool = await getPool(cfg, ctx.secrets);
    const scopeConn = await pool.getConnection();
    try {
        return await measure(
            'buildCoverageOptions',
            async () => {
                // groupRequest (runHandler.ts) selects every path-bearing
                // descendant of the run request — suites, contexts *and*
                // tests, not just leaves — so the same package's object name
                // repeats here once per row. computeCoverageScope (issue
                // #21) is what turns that back into one *_dependencies query
                // per distinct owner instead of one per item; see its own
                // doc comment (coverageScope.ts) for the full reasoning.
                const scopeItems: CoverageScopeItem[] = [];
                for (const item of items) {
                    const meta = ctx.meta.get(item.id);
                    if (!meta?.row) {
                        continue;
                    }
                    scopeItems.push({ owner: meta.owner, objectName: meta.row.objectName });
                }

                const scope = await computeCoverageExportScope(ctx, scopeConn, profile, scopeItems);
                const additionalReporterSetting = coverageCfg.get<'sonar' | 'cobertura'>('reporter', 'sonar');

                return {
                    options: {
                        reporter: 'ut_coverage_sonar_reporter',
                        schemes: scope.schemes,
                        includeObjects: scope.includeObjects,
                        fileMappings: scope.fileMappings,
                        testFileMappings: scope.testFileMappings,
                        htmlReport: coverageCfg.get<boolean>('htmlReport', false),
                        additionalReporter: additionalReporterSetting === 'cobertura' ? 'ut_coverage_cobertura_reporter' : undefined,
                        includeSchemaExpr: scope.includeSchemaExpr,
                        includeObjectExpr: scope.includeObjectExpr,
                        excludeSchemaExpr: scope.excludeSchemaExpr,
                        excludeObjectExpr: scope.excludeObjectExpr
                    },
                    pathToUri: scope.pathToUri
                };
            },
            { items: items.length }
        );
    } finally {
        await scopeConn.close();
    }
}

function applyCoverage(
    ctx: UtplsqlContext,
    run: vscode.TestRun,
    detailByUri: Map<string, vscode.StatementCoverage[]>,
    xml: string,
    pathToUri: ReadonlyMap<string, vscode.Uri>
): void {
    const files = parseSonarCoverage(xml, pathToUri, (path) =>
        ctx.output.appendLine(
            `utPLSQL: coverage — ignoring file path '${path}' from the coverage report: it doesn't match any a_source_file_mappings entry we sent, likely the reporter's fallback name for an object whose local source file wasn't found`
        )
    );
    for (const file of files) {
        const statements = [...file.lines.entries()].map(
            ([line, covered]) => new vscode.StatementCoverage(covered, new vscode.Position(Math.max(0, line - 1), 0))
        );
        detailByUri.set(file.uri.toString(), statements);
        const coveredCount = statements.filter((s) => s.executed).length;
        const summary = new vscode.TestCoverageCount(coveredCount, statements.length);
        run.addCoverage(new vscode.FileCoverage(file.uri, summary));
    }
}

export async function loadDetailedCoverage(
    testRun: vscode.TestRun,
    fileCoverage: vscode.FileCoverage,
    _token: vscode.CancellationToken
): Promise<vscode.FileCoverageDetail[]> {
    return detailedCoverage.get(testRun)?.get(fileCoverage.uri.toString()) ?? [];
}

/**
 * Issue #13: ut_coverage_html_reporter's report is assembled by the database
 * from database-derived text (schema names, object names, verbatim package
 * source lines) that on a shared schema is not necessarily written by
 * whoever is viewing the report, and utPLSQL does not escape any of it (see
 * test/integration/coverage.test.ts's XSS-passthrough case). This used to
 * render the report in an extension-host webview with enableScripts: true —
 * needed because the report's own collapsible file/line view is driven by
 * its own inline <script>, so scripts could not just be turned off. A CSP of
 * default-src 'none'; script-src 'unsafe-inline' meant an injected <script>
 * in that report could still execute inside the webview, could still call
 * acquireVsCodeApi().postMessage(...) (harmless only because no message
 * handler was ever registered on the extension side), and could still
 * rewrite the panel's own DOM to impersonate extension UI — a CSP caps what
 * injected script can *send*, not what it can *run* or *whose surface it
 * runs on*.
 *
 * Of the three mitigations issue #13 lists — (1) stop executing the report
 * at all and hand it to the browser instead, (2) keep the webview but wrap
 * the report in a sandboxed <iframe srcdoc> without allow-same-origin so it
 * cannot reach acquireVsCodeApi(), (3) at minimum hardening REPORT_CSP and
 * stripping any competing policy the report carries — this implements (1),
 * the one the issue ranks first, plus (3) (see coverageHtml.ts's REPORT_CSP)
 * regardless, since it costs nothing extra once (1) is in place. (2) was
 * rejected here on implementation-risk grounds specific to this fix: getting
 * a <iframe srcdoc="..."> attribute-escaping wrong is exactly the class of
 * bug this issue is about, there is no Oracle instance available in this
 * environment to render a real report and confirm the escaping/sandboxing
 * actually holds, and (2) still leaves both the acquireVsCodeApi() hinge and
 * the DOM-rewrite risk standing on *some* code path (a same-document parent
 * frame two DOM nodes away) rather than removing them. (1) removes both
 * outright: a browser tab has no acquireVsCodeApi to reach and no extension
 * UI to impersonate, because neither exists there at all — nothing to get
 * subtly wrong. withContentSecurityPolicy() is still applied to the file
 * that gets written, so the parts of the containment that never depended on
 * "is this a webview" — no networking, no framing, no form/base
 * redirection — carry over unchanged; arguably they matter *more* now, since
 * a real browser has a real network stack where a bare webview mostly
 * doesn't.
 *
 * This does change user-visible behaviour: the report no longer opens
 * automatically beside the editor — viewing it now takes one extra click via
 * the notification below, and it opens in the OS browser instead of inside
 * VS Code. That trade-off is deliberate (see the issue), but it does leave
 * utplsql.coverage.htmlReport's package.json description ("...und in einem
 * Webview anzeigen") stale; updating it is out of this change's scope
 * (package.json is off limits here) and left for a follow-up.
 *
 * The file is written under ExtensionContext.globalStorageUri (threaded
 * through UtplsqlContext) rather than the OS temp directory: on Linux/macOS
 * os.tmpdir() is world-readable (/tmp is mode 1777), which would expose the
 * report's verbatim package source — not just coverage percentages — to any
 * other local account, while global storage lives under the user's own
 * profile. A fresh, randomly-named file per call still avoids collisions
 * between reports from different profiles/runs; unlike that, previous
 * reports under the same directory are removed once per run — by
 * runCoverage, before it starts iterating profiles — rather than once per
 * profile here in showHtmlReport. A run over N profiles calls this function
 * N times, each with its own still-open "report is ready" notification
 * (the choice below is fire-and-forget, not awaited); clearing here instead
 * of there would delete an earlier profile's report out from under its own
 * unanswered notification the moment a later profile's report is written,
 * so "Open in Browser" on that earlier notification would then fail. Once
 * per run instead still keeps at most one run's worth of reports lingering
 * between separate runs, instead of accumulating for the life of the
 * extension's storage. That still leaves a window within the same extension
 * host: two runs (a second run started before the user answers a still-open
 * "report is ready" notification from an earlier one) can interleave, and
 * the second run's clearPreviousReports would otherwise delete a file the
 * first run's notification still points at. pendingReportUris (below) closes
 * that by having clearPreviousReports skip any file this extension host has
 * written but not yet resolved (notification answered, dismissed, or
 * errored) — see showHtmlReport. It does not cover a second VS Code *window*
 * clearing the same globalStorageUri-backed directory from a separate
 * extension host process, which has no way to see this in-memory set; that
 * residual race is accepted, the same trade-off as sharing global storage
 * across windows in the first place.
 *
 * Only the write is awaited, not the notification/open/save that follows —
 * this function's caller (runCoverage) awaits it before calling run.end(),
 * and the original webview version never made the TestRun's completion
 * depend on anything the user does with the result: showHtmlReport() used
 * to be fire-and-forget and synchronous, opening the panel and returning
 * immediately. Awaiting the full interactive flow here (button choice, then
 * whichever of openExternal/showSaveDialog it leads to) would regress that:
 * the Test Explorer would show the run as still in progress for as long as
 * an unanswered "report is ready" notification sits on screen — unlike a
 * webview opening instantly, that time is unbounded.
 */
// Report files this extension host has written and shown a "report is
// ready" notification for, but that notification hasn't been resolved yet —
// see showHtmlReport and clearPreviousReports' own doc comment.
const pendingReportUris = new Set<string>();

async function clearPreviousReports(ctx: UtplsqlContext, reportsDir: vscode.Uri): Promise<void> {
    try {
        const entries = await vscode.workspace.fs.readDirectory(reportsDir);
        await Promise.all(
            entries
                .filter(([name, type]) => type === vscode.FileType.File && name.startsWith('utplsql-coverage-') && name.endsWith('.html'))
                .map(([name]) => vscode.Uri.joinPath(reportsDir, name))
                .filter((uri) => !pendingReportUris.has(uri.toString()))
                .map((uri) => vscode.workspace.fs.delete(uri))
        );
    } catch (err) {
        // Best-effort: a report we fail to clean up here just means one
        // extra file lingers until the next run, not a functional failure.
        ctx.output.appendLine(`utPLSQL: coverage HTML report — failed to clear previous reports: ${String(err)}`);
    }
}

async function showHtmlReport(ctx: UtplsqlContext, html: string, reportsDir: vscode.Uri): Promise<void> {
    const hardened = withContentSecurityPolicy(html);
    const buffer = Buffer.from(hardened, 'utf8');
    const tempUri = vscode.Uri.joinPath(reportsDir, `utplsql-coverage-${randomUUID()}.html`);
    await vscode.workspace.fs.writeFile(tempUri, buffer);
    ctx.output.appendLine(`utPLSQL: coverage HTML report written to ${tempUri.fsPath}`);

    const uriKey = tempUri.toString();
    pendingReportUris.add(uriKey);

    const openInBrowser = 'Open in Browser';
    const saveAs = 'Save As…';
    void vscode.window
        .showInformationMessage('utPLSQL: coverage HTML report is ready.', openInBrowser, saveAs)
        .then(async (choice) => {
            if (choice === openInBrowser) {
                await vscode.env.openExternal(tempUri);
            } else if (choice === saveAs) {
                const target = await vscode.window.showSaveDialog({
                    filters: { 'HTML report': ['html'] },
                    saveLabel: 'Save Coverage HTML Report'
                });
                if (target) {
                    await vscode.workspace.fs.writeFile(target, buffer);
                    ctx.output.appendLine(`utPLSQL: coverage HTML report saved to ${target.fsPath}`);
                }
            }
        })
        .then(undefined, (err: unknown) => {
            // Same "don't take the extension host down over a best-effort
            // follow-up action" reasoning as runProfile.ts's producePromise
            // guard in the test support code this issue's integration test
            // extends — nothing awaits this chain, so an unhandled rejection
            // here would otherwise surface as an unhandled rejection warning
            // instead of a normal, attributable output-channel line.
            ctx.output.appendLine(`utPLSQL: coverage HTML report — opening/saving failed: ${String(err)}`);
        })
        .then(() => pendingReportUris.delete(uriKey));
}
