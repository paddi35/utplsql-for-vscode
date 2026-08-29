import assert from 'node:assert/strict';
import { resolveWorkspaceRelativePath } from '../../src/testing/coveragePaths';

describe('resolveWorkspaceRelativePath', () => {
    it('passes a plain forward-slash relative path through unchanged', () => {
        assert.equal(resolveWorkspaceRelativePath('db/calc_pkg.pkb'), 'db/calc_pkg.pkb');
    });

    it('normalizes Windows backslashes to forward slashes', () => {
        assert.equal(resolveWorkspaceRelativePath('db\\calc_pkg.pkb'), 'db/calc_pkg.pkb');
    });

    it('normalizes a mix of backslashes and forward slashes', () => {
        assert.equal(resolveWorkspaceRelativePath('db\\pkg/calc_pkg.pkb'), 'db/pkg/calc_pkg.pkb');
    });

    it('rejects the empty string', () => {
        assert.equal(resolveWorkspaceRelativePath(''), undefined);
    });

    it('rejects an absolute POSIX path', () => {
        assert.equal(resolveWorkspaceRelativePath('/etc/passwd'), undefined);
    });

    it('rejects an absolute Windows path with backslashes', () => {
        assert.equal(resolveWorkspaceRelativePath('C:\\secrets\\file.txt'), undefined);
    });

    it('rejects an absolute Windows path with forward slashes', () => {
        assert.equal(resolveWorkspaceRelativePath('c:/secrets/file.txt'), undefined);
    });

    it('rejects a path containing a ".." traversal segment', () => {
        assert.equal(resolveWorkspaceRelativePath('../secrets/file.txt'), undefined);
        assert.equal(resolveWorkspaceRelativePath('db/../../secrets/file.txt'), undefined);
    });

    it('does not reject a segment that merely contains ".." as a substring', () => {
        assert.equal(resolveWorkspaceRelativePath('db/..foo/bar.pkb'), 'db/..foo/bar.pkb');
        assert.equal(resolveWorkspaceRelativePath('db/foo../bar.pkb'), 'db/foo../bar.pkb');
    });
});
