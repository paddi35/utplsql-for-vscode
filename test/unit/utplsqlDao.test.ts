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
    clearDbaViewCache,
    getSuitesInfo,
    parseItemType,
    isTestItem,
    getReportersList,
    SuiteInfoRow
} from '../../src/db/utplsqlDao';

/** A full SuiteInfoRow with sane defaults, so a test only has to spell out the fields it actually cares about (issue #18's collectTags coverage below). */
function suiteRow(overrides: Partial<SuiteInfoRow> = {}): SuiteInfoRow {
    return {
        objectOwner: 'HR',
        objectName: 'TEST_PKG',
        itemName: 'test_something',
        itemType: 'UT_TEST',
        path: 'test_pkg.test_something',
        disabledFlag: false,
        ...overrides
    };
}

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

/** Scripted Connection fake for getSuitesInfo — returns exactly the given rows from its one execute() call, ignoring the SQL/binds. */
function fakeRowsConnection(rows: Record<string, unknown>[]): Connection {
    return { execute: async () => ({ rows }) } as unknown as Connection;
}

describe('getReportersList', () => {
    // reporter_object_name comes back schema-qualified against a live
    // instance (e.g. 'UT3.UT_COVERAGE_SONAR_REPORTER', confirmed against a
    // live utPLSQL 3.2.3 instance) — not the bare object name. A filter
    // comparing the raw value against a bare-name set would never match, so
    // this fixture deliberately uses the qualified shape throughout, the
    // same regression bareObjectName() in utplsqlDao.ts exists to prevent.
    it('excludes coverage reporters and non-output reporters, keeping plain output reporters', async () => {
        const conn = fakeRowsConnection([
            { REPORTER_OBJECT_NAME: 'UT3.UT_DOCUMENTATION_REPORTER', IS_OUTPUT_REPORTER: 'Y' },
            { REPORTER_OBJECT_NAME: 'UT3.UT_JUNIT_REPORTER', IS_OUTPUT_REPORTER: 'Y' },
            // Passes is_output_reporter = 'Y' same as any text reporter, but
            // needs a_source_file_mappings that "Export with Reporter" never
            // supplies — see COVERAGE_REPORTER_NAMES's doc comment in
            // utplsqlDao.ts for why this must not reach that command's
            // reporter QuickPick.
            { REPORTER_OBJECT_NAME: 'UT3.UT_COVERAGE_HTML_REPORTER', IS_OUTPUT_REPORTER: 'Y' },
            { REPORTER_OBJECT_NAME: 'UT3.UT_COVERAGE_SONAR_REPORTER', IS_OUTPUT_REPORTER: 'Y' },
            { REPORTER_OBJECT_NAME: 'UT3.UT_COVERAGE_COBERTURA_REPORTER', IS_OUTPUT_REPORTER: 'Y' },
            { REPORTER_OBJECT_NAME: 'UT3.UT_REALTIME_REPORTER', IS_OUTPUT_REPORTER: 'N' }
        ]);
        const reporters = await getReportersList(conn);
        assert.deepEqual(
            reporters.map((r) => r.reporterObjectName),
            ['UT3.UT_DOCUMENTATION_REPORTER', 'UT3.UT_JUNIT_REPORTER']
        );
    });
});

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

    // Issue #18's fix is "read tags from the discovery rows, not from
    // materialized TestItems" — collectTags already takes rows and never
    // looks at path/depth/owner, so the cases below pin that shape rather
    // than change behaviour: a caller that (like the old MetaStore-based
    // code) only ever sees shallow/single-owner rows would still pass these
    // trivially, but a caller that filters by tree depth or by materialized
    // item first would not.
    it('returns tags carried by rows whose path is several levels below the schema, same as a shallow row', () => {
        const deep = suiteRow({ path: 'alltests.grp1.grp2.ctx.deep_test', tags: 'slow' });
        assert.deepEqual(collectTags([deep]), ['slow']);
    });

    it('splits, trims and dedupes tags: undefined, empty, doubled-comma and padded-whitespace inputs all reduce to the same set', () => {
        assert.deepEqual(
            collectTags([{ tags: undefined }, { tags: '' }, { tags: 'a,,b' }, { tags: ' a , b ' }]),
            ['a', 'b']
        );
    });

    it('merges tags from rows owned by two different schemas within one profile into one sorted list', () => {
        const hrRow = suiteRow({ objectOwner: 'HR', tags: 'hr_only, shared' });
        const financeRow = suiteRow({ objectOwner: 'FINANCE', objectName: 'FIN_PKG', tags: 'finance_only, shared' });
        assert.deepEqual(collectTags([hrRow, financeRow]), ['finance_only', 'hr_only', 'shared']);
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

describe('parseItemType', () => {
    it('returns each of the four item types get_suites_info can return, unchanged', () => {
        assert.equal(parseItemType('UT_SUITE'), 'UT_SUITE');
        assert.equal(parseItemType('UT_SUITE_CONTEXT'), 'UT_SUITE_CONTEXT');
        assert.equal(parseItemType('UT_TEST'), 'UT_TEST');
        assert.equal(parseItemType('UT_LOGICAL_SUITE'), 'UT_LOGICAL_SUITE');
    });

    it('returns undefined for an item_type it does not recognise', () => {
        assert.equal(parseItemType('UT_SOMETHING_NEW'), undefined);
    });

    it('does not throw for null or undefined', () => {
        assert.equal(parseItemType(null), undefined);
        assert.equal(parseItemType(undefined), undefined);
    });
});

describe('isTestItem', () => {
    it('treats UT_TEST as a test', () => {
        assert.equal(isTestItem('UT_TEST'), true);
    });

    it('treats UT_SUITE, UT_SUITE_CONTEXT and UT_LOGICAL_SUITE as non-tests', () => {
        assert.equal(isTestItem('UT_SUITE'), false);
        assert.equal(isTestItem('UT_SUITE_CONTEXT'), false);
        assert.equal(isTestItem('UT_LOGICAL_SUITE'), false);
    });
});

describe('getSuitesInfo item_type handling', () => {
    function row(itemType: string): Record<string, unknown> {
        return {
            OBJECT_OWNER: 'HR',
            OBJECT_NAME: 'PERF_G01',
            ITEM_NAME: 'perf.g01',
            ITEM_TYPE: itemType,
            PATH: 'perf.g01',
            DISABLED_FLAG: 0
        };
    }

    it('maps a UT_LOGICAL_SUITE row straight through without calling onUnknownItemType', async () => {
        const seen: unknown[] = [];
        const rows = await getSuitesInfo(fakeRowsConnection([row('UT_LOGICAL_SUITE')]), undefined, undefined, (raw) => seen.push(raw));
        assert.equal(rows[0].itemType, 'UT_LOGICAL_SUITE');
        assert.deepEqual(seen, []);
    });

    it('calls onUnknownItemType exactly once, naming the raw value, for a row with an unrecognised item_type, and treats it as a suite', async () => {
        const seen: unknown[] = [];
        const rows = await getSuitesInfo(fakeRowsConnection([row('UT_SOMETHING_NEW')]), undefined, undefined, (raw) => seen.push(raw));
        assert.deepEqual(seen, ['UT_SOMETHING_NEW']);
        assert.equal(rows[0].itemType, 'UT_SUITE');
    });

    it('works without an onUnknownItemType callback at all', async () => {
        const rows = await getSuitesInfo(fakeRowsConnection([row('UT_SOMETHING_NEW')]));
        assert.equal(rows[0].itemType, 'UT_SUITE');
    });
});
