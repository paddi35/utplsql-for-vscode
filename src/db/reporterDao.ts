import oracledb, { Connection, ResultSet } from 'oracledb';
import {
    DEFAULT_INITIAL_TIMEOUT_SEC,
    DEFAULT_NEXT_EVENT_TIMEOUT_SEC,
    cancelConsumer,
    coverageScopeArgsClause,
    CoverageScopeArgs,
    fileMappingsLiteral,
    newReporterId,
    validateIdentifier
} from './realtimeDao';

function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function varchar2List(values: string[]): string {
    return values.length === 0 ? 'ut_varchar2_list()' : `ut_varchar2_list(${values.map(quoteLiteral).join(', ')})`;
}

/**
 * Wires a_source_file_mappings (and friends) into runWithReporter's producer
 * block for utPLSQL's built-in coverage reporters (ut_coverage_html_reporter,
 * ut_coverage_sonar_reporter, ut_coverage_cobertura_reporter) — issue #98.
 * Without this, a coverage reporter picked in "Export with Reporter" had
 * nothing to report coverage *of* and its consumer's get_lines_cursor()
 * always hit a_initial_timeout with ORA-20215, regardless of what was run.
 * Callers (commands/index.ts's utplsql.runWithReporter,
 * testing/reporterProfile.ts's runReporterExport) build this the same way
 * "Run with Coverage" does, via testing/coverage.ts's
 * computeCoverageExportScope, so both paths agree on scope/file-mapping
 * resolution and only the attached reporter differs.
 */
export interface CoverageExportOptions extends CoverageScopeArgs {
    /** { file: workspace-relative path, owner, name, type } */
    fileMappings: Array<{ file: string; owner: string; name: string; type: string }>;
    /** a_test_file_mappings — objects to report as test files rather than source under coverage. */
    testFileMappings?: Array<{ file: string; owner: string; name: string; type: string }>;
}

export interface RunWithReporterOptions {
    /** a_client_character_set — the charset the exported text is transcoded to, e.g. for a file export whose destination expects UTF-8 regardless of the DB session's default. */
    clientCharacterSet?: string;
    /** a_color_console — ANSI colors in the reporter's own text output (meaningful for e.g. ut_documentation_reporter, not for a machine-readable format like JUnit/Sonar). */
    colorConsole?: boolean;
    /** Coverage-reporter export (see CoverageExportOptions above) — omit for every non-coverage reporter. */
    coverage?: CoverageExportOptions;
}

/** Pure SQL builder for runWithReporter's producer block, split out so the a_color_console/a_client_character_set/coverage wiring is unit-testable without a real connection. */
export function buildRunWithReporterSql(id: string, reporterType: string, paths: string[], options: RunWithReporterOptions = {}): string {
    validateIdentifier(reporterType, 'reporter type');
    const coverage = options.coverage;
    // No separate output_buffer.init() call: set_reporter_id() already runs
    // output_buffer.init(a_reporter_id) internally (see realtimeDao.ts's
    // reportersClause doc comment) — calling init() again afterward with no
    // argument would regenerate a random output_id and desync producer from
    // consumer.
    const coverageDecls = coverage
        ? `\n   l_source_mappings ut_file_mappings := ut_file_mappings(\n            ${fileMappingsLiteral(coverage.fileMappings)}\n         );` +
          (coverage.testFileMappings && coverage.testFileMappings.length > 0
              ? `\n   l_test_mappings ut_file_mappings := ut_file_mappings(\n            ${fileMappingsLiteral(coverage.testFileMappings)}\n         );`
              : '')
        : '';
    const coverageArgs = coverage
        ? `,\n      a_source_file_mappings => l_source_mappings` +
          (coverage.testFileMappings && coverage.testFileMappings.length > 0 ? `,\n      a_test_file_mappings => l_test_mappings` : '') +
          coverageScopeArgsClause(coverage)
        : '';
    const runArgs =
        `a_paths => ${varchar2List(paths)}, a_reporters => ut_reporters(l_reporter)` +
        (options.colorConsole ? `, a_color_console => true` : '') +
        (options.clientCharacterSet ? `, a_client_character_set => ${quoteLiteral(options.clientCharacterSet)}` : '') +
        coverageArgs;
    return `DECLARE
   l_reporter ${reporterType} := ${reporterType}();${coverageDecls}
BEGIN
   l_reporter.set_reporter_id(${quoteLiteral(id)});
   ut_runner.run(${runArgs});
END;`;
}

/**
 * Structural subset of vscode.CancellationToken that runWithReporter needs.
 * Declared locally rather than `import { CancellationToken } from 'vscode'`
 * so this module stays loadable outside the extension host — the real
 * `vscode` module only exists there, and test/unit/reporterDao.test.ts runs
 * under plain tsx/mocha (same reason realtimeDao.ts, this file's
 * sibling, never imports vscode either). A real vscode.CancellationToken —
 * or a vscode.CancellationTokenSource's .token — satisfies this
 * structurally, so callers pass theirs straight through unmodified; unit
 * tests instead drive a plain object literal.
 */
