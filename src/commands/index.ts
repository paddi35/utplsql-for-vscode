import * as vscode from 'vscode';
import { addProfile, ConnectionProfile, getProfile, readProfiles, removeProfile, setPassword } from '../db/connections';
import { getPool, recyclePool } from '../db/pool';
import * as dao from '../db/utplsqlDao';
import { runWithReporter as runWithReporterDao } from '../db/reporterDao';
import { UtplsqlContext } from '../testing/model';
import { runTests } from '../testing/runHandler';
import { parseId, rootId } from '../testing/ids';
import { readReporterOptions } from '../testing/reporterConfig';
import { generateTestPackage, readGenerateOptions } from '../generate/testTemplate';
import { matchesConfiguredLanguage } from '../workspace/languageIndex';
import { listTnsAliases, resolveTnsAdminDir } from '../db/tnsnames';
import { getSuiteRows } from '../testing/controller';
import { parseVirtualSourceUri } from '../workspace/virtualSource';
import { Candidate, chooseTarget, editorTargetFromVirtualSource } from './resolveTarget';

const ENTER_MANUALLY = '$(edit) Enter Easy-Connect string manually…';

async function pickConnectString(): Promise<string | undefined> {
    const tnsDir = resolveTnsAdminDir();
    if (tnsDir) {
        const aliases = await listTnsAliases(tnsDir);
        if (aliases.length > 0) {
            const pick = await vscode.window.showQuickPick([ENTER_MANUALLY, ...aliases], {
                title: `Select a TNS alias (from ${tnsDir})`,
                placeHolder: 'Or pick "Enter manually" for an Easy-Connect string'
            });
            if (!pick) {
                return undefined;
            }
            if (pick !== ENTER_MANUALLY) {
                return pick;
            }
        }
    }
    return vscode.window.showInputBox({ prompt: 'Easy-Connect string or TNS alias', ignoreFocusOut: true });
}

async function pickProfile(promptTitle: string): Promise<string | undefined> {
    const profiles = readProfiles();
    if (profiles.length === 0) {
        vscode.window.showErrorMessage('utPLSQL: No connection profile configured yet. Run "utPLSQL: Add Connection" first.');
        return undefined;
    }
    if (profiles.length === 1) {
        return profiles[0].name;
    }
    const pick = await vscode.window.showQuickPick(
        profiles.map((p) => p.name),
        { title: promptTitle }
    );
    return pick;
}

export function registerConnectionCommands(extCtx: vscode.ExtensionContext): void {
    extCtx.subscriptions.push(
        vscode.commands.registerCommand('utplsql.addConnection', async () => {
            const name = await vscode.window.showInputBox({ prompt: 'Connection profile name', ignoreFocusOut: true });
            if (!name) {
                return;
            }
            const user = await vscode.window.showInputBox({ prompt: 'DB user', ignoreFocusOut: true });
            if (!user) {
                return;
            }
            const connectString = await pickConnectString();
            if (!connectString) {
                return;
            }
            const defaultSchema = await vscode.window.showInputBox({
                prompt: 'Default schema (optional, defaults to the DB user)',
                ignoreFocusOut: true
            });
            await addProfile({ name, user, connectString, defaultSchema: defaultSchema || undefined });
            const password = await vscode.window.showInputBox({
                prompt: `Password for '${user}' (stored in SecretStorage)`,
                password: true,
                ignoreFocusOut: true
            });
            if (password) {
                await setPassword(extCtx.secrets, name, password);
            }
            vscode.window.showInformationMessage(`utPLSQL: connection '${name}' added.`);
        }),

        vscode.commands.registerCommand('utplsql.setPassword', async () => {
            const name = await pickProfile('Select connection profile');
            if (!name) {
                return;
            }
            const password = await vscode.window.showInputBox({ prompt: `Password for '${name}'`, password: true, ignoreFocusOut: true });
            if (password === undefined) {
                return;
            }
            await setPassword(extCtx.secrets, name, password);
            vscode.window.showInformationMessage(`utPLSQL: password for '${name}' stored.`);
        }),

        vscode.commands.registerCommand('utplsql.removeConnection', async () => {
            const name = await pickProfile('Select connection profile to remove');
            if (!name) {
                return;
            }
            const confirm = await vscode.window.showWarningMessage(
                `Remove connection profile '${name}'? Its stored password will also be deleted.`,
                { modal: true },
                'Remove'
            );
            if (confirm !== 'Remove') {
                return;
            }
            await removeProfile(name, extCtx.secrets);
            vscode.window.showInformationMessage(`utPLSQL: connection '${name}' removed.`);
        })
    );
}

