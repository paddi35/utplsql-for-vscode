/**
 * Pure path-string logic for utplsql-source:// URIs (see virtualSource.ts),
 * kept vscode-free so it can be unit tested directly with plain mocha/ts-node
 * instead of the extension host — importing 'vscode' itself fails outside it.
 */
export interface VirtualSourcePathParts {
    owner: string;
    name: string;
    isBody: boolean;
}

/** .pkb/.pks so the resulting document still gets 'oracle-sql' syntax highlighting (see package.json's language contribution). */
export function buildVirtualSourcePath(owner: string, name: string, isBody: boolean): string {
    return `/${owner}/${name}.${isBody ? 'pkb' : 'pks'}`;
}

const PATH_RE = /^\/([^/]+)\/([^/.]+)\.(pkb|pks)$/;

export function parseVirtualSourcePath(path: string): VirtualSourcePathParts | undefined {
    const m = PATH_RE.exec(path);
    if (!m) {
        return undefined;
    }
    return { owner: m[1], name: m[2], isBody: m[3] === 'pkb' };
}
