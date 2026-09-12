import assert from 'node:assert/strict';
import * as path from 'node:path';
import { createReportFileGuard, isReportFileAllowed } from '../../src/perfReportPath';

/**
 * src/perf.ts itself imports 'vscode' (a real workspace.getConfiguration()
 * call, not just a type reference), so it cannot be loaded here the same
 * way src/workspace/virtualSourcePath.ts can't be loaded from a module that
 * pulls in 'vscode' -- see that module's own doc comment. What's tested
 * directly is the vscode-free validation logic perf.ts's emit() calls
 * (perfReportPath.ts): isReportFileAllowed() as its own set of cases, and
 * createReportFileGuard()'s "warn once" bookkeeping standing in for
 * emit()'s "writes nothing and logs exactly one warning even when called
 * repeatedly" behaviour.
 */
const workspaceFolder = path.resolve('/fake/workspace');
const globalStorage = path.resolve('/fake/globalStorage');
const allowedRoots = [workspaceFolder, globalStorage];

describe('isReportFileAllowed', () => {
    it('allows a path inside the open workspace folder', () => {
        assert.equal(isReportFileAllowed(path.join(workspaceFolder, 'test-results', 'perf.jsonl'), allowedRoots), true);
    });

    it("allows a path inside the extension's own storage root", () => {
        assert.equal(isReportFileAllowed(path.join(globalStorage, 'perf.jsonl'), allowedRoots), true);
    });

    it('rejects a Windows system path outside every allowed root', () => {
        assert.equal(isReportFileAllowed('C:\\Windows\\System32\\drivers\\etc\\hosts', allowedRoots), false);
    });

    it('rejects a POSIX system path outside every allowed root', () => {
        assert.equal(isReportFileAllowed('/etc/hosts', allowedRoots), false);
    });

    it('rejects a traversal path that resolves outside the workspace folder', () => {
        const escaped = path.join(workspaceFolder, '..', '..', '..', '..', 'etc', 'cron.d', 'x');
        assert.equal(isReportFileAllowed(escaped, allowedRoots), false);
    });

    it('rejects a UNC/network path', () => {
        assert.equal(isReportFileAllowed('\\\\server\\share\\x', allowedRoots), false);
    });

    it('rejects an empty path', () => {
        assert.equal(isReportFileAllowed('', allowedRoots), false);
    });

    it('rejects everything when there are no allowed roots (e.g. no workspace open)', () => {
        assert.equal(isReportFileAllowed(path.join(workspaceFolder, 'perf.jsonl'), []), false);
    });

    it('does not treat a sibling directory that merely shares a name prefix as contained', () => {
        assert.equal(isReportFileAllowed(`${workspaceFolder}-evil${path.sep}x`, allowedRoots), false);
    });
});

describe('createReportFileGuard', () => {
    it('allows a path inside an allowed root and never calls the rejection callback', () => {
        const rejections: string[] = [];
        const guard = createReportFileGuard(allowedRoots, (p) => rejections.push(p));
        assert.equal(guard.check(path.join(workspaceFolder, 'perf.jsonl')), true);
        assert.deepEqual(rejections, []);
    });

    it('rejects a disallowed path and logs exactly one warning even when called repeatedly', () => {
        const rejections: string[] = [];
        const guard = createReportFileGuard(allowedRoots, (p) => rejections.push(p));
        assert.equal(guard.check('/etc/hosts'), false);
        assert.equal(guard.check('/etc/hosts'), false);
        assert.equal(guard.check('/etc/passwd'), false);
        assert.deepEqual(rejections, ['/etc/hosts']);
    });

    it('keeps warning suppressed even after an allowed check succeeds in between', () => {
        const rejections: string[] = [];
        const guard = createReportFileGuard(allowedRoots, (p) => rejections.push(p));
        assert.equal(guard.check('/etc/hosts'), false);
        assert.equal(guard.check(path.join(workspaceFolder, 'perf.jsonl')), true);
        assert.equal(guard.check('/etc/passwd'), false);
        assert.deepEqual(rejections, ['/etc/hosts']);
    });
});
