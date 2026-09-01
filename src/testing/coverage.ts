import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';
import { getPool } from '../db/pool';
import { getProfile } from '../db/connections';
import * as dao from '../db/utplsqlDao';
import { CoverageOptions } from '../db/realtimeDao';
import { UtplsqlContext } from './model';
import { virtualSourceUri } from '../workspace/virtualSource';
import { groupRequest, runOneProfile, readRandomOrderConfig } from './runHandler';

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
    try {
        const grouped = groupRequest(ctx, request);
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
            if (result.htmlReport && vscode.workspace.getConfiguration('utplsql').get<boolean>('coverage.htmlReport')) {
                showHtmlReport(result.htmlReport);
            }
        }
    } finally {
        run.end();
    }
}

interface BuiltCoverage {
    options: CoverageOptions;
    pathToUri: Map<string, vscode.Uri>;
}

async function buildCoverageOptions(ctx: UtplsqlContext, profile: string, items: vscode.TestItem[]): Promise<BuiltCoverage | undefined> {
    const cfg = getProfile(profile);
    if (!cfg) {
        return undefined;
    }
    const pool = await getPool(cfg, ctx.secrets, 1);
    const scopeConn = await pool.getConnection();
    try {
        const owners = new Set<string>();
        const testObjectNames = new Set<string>();
        const includeObjects = new Map<string, { owner: string; name: string }>();

        for (const item of items) {
            const meta = ctx.meta.get(item.id);
            if (!meta?.row) {
                continue;
            }
            owners.add(meta.owner);
            testObjectNames.add(meta.row.objectName);
            const deps = await dao.includes(scopeConn, meta.owner, meta.row.objectName);
            deps.forEach((d) => includeObjects.set(`${d.owner}.${d.name}`, d));
        }

        // Dependency discovery can't tell the utPLSQL framework's own
        // packages (e.g. UT, UT_EXPECTATION) apart from real code under
        // test when the framework is installed into the same schema as the
        // tests — every test necessarily calls ut.expect(...), so they
        // always show up as a direct dependency. There is no reliable
        // signal in *_dependencies to filter those out automatically, so
        // this is a user-maintained denylist instead of a guessed one.
        const userExcluded = new Set(
            vscode.workspace
                .getConfiguration('utplsql')
                .get<string[]>('coverage.excludeObjects', [])
                .map((n) => n.toUpperCase())
        );
        for (const [key, { name }] of includeObjects) {
            if (userExcluded.has(name)) {
                includeObjects.delete(key);
            }
        }

        const fileMappings: CoverageOptions['fileMappings'] = [];
        const pathToUri = new Map<string, vscode.Uri>();
        for (const { owner, name } of includeObjects.values()) {
            const loc = ctx.sourceIndex.lookupPackage(name);
            if (loc) {
                const file = vscode.workspace.asRelativePath(loc.uri, false).replace(/\\/g, '/');
                ctx.output.appendLine(`utPLSQL: coverage — mapped '${owner}.${name}' to local file '${file}'`);
                fileMappings.push({ file, owner, name, type: loc.isBody ? 'PACKAGE BODY' : 'PACKAGE' });
                pathToUri.set(file, loc.uri);
                continue;
            }

            // No local workspace file (e.g. this project keeps the DB as
            // the sole source of truth) — fall back to a virtual,
            // DB-backed document instead of dropping the object from
            // coverage entirely, so native gutters/the Test Coverage panel
            // still get something to point at.
            const objType = await dao.getPackageObjectType(scopeConn, owner, name);
            if (!objType) {
                ctx.output.appendLine(
                    `utPLSQL: coverage — '${owner}.${name}' has neither a local file nor a PACKAGE/PACKAGE BODY in the database, excluding it from a_source_file_mappings`
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

        return {
            options: {
                reporter: 'ut_coverage_sonar_reporter',
                schemes: [...owners],
                includeObjects: [...includeObjects.values()].map((v) => v.name),
                excludeObjects: [...testObjectNames],
                fileMappings,
                htmlReport: vscode.workspace.getConfiguration('utplsql').get<boolean>('coverage.htmlReport', false)
            },
            pathToUri
        };
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

let htmlPanel: vscode.WebviewPanel | undefined;

/**
 * ut_coverage_html_reporter's output is a self-contained report with its own
 * inline <script>/<style> (the collapsible file/line view) — with scripts
 * disabled the panel opens but stays blank/inert, so inline code has to stay
 * allowed. The report also embeds database-derived text (object names and
 * package source lines) though, and on a shared database that is not all
 * written by the person reading the report. This policy therefore permits
 * exactly the report's own inline code and nothing else: 'none' as the
 * default covers connect-src, so the panel has no network destination to
 * send anything to.
 */
const REPORT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;";

function withContentSecurityPolicy(html: string): string {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`;
    const head = /<head[^>]*>/i.exec(html);
    if (!head) {
        return meta + html;
    }
    const insertAt = head.index + head[0].length;
    return html.slice(0, insertAt) + meta + html.slice(insertAt);
}

function showHtmlReport(html: string): void {
    if (!htmlPanel) {
        htmlPanel = vscode.window.createWebviewPanel('utplsqlCoverage', 'utPLSQL Coverage', vscode.ViewColumn.Beside, {
            enableScripts: true,
            // The report is fully self-contained, so it never needs to read
            // a file; left at its default a webview may load resources from
            // the extension's install directory and every workspace folder.
            localResourceRoots: []
        });
        htmlPanel.onDidDispose(() => {
            htmlPanel = undefined;
        });
    }
    htmlPanel.webview.html = withContentSecurityPolicy(html);
    htmlPanel.reveal(vscode.ViewColumn.Beside);
}
