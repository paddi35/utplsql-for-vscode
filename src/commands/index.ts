import * as vscode from 'vscode';
import { addProfile, getProfile, readProfiles, removeProfile, setPassword } from '../db/connections';
import { getPool } from '../db/pool';
import * as dao from '../db/utplsqlDao';
import { runWithReporter as runWithReporterDao } from '../db/reporterDao';
import { UtplsqlContext } from '../testing/model';
import { runTests } from '../testing/runHandler';
import { parseId, rootId } from '../testing/ids';
import { generateTestPackage, readGenerateOptions } from '../generate/testTemplate';
import { matchesConfiguredLanguage } from '../workspace/languageIndex';
import { listTnsAliases, resolveTnsAdminDir } from '../db/tnsnames';

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

async function resolveAtCursor(ctx: UtplsqlContext): Promise<ResolvedCursorObject | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !matchesConfiguredLanguage(editor.document)) {
        vscode.window.showErrorMessage('utPLSQL: place the cursor in a PL/SQL file first.');
        return undefined;
    }
    const path = ctx.sourceIndex.getPathAtCursor(editor.document, editor.selection.active);
    if (!path) {
        vscode.window.showErrorMessage('utPLSQL: no PACKAGE/TYPE/PROCEDURE/FUNCTION found at cursor.');
        return undefined;
    }
    const profile = await pickProfile('Select connection profile');
    if (!profile) {
        return undefined;
    }
    const cfg = getProfile(profile);
    if (!cfg) {
        return undefined;
    }
    const owner = (cfg.defaultSchema ?? cfg.user).toUpperCase();
    const [packageName, procedureName] = path.split('.', 2);
    return { profile, owner, packageName, procedureName };
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
            const resolved = await resolveAtCursor(ctx);
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
            const root = ctx.controller.items.get(rootId(profile));
            if (!root || root.children.size === 0) {
                vscode.window.showErrorMessage(
                    `utPLSQL: no tests discovered yet for '${profile}'. Expand it in the Testing view (or run "Refresh Tests") first.`
                );
                return;
            }
            const tags = dao.collectTags(
                ctx.meta
                    .valuesForProfile(profile)
                    .map((m) => m.row)
                    .filter((row): row is NonNullable<typeof row> => row !== undefined)
            );
            if (tags.length === 0) {
                vscode.window.showErrorMessage(`utPLSQL: no '--%tags(...)' annotations found among the discovered tests for '${profile}'.`);
                return;
            }
            const selected = await vscode.window.showQuickPick(tags, {
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
                await runTests(ctx, request, tokenSource.token, { tags: selected });
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
            const resolved = await resolveAtCursor(ctx);
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

            const producerConn = await pool.getConnection();
            const consumerConn = await pool.getConnection();
            let output: string;
            try {
                output = await runWithReporterDao(producerConn, consumerConn, reporterName, [runPath]);
            } finally {
                await producerConn.close();
                await consumerConn.close();
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
            const resolved = await resolveAtCursor(ctx);
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
