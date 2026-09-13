import assert from 'node:assert/strict';
import { LoggableItem, formatCoverageScopeLine, formatProduceSqlLine, formatRunFailureLines, formatRunPathsLine, summarizeRun } from '../../src/testing/runLogging';

/**
 * Stands in for runOneProfile()'s trace(ctx, text) gate (src/testing/runHandler.ts)
 * without importing that file at all -- it pulls in 'vscode' at the top, so
 * plain mocha/tsx cannot load it outside the extension host. `enabled`
 * plays the role of the utplsql.trace setting; `sink` plays ctx.output.
 */
function trace(enabled: boolean, sink: { appendLine: (text: string) => void }, text: string): void {
    if (enabled) {
        sink.appendLine(text);
    }
}

function fakeOutput(): { calls: string[]; appendLine: (text: string) => void } {
    const calls: string[] = [];
    return { calls, appendLine: (text: string): void => void calls.push(text) };
}

function items(count: number): LoggableItem[] {
    return Array.from({ length: count }, (_, i) => ({ id: `conn:DEV/path:HR:suite1.test${i}` }));
}

describe('runLogging', () => {
    describe('summarizeRun', () => {
        it('stays a single short line regardless of how many paths/items are passed', () => {
            const tenThousand = items(10000);
            const runPaths = tenThousand.map((i) => i.id);
            const line = summarizeRun('DEV', runPaths, tenThousand);
            assert.ok(line.length < 200, `expected a short bounded summary line, got ${line.length} characters: ${line}`);
            assert.equal(line, "utPLSQL: running 10000 path(s) for 'DEV' (10000 selected item(s))");
        });

        it('reports zero paths/items plainly', () => {
            assert.equal(summarizeRun('DEV', [], []), "utPLSQL: running 0 path(s) for 'DEV' (0 selected item(s))");
        });
    });

    describe('formatRunPathsLine', () => {
        it('includes every run path and every selected item id', () => {
            const selected = [{ id: 'conn:DEV/path:HR:suite1.test1' }, { id: 'conn:DEV/path:HR:suite1.test2' }];
            const line = formatRunPathsLine('DEV', ['HR:suite1'], selected);
            assert.match(line, /HR:suite1/);
            for (const item of selected) {
                assert.ok(line.includes(item.id), `expected the detailed line to include '${item.id}': ${line}`);
            }
        });

        it('still includes every id at the 10,000-item scale summarizeRun deliberately collapses away', () => {
            const tenThousand = items(10000);
            const line = formatRunPathsLine('DEV', [], tenThousand);
            assert.ok(line.includes(tenThousand[0].id), 'expected the first id to survive in the detailed line');
            assert.ok(line.includes(tenThousand[9999].id), 'expected the last id to survive in the detailed line');
            assert.equal(line.split(', ').length, 10000, 'expected all 10,000 ids to be present, comma-separated');
        });
    });

    describe('formatCoverageScopeLine', () => {
        it('reports both counts without embedding any object/file names', () => {
            assert.equal(formatCoverageScopeLine(3, 5), 'utPLSQL: coverage scope: 3 object(s), 5 file mapping(s)');
        });

        it('reports zero scope plainly, e.g. a coverage run with nothing left after user exclusions', () => {
            assert.equal(formatCoverageScopeLine(0, 0), 'utPLSQL: coverage scope: 0 object(s), 0 file mapping(s)');
        });
    });

    describe('formatProduceSqlLine', () => {
        it('embeds the produce SQL unchanged, on its own lines after a fixed prefix', () => {
            const sql = 'DECLARE\n   x NUMBER;\nBEGIN\n   NULL;\nEND;';
            assert.equal(formatProduceSqlLine(sql), `utPLSQL: produce SQL:\n${sql}`);
        });
    });

    /**
     * The trace()-gated pair as runOneProfile actually calls them: an
     * unconditional summary, then the two detailed formatters only under
     * trace(). See runHandler.ts's runOneProfile for the real call sites --
     * this exercises the same two functions it calls, through the same gate
     * shape, since that file itself cannot be loaded here.
     */
    describe('the utplsql.trace gate around the detailed formatters', () => {
        it('records zero calls to the detailed formatters when tracing is off', () => {
            const output = fakeOutput();
            const selected = items(2);
            output.appendLine(summarizeRun('DEV', ['HR:s1'], selected));
            trace(false, output, formatRunPathsLine('DEV', ['HR:s1'], selected));
            trace(false, output, formatProduceSqlLine('DECLARE BEGIN NULL; END;'));

            assert.equal(output.calls.length, 1, `expected only the unconditional summary line, got: ${JSON.stringify(output.calls)}`);
            assert.ok(!output.calls[0].includes('produce SQL'));
            assert.ok(!output.calls[0].includes('run paths for'));
        });

        it('records exactly one call to each detailed formatter when tracing is on', () => {
            const output = fakeOutput();
            const selected = items(2);
            output.appendLine(summarizeRun('DEV', ['HR:s1'], selected));
            trace(true, output, formatRunPathsLine('DEV', ['HR:s1'], selected));
            trace(true, output, formatProduceSqlLine('DECLARE BEGIN NULL; END;'));

            assert.equal(output.calls.length, 3);
            assert.ok(output.calls[1].startsWith('utPLSQL: run paths for'));
            assert.ok(output.calls[2].startsWith('utPLSQL: produce SQL:'));
        });
    });

    describe('formatRunFailureLines', () => {
        it('logs the produce SQL exactly once no matter how many items the failed run had', () => {
            // formatRunFailureLines takes no items/count parameter at all --
            // the produce SQL is a property of the run, not of any one item,
            // so runOneProfile's `items.forEach(i => run.errored(...))`
            // alongside one call to this function gets "exactly once" by
            // construction, regardless of items.length.
            for (const itemCount of [0, 1, 3, 100]) {
                const lines = formatRunFailureLines('DEV', new Error('ORA-20204: boom'), 'DECLARE BEGIN NULL; END;');
                const sqlLines = lines.filter((l) => l.startsWith('utPLSQL: produce SQL:'));
                assert.equal(sqlLines.length, 1, `itemCount=${itemCount}: expected exactly one produce-SQL line, got ${sqlLines.length}`);
            }
        });

        it('always includes the failure summary line first', () => {
            const lines = formatRunFailureLines('DEV', new Error('boom'), undefined);
            assert.equal(lines.length, 1);
            assert.equal(lines[0], "utPLSQL: run failed for profile 'DEV': Error: boom");
        });

        it('omits the produce SQL line when the failure happened before it was built', () => {
            const lines = formatRunFailureLines('DEV', new Error('pool exhausted'), undefined);
            assert.ok(!lines.some((l) => l.startsWith('utPLSQL: produce SQL:')));
        });

        it('includes the produce SQL, byte-identical, when it had already been built', () => {
            const sql = 'DECLARE\n   x NUMBER;\nBEGIN\n   NULL;\nEND;';
            const lines = formatRunFailureLines('DEV', new Error('ORA-20204: no suite packages found'), sql);
            assert.deepEqual(lines, ["utPLSQL: run failed for profile 'DEV': Error: ORA-20204: no suite packages found", `utPLSQL: produce SQL:\n${sql}`]);
        });
    });
});
