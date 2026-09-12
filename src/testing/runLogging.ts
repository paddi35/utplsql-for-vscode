/**
 * Pure log-line construction for runOneProfile()'s pre-run and produce-SQL
 * output (src/testing/runHandler.ts), split out into their own vscode-free
 * functions so they can be unit tested outside the extension host -- that
 * file imports 'vscode' at the top and therefore cannot be `require()`d by
 * plain mocha/ts-node at all (see virtualSourcePath.ts and
 * reporterDao.ts's buildRunWithReporterSql for the same split elsewhere in
 * this codebase, and test/unit/runLogging.test.ts for the tests this
 * enables).
 *
 * Issue #23: two ctx.output.appendLine() calls in runOneProfile ran
 * unconditionally on *every* run, regardless of the utplsql.trace setting
 * that already gates every other per-event log line in that file (see
 * trace() there and docs/performance.md's "In-extension instrumentation"
 * section) -- they were simply missed when that gate was introduced. One
 * embedded every selected TestItem.id: groupRequest selects every
 * path-bearing descendant (suites, contexts *and* tests, not just leaves),
 * so on the documented 1000-package/~15,000-test fixture a plain "Run All"
 * produced a single ~1MB appendLine call for that line alone, at the exact
 * moment a run starts -- a real hitch on the extension host, and it buried
 * every other line (results, coverage decisions, errors) already sitting in
 * the output channel. The other embedded the complete generated produce SQL,
 * which grows with coverage scope the same way (one ut_file_mapping(...)
 * per covered object, plus the whole a_include_objects list).
 *
 * The fix keeps an unconditional line in each spot, but one whose size is
 * bounded by the *count* of paths/items/objects rather than their contents
 * (summarizeRun/formatCoverageScopeLine); the full detail
 * (formatRunPathsLine/formatProduceSqlLine) moves behind the same trace()
 * gate as everything else. formatProduceSqlLine is also used unconditionally
 * from runOneProfile's failure path -- see that call site's own comment for
 * why that one line is worth its cost even with tracing off.
 */

/** The only field these formatters need from a vscode.TestItem, kept structural so this module has no dependency on 'vscode' at all -- not even a type-only import. */
export interface LoggableItem {
    id: string;
}

/**
 * Unconditional per-run summary. Length is bounded by the digit count of
 * `runPaths.length`/`items.length` alone, never by their contents -- see
 * formatRunPathsLine() for the full detail this deliberately leaves out, and
 * test/unit/runLogging.test.ts for the assertion that this stays short even
 * at 10,000 items.
 */
export function summarizeRun(profile: string, runPaths: readonly string[], items: readonly LoggableItem[]): string {
    return `utPLSQL: running ${runPaths.length} path(s) for '${profile}' (${items.length} selected item(s))`;
}

/**
 * Full detail behind utplsql.trace: every deduped run path and every
 * originally selected TestItem id. Text is unchanged from the line this
 * replaces -- trace mode is meant to lose no information relative to before
 * this fix, only to stop paying for that information on every run.
 */
export function formatRunPathsLine(profile: string, runPaths: readonly string[], items: readonly LoggableItem[]): string {
    return `utPLSQL: run paths for '${profile}' = ${JSON.stringify(runPaths)} (from ${items.length} selected item(s): ${items.map((i) => i.id).join(', ')})`;
}

/**
 * Unconditional per-run coverage summary, only emitted when coverage was
 * requested. Two counts instead of the a_include_objects name list and the
 * whole a_source_file_mappings constructor block buildProduceSql() embeds in
 * the produce SQL (see formatProduceSqlLine()) -- both of which grow with
 * coverage scope the same way the run-paths list grows with selection size.
 */
export function formatCoverageScopeLine(includeObjectCount: number, fileMappingCount: number): string {
    return `utPLSQL: coverage scope: ${includeObjectCount} object(s), ${fileMappingCount} file mapping(s)`;
}

/**
 * Full generated produce SQL, unchanged from the line this replaces. On the
 * normal path this stays behind utplsql.trace (see runOneProfile); it is
 * also used unconditionally from the failure path, since the SQL that was
 * actually sent to the producer connection is the one thing genuinely useful
 * when a run fails, and a failure is by definition not the steady-state cost
 * this module exists to bound.
 */
export function formatProduceSqlLine(sql: string): string {
    return `utPLSQL: produce SQL:\n${sql}`;
}

/**
 * Everything runOneProfile's catch block writes to the output channel about
 * a failed run, beyond the per-item run.errored() calls it also makes there
 * (those need vscode.TestItem/vscode.TestMessage, so they stay in
 * runHandler.ts). Deliberately takes no `items`/count parameter at all: the
 * produce SQL is a property of the run, not of any one item, so a caller
 * that does `items.forEach(i => run.errored(...))` alongside a single call
 * to this function gets "log the SQL once per failed run" for free, instead
 * of by convention only — see test/unit/runLogging.test.ts, which checks
 * exactly that.
 *
 * `sql` is `undefined` when the failure happened before buildProduceSql()
 * ran at all (e.g. openConsumer() itself throwing) — there is no SQL yet to
 * show in that case, so the returned lines omit it rather than logging
 * something misleading.
 */
export function formatRunFailureLines(profile: string, err: unknown, sql: string | undefined): string[] {
    const lines = [`utPLSQL: run failed for profile '${profile}': ${String(err)}`];
    if (sql !== undefined) {
        lines.push(formatProduceSqlLine(sql));
    }
    return lines;
}
