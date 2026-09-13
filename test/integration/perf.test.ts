import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createReportFileGuard, isReportFileAllowed } from '../../src/perfReportPath';

/**
 * No Oracle instance needed -- unlike the rest of test/integration -- but a
 * real filesystem is, which is what puts this here rather than in
 * test/unit: src/perf.ts's own emit()/measure() can't be driven directly
 * either way (it does a real `vscode.workspace.getConfiguration(...)` call,
 * so importing it outside the extension host throws "Cannot find module
 * 'vscode'" -- see test/unit/perf.test.ts's doc comment). What this
 * exercises instead is the exact shared validation logic emit() calls
 * (perfReportPath.ts) driven against real fs.appendFile/real directories,
 * one level below test/e2e/testExplorer.e2e.test.ts's
 * testWorkspacePerfSettingsAreIgnored case, which is the only one of the
 * three that actually runs inside a real extension host against perf.ts
 * itself.
 */
function appendReportLine(file: string, payload: Record<string, unknown>): Promise<void> {
    return new Promise((resolvePromise, reject) => {
        fs.appendFile(file, JSON.stringify(payload) + '\n', 'utf8', (err) => (err ? reject(err) : resolvePromise()));
    });
}

describe('utplsql.perf.reportFile validation against a real filesystem [integration]', () => {
    let workspaceDir: string;
    let outsideDir: string;

    beforeEach(() => {
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utplsql-perf-it-ws-'));
        outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utplsql-perf-it-outside-'));
    });

    afterEach(() => {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    it('N calls with an allowed path append exactly N parseable JSON lines carrying name/ms/timestamp', async () => {
        const file = path.join(workspaceDir, 'test-results', 'perf.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const guard = createReportFileGuard([workspaceDir], () => {
            throw new Error('should not be rejected -- file is inside the allowed workspace root');
        });

        const callCount = 5;
        for (let i = 0; i < callCount; i++) {
            assert.ok(guard.check(file));
            await appendReportLine(file, { name: `span-${i}`, ms: i * 1.5, timestamp: new Date().toISOString() });
        }

        const lines = fs
            .readFileSync(file, 'utf8')
            .trim()
            .split('\n');
        assert.equal(lines.length, callCount);
        for (const line of lines) {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            assert.equal(typeof parsed.name, 'string');
            assert.equal(typeof parsed.ms, 'number');
            assert.equal(typeof parsed.timestamp, 'string');
        }
    });

    it('a disallowed path is never created, and the guarded operation still returns its value unaffected', async () => {
        const file = path.join(outsideDir, 'perf.jsonl');
        const rejections: string[] = [];
        const guard = createReportFileGuard([workspaceDir], (p) => rejections.push(p));

        // Mirrors measure()'s "best-effort must not break the measured
        // operation" contract: the guarded value is still produced even
        // though the report write is skipped.
        const produceGuardedValue = async (): Promise<number> => {
            if (guard.check(file)) {
                await appendReportLine(file, { name: 'span', ms: 1, timestamp: new Date().toISOString() });
            }
            return 42;
        };

        const value = await produceGuardedValue();
        assert.equal(value, 42);
        assert.equal(fs.existsSync(file), false);
        assert.deepEqual(rejections, [file]);
    });

    it('isReportFileAllowed rejects a real traversal path that resolves outside the workspace root', () => {
        const escaped = path.join(workspaceDir, '..', '..', '..', '..', 'etc', 'cron.d', 'x');
        assert.equal(isReportFileAllowed(escaped, [workspaceDir]), false);
        assert.equal(fs.existsSync(escaped), false);
    });
});
