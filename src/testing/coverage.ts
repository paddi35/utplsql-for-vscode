import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';
import { getPool } from '../db/pool';
import { getProfile } from '../db/connections';
import * as dao from '../db/utplsqlDao';
import { CoverageOptions } from '../db/realtimeDao';
import { UtplsqlContext } from './model';
import { resolveWorkspaceRelativePath } from './coveragePaths';
import { groupRequest, runOneProfile } from './runHandler';

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
 */
function parseSonarCoverage(xml: string, resolveUri: (path: string) => vscode.Uri | undefined): FileLineHits[] {
    const doc = xmlParser.parse(xml) as Record<string, unknown>;
    const root = doc.coverage as Record<string, unknown> | undefined;
    if (!root) {
        return [];
    }
    const files = asArray(root.file as Record<string, unknown> | Record<string, unknown>[]);
    const result: FileLineHits[] = [];
    for (const file of files) {
        const path = String((file as Record<string, unknown>)['@_path'] ?? '');
        const uri = resolveUri(path);
        if (!uri) {
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
    try {
        const grouped = groupRequest(ctx, request);
        for (const [profile, group] of grouped) {
            if (token.isCancellationRequested) {
                group.items.forEach((i) => run.skipped(i));
                continue;
            }
            const coverageOptions = await buildCoverageOptions(ctx, profile, group.items);
            const result = await runOneProfile(ctx, run, profile, group.items, group.paths, token, {
                coverage: coverageOptions
            });
            if (result.coverageXml) {
                applyCoverage(run, detailByUri, result.coverageXml);
            }
            if (result.htmlReport && vscode.workspace.getConfiguration('utplsql').get<boolean>('coverage.htmlReport')) {
                showHtmlReport(result.htmlReport);
            }
        }
    } finally {
        run.end();
    }
}

async function buildCoverageOptions(
    ctx: UtplsqlContext,
    profile: string,
    items: vscode.TestItem[]
): Promise<CoverageOptions | undefined> {
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

        const fileMappings: CoverageOptions['fileMappings'] = [];
        for (const { owner, name } of includeObjects.values()) {
            const loc = ctx.sourceIndex.lookupPackage(name);
            if (!loc) {
                continue;
            }
            const file = vscode.workspace.asRelativePath(loc.uri, false).replace(/\\/g, '/');
            fileMappings.push({ file, owner, name, type: loc.isBody ? 'PACKAGE BODY' : 'PACKAGE' });
        }

        return {
            reporter: 'ut_coverage_sonar_reporter',
            schemes: [...owners],
            includeObjects: [...includeObjects.values()].map((v) => v.name),
            excludeObjects: [...testObjectNames],
            fileMappings,
            htmlReport: vscode.workspace.getConfiguration('utplsql').get<boolean>('coverage.htmlReport', false)
        };
    } finally {
        await scopeConn.close();
    }
}

function applyCoverage(run: vscode.TestRun, detailByUri: Map<string, vscode.StatementCoverage[]>, xml: string): void {
    const files = parseSonarCoverage(xml, (path) => resolveWorkspaceUri(path));
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

function resolveWorkspaceUri(relativePath: string): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const normalized = resolveWorkspaceRelativePath(relativePath);
    return folder && normalized ? vscode.Uri.joinPath(folder.uri, normalized) : undefined;
}

export async function loadDetailedCoverage(
    testRun: vscode.TestRun,
    fileCoverage: vscode.FileCoverage,
    _token: vscode.CancellationToken
): Promise<vscode.FileCoverageDetail[]> {
    return detailedCoverage.get(testRun)?.get(fileCoverage.uri.toString()) ?? [];
}

let htmlPanel: vscode.WebviewPanel | undefined;

function showHtmlReport(html: string): void {
    if (!htmlPanel) {
        htmlPanel = vscode.window.createWebviewPanel('utplsqlCoverage', 'utPLSQL Coverage', vscode.ViewColumn.Beside, {
            enableScripts: false
        });
        htmlPanel.onDidDispose(() => {
            htmlPanel = undefined;
        });
    }
    htmlPanel.webview.html = html;
    htmlPanel.reveal(vscode.ViewColumn.Beside);
}
