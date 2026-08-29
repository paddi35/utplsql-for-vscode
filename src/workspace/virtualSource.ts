import * as vscode from 'vscode';
import { getProfile } from '../db/connections';
import { getPool } from '../db/pool';
import { getObjectSource } from '../db/utplsqlDao';
import { buildVirtualSourcePath, parseVirtualSourcePath } from './virtualSourcePath';

/**
 * URI scheme for PL/SQL source that exists only in the database, not as a
 * workspace file — e.g. a schema whose packages are never checked out
 * locally, DB being the sole source of truth. Coverage (and anything else
 * that needs a vscode.Uri to point at) uses these instead of failing to map
 * the object at all, so native coverage gutters and the Test Coverage panel
 * still work without a local file.
 */
export const VIRTUAL_SOURCE_SCHEME = 'utplsql-source';

export interface VirtualSourceParts {
    profile: string;
    owner: string;
    name: string;
    isBody: boolean;
}

export function virtualSourceUri(profile: string, owner: string, name: string, isBody: boolean): vscode.Uri {
    return vscode.Uri.from({
        scheme: VIRTUAL_SOURCE_SCHEME,
        authority: profile,
        path: buildVirtualSourcePath(owner, name, isBody)
    });
}

export function parseVirtualSourceUri(uri: vscode.Uri): VirtualSourceParts | undefined {
    if (uri.scheme !== VIRTUAL_SOURCE_SCHEME) {
        return undefined;
    }
    const parts = parseVirtualSourcePath(uri.path);
    return parts ? { profile: uri.authority, ...parts } : undefined;
}

export class VirtualSourceProvider implements vscode.TextDocumentContentProvider {
    constructor(private readonly secrets: vscode.SecretStorage) {}

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const parsed = parseVirtualSourceUri(uri);
        if (!parsed) {
            return `-- utPLSQL: invalid virtual source URI '${uri.toString()}'`;
        }
        const cfg = getProfile(parsed.profile);
        if (!cfg) {
            return `-- utPLSQL: unknown connection profile '${parsed.profile}'`;
        }
        const pool = await getPool(cfg, this.secrets, 0);
        const conn = await pool.getConnection();
        try {
            const type = parsed.isBody ? 'PACKAGE BODY' : 'PACKAGE';
            const source = await getObjectSource(conn, parsed.owner, parsed.name, type);
            return source || `-- utPLSQL: no ${type} source found for ${parsed.owner}.${parsed.name}`;
        } finally {
            await conn.close();
        }
    }
}
