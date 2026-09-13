/**
 * Generic resolved-value cache with in-flight de-duplication, keyed by an
 * arbitrary string. Kept vscode-free (see workspace/virtualSourcePath.ts for
 * the same split elsewhere in this codebase) so it is directly testable with
 * plain mocha/tsx instead of the extension host.
 *
 * Fixes the shape of issue #17: controller.ts's fetchSuiteRows used to cache
 * only the *resolved* value, which is a cache-effective-only-after-the-fact
 * — every caller that arrives while the first fetch for a profile is still
 * running starts its own redundant one. VS Code invokes resolveHandler
 * concurrently for sibling Test Explorer items (a root plus a schema, or two
 * schemas at once), and runHandler.ts's ensureSubtreeResolved drives it
 * again before every run, so on the documented 1000-package fixture — one
 * getSuitesInfo call measured at ~27-59s, see docs/performance.md — a
 * duplicated call is not a rounding error. Caching the in-flight PROMISE
 * instead closes that window: every caller for the same key while a fetch is
 * running shares it, and only the winner actually calls `fetch`.
 */
export interface SingleFlightCache<T> {
    /** The cached resolved value for `key`, without triggering or joining a fetch. */
    peek(key: string): T | undefined;

    /**
     * Returns the cached value for `key` if there is one; otherwise joins an
     * already-running fetch for `key`, or starts a new one via `fetch`.
     * Concurrent callers for the same key therefore always share exactly one
     * underlying call, and all resolve to (or reject with) the same result.
     * On rejection, the in-flight entry is dropped and the resolved-value
     * cache is left unset — so a transient failure is not pinned for the
     * rest of the session, and the next call retries from scratch.
     */
    get(key: string, fetch: () => Promise<T>): Promise<T>;

    /**
     * Drops the resolved-value cache for `key`, or for every key when
     * omitted. Deliberately leaves any in-flight fetch running rather than
     * also removing it: a caller that arrives while a fetch triggered before
     * the clear is still running joins that same fetch instead of triggering
     * a redundant second one, and its eventual (non-stale) result is what
     * repopulates the cache — never a value from before the clear, since
     * none is left cached in the meantime.
     */
    clear(key?: string): void;
}

export function createSingleFlightCache<T>(): SingleFlightCache<T> {
    const values = new Map<string, T>();
    const inFlight = new Map<string, Promise<T>>();

    return {
        peek(key) {
            return values.get(key);
        },
        get(key, fetch) {
            if (values.has(key)) {
                return Promise.resolve(values.get(key) as T);
            }
            const pending = inFlight.get(key);
            if (pending) {
                return pending;
            }
            const p = fetch()
                .then((value) => {
                    values.set(key, value);
                    return value;
                })
                .finally(() => inFlight.delete(key));
            inFlight.set(key, p);
            return p;
        },
        clear(key) {
            if (key !== undefined) {
                values.delete(key);
            } else {
                values.clear();
            }
        }
    };
}
