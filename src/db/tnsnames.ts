import oracledb from 'oracledb';
import * as vscode from 'vscode';

/**
 * Resolves the tnsnames.ora directory to use, in priority order:
 * 1. our own setting (explicit override)
 * 2. the Oracle SQL Developer for VSCode extension's setting, if that
 *    extension is installed and configured — its own description calls this
 *    a "Folder path for tnsnames.ora file", i.e. exactly what oracledb's
 *    configDir/getNetworkServiceNames expect, so it can be reused as-is.
 * 3. the TNS_ADMIN environment variable.
 */
export function resolveTnsAdminDir(): string | undefined {
    const own = vscode.workspace.getConfiguration('utplsql').get<string>('connections.tnsAdminPath');
    if (own) {
        return own;
    }
    const sqldev = vscode.workspace.getConfiguration('sqldeveloper').get<string>('connections.tnsConfiguration.path');
    if (sqldev) {
        return sqldev;
    }
    return process.env.TNS_ADMIN || undefined;
}

/** Net Service Names (TNS aliases) defined in <configDir>/tnsnames.ora, or [] if unavailable. */
export async function listTnsAliases(configDir: string): Promise<string[]> {
    try {
        return await oracledb.getNetworkServiceNames(configDir);
    } catch {
        return [];
    }
}
