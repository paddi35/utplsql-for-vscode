/**
 * Orchestrates "forget everything about this connection profile" across the
 * four per-profile caches issue #19 found had drifted out of sync:
 * suiteRowsCache/objectTypeCache/childrenIndexCache (src/testing/
 * controller.ts), the utPLSQL version cache (src/db/versionCache.ts) and the
 * dba_/all_ view-prefix cache (src/db/utplsqlDao.ts) were each invalidated
 * by nothing at all — only deactivate()'s closeAllPools and recyclePool()
 * touched the pool, and none of the four caches had any per-profile
 * invalidation path whatsoever. A profile whose password was just fixed, or
 * that was just removed, kept every one of these until a window reload.
 *
 * Takes the five operations as an injected `handles` object rather than
 * importing pool.ts/versionCache.ts/utplsqlDao.ts/controller.ts's own
 * module-level caches directly, so this orchestration — "clear all five,
 * for exactly this profile, leaving every other profile's entries alone" —
 * is directly testable with plain mocha (the same split singleFlight.ts and
 * objectTypeCache.ts use). The real wiring lives in controller.ts's own
 * exported forgetProfile(), which is the only thing commands/index.ts calls.
 */
export interface ProfileCacheHandles {
    clearSuiteRows(profile: string): void;
    clearObjectTypes(profile: string): void;
    clearChildrenIndex(profile: string): void;
    clearVersion(profile: string): void;
    clearDbaView(profile: string): void;
    /**
     * Evicts the cached pool for `profile`. controller.ts's real wiring
     * passes pool.ts's recyclePool rather than closePool here: recyclePool
     * drops the map entry unconditionally before attempting pool.close(),
     * so a pool that fails to close cleanly (the same failure mode its own
     * doc comment describes for a cancelled run) still doesn't survive a
     * forgetProfile call and get handed back out by the next getPool().
     */
    closePool(profile: string): Promise<void>;
}

export async function forgetProfile(name: string, handles: ProfileCacheHandles): Promise<void> {
    handles.clearSuiteRows(name);
    handles.clearObjectTypes(name);
    handles.clearChildrenIndex(name);
    handles.clearVersion(name);
    handles.clearDbaView(name);
    await handles.closePool(name);
}
