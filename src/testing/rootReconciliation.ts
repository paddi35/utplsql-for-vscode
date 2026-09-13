import { rootId } from './ids';

export interface RootReconciliation {
    /** Root ids to create — a configured profile with no existing root item yet. */
    added: string[];
    /** Root ids to remove — an existing root item whose profile is no longer configured. */
    removed: string[];
}

/**
 * Pure diff between the Test Explorer's current root TestItem ids and the
 * profiles currently configured. Backs both controller.ts's
 * onDidChangeConfiguration('utplsql.connections') listener (issue #19: a
 * profile added or removed — via a command, or by hand-editing
 * settings.json, which the listener covers too — used to leave the tree
 * stale until a manual refresh or window reload) and its initial
 * resolveHandler(undefined) call, which is just reconcileRoots(existingIds:
 * [], profiles) with everything landing in `added`.
 *
 * Kept vscode-free (see singleFlight.ts, objectTypeCache.ts for the same
 * split elsewhere in this codebase) so it is directly testable with plain
 * mocha: the caller does the actual TestItem creation/deletion, this only
 * decides which ids to create or delete, so a computed diff is exactly what
 * a controller.items.forEach + Set comparison would otherwise duplicate at
 * every call site.
 */
export function reconcileRoots(existingIds: readonly string[], profileNames: readonly string[]): RootReconciliation {
    const desiredIds = new Set(profileNames.map(rootId));
    const currentIds = new Set(existingIds);
    return {
        added: [...desiredIds].filter((id) => !currentIds.has(id)),
        removed: [...currentIds].filter((id) => !desiredIds.has(id))
    };
}
