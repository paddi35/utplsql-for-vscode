import assert from 'node:assert/strict';
import { Connection } from 'oracledb';
import {
    normalizeVersion,
    parseDisabledFlag,
    describeDisabled,
    collectTags,
    checkRealtimeReporterSupport,
    VERSION_REALTIME_REPORTER,
    getDbaView,
    clearDbaViewCache
} from '../../src/db/utplsqlDao';

/**
 * Minimal scripted Connection fake for isDbaViewAccessible/getDbaView below —
 * only `execute` is ever called by that code path. `behavior` runs on every
 * call so a test can make the probe succeed or reject; `calls()` is the
 * regression guard against a re-probe the cache should have prevented.
 */
function fakeProbeConnection(behavior: () => Promise<unknown>): { conn: Connection; calls: () => number } {
    let count = 0;
    const conn = {
        execute: async () => {
            count++;
            return behavior();
        }
    } as unknown as Connection;
    return { conn, calls: () => count };
}

describe('normalizeVersion', () => {
    it('parses a plain dotted version', () => {
        assert.equal(normalizeVersion('3.1.13.3178'), 3001013);
    });

    it('strips a "v" prefix', () => {
        assert.equal(normalizeVersion('v3.2.3.4508'), 3002003);
    });

    it('strips a "v." prefix', () => {
        assert.equal(normalizeVersion('v.3.2.3.4508'), 3002003);
    });

    it('is case-insensitive on the prefix', () => {
        assert.equal(normalizeVersion('V3.1.3'), 3001003);
    });
});

describe('parseDisabledFlag', () => {
    it('treats the numeric 1 that node-oracledb actually returns as disabled', () => {
        assert.equal(parseDisabledFlag(1), true);
    });

    it('treats the numeric 0 that node-oracledb actually returns as enabled', () => {
        assert.equal(parseDisabledFlag(0), false);
    });

    it('still accepts a Y/N string, in case a future driver/version returns one', () => {
        assert.equal(parseDisabledFlag('Y'), true);
        assert.equal(parseDisabledFlag('N'), false);
    });

    it('accepts a native boolean', () => {
        assert.equal(parseDisabledFlag(true), true);
        assert.equal(parseDisabledFlag(false), false);
    });
});

describe('describeDisabled', () => {
    it('returns undefined for an enabled row', () => {
        assert.equal(describeDisabled({ disabledFlag: false, disabledReason: undefined }), undefined);
    });

    it('returns a plain marker when disabled without a reason', () => {
        assert.equal(describeDisabled({ disabledFlag: true, disabledReason: undefined }), 'disabled');
    });

    it('includes the reason when the annotation carries one', () => {
        assert.equal(
            describeDisabled({ disabledFlag: true, disabledReason: 'not yet implemented' }),
            'disabled: not yet implemented'
        );
    });
});

describe('checkRealtimeReporterSupport', () => {
    it('returns undefined when the version meets the minimum exactly', () => {
        assert.equal(checkRealtimeReporterSupport({ raw: 'v3.1.4.0', normalized: VERSION_REALTIME_REPORTER }, 'my-profile'), undefined);
    });

    it('returns undefined for a newer version', () => {
        assert.equal(checkRealtimeReporterSupport({ raw: 'v3.2.3.4508', normalized: 3002003 }, 'my-profile'), undefined);
    });

    it('returns an actionable message naming the profile and raw version for an old one', () => {
        const message = checkRealtimeReporterSupport({ raw: 'v3.1.3.0', normalized: 3001003 }, 'my-profile');
        assert.match(message ?? '', /v3\.1\.3\.0/);
        assert.match(message ?? '', /my-profile/);
        assert.match(message ?? '', /3\.1\.4/);
    });
});

describe('collectTags', () => {
    it('returns an empty list when no row carries tags', () => {
        assert.deepEqual(collectTags([{ tags: undefined }, { tags: '' }]), []);
    });

    it('splits, trims and dedupes comma-separated tags across rows, sorted', () => {
        assert.deepEqual(
            collectTags([{ tags: 'slow, integration' }, { tags: 'slow' }, { tags: 'fast , slow' }]),
            ['fast', 'integration', 'slow']
        );
    });
});

