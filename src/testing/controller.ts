import * as vscode from 'vscode';
import { getConnection } from '../db/pool';
import { getProfile, readProfiles } from '../db/connections';
import * as dao from '../db/utplsqlDao';
import { SuiteInfoRow } from '../db/utplsqlDao';
import { SourceIndex } from '../workspace/sourceIndex';
import { virtualSourceUri } from '../workspace/virtualSource';
import { parseId, pathId, rootId, schemaId } from './ids';
import { MetaStore, UtplsqlContext } from './model';
import { runTests } from './runHandler';
import { runCoverage, loadDetailedCoverage } from './coverage';
import { measure, setPerfOutputChannel } from '../perf';
import { runReporterExport } from './reporterProfile';
import { getCachedVersion, clearVersionCache } from '../db/versionCache';

const suitesCache = new Map<string, SuiteInfoRow[]>();

/**
 * Per (profile, owner), which SuiteInfoRow[] are the direct children of
 * which suitepath — '' is the synthetic key for "direct child of the schema
 * item itself" (a row whose own parent path isn't itself a row, same
 * fallback rule the old eager buildSchemaTree used). Built once from the
 * already-fetched/cached `rows` and reused by every resolveHandler call for
 * that owner, so expanding node after node doesn't re-scan the full row set
 * each time. Cleared alongside suitesCache on refresh.
 */
const childrenIndexCache = new Map<string, Map<string, SuiteInfoRow[]>>();

function buildChildrenIndex(forOwner: SuiteInfoRow[]): Map<string, SuiteInfoRow[]> {
    const paths = new Set(forOwner.map((r) => r.path));
    const index = new Map<string, SuiteInfoRow[]>();
    for (const row of forOwner) {
        const dotIdx = row.path.lastIndexOf('.');
        const parentPath = dotIdx === -1 ? undefined : row.path.slice(0, dotIdx);
        const key = parentPath !== undefined && paths.has(parentPath) ? parentPath : '';
        const list = index.get(key);
        if (list) {
            list.push(row);
        } else {
            index.set(key, [row]);
        }
    }
    return index;
}

function childrenIndexFor(profile: string, owner: string, forOwner: SuiteInfoRow[]): Map<string, SuiteInfoRow[]> {
    const key = `${profile}:${owner.toUpperCase()}`;
    const cached = childrenIndexCache.get(key);
    if (cached) {
        return cached;
    }
    const index = buildChildrenIndex(forOwner);
    childrenIndexCache.set(key, index);
    return index;
}

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
        const version = await getCachedVersion(conn, profile);
        if (version.normalized < dao.VERSION_GET_SUITES_INFO) {
            throw new Error(
                `utPLSQL ${version.raw} is too old (needs >= 3.1.3 for get_suites_info). Extension stays inactive for '${profile}'.`
            );
        }
        const rows = await measure('getSuitesInfo', () => dao.getSuitesInfo(conn), { profile });
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

function pointAt(uri: vscode.Uri, itemLineNo: number | undefined): { uri: vscode.Uri; range: vscode.Range } {
    const line = itemLineNo !== undefined ? Math.max(0, itemLineNo - 1) : 0;
    const pos = new vscode.Position(line, 0);
    return { uri, range: new vscode.Range(pos, pos) };
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
    return pointAt(location.uri, row.itemLineNo);
}

/**
 * Same idea as coverage.ts's virtual-source fallback: when there's no local
 * workspace file to point a test item at (the DB is the sole source of
 * truth), point it at a virtual utplsql-source:// document instead, so
 * "go to test"/"go to failing assertion" still works. types comes from one
 * batched getPackageObjectTypes() call per schema rather than a query per
 * row — every test in the same package shares the same underlying object.
 */
function resolveVirtualLocation(
    profile: string,
    owner: string,
    row: SuiteInfoRow,
    types: ReadonlyMap<string, 'PACKAGE BODY' | 'PACKAGE'>
): { uri: vscode.Uri; range: vscode.Range } | undefined {
    const type = types.get(row.objectName.toUpperCase());
    if (!type) {
        return undefined;
    }
    return pointAt(virtualSourceUri(profile, owner, row.objectName, type === 'PACKAGE BODY'), row.itemLineNo);
}

async function resolveVirtualTypes(
    secrets: vscode.SecretStorage,
    profile: string,
    owner: string,
    names: string[]
): Promise<Map<string, 'PACKAGE BODY' | 'PACKAGE'>> {
    if (names.length === 0) {
        return new Map();
    }
    const cfg = getProfile(profile);
    if (!cfg) {
        return new Map();
    }
    const conn = await getConnection(cfg, secrets);
    try {
        return await measure('getPackageObjectTypes', () => dao.getPackageObjectTypes(conn, owner, names), { names: names.length });
    } finally {
        await conn.close();
    }
}

