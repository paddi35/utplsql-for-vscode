import { Connection } from 'oracledb';
import * as dao from './utplsqlDao';

/**
 * ut.version() is a real round-trip, and every entry point that needs it
 * (discovery's get_suites_info gate, a run's realtime-reporter gate, the
 * profile node's tooltip) would otherwise re-query it — this caches it once
 * per connection profile, the same way controller.ts's suitesCache does for
 * discovered suites.
 */
const cache = new Map<string, { raw: string; normalized: number }>();

export async function getCachedVersion(conn: Connection, profile: string): Promise<{ raw: string; normalized: number }> {
    const cached = cache.get(profile);
    if (cached) {
        return cached;
    }
    const version = await dao.getVersion(conn);
    cache.set(profile, version);
    return version;
}

export function clearVersionCache(profile?: string): void {
    if (profile) {
        cache.delete(profile);
    } else {
        cache.clear();
    }
}
