import * as vscode from 'vscode';
import { listTnsAliases, pickTnsAdminDir, TnsAdminResolution, TnsAdminSource } from './tnsAdminDir';

export { listTnsAliases, TnsAdminResolution, TnsAdminSource };

/**
 * Resolves the tnsnames.ora directory to use, in priority order:
 * 1. our own setting (explicit override)
 * 2. the Oracle SQL Developer for VSCode extension's setting, if that
 *    extension is installed and configured — its own description calls this
 *    a "Folder path for tnsnames.ora file", i.e. exactly what oracledb's
 *    configDir/getNetworkServiceNames expect, so it can be reused as-is.
 * 3. the TNS_ADMIN environment variable.
 *
 * The actual priority logic lives in pickTnsAdminDir() (tnsAdminDir.ts),
 * kept vscode-free so it is directly unit testable; this function's only
 * job is to gather the three raw inputs from vscode's configuration API and
 * the environment. See resolveTnsAdminDirWithSource() below for a variant
 * that also reports which source won, for logging.
 */
export function resolveTnsAdminDir(): string | undefined {
    return resolveTnsAdminDirWithSource().dir;
}

/**
 * Same resolution as resolveTnsAdminDir(), but also reports which of the
 * three sources actually won — own setting / SQL Developer / TNS_ADMIN /
 * none — so a caller can log it. This is issue #12's second ask (logging
 * the winning source to the 'utPLSQL' output channel at pool-creation time)
 * without changing resolveTnsAdminDir()'s own return type: that function is
 * called from src/db/pool.ts's getPool(), which is out of scope for this
 * change, so its existing `string | undefined` contract is left alone.
 * Wiring this into getPool()'s logging is left for a follow-up there.
 */
export function resolveTnsAdminDirWithSource(): TnsAdminResolution {
    const own = vscode.workspace.getConfiguration('utplsql').get<string>('connections.tnsAdminPath');
    /**
     * inspect(), not get(): get() would silently return whichever scope's
     * value wins, including one set by the workspace's own
     * .vscode/settings.json. Unlike our own tnsAdminPath — declared
     * "scope": "machine" in package.json, so VS Code itself blocks a
     * workspace from setting it — this key belongs to a different
     * extension whose declared scope is not ours to control. Passing the
     * full inspect() result lets pickTnsAdminDir() ignore
     * workspaceValue/workspaceFolderValue and only trust
     * globalValue/defaultValue; see its doc comment for the full reasoning
     * (this inspect() call, in place of the previous plain get(), is the
     * actual fix for issue #12).
     */
    const sqldevInspect = vscode.workspace.getConfiguration('sqldeveloper').inspect<string>('connections.tnsConfiguration.path');
    return pickTnsAdminDir({ own, sqldevInspect, envTnsAdmin: process.env.TNS_ADMIN || undefined });
}