interface ResolvedCursorObject {
    profile: string;
    owner: string;
    packageName: string;
    procedureName?: string;
}

/** Mirrors controller.ts's own (unexported) onUnknownItemType handling, so getSuiteRows callers here log an unrecognised item_type the same way instead of silently absorbing it. */
function logUnknownItemType(ctx: UtplsqlContext, profile: string, raw: unknown): void {
    ctx.output.appendLine(`utPLSQL: getSuitesInfo for '${profile}' returned an unrecognised item_type '${String(raw)}', treating it as a suite`);
}

/**
 * generateTest's QuickPick fallback candidate list: every OWNER.OBJECT[.PROCEDURE]
 * dao.testables() finds for the profile's default schema — the same source
 * generateTest's own DB step already reads, just consulted one call earlier
 * so there is something to choose from before an editor target exists.
 */
async function testableCandidates(ctx: UtplsqlContext, cfg: ConnectionProfile): Promise<Candidate[]> {
    const pool = await getPool(cfg, ctx.secrets, 0);
    const conn = await pool.getConnection();
    try {
        const owner = (cfg.defaultSchema ?? cfg.user).toUpperCase();
        const units = await dao.testables(conn, owner);
        return units.map((u) => ({ owner: u.objectOwner, packageName: u.objectName, procedureName: u.subobjectName }));
    } finally {
        await conn.close();
    }
}

/**
 * runTestAtCursor's/runWithReporter's QuickPick fallback candidate list: the
 * full discovery row set for the profile (getSuiteRows, controller.ts)
 * rather than only whatever the Test Explorer tree has materialized so far
 * — the same fix issue #18 needed for the tag list, for the same
 * lazy-materialization reason.
 */
async function suiteRowCandidates(ctx: UtplsqlContext, profile: string): Promise<Candidate[]> {
    const rows = await getSuiteRows(profile, (raw) => logUnknownItemType(ctx, profile, raw));
    return rows.map((row) => ({
        owner: row.objectOwner,
        packageName: row.objectName,
        procedureName: dao.isTestItem(row.itemType) ? row.itemName : undefined
    }));
}

/**
 * Resolves the database object a cursor-driven command (runTestAtCursor,
 * runWithReporter, generateTest) should act on. Tries, in order:
 *
 * 1. A utplsql-source:// document at the cursor (see workspace/
 *    virtualSource.ts): its URI already names the owning schema and
 *    package, used directly instead of guessing from the profile's default
 *    schema — see editorTargetFromVirtualSource's doc comment for why that
 *    distinction matters. The profile is likewise taken from the URI's
 *    authority rather than re-prompted: the document already commits to one
 *    connection, and prompting again could only introduce a mismatch
 *    between the schema the source came from and the schema a run/generate
 *    step would act on.
 * 2. A real workspace file matched by SourceIndex at the cursor — the
 *    original, and still the fastest, path.
 * 3. Neither: falls back to a QuickPick built from `getCandidates`, so the
 *    command remains usable in a workspace with no local PL/SQL source at
 *    all — the database-as-sole-source-of-truth shape this extension
 *    otherwise builds features for (utplsql-source://, the virtual-source
 *    coverage fallback), which used to make these three commands dead
 *    entries in the palette (issue #29).
 */
