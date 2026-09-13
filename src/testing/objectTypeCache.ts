/**
 * Per (profile, owner) cache of PACKAGE/PACKAGE BODY object types, backing
 * controller.ts's resolveVirtualTypes (issue #22). Kept vscode-free (see
 * singleFlight.ts, virtualSourcePath.ts for the same split elsewhere in this
 * codebase) so it is directly testable with plain mocha, via an injected
 * `fetchAll` rather than a real Connection.
 *
 * dao.getPackageObjectTypes() used to be called fresh, on its own pooled
 * connection, once per materialized tree level — every expanded suitepath/
 * context node with rows missing a local workspace file re-asked the same
 * question for whatever subset of names that one level happened to have.
 * This lands hardest exactly where the extension is meant to shine: a
 * workspace with no local PL/SQL source at all, the database as sole source
 * of truth, where *every* row at *every* level misses the source index. A
 * package's PACKAGE vs PACKAGE BODY answer (or its absence — neither exists
 * in this schema) is stable for the life of a discovery cache, so it only
 * needs asking once per owner, not once per level:
 *
 * - `resolve()` treats a name never seen for (profile, owner) as unknown and
 *   worth fetching; a name seen but absent from a previous fetch's result is
 *   recorded as a confirmed miss (the Map explicitly holds `undefined` for
 *   it) and is never retried — previously, "absent from the last batch" and
 *   "not yet asked" were indistinguishable, so a --%suitepath grouping row
 *   (whose objectName isn't a real package at all, see issue #27) triggered
 *   a fresh round trip every time a level containing it was resolved.
 * - Concurrent resolve() calls for the same owner single-flight into one
 *   `fetchAll` call, the same shape singleFlight.ts uses, kept separate here
 *   because the cached unit is one name's answer within a per-owner batch —
 *   including negative answers — rather than one blob value per key.
 *
 * Priming an owner's *entire* known name list in one call rather than just
 * whatever a single level is missing is the caller's job, not this cache's:
 * controller.ts's materializeLevel passes every distinct object name in the
 * owner's already-built children index (childrenIndexCache), not just the
 * current level's, as `names` — so the first level of an owner that needs a
 * virtual-source lookup at all primes the whole owner in one round trip
 * (docs/performance.md already established that its bind-list approach
 * handles thousands of names in a single call), and every later level for
 * the same owner asks about names this cache already knows, at zero DB cost.
 * That also means concurrent resolve() calls for the same owner are expected
 * to request the same name set — true for that call site — since a second
 * caller whose names aren't covered by an already in-flight fetch still
 * waits for it rather than starting a second one; any of its names outside
 * that batch are picked up on its next call instead of the current one.
 */
export type ObjectType = 'PACKAGE BODY' | 'PACKAGE';

export interface ObjectTypeCache {
    /**
     * Resolved types for `names` under (profile, owner). Names this cache
     * has never seen for this owner are fetched via `fetchAll` — single-
     * flighted per owner — and both positive and negative answers are
     * memoized; already-known names (whichever way) never trigger a fetch.
     * The returned map holds only names that actually resolved to a type —
     * a name with neither a PACKAGE nor a PACKAGE BODY is simply absent from
     * it, the same contract dao.getPackageObjectTypes has.
     */
    resolve(profile: string, owner: string, names: readonly string[], fetchAll: (names: string[]) => Promise<Map<string, ObjectType>>): Promise<Map<string, ObjectType>>;

    /** Drops the cache for one owner under `profile`, every owner under `profile` when `owner` is omitted, or everything when both are omitted. */
    clear(profile?: string, owner?: string): void;
}

export function createObjectTypeCache(): ObjectTypeCache {
    const perOwner = new Map<string, Map<string, ObjectType | undefined>>();
    const priming = new Map<string, Promise<void>>();

    function ownerKey(profile: string, owner: string): string {
        return `${profile}:${owner.toUpperCase()}`;
    }

    return {
        async resolve(profile, owner, names, fetchAll) {
            const key = ownerKey(profile, owner);
            let known = perOwner.get(key);
            if (!known) {
                known = new Map();
                perOwner.set(key, known);
            }
            const upperNames = [...new Set(names.map((n) => n.toUpperCase()))];
            const unknown = upperNames.filter((n) => !known!.has(n));

            if (unknown.length > 0) {
                let p = priming.get(key);
                if (!p) {
                    p = fetchAll(unknown)
                        .then((fetched) => {
                            unknown.forEach((n) => known!.set(n, fetched.get(n)));
                        })
                        .finally(() => priming.delete(key));
                    priming.set(key, p);
                }
                await p;
            }

            const result = new Map<string, ObjectType>();
            upperNames.forEach((n) => {
                const type = known!.get(n);
                if (type) {
                    result.set(n, type);
                }
            });
            return result;
        },
        clear(profile, owner) {
            if (profile === undefined) {
                perOwner.clear();
                priming.clear();
                return;
            }
            const exact = owner !== undefined ? ownerKey(profile, owner) : undefined;
            const prefix = `${profile}:`;
            const matches = (k: string): boolean => (exact !== undefined ? k === exact : k.startsWith(prefix));
            [...perOwner.keys()].filter(matches).forEach((k) => perOwner.delete(k));
            [...priming.keys()].filter(matches).forEach((k) => priming.delete(k));
        }
    };
}