export interface CancellationSignal {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface RunWithReporterResult {
    /** Reporter output collected before cancellation (if any) cut the drain short; '' if cancelled before a single line was collected. */
    output: string;
    /**
     * True whenever `token` fired at any point during this call. Mirrors
     * runOneProfile's own `cancelled` flag (runHandler.ts): the caller MUST
     * recyclePool() its connection profile whenever this is true, exactly
     * as runOneProfile does in its finally block, because
     * cancelConsumer()'s break() may have been called on consumerConn — see
     * pool.ts's recyclePool() doc comment for why a pool that has seen one
     * broken connection poisons every later checkout with ORA-01013 until
     * recycled. Left un-narrowed to "only if break() definitely ran" (e.g.
     * an already-cancelled token short-circuits before touching either
     * connection at all): recyclePool() is cheap and always safe to call
     * again, whereas skipping it on a wrong guess reintroduces the exact
     * poisoned-pool bug this flag exists to prevent.
     */
    cancelled: boolean;
}

/**
 * Drains a plain (non-realtime) reporter's line cursor into `lines`,
 * tolerating the NJS-018 ("invalid ResultSet") that cancelConsumer()'s
 * break()+drop leaves on the next getRow() call mid-drain — the same
 * contract realtimeDao.ts's streamRows() documents and relies on for the
 * realtime reporter's cursor. Not reused directly from there: that cursor's
 * rows carry an ITEM_TYPE/TEXT pair (EventRow) for per-test events, while a
 * plain reporter's get_lines_cursor() here only ever yields TEXT — this
 * reporter's whole output is written at once, not streamed per test.
 *
 * isCancelled() is checked before every getRow() call, not just relied on
 * to eventually surface as a getRow() rejection: fetchArraySize is 50 here
 * (vs realtimeDao's 1, which exists specifically so realtime events are
 * never batched), so up to 50 already-fetched rows can be sitting in the
 * local buffer with no network round-trip left to interrupt — without this
 * check, cancellation would silently wait for the local buffer to drain
 * before ever taking effect.
 *
 * A getRow() rejection is only swallowed when isCancelled() is already true
 * at that point — the expected NJS-018 ("invalid ResultSet") left by
 * cancelConsumer()'s break()+drop. Any other rejection (e.g. ORA-20215 when
 * the producer never registered within a_initial_timeout) is a real failure
 * and must propagate, not be silently treated as a clean end-of-stream —
 * swallowing it unconditionally left callers reporting an empty export with
 * no indication anything had gone wrong.
 */
async function drainLines(
    rs: ResultSet<Record<string, unknown>>,
    lines: string[],
    isCancelled: () => boolean,
    onProgress?: (message: string) => void
): Promise<void> {
    try {
        while (!isCancelled()) {
            let row: Record<string, unknown> | undefined;
            try {
                row = await rs.getRow();
            } catch (err) {
                if (isCancelled()) {
                    return;
                }
                throw err;
            }
            if (!row) {
                return;
            }
            lines.push(String(row.TEXT ?? ''));
            onProgress?.(`collecting ${lines.length} line${lines.length === 1 ? '' : 's'}…`);
        }
    } finally {
        try {
            await rs.close();
        } catch {
            // connection may already be broken/closed by a cancellation
        }
    }
}

/**
 * Runs ut_runner with a single named reporter type (validated by the caller
 * against ut_runner.get_reporters_list()) and returns the full text output.
 * Used by utplsql.runWithReporter — export path equivalent to
 * `utplsql-cli run -f=<reporter> -o=<file>`. Needs two sessions like the
 * realtime reporter: producerConn runs ut_runner.run, consumerConn drains
 * get_lines_cursor(); the consumer is started first (100ms head start).
 *
 * Cancellation mirrors runOneProfile (runHandler.ts), the realtime run
 * path's own template, closely enough to reuse its exact shape: `token`'s
 * onCancellationRequested is wired to cancelConsumer() (break() +
 * close({drop:true}) on consumerConn), and the producer statement — left
 * running server-side to completion by design, see cancelConsumer()'s doc
 * comment — is fired-and-forgotten with its rejection captured into
 * `produceError` rather than directly awaited, exactly like runOneProfile's
 * own produceError handling: the producer can fail (or just keep running)
 * long after the consumer side has stopped draining, so leaving its promise
 * unattached in that window would risk an unhandled rejection in the
 * extension host. An already-cancelled token short-circuits before either
 * connection is sent a single statement, so a cancellation that lands
 * between the caller acquiring its two connections and actually calling
 * this function costs nothing beyond the caller's own cleanup.
 */
export async function runWithReporter(
    producerConn: Connection,
    consumerConn: Connection,
    reporterType: string,
    paths: string[],
    options: RunWithReporterOptions = {},
    token?: CancellationSignal,
    onProgress?: (message: string) => void
): Promise<RunWithReporterResult> {
    if (token?.isCancellationRequested) {
        return { output: '', cancelled: true };
    }
    // buildRunWithReporterSql below already refuses an invalid reporterType
    // before returning produceSql, which today also protects consumeSql —
    // built further down, from the same reporterType, and never through a
    // validated builder of its own — purely because it happens to run
    // second in this function. Checked again here so that guarantee holds
    // even if the two statements are ever reordered, instead of resting on
    // source order alone.
    validateIdentifier(reporterType, 'reporter type');

    const id = newReporterId();
    const produceSql = buildRunWithReporterSql(id, reporterType, paths, options);

    // Both timeouts must be passed explicitly — left at their NULL defaults,
    // get_lines_cursor() returns an empty cursor immediately without ever
    // polling (see realtimeDao.ts's openConsumer doc comment).
    const consumeSql = `DECLARE
   l_reporter ${reporterType} := ${reporterType}();
BEGIN
   l_reporter.set_reporter_id(:id);
   :cur := l_reporter.get_lines_cursor(a_initial_timeout => :initialTimeout, a_timeout_sec => :nextTimeout);
END;`;

    let cancelled = false;
    const cancelSub = token?.onCancellationRequested(() => {
        cancelled = true;
        void cancelConsumer(consumerConn);
    });

    try {
        onProgress?.('opening consumer…');
        // Fired without awaiting: get_lines_cursor()'s wait-for-producer loop
        // runs *synchronously inside this very execute() call* for a
        // bulk-buffer reporter (ut_junit_reporter, ut_xunit_reporter,
        // ut_tfs_junit_reporter, ut_sonar_test_reporter, and utPLSQL's
        // built-in coverage reporters — confirmed against a live utPLSQL
        // 3.2.3 instance's ut_output_bulk_buffer.get_lines_cursor source,
        // which loops on dbms_lock/row checks and only opens its result
        // cursor once that loop exits). A table-buffer reporter's
        // get_lines_cursor(), by contrast, opens a lazy pipelined cursor
        // that only starts waiting on the first fetch (drainLines() below).
        // Awaiting this call before sending the producer statement meant the
        // producer was never even dispatched until a bulk-buffer reporter's
        // consumer had already finished waiting — a guaranteed ORA-20215
        // every single time, for every bulk-buffer reporter, regardless of
        // database or run size. The 100ms head start below now applies to
        // "the consumer's statement has been sent", not "the consumer's
        // statement has returned".
        const consumeExecPromise = consumerConn.execute<{ cur: ResultSet<Record<string, unknown>> }>(
            consumeSql,
            {
                id,
                initialTimeout: DEFAULT_INITIAL_TIMEOUT_SEC,
                nextTimeout: DEFAULT_NEXT_EVENT_TIMEOUT_SEC,
                cur: { dir: oracledb.BIND_OUT, type: oracledb.CURSOR }
            },
            { fetchArraySize: 50 }
        );

        await new Promise((resolve) => setTimeout(resolve, 100));

        onProgress?.('running tests…');
        let produceError: unknown;
        const producePromise = producerConn.execute(produceSql).catch((err: unknown) => {
            produceError = err;
        });

        const lines: string[] = [];
        // Any error from here — including consumeExecPromise itself
        // rejecting, e.g. a bulk-buffer reporter's own ORA-20215, or
        // cancelConsumer()'s break() landing while it's still in flight —
        // must not skip the `await producePromise` below: producerConn.close()
        // in the caller's finally block would otherwise race a
        // still-executing statement on that same connection the moment this
        // function returns/throws, which is exactly the crash producePromise
        // exists to prevent (see this function's doc comment). So the error
        // is captured here and only rethrown afterward, once the producer
        // statement has genuinely settled either way.
        let drainError: unknown;
        try {
            const result = await consumeExecPromise;
            const rs = (result.outBinds as { cur: ResultSet<Record<string, unknown>> }).cur;
            await drainLines(rs, lines, () => cancelled, onProgress);
        } catch (err) {
            // Mirrors drainLines()'s own getRow() rejection handling above:
            // cancelConsumer()'s break() can land while consumeExecPromise
            // (get_lines_cursor() itself) is still pending for a bulk-buffer
            // reporter's synchronous wait loop, rejecting it with the same
            // kind of "connection broken" error getRow() would otherwise
            // surface. Swallowed only when cancelled is already true, so a
            // genuine failure (e.g. ORA-20215) still propagates.
            if (!cancelled) {
                drainError = err;
            }
        }

        await producePromise;
        if (produceError !== undefined) {
            throw produceError;
        }
        if (drainError !== undefined) {
            throw drainError;
        }
        return { output: lines.join('\r\n'), cancelled };
    } finally {
        cancelSub?.dispose();
    }
}