async function resolveAtCursor(
    ctx: UtplsqlContext,
    quickPickTitle: string,
    getCandidates: (profile: string, cfg: ConnectionProfile) => Promise<Candidate[]>
): Promise<ResolvedCursorObject | undefined> {
    const editor = vscode.window.activeTextEditor;
    const virtual = editor ? parseVirtualSourceUri(editor.document.uri) : undefined;
    if (virtual) {
        const cfg = getProfile(virtual.profile);
        if (!cfg) {
            vscode.window.showErrorMessage(`utPLSQL: connection profile '${virtual.profile}' no longer exists.`);
            return undefined;
        }
        const cursorPath = ctx.sourceIndex.getPathAtCursor(editor!.document, editor!.selection.active);
        const target = editorTargetFromVirtualSource(virtual, cursorPath);
        return { profile: virtual.profile, ...target };
    }

    const usableEditor = editor && matchesConfiguredLanguage(editor.document) ? editor : undefined;
    const cursorPath = usableEditor ? ctx.sourceIndex.getPathAtCursor(usableEditor.document, usableEditor.selection.active) : undefined;

    const profile = await pickProfile('Select connection profile');
    if (!profile) {
        return undefined;
    }
    const cfg = getProfile(profile);
    if (!cfg) {
        return undefined;
    }

    let editorTarget: Candidate | undefined;
    if (cursorPath) {
        const owner = (cfg.defaultSchema ?? cfg.user).toUpperCase();
        const [packageName, procedureName] = cursorPath.split('.', 2);
        editorTarget = { owner, packageName, procedureName };
    }

    const candidates = editorTarget ? [] : await getCandidates(profile, cfg);
    const chosen = await chooseTarget({
        editorTarget,
        candidates,
        pickOne: async (labels) => vscode.window.showQuickPick(labels, { title: quickPickTitle })
    });
    if (!chosen) {
        if (!editorTarget && candidates.length === 0) {
            vscode.window.showErrorMessage(`utPLSQL: no database objects found for '${profile}'.`);
        }
        return undefined;
    }
    return { profile, ...chosen };
}

/** Finds the TestItem for a resolved cursor object among already-discovered items, if any. */
function findKnownItem(ctx: UtplsqlContext, resolved: ResolvedCursorObject): vscode.TestItem | undefined {
    let found: vscode.TestItem | undefined;
    const visit = (item: vscode.TestItem) => {
        if (found) {
            return;
        }
        const meta = ctx.meta.get(item.id);
        if (meta && meta.profile === resolved.profile && meta.owner === resolved.owner && meta.row) {
            const nameMatches = meta.row.objectName.toUpperCase() === resolved.packageName.toUpperCase();
            const procMatches = !resolved.procedureName || meta.row.itemName.toUpperCase() === resolved.procedureName.toUpperCase();
            if (nameMatches && procMatches && (resolved.procedureName ? meta.row.itemType === 'UT_TEST' : true)) {
                found = item;
                return;
            }
        }
        item.children.forEach(visit);
    };
    ctx.controller.items.forEach(visit);
    return found;
}

