import assert from 'node:assert/strict';
import { normalizeVersion, parseDisabledFlag } from '../../src/db/utplsqlDao';

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
