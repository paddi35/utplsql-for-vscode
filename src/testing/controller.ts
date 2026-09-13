import * as vscode from 'vscode';
import { getConnection, recyclePool } from '../db/pool';
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
import { createSingleFlightCache } from './singleFlight';
import { createObjectTypeCache } from './objectTypeCache';
import { forgetProfile as forgetProfileCaches } from './profileCaches';
import { reconcileRoots } from './rootReconciliation';

/**
 * Single-flighted per-profile cache of the full get_suites_info row set (see
 * singleFlight.ts). VS Code invokes resolveHandler concurrently for sibling
 * Test Explorer items, and ensureSubtreeResolved (runHandler.ts) drives it
 * again before every run — without in-flight de-duplication, each of those
 * started its own ~27-59s getSuitesInfo round trip on the documented
 * 1000-package fixture (issue #17).
 */
const suiteRowsCache = createSingleFlightCache<SuiteInfoRow[]>();

/** Per (profile, owner) PACKAGE/PACKAGE BODY object-type cache backing resolveVirtualTypes below — see objectTypeCache.ts (issue #22). */
const objectTypeCache = createObjectTypeCache();

/**
 * Per (profile, owner), which SuiteInfoRow[] are the direct children of
 * which suitepath — '' is the synthetic key for "direct child of the schema
 * item itself" (a row whose own parent path isn't itself a row, same
 * fallback rule the old eager buildSchemaTree used). Built once from the
 * already-fetched/cached `rows` and reused by every resolveHandler call for
 * that owner, so expanding node after node doesn't re-scan the full row set
 * each time. Cleared alongside suiteRowsCache on refresh.
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

/** Drops every childrenIndexCache entry for `profile` (every owner under it — the cache key is `${profile}:${owner}`), leaving other profiles' entries untouched. */
function clearChildrenIndexForProfile(profile: string): void {
    const prefix = `${profile}:`;
    for (const key of [...childrenIndexCache.keys()]) {
        if (key.startsWith(prefix)) {
            childrenIndexCache.delete(key);
        }
    }
}

/**
 * Closes the pool and clears every per-profile cache for `name` in one
 * place (issue #19) — see profileCaches.ts for why the caches are cleared
 * before the pool, and why recyclePool rather than closePool. Exported for
 * commands/index.ts's setPassword (the old pool otherwise keeps using the
 * password that was just replaced) and removeConnection (otherwise the
 * removed profile's Oracle sessions stay open), and used below by this
 * module's own onDidChangeConfiguration('utplsql.connections') listener for
 * a profile that disappears by any means, including a hand-edited
 * settings.json.
 */
export async function forgetProfile(name: string): Promise<void> {
    await forgetProfileCaches(name, {
        clearSuiteRows: (p) => suiteRowsCache.clear(p),
        clearObjectTypes: (p) => objectTypeCache.clear(p),
        clearChildrenIndex: clearChildrenIndexForProfile,
        clearVersion: clearVersionCache,
        clearDbaView: dao.clearDbaViewCache,
        closePool: recyclePool
    });
}

function fetchSuiteRows(profile: string, onUnknownItemType: (raw: unknown) => void): Promise<SuiteInfoRow[]> {
    return suiteRowsCache.get(profile, async () => {
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
            return await measure('getSuitesInfo', () => dao.getSuitesInfo(conn, undefined, undefined, onUnknownItemType), { profile });
        } finally {
            await conn.close();
        }
    });
}

/**
 * Public accessor for the same discovery-rows cache fetchSuiteRows uses,
 * for callers outside this module that need the full row set for a profile
 * without being limited to whatever the Test Explorer tree has actually
 * materialized so far: utplsql.runWithTags's tag list, and
 * utplsql.runTestAtCursor's/utplsql.runWithReporter's/utplsql.generateTest's
 * QuickPick fallback candidates, all in commands/index.ts (issues #18, #29).
 * Single-flighted and cached exactly like every other fetchSuiteRows caller
 * — including resolveHandler's own — so calling this doesn't cost an extra
 * round trip beyond whatever discovery already ran (or is about to).
 */