export function registerTestCommands(extCtx: vscode.ExtensionContext, ctx: UtplsqlContext): void {
    extCtx.subscriptions.push(
        vscode.commands.registerCommand('utplsql.runTestAtCursor', async () => {
            const resolved = await resolveAtCursor(ctx, 'Select a test to run', (profile) => suiteRowCandidates(ctx, profile));
            if (!resolved) {
                return;
            }
            const item = findKnownItem(ctx, resolved);
            if (!item) {
                vscode.window.showErrorMessage(
                    `utPLSQL: '${resolved.packageName}${resolved.procedureName ? '.' + resolved.procedureName : ''}' is not in the Test Explorer yet. Run "Refresh Tests" first.`
                );
                return;
            }
            const request = new vscode.TestRunRequest([item]);
            const tokenSource = new vscode.CancellationTokenSource();
            try {
                await runTests(ctx, request, tokenSource.token);
            } finally {
                tokenSource.dispose();
            }
        }),

        vscode.commands.registerCommand('utplsql.runWithTags', async () => {
            const profile = await pickProfile('Select connection profile');
            if (!profile) {
                return;
            }
            // Only guards "the Testing view has never been asked about this
            // profile at all" (resolveHandler(undefined) never ran) — not
            // materialization depth below that. The old `|| root.children.size
            // === 0` half of this check was the actual bug (issue #18): it
            // fired as soon as the root's *schema* children existed, which is
            // exactly the state right after expanding the connection root and
            // before anything below it has been expanded, and is also the
            // single most common moment to invoke this command.
            const root = ctx.controller.items.get(rootId(profile));
            if (!root) {
                vscode.window.showErrorMessage(
                    `utPLSQL: '${profile}' has not been discovered yet. Open the Testing view (or run "Refresh Tests") first.`
                );
                return;
            }
            // Reads the full discovery row set (controller.ts's
            // suiteRowsCache, via getSuiteRows) instead of MetaStore, which
            // only holds rows for TestItems the lazily-materializing tree has
            // actually built — a suite the user never expanded contributed no
            // tags there even though its --%tags(...) annotations exist
            // (issue #18). The round trip this can trigger is the same one
            // resolveHandler already pays for when the tree gets expanded;
            // wrapping it in a progress notification here means the command
            // doesn't look hung while a first call (or one after Refresh
            // Tests) is still in flight.
            const rows = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `utPLSQL: discovering tests in '${profile}'…` },
                () => getSuiteRows(profile, (raw) => logUnknownItemType(ctx, profile, raw))
            );
            if (rows.length === 0) {
                vscode.window.showErrorMessage(`utPLSQL: no rows discovered for this profile ('${profile}'). Run "Refresh Tests" first.`);
                return;
            }
            const tags = dao.collectTags(rows);
            if (tags.length === 0) {
                vscode.window.showErrorMessage(`utPLSQL: no '--%tags(...)' annotations found among the discovered tests for '${profile}'.`);
                return;
            }
            // Tag -> number of discovered rows carrying it — free once the
            // full row set is in hand, and tells the user up front roughly
            // how much a tag will run instead of them finding out only after
            // starting it.
            const counts = new Map<string, number>();
            for (const row of rows) {
                for (const tag of (row.tags ?? '').split(',').map((t) => t.trim()).filter((t) => t.length > 0)) {
                    counts.set(tag, (counts.get(tag) ?? 0) + 1);
                }
            }
            const items = tags.map((tag) => {
                const count = counts.get(tag) ?? 0;
                return { label: tag, description: `${count} test${count === 1 ? '' : 's'}` };
            });
            const selected = await vscode.window.showQuickPick(items, {
                title: `Run tests tagged in '${profile}'`,
                canPickMany: true,
                placeHolder: 'Select one or more tags — tests are run if they carry any of them'
            });
            if (!selected || selected.length === 0) {
                return;
            }
            const request = new vscode.TestRunRequest([root]);
            const tokenSource = new vscode.CancellationTokenSource();
            try {
                await runTests(ctx, request, tokenSource.token, { tags: selected.map((s) => s.label) });
            } finally {
                tokenSource.dispose();
            }
        }),

        vscode.commands.registerCommand('utplsql.rebuildAnnotations', async () => {
            const profile = await pickProfile('Select connection profile');
            if (!profile) {
                return;
            }
            const cfg = getProfile(profile);
            if (!cfg) {
                return;
            }
            // Prefer the schemas already discovered for this profile (a
            // connection can surface suites owned by more than one schema);
            // fall back to the profile's own default schema when nothing has
            // been discovered yet.
            const owners = new Set<string>();
            const root = ctx.controller.items.get(rootId(profile));
            root?.children.forEach((schemaItem) => {
                const parsed = parseId(schemaItem.id);
                if (parsed.kind === 'schema') {
                    owners.add(parsed.owner);
                }
            });
            if (owners.size === 0) {
                owners.add((cfg.defaultSchema ?? cfg.user).toUpperCase());
            }

            const pool = await getPool(cfg, extCtx.secrets, 0);
            const conn = await pool.getConnection();
            try {
                for (const owner of owners) {
                    await dao.rebuildAnnotationCache(conn, owner);
                }
            } finally {
                await conn.close();
            }
            ctx.output.appendLine(`utPLSQL: rebuilt annotation cache for '${profile}' (${[...owners].sort().join(', ')})`);
            const tokenSource = new vscode.CancellationTokenSource();
            try {
                await ctx.controller.refreshHandler?.(tokenSource.token);
            } finally {
                tokenSource.dispose();
            }
        }),

        vscode.commands.registerCommand('utplsql.runWithReporter', async () => {
            const resolved = await resolveAtCursor(ctx, 'Select an object to export', (profile) => suiteRowCandidates(ctx, profile));
            if (!resolved) {
                return;
            }
            const cfg = getProfile(resolved.profile);
            if (!cfg) {
                return;
            }
            const pool = await getPool(cfg, extCtx.secrets, 1);
            const probeConn = await pool.getConnection();
            let reporters;
            try {
                reporters = await dao.getReportersList(probeConn);
            } finally {
                await probeConn.close();
            }
            if (reporters.length === 0) {
                vscode.window.showErrorMessage('utPLSQL: no output reporters available on this DB.');
                return;
            }
            const reporterName = await vscode.window.showQuickPick(
                reporters.map((r) => r.reporterObjectName),
                { title: 'Select reporter' }
            );
            if (!reporterName) {
                return;
            }
            const runPath = `${resolved.owner}:${resolved.packageName}`;

            // Gives the quick cursor shortcut the same visible, cancellable
            // operation the "Export with Reporter" run profile now has
            // (runReporterExport, reporterProfile.ts) — previously this
            // command had no cancellation token at all, so the only way to
            // stop a wedged export was to reload the extension host.
            const { output, cancelled } = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `utPLSQL: exporting '${resolved.packageName}' with ${reporterName}…`,
                    cancellable: true
                },
                async (progress, token) => {
                    const producerConn = await pool.getConnection();
                    const consumerConn = await pool.getConnection();
                    let result: Awaited<ReturnType<typeof runWithReporterDao>>;
                    try {
                        result = await runWithReporterDao(producerConn, consumerConn, reporterName, [runPath], readReporterOptions(), token, (message) =>
                            progress.report({ message })
                        );
                    } finally {
                        await producerConn.close().catch(() => undefined);
                        // Tolerant: a cancelled result already had this same
                        // connection broken and drop-closed by
                        // runWithReporterDao's cancelConsumer(), so a second
                        // close() on it throwing is expected, not a failure.
                        await consumerConn.close().catch(() => undefined);
                    }
                    // Only after both connections are safely closed — same
                    // ordering as runOneProfile's finally block
                    // (runHandler.ts) and for the same reason: recyclePool()'s
                    // pool.close(0) must not race a still-executing statement
                    // on producerConn.
                    if (result.cancelled) {
                        await recyclePool(resolved.profile);
                    }
                    return result;
                }
            );
            if (cancelled) {
                ctx.output.appendLine(`utPLSQL: export of '${resolved.packageName}' cancelled.`);
                return;
            }

            const target = await vscode.window.showQuickPick(['Show in Output Channel', 'Save to File'], {
                title: 'Where should the report go?'
            });
            if (target === 'Save to File') {
                const uri = await vscode.window.showSaveDialog({});
                if (uri) {
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(output, 'utf8'));
                }
            } else {
                ctx.output.appendLine(output);
                ctx.output.show(true);
            }
        }),

        vscode.commands.registerCommand('utplsql.generateTest', async () => {
            const resolved = await resolveAtCursor(ctx, 'Select an object to generate a test for', (_profile, cfg) => testableCandidates(ctx, cfg));
            if (!resolved) {
                return;
            }
            const cfg = getProfile(resolved.profile);
            if (!cfg) {
                return;
            }
            const pool = await getPool(cfg, extCtx.secrets, 0);
            const conn = await pool.getConnection();
            let units;
            try {
                units = await dao.testables(conn, resolved.owner);
            } finally {
                await conn.close();
            }
            const matching = units.filter((u) => u.objectName.toUpperCase() === resolved.packageName.toUpperCase());
            if (matching.length === 0) {
                vscode.window.showErrorMessage(`utPLSQL: '${resolved.packageName}' has no testable procedures/functions.`);
                return;
            }
            const procNames = matching.map((u) => u.subobjectName ?? u.objectName).filter((n, i, arr) => arr.indexOf(n) === i);
            const skeleton = generateTestPackage(matching[0], procNames, readGenerateOptions());
            const doc = await vscode.workspace.openTextDocument({ language: editorLanguageId(), content: skeleton });
            await vscode.window.showTextDocument(doc);
        })
    );
}

function editorLanguageId(): string {
    const active = vscode.window.activeTextEditor;
    return active && matchesConfiguredLanguage(active.document) ? active.document.languageId : 'sql';
}
