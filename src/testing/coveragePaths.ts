/**
 * Normalizes a coverage-XML file path (as returned by ut_coverage_sonar_reporter's
 * <file path="...">) into a plain workspace-relative, forward-slash path, or
 * returns undefined if it isn't safely joinable onto a workspace root.
 *
 * buildCoverageOptions always sends forward-slash relative paths in
 * ut_file_mapping.file_name, and the reporter is confirmed (against a live
 * utPLSQL 3.2.3 instance, see test/integration/coverage.test.ts) to echo that
 * value back unchanged — so this is defense-in-depth, not a path this
 * extension is known to hit: it tolerates stray backslashes and rejects
 * absolute paths (POSIX or Windows drive-letter) and '..' segments, so an
 * unexpected value can't join outside the workspace folder.
 *
 * Kept vscode-free (unlike coverage.ts, which calls this) so it can be unit
 * tested directly with plain mocha/ts-node instead of the extension host.
 */
export function resolveWorkspaceRelativePath(relativePath: string): string | undefined {
    const normalized = relativePath.replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
        return undefined;
    }
    return normalized;
}
