import oracledb from 'oracledb';

/**
 * TNS_ADMIN directory selection (pickTnsAdminDir) and alias listing
 * (listTnsAliases), kept vscode-free so both are directly testable with
 * plain mocha/tsx instead of the extension host — importing 'vscode'
 * itself fails outside it, the same reason
 * src/workspace/virtualSourcePath.ts is split out of virtualSource.ts.
 * oracledb is a plain npm dependency, not vscode, so it does not break that
 * property; tnsnames.ts re-exports both from here for its existing callers
 * (src/commands/index.ts, src/db/pool.ts) and additionally gathers the
 * vscode-dependent inputs pickTnsAdminDir() needs.
 */

/** Which of pickTnsAdminDir()'s three sources actually won. */
export type TnsAdminSource = 'own' | 'sqldeveloper' | 'env' | 'none';

export interface TnsAdminResolution {
    dir: string | undefined;
    source: TnsAdminSource;
}

/**
 * The subset of vscode.WorkspaceConfiguration.inspect()'s return shape this
 * module cares about. Deliberately not typed by importing from 'vscode':
 * even a type-only import would tie this file to a module that cannot be
 * resolved outside the extension host, defeating the point of the split.
 */
export interface TnsAdminInspect {
    defaultValue?: string;
    globalValue?: string;
    workspaceValue?: string;
    workspaceFolderValue?: string;
}

export interface PickTnsAdminDirInput {
    /** utplsql.connections.tnsAdminPath, via get(). Machine-scoped (package.json), so a plain get() is safe. */
    own: string | undefined;
    /** sqldeveloper.connections.tnsConfiguration.path, via inspect() rather than get() — see pickTnsAdminDir's doc comment for why that distinction is the actual fix here. */
    sqldevInspect: TnsAdminInspect | undefined;
    /** The TNS_ADMIN environment variable, already read. */
    envTnsAdmin: string | undefined;
}

/**
 * Picks the TNS_ADMIN directory to use, in priority order, from already-read
 * inputs — no vscode or filesystem access here, so every branch is directly
 * assertable from a plain object literal. See resolveTnsAdminDir() /
 * resolveTnsAdminDirWithSource() in tnsnames.ts for how the real inputs are
 * gathered.
 *
 * The SQL Developer fallback only honours `globalValue`/`defaultValue`,
 * never `workspaceValue`/`workspaceFolderValue`. Our own `own` setting is
 * declared `"scope": "machine"` in package.json, so VS Code itself refuses
 * to let a workspace set it — reading it with plain get() is fine, whatever
 * it returns already went through that scope check. But
 * `sqldeveloper.connections.tnsConfiguration.path` is declared by a
 * different extension (Oracle SQL Developer for VSCode), whose scope this
 * extension does not control; if it declares no scope (or "window", VS
 * Code's default), a workspace's own .vscode/settings.json can set it. That
 * directory is handed straight to oracledb.createPool()'s configDir
 * (src/db/pool.ts), i.e. where tnsnames.ora/sqlnet.ora are read from — so a
 * workspace-supplied value there can redefine the TNS alias a stored-
 * password connection profile names, redirecting that connection
 * (credentials included) to a host the workspace chose, merely because the
 * user opened the Testing view. Restricting the fallback to global/default
 * values closes that off without giving up the fallback for the case it
 * exists for: a user who has SQL Developer's setting configured for
 * themselves, machine-wide, and would reasonably expect this extension to
 * reuse it instead of asking again.
 */
export function pickTnsAdminDir({ own, sqldevInspect, envTnsAdmin }: PickTnsAdminDirInput): TnsAdminResolution {
    if (own) {
        return { dir: own, source: 'own' };
    }
    const sqldev = sqldevInspect?.globalValue ?? sqldevInspect?.defaultValue;
    if (sqldev) {
        return { dir: sqldev, source: 'sqldeveloper' };
    }
    if (envTnsAdmin) {
        return { dir: envTnsAdmin, source: 'env' };
    }
    return { dir: undefined, source: 'none' };
}

/** Net Service Names (TNS aliases) defined in <configDir>/tnsnames.ora, or [] if unavailable. */
export async function listTnsAliases(configDir: string): Promise<string[]> {
    try {
        return await oracledb.getNetworkServiceNames(configDir);
    } catch {
        return [];
    }
}