export function getSuiteRows(profile: string, onUnknownItemType?: (raw: unknown) => void): Promise<SuiteInfoRow[]> {
    return fetchSuiteRows(profile, onUnknownItemType ?? (() => undefined));
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
    const location = dao.isTestItem(row.itemType)
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

/**
 * Resolves PACKAGE/PACKAGE BODY types for `names` under (profile, owner)
 * through objectTypeCache (issue #22) instead of a fresh pooled connection
 * and dao.getPackageObjectTypes call per invocation. materializeLevel below
 * always passes the owner's *entire* distinct missing-name set here, not
 * just the current level's — see objectTypeCache.ts's doc comment for why
 * that is what makes "one round trip per owner" actually happen instead of
 * "one (smaller) round trip per level".
 */
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
    return objectTypeCache.resolve(profile, owner, names, async (toFetch) => {
        const conn = await getConnection(cfg, secrets);
        try {
            return await measure('getPackageObjectTypes', () => dao.getPackageObjectTypes(conn, owner, toFetch, profile), { names: toFetch.length });
        } finally {
            await conn.close();
        }
    });
}

/**
 * Every distinct objectName across *all* rows known for this owner (every
 * bucket of the owner's children index, not just one level's rowsAtLevel)
 * that has no local workspace source — the priming set resolveVirtualTypes
 * needs to turn "one getPackageObjectTypes call per owner" from an
 * aspiration into what actually happens (see objectTypeCache.ts). Pure
 * in-memory work over an already-built index (no DB access itself), so
 * recomputing it on every materializeLevel call for an owner is cheap; the
 * cache it feeds is what makes the *DB* call happen at most once.
 */