/**
 * Materializes exactly one level of the tree under `parentItem` — the rows
 * that are direct children of the suitepath `parentItem` represents (or, for
 * the schema item itself, the top-level rows) — instead of the whole
 * ~15,000-row schema at once. A suite/context/suitepath-group row whose own
 * path has entries in `index` gets `canResolveChildren = true`; the
 * controller's own resolveHandler (kind === 'path') calls this again for
 * that row's own id when the user actually expands it. Discovery still
 * fetches every row in one DB round trip (splitting that into many smaller
 * calls measured *slower*, not faster — see docs/performance.md); only the
 * client-side vscode.TestItem construction is deferred.
 */
async function materializeLevel(
    controller: vscode.TestController,
    meta: MetaStore,
    sourceIndex: SourceIndex,
    parentItem: vscode.TestItem,
    profile: string,
    owner: string,
    rowsAtLevel: SuiteInfoRow[],
    index: Map<string, SuiteInfoRow[]>,
    secrets: vscode.SecretStorage
): Promise<void> {
    const missingNames = new Set<string>();
    for (const row of rowsAtLevel) {
        if (!resolveLocation(sourceIndex, row)) {
            missingNames.add(row.objectName);
        }
    }
    const virtualTypes = await resolveVirtualTypes(secrets, profile, owner, [...missingNames]);

    for (const row of rowsAtLevel) {
        const id = pathId(profile, owner, row.path);
        const location = resolveLocation(sourceIndex, row) ?? resolveVirtualLocation(profile, owner, row, virtualTypes);
        const item = controller.createTestItem(id, row.itemDescription || row.itemName, location?.uri);
        if (location) {
            item.range = location.range;
        }
        const tags = (row.tags ?? '')
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t.length > 0)
            .map((t) => new vscode.TestTag(t));
        const disabledDescription = dao.describeDisabled(row);
        if (disabledDescription) {
            // --%disabled: the run already reports these as 'skipped' (see
            // escalateStatus), but nothing distinguished them from an
            // enabled test *before* running — this is the only signal that
            // a "failure" is actually just a disabled test never having run.
            item.description = disabledDescription;
            tags.push(new vscode.TestTag('disabled'));
        }
        item.tags = tags;
        item.canResolveChildren = index.has(row.path);
        meta.set(id, { profile, owner, suitepath: row.path, row });
        parentItem.children.add(item);
    }
}

export function createUtplsqlContext(extCtx: vscode.ExtensionContext, sourceIndex: SourceIndex): UtplsqlContext {
    secretsRef = extCtx.secrets;
    const controller = vscode.tests.createTestController('utplsql', 'utPLSQL');
    const meta = new MetaStore();
    const output = vscode.window.createOutputChannel('utPLSQL');
    setPerfOutputChannel(output);
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
                    const version = await getCachedVersion(conn, parsed.profile);
                    item.description = version.raw;
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
        if (parsed.kind === 'schema' || parsed.kind === 'path') {
            item.children.replace([]);
            try {
                const owner = parsed.owner;
                const rows = await fetchSuiteRows(parsed.profile);
                const forOwner = rows.filter((r) => r.objectOwner.toUpperCase() === owner.toUpperCase());
                const index = childrenIndexFor(parsed.profile, owner, forOwner);
                const levelKey = parsed.kind === 'schema' ? '' : parsed.suitepath;
                const rowsAtLevel = index.get(levelKey) ?? [];
                await measure(
                    'buildSchemaTree',
                    () => materializeLevel(controller, meta, sourceIndex, item, parsed.profile, owner, rowsAtLevel, index, extCtx.secrets),
                    { owner, level: levelKey || '(top)', rows: rowsAtLevel.length }
                );
            } catch (err) {
                reportResolveError(item, err);
            }
        }
    };

    controller.refreshHandler = async () => {
        suitesCache.clear();
        childrenIndexCache.clear();
        clearVersionCache();
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

    const reporterExportProfile = controller.createRunProfile(
        'Export with Reporter',
        vscode.TestRunProfileKind.Run,
        (request, token) => runReporterExport(ctx, request, token),
        false
    );

    extCtx.subscriptions.push(controller, output, runProfile, coverageProfile, reporterExportProfile);

    return ctx;
}
