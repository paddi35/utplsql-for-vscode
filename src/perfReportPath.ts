import * as path from 'node:path';

/**
 * Pure path-containment logic for utplsql.perf.reportFile (see perf.ts),
 * kept vscode-free so it can be unit tested directly with plain mocha/
 * ts-node instead of the extension host -- importing 'vscode' itself fails
 * outside it (see workspace/virtualSourcePath.ts for the same pattern).
 *
 * utplsql.perf.reportFile/perf.enabled are now "scope": "machine"
 * (package.json), which is the actual fix for the arbitrary-file-append
 * primitive this setting used to be: VS Code itself drops a workspace's own
 * .vscode/settings.json value for a machine-scoped setting before any
 * extension ever sees it via getConfiguration(). This module is the
 * belt-and-braces half -- even a legitimately user/machine-configured value
 * is resolved and required to land inside one of the caller-supplied
 * allowedRoots before perf.ts will append anything to it, so a stray or
 * mistyped path can't silently corrupt an unrelated file either.
 */

/**
 * path.relative()+path.isAbsolute(), not a startsWith() prefix comparison:
 * a naive string-prefix check would treat 'C:/ws/../../etc/x' as "inside"
 * 'C:/ws' because the *unresolved* string happens to start with that
 * substring, and would also treat a sibling directory like 'C:/ws-evil' as
 * inside 'C:/ws'. Resolving both paths first (collapsing '..' traversal)
 * and comparing via path.relative() instead of substring matching closes
 * both holes. A relative result that starts with '..' or is itself
 * absolute (Node's signal for "no relative path exists between these two",
 * e.g. across Windows drive letters or to/from a UNC path) means candidate
 * is not under root. An exact match (candidate === root) is also treated
 * as "not inside" -- root is a directory, candidate is expected to name a
 * file within one, and appending to a directory path fails at the fs layer
 * regardless -- mirroring the semantics of the widely used is-path-inside
 * package rather than inventing a bespoke rule here.
 */
function isInside(root: string, candidate: string): boolean {
    const rel = path.relative(root, candidate);
    return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/**
 * True if candidatePath resolves to somewhere inside one of allowedRoots
 * (typically the open workspace folder(s); see perf.ts for what it passes
 * today and why the extension's own globalStorageUri/logUri aren't among
 * them yet). Both sides are resolved with path.resolve() before comparing,
 * so a relative candidatePath is measured from process.cwd() -- which for
 * an extension host is not workspace-related, so a relative
 * utplsql.perf.reportFile value is rejected unless that coincidentally
 * lands inside an allowed root anyway; that is the correct, conservative
 * outcome, not a bug.
 */
export function isReportFileAllowed(candidatePath: string, allowedRoots: readonly string[]): boolean {
    if (!candidatePath || allowedRoots.length === 0) {
        return false;
    }
    const resolved = path.resolve(candidatePath);
    return allowedRoots.some((root) => isInside(path.resolve(root), resolved));
}

export interface ReportFileGuard {
    /**
     * Returns true if the caller should proceed to write to candidatePath.
     * Calls the guard's onRejected callback at most once per guard instance
     * -- the first time an invalid path is seen -- rather than once per
     * check(), so a perf session stuck with a bad utplsql.perf.reportFile
     * logs one actionable line instead of spamming the output channel once
     * per measure() span.
     */
    check(candidatePath: string): boolean;
}

/** Wraps isReportFileAllowed() with the "warn once" bookkeeping perf.ts's emit() needs, without perf.ts having to manage that state itself. */
export function createReportFileGuard(allowedRoots: readonly string[], onRejected: (candidatePath: string) => void): ReportFileGuard {
    let warned = false;
    return {
        check(candidatePath: string): boolean {
            if (isReportFileAllowed(candidatePath, allowedRoots)) {
                return true;
            }
            if (!warned) {
                warned = true;
                onRejected(candidatePath);
            }
            return false;
        }
    };
}