function allMissingNamesForOwner(sourceIndex: SourceIndex, index: ReadonlyMap<string, SuiteInfoRow[]>): string[] {
    const missing = new Set<string>();
    for (const rows of index.values()) {
        for (const row of rows) {
            if (!resolveLocation(sourceIndex, row)) {
                missing.add(row.objectName);
            }
        }
    }
    return [...missing];
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
 * per-package calls measured *slower*, not faster, against a 1000-package
 * fixture: a single call took ~27-59s, parallel per-package calls at
 * concurrency 4/10 took ~55s/80s); only the client-side vscode.TestItem
 * construction is deferred.
 *
 * Reconciles rather than wipes-and-rebuilds: an existing child TestItem
 * whose id is still present at this level (and whose location didn't
 * change — uri is read-only on a TestItem, so a moved/newly-resolved
 * location still needs a fresh object) is updated in place and kept, not
 * replaced. resolveHandler can be invoked again on an already-resolved
 * node — runHandler.ts's ensureSubtreeResolved does this deliberately
 * before every run, and VS Code itself may re-resolve after a reload — and
 * a blind children.replace([]) there would discard the exact TestItem
 * objects a just-finished TestRun attached pass/fail status to, desyncing
 * the sidebar from the Test Results panel even though nothing about the
 * schema actually changed. Rows that disappeared from this level (e.g. the
 * package was dropped) are removed.
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
    // Only bother priming (and paying allMissingNamesForOwner's owner-wide
    // scan) when this level actually needs a virtual-source lookup at all —
    // an owner that's fully covered by local workspace files never triggers
    // this, the same as before.
    const virtualTypes =
        missingNames.size > 0 ? await resolveVirtualTypes(secrets, profile, owner, allMissingNamesForOwner(sourceIndex, index)) : new Map<string, 'PACKAGE BODY' | 'PACKAGE'>();

    const expectedIds = new Set<string>();
    for (const row of rowsAtLevel) {
        const id = pathId(profile, owner, row.path);
        expectedIds.add(id);
        const location = resolveLocation(sourceIndex, row) ?? resolveVirtualLocation(profile, owner, row, virtualTypes);
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
            tags.push(new vscode.TestTag('disabled'));
        }

        const existing = parentItem.children.get(id);
        const reusable = existing && existing.uri?.toString() === location?.uri?.toString();
        const item = reusable ? existing : controller.createTestItem(id, row.itemDescription || row.itemName, location?.uri);
        item.label = row.itemDescription || row.itemName;
        if (location) {
            item.range = location.range;
        }
        item.description = disabledDescription;
        item.tags = tags;
        item.canResolveChildren = index.has(row.path);
        meta.set(id, { profile, owner, suitepath: row.path, row });
        if (!reusable) {
            parentItem.children.add(item);
        }
    }

    const stale: string[] = [];
    parentItem.children.forEach((child) => {
        if (!expectedIds.has(child.id)) {
            stale.push(child.id);
        }
    });
    stale.forEach((id) => parentItem.children.delete(id));
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

    /** getSuitesInfo's onUnknownItemType callback (see parseItemType in utplsqlDao.ts) — one line per unrecognised item_type actually observed, instead of the silent cast it replaces. */
    const logUnknownItemType = (profile: string, raw: unknown): void => {
        output.appendLine(`utPLSQL: getSuitesInfo for '${profile}' returned an unrecognised item_type '${String(raw)}', treating it as a suite`);
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
                    const rows = await fetchSuiteRows(parsed.profile, (raw) => logUnknownItemType(parsed.profile, raw));
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
                    const expectedIds = new Set<string>();
                    for (const owner of [...owners].sort()) {
                        const id = schemaId(parsed.profile, owner);
                        expectedIds.add(id);
                        // Reuse an existing schema item rather than replacing it:
                        // it may already carry a fully-resolved subtree with live
                        // run state (see materializeLevel's merge for why a blind
                        // rebuild here would orphan that).
                        const schemaItem = item.children.get(id) ?? controller.createTestItem(id, owner);
                        schemaItem.canResolveChildren = true;
                        item.children.add(schemaItem);
                    }
                    const stale: string[] = [];
                    item.children.forEach((child) => {
                        if (!expectedIds.has(child.id)) {
                            stale.push(child.id);
                        }
                    });
                    stale.forEach((id) => item.children.delete(id));
                } finally {
                    await conn.close();
                }
            } catch (err) {
                reportResolveError(item, err);
            }
            return;
        }
        if (parsed.kind === 'schema' || parsed.kind === 'path') {
            try {
                const owner = parsed.owner;
                const rows = await fetchSuiteRows(parsed.profile, (raw) => logUnknownItemType(parsed.profile, raw));
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
        suiteRowsCache.clear();
        childrenIndexCache.clear();
        objectTypeCache.clear();
        clearVersionCache();
        dao.clearDbaViewCache();
        controller.items.forEach((root) => meta.deleteForProfile(parseId(root.id).profile));
        controller.items.replace([]);
        await controller.resolveHandler?.(undefined);
    };

    /**
     * The only place that watches `utplsql.connections` for changes (issue
     * #19) — SourceIndex has the only other onDidChangeConfiguration
     * listener in the codebase, for files.associations/
     * utplsql.discovery.languageIds. Fires for a profile added or removed
     * through the connection commands *and* for a hand-edited
     * settings.json, since both go through the same
     * vscode.workspace.getConfiguration('utplsql').update('connections', …)
     * call (connections.ts's writeProfiles). reconcileRoots (pure, see
     * rootReconciliation.ts) turns "current root ids" + "configured
     * profiles" into exactly the ids to add/remove, so an unrelated
     * profile's already-resolved subtree is left alone rather than being
     * rebuilt from scratch the way refreshHandler's full wipe does.
     */
    const connectionsWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('utplsql.connections')) {
            return;
        }
        const existingIds: string[] = [];
        controller.items.forEach((root) => existingIds.push(root.id));
        const { added, removed } = reconcileRoots(
            existingIds,
            readProfiles().map((p) => p.name)
        );
        removed.forEach((id) => {
            const profile = parseId(id).profile;
            controller.items.delete(id);
            meta.deleteForProfile(profile);
            void forgetProfile(profile);
        });
        added.forEach((id) => {
            const root = controller.createTestItem(id, parseId(id).profile);
            root.canResolveChildren = true;
            controller.items.add(root);
        });
    });

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

    extCtx.subscriptions.push(controller, output, connectionsWatcher, runProfile, coverageProfile, reporterExportProfile);

    return ctx;
}
