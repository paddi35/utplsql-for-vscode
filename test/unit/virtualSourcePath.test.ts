import assert from 'node:assert/strict';
import { buildVirtualSourcePath, parseVirtualSourcePath } from '../../src/workspace/virtualSourcePath';

describe('virtualSourcePath', () => {
    it('round-trips a package body path', () => {
        const path = buildVirtualSourcePath('UT3', 'CALC_PKG', true);
        assert.equal(path, '/UT3/CALC_PKG.pkb');
        assert.deepEqual(parseVirtualSourcePath(path), { owner: 'UT3', name: 'CALC_PKG', isBody: true });
    });

    it('round-trips a package spec path', () => {
        const path = buildVirtualSourcePath('UT3', 'CALC_PKG', false);
        assert.equal(path, '/UT3/CALC_PKG.pks');
        assert.deepEqual(parseVirtualSourcePath(path), { owner: 'UT3', name: 'CALC_PKG', isBody: false });
    });

    it('rejects a path with an unrecognized extension', () => {
        assert.equal(parseVirtualSourcePath('/UT3/CALC_PKG.sql'), undefined);
    });

    it('rejects a path missing the owner segment', () => {
        assert.equal(parseVirtualSourcePath('/CALC_PKG.pkb'), undefined);
    });

    it('rejects a name containing a dot', () => {
        assert.equal(parseVirtualSourcePath('/UT3/CALC.PKG.pkb'), undefined);
    });

    it('rejects an empty path', () => {
        assert.equal(parseVirtualSourcePath(''), undefined);
    });
});