describe('getDbaView', () => {
    // Every test starts from a clean cache rather than relying on distinct
    // profile names to avoid collisions with each other: the cache is
    // module-level state shared by the whole mocha process, so a leftover
    // entry from an earlier test file that happened to reuse a profile name
    // would otherwise make a test pass for the wrong reason.
    beforeEach(() => clearDbaViewCache());

    it('probes once and returns dba_ when the dba_objects probe succeeds, caching the answer for that profile', async () => {
        const { conn, calls } = fakeProbeConnection(async () => ({ rows: [] }));
        assert.equal(await getDbaView(conn, 'A'), 'dba_');
        assert.equal(await getDbaView(conn, 'A'), 'dba_');
        assert.equal(calls(), 1, 'a second call for the same profile must not re-probe');
    });

    it('probes once and returns all_ when the dba_objects probe rejects, caching the answer for that profile', async () => {
        const { conn, calls } = fakeProbeConnection(async () => {
            throw new Error('ORA-00942: table or view does not exist');
        });
        assert.equal(await getDbaView(conn, 'B'), 'all_');
        assert.equal(await getDbaView(conn, 'B'), 'all_');
        assert.equal(calls(), 1);
    });

    it('regression guard: a privileged profile probed first must not decide the answer for an unprivileged profile probed second', async () => {
        const privileged = fakeProbeConnection(async () => ({ rows: [] }));
        const unprivileged = fakeProbeConnection(async () => {
            throw new Error('ORA-00942');
        });
        assert.equal(await getDbaView(privileged.conn, 'A'), 'dba_');
        assert.equal(await getDbaView(unprivileged.conn, 'B'), 'all_');
    });

    it('mirror case: an unprivileged profile probed first must not decide the answer for a privileged profile probed second', async () => {
        const unprivileged = fakeProbeConnection(async () => {
            throw new Error('ORA-00942');
        });
        const privileged = fakeProbeConnection(async () => ({ rows: [] }));
        assert.equal(await getDbaView(unprivileged.conn, 'A'), 'all_');
        assert.equal(await getDbaView(privileged.conn, 'B'), 'dba_');
    });

    it('clearDbaViewCache(profile) forces exactly one re-probe for that profile and leaves other profiles cached', async () => {
        await getDbaView(fakeProbeConnection(async () => ({ rows: [] })).conn, 'A');
        await getDbaView(fakeProbeConnection(async () => ({ rows: [] })).conn, 'B');

        clearDbaViewCache('A');

        const reprobeA = fakeProbeConnection(async () => ({ rows: [] }));
        assert.equal(await getDbaView(reprobeA.conn, 'A'), 'dba_');
        assert.equal(reprobeA.calls(), 1, 'A must be re-probed after its cache entry was cleared');

        // B's entry must be untouched: a connection that would fail if
        // actually queried still produces the cached answer, not a fresh probe.
        const mustNotBeQueried = fakeProbeConnection(async () => {
            throw new Error('B should not be re-probed');
        });
        assert.equal(await getDbaView(mustNotBeQueried.conn, 'B'), 'dba_');
        assert.equal(mustNotBeQueried.calls(), 0);
    });

    it('clearDbaViewCache() with no profile clears every profile', async () => {
        await getDbaView(fakeProbeConnection(async () => ({ rows: [] })).conn, 'A');
        await getDbaView(fakeProbeConnection(async () => ({ rows: [] })).conn, 'B');

        clearDbaViewCache();

        const reprobeA = fakeProbeConnection(async () => ({ rows: [] }));
        const reprobeB = fakeProbeConnection(async () => ({ rows: [] }));
        assert.equal(await getDbaView(reprobeA.conn, 'A'), 'dba_');
        assert.equal(await getDbaView(reprobeB.conn, 'B'), 'dba_');
        assert.equal(reprobeA.calls(), 1);
        assert.equal(reprobeB.calls(), 1);
    });
});
