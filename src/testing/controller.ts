import * as vscode from 'vscode';
import { getConnection } from '../db/pool';
import { getProfile, readProfiles } from '../db/connections';
import * as dao from '../db/utplsqlDao';
import { SuiteInfoRow } from '../db/utplsqlDao';
import { SourceIndex } from '../workspace/sourceIndex';
import { parseId, pathId, rootId, schemaId } from './ids';
import { MetaStore, UtplsqlContext } from './model';
import { runTests } from './runHandler';
import { runCoverage, loadDetailedCoverage } from './coverage';

const suitesCache = new Map<string, SuiteInfoRow[]>();

async function fetchSuiteRows(profile: string): Promise<SuiteInfoRow[]> {
    const cached = suitesCache.get(profile);
    if (cached) {
        return cached;
    }
    const cfg = getProfile(profile);
    if (!cfg) {
        return [];
    }
    const conn = await getConnection(cfg, ctxSecrets());
    try {
        const version = await dao.getVersion(conn);
        if (version.normalized < dao.VERSION_GET_SUITES_INFO) {
            throw new Error(
                `utPLSQL ${version.raw} is too old (needs >= 3.1.3 for get_suites_info). Extension stays inactive for '${profile}'.`
            );
        }
        const rows = await dao.getSuitesInfo(conn);
        suitesCache.set(profile, rows);
        return rows;
    } finally {
        await conn.close();
    }
}

let secretsRef: vscode.SecretStorage;
function ctxSecrets(): vscode.SecretStorage {
    return secretsRef;
}

function resolveLocation(sourceIndex: SourceIndex, row: SuiteInfoRow): { uri: vscode.Uri; range: vscode.Range } | undefined {
    const location =
        row.itemType === 'UT_TEST'
            ? sourceIndex.lookupProcedure(row.objectName, row.itemName)
            : sourceIndex.lookupPackage(row.objectName);
    if (!location) {
        return undefined;
    }
    if (row.itemLineNo === undefined) {
        return { uri: location.uri, range: location.range };
    }
    const line = Math.max(0, row.itemLineNo - 1);
    const pos = new vscode.Position(line, 0);
    return { uri: location.uri, range: new vscode.Range(pos, pos) };
}

function buildSchemaTree(
    controller: vscode.TestController,
    meta: MetaStore,
    sourceIndex: SourceIndex,
    schemaItem: vscode.TestItem,
    profile: string,
    owner: string,
    rows: SuiteInfoRow[]
): void {
    const forOwner = rows.filter((r) => r.objectOwner.toUpperCase() === owner.toUpperCase());
    forOwner.sort((a, b) => a.path.split('.').length - b.path.split('.').length);
    const created = new Map<string, vscode.TestItem>();

    for (const row of forOwner) {
        const id = pathId(profile, owner, row.path);
        const location = resolveLocation(sourceIndex, row);
        const item = controller.createTestItem(id, row.itemDescription || row.itemName, location?.uri);
        if (location) {
            item.range = location.range;
        }
        item.tags = (row.tags ?? '')
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t.length > 0)
            .map((t) => new vscode.TestTag(t));
        item.canResolveChildren = false;
        meta.set(id, { profile, owner, suitepath: row.path, row });

        const dotIdx = row.path.lastIndexOf('.');
        const parentPath = dotIdx === -1 ? undefined : row.path.slice(0, dotIdx);
        const parent = parentPath ? created.get(parentPath) : undefined;
        (parent ?? schemaItem).children.add(item);
        created.set(row.path, item);
    }
}

export function createUtplsqlContext(extCtx: vscode.ExtensionContext, sourceIndex: SourceIndex): UtplsqlContext {
    secretsRef = extCtx.secrets;
    const controller = vscode.tests.createTestController('utplsql', 'utPLSQL');
    const meta = new MetaStore();
    const output = vscode.window.createOutputChannel('utPLSQL');
    const ctx: UtplsqlContext = { controller, meta, output, secrets: extCtx.secrets, sourceIndex };

    const reportResolveError = (item: vscode.TestItem, err: unknown): void => {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`utPLSQL: failed to resolve '${item.id}': ${message}`);
        output.show(true);
        void vscode.window.showErrorMessage(`utPLSQL: ${message}`, 'Show Output').then((choice) => {
            if (choice === 'Show Output') {
                output.show(true);
            }
        });
        const errorItem = controller.createTestItem(`${item.id}/error`, `⚠ ${message}`);
        errorItem.canResolveChildren = false;
        item.children.replace([errorItem]);
    };

    controller.resolveHandler = async (item) => {
        if (!item) {
            for (const profile of readProfiles()) {
                const root = controller.createTestItem(rootId(profile.name), profile.name);
                root.canResolveChildren = true;
                controller.items.add(root);
            }
            return;
        }
        const parsed = parseId(item.id);
        if (parsed.kind === 'root') {
            item.children.replace([]);
            const cfg = getProfile(parsed.profile);
            if (!cfg) {
                reportResolveError(item, new Error(`Connection profile '${parsed.profile}' no longer exists.`));
                return;
            }
            try {
                const conn = await getConnection(cfg, extCtx.secrets);
                try {
                    const owners = new Set<string>();
                    const primary = (cfg.defaultSchema ?? cfg.user).toUpperCase();
                    if (await dao.hasSuites(conn, primary)) {
                        owners.add(primary);
                    }
                    const rows = await fetchSuiteRows(parsed.profile);
                    rows.forEach((r) => owners.add(r.objectOwner.toUpperCase()));
                    if (owners.size === 0) {
                        reportResolveError(
                            item,
                            new Error(
                                `No utPLSQL suites found for '${parsed.profile}'. Is utPLSQL installed in schema '${primary}' and are any %suite packages compiled there?`
                            )
                        );
                        return;
                    }
                    for (const owner of [...owners].sort()) {
                        const schemaItem = controller.createTestItem(schemaId(parsed.profile, owner), owner);
                        schemaItem.canResolveChildren = true;
                        item.children.add(schemaItem);
                    }
                } finally {
                    await conn.close();
                }
            } catch (err) {
                reportResolveError(item, err);
            }
            return;
        }
        if (parsed.kind === 'schema') {
            item.children.replace([]);
            try {
                const rows = await fetchSuiteRows(parsed.profile);
                buildSchemaTree(controller, meta, sourceIndex, item, parsed.profile, parsed.owner, rows);
            } catch (err) {
                reportResolveError(item, err);
            }
        }
    };

    controller.refreshHandler = async () => {
        suitesCache.clear();
        controller.items.forEach((root) => meta.deleteForProfile(parseId(root.id).profile));
        controller.items.replace([]);
        await controller.resolveHandler?.(undefined);
    };

    const runProfile = controller.createRunProfile(
        'Run',
        vscode.TestRunProfileKind.Run,
        (request, token) => runTests(ctx, request, token),
        true
    );

    const coverageProfile = controller.createRunProfile(
        'Run with Coverage',
        vscode.TestRunProfileKind.Coverage,
        (request, token) => runCoverage(ctx, request, token),
        false
    );
    coverageProfile.loadDetailedCoverage = loadDetailedCoverage;

    extCtx.subscriptions.push(controller, output, runProfile, coverageProfile);

    return ctx;
}
