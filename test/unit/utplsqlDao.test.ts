import assert from 'node:assert/strict';
import {
    normalizeVersion,
    parseDisabledFlag,
    describeDisabled,
    collectTags,
    checkRealtimeReporterSupport,
    VERSION_REALTIME_REPORTER
} from '../../src/db/utplsqlDao';

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
