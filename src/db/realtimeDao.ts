import oracledb, { Connection, ResultSet } from 'oracledb';
import { randomUUID } from 'node:crypto';

export interface CoverageOptions {
    reporter: 'ut_coverage_sonar_reporter' | 'ut_coverage_cobertura_reporter';
    schemes?: string[];
    includeObjects?: string[];
    excludeObjects?: string[];
    /** { file: workspace-relative path, owner, name, type } */
    fileMappings: Array<{ file: string; owner: string; name: string; type: string }>;
    htmlReport?: boolean;
}

export interface EventRow {
    itemType: string;
    text: string;
}

/** Reporter id per run: a UUID without dashes, as expected by ut_realtime_reporter.set_reporter_id. */
export function newReporterId(): string {
    return randomUUID().replace(/-/g, '');
}

const IDENTIFIER_RE = /^[A-Za-z0-9_$#.]+$/;

function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function validateIdentifier(value: string, kind: string): string {
    if (!IDENTIFIER_RE.test(value)) {
        throw new Error(`utPLSQL: invalid ${kind} '${value}' — expected [A-Za-z0-9_$#.]+`);
    }
    return value;
}

function varchar2List(values: string[]): string {
    if (values.length === 0) {
        return 'ut_varchar2_list()';
    }
    return `ut_varchar2_list(${values.map(quoteLiteral).join(', ')})`;
}

/**
 * Builds the reporter variable declarations (valid only in DECLARE) and
 * their init calls (executable statements, valid only in BEGIN) separately.
 * Mixing method calls into the DECLARE section is invalid PL/SQL
 * (PLS-00103, "expecting an identifier" on the "."), which is what happened
 * when both were concatenated into one block emitted under DECLARE.
 *
 * set_reporter_id(id) is the ONLY init call needed: per the installed
 * ut_output_reporter_base.set_reporter_id source, it already does
 * `self.id := a_reporter_id; self.output_buffer.init(a_reporter_id);`
 * internally. A separate, argument-less `output_buffer.init()` call (as an
 * earlier version of this file had, copied from the plan) re-runs init with
 * a_output_id defaulting to null, which regenerates a *new* random
 * output_id and silently overwrites the one set_reporter_id just set — the
 * producer then buffers events under a different id than the consumer polls
 * for, so the run completes with zero events ever observed by the consumer.
 */
interface ReportersClause {
    reporters: string;
    decls: string;
    inits: string;
    coverageId?: string;
    htmlId?: string;
}

/**
 * set_reporter_id(a_reporter_id RAW) — the parameter is RAW, not VARCHAR2, so
 * the literal passed in the PL/SQL block goes through an implicit
 * HEXTORAW conversion. A suffixed id like '<32-hex>_cov' is not valid hex
 * and blows up with ORA-06502 ("hex to raw conversion error") the moment
 * coverage is requested — confirmed against a live utPLSQL 3.2.3 instance.
 * Each additional reporter therefore needs its own freshly generated
 * 32-hex id instead of a string suffix on the primary one.
 */
function reportersClause(id: string, coverage?: CoverageOptions): ReportersClause {
    const rt = `l_rt_rep`;
    let decls = `${rt} ut_realtime_reporter := ut_realtime_reporter();`;
    let inits = `${rt}.set_reporter_id('${id}');`;
    let reporters = rt;
    let coverageId: string | undefined;
    let htmlId: string | undefined;
    if (coverage) {
        coverageId = newReporterId();
        const cov = `l_cov_rep`;
        const mappings = coverage.fileMappings
            .map(
                (m) =>
                    `ut_file_mapping(${quoteLiteral(m.file)}, ${quoteLiteral(
                        validateIdentifier(m.owner, 'owner')
                    )}, ${quoteLiteral(validateIdentifier(m.name, 'object name'))}, ${quoteLiteral(m.type)})`
            )
            .join(',\n            ');
        decls += `\n   ${cov} ${coverage.reporter} := ${coverage.reporter}();`;
        decls += `\n   l_source_mappings ut_file_mappings := ut_file_mappings(\n            ${mappings}\n         );`;
        inits += `\n   ${cov}.set_reporter_id('${coverageId}');`;
        reporters += `, ${cov}`;
        if (coverage.includeObjects) {
            coverage.includeObjects.forEach((o) => validateIdentifier(o, 'include object'));
        }
        if (coverage.excludeObjects) {
            coverage.excludeObjects.forEach((o) => validateIdentifier(o, 'exclude object'));
        }
        if (coverage.htmlReport) {
            htmlId = newReporterId();
            const html = `l_html_rep`;
            decls += `\n   ${html} ut_coverage_html_reporter := ut_coverage_html_reporter();`;
            inits += `\n   ${html}.set_reporter_id('${htmlId}');`;
            reporters += `, ${html}`;
        }
    }
    return { reporters, decls, inits, coverageId, htmlId };
}

export interface ProduceOptions {
    tags?: string[];
    randomOrder?: boolean;
    seed?: number;
    coverage?: CoverageOptions;
}

export interface ProduceSql {
    sql: string;
    /** Reporter id to pass to consumeNamedReporter() for the coverage reporter, when coverage was requested. */
    coverageId?: string;
    /** Reporter id to pass to consumeNamedReporter() for ut_coverage_html_reporter, when options.coverage.htmlReport was set. */
    htmlId?: string;
}

export function buildProduceSql(id: string, paths: string[], options: ProduceOptions = {}): ProduceSql {
    const { reporters, decls, inits, coverageId, htmlId } = reportersClause(id, options.coverage);
    // a_tags is a plain varchar2 (comma-separated tag list, OR-matched),
    // not a ut_varchar2_list — unlike a_paths/a_include_objects/etc. Passing
    // ut_varchar2_list(...) here compiles to a PLS-00306 wrong-argument-type
    // error, which the producer connection never surfaces to the consumer:
    // the realtime reporter never gets initialized, so the consumer just
    // sits on its initial timeout instead of failing fast (caught via a live
    // utPLSQL 3.2.3 instance, see test/integration/runOptions.test.ts).
    const tagsBind = options.tags && options.tags.length > 0 ? `\n      a_tags => ${quoteLiteral(options.tags.join(','))},` : '';
    const randomOrder = options.randomOrder ? 'true' : 'false';
    const seedBind = options.seed !== undefined ? String(options.seed) : 'null';
    const coverageArgs = options.coverage
        ? `,\n      a_source_file_mappings => l_source_mappings` +
          (options.coverage.schemes && options.coverage.schemes.length > 0
              ? `,\n      a_coverage_schemes => ${varchar2List(options.coverage.schemes)}`
              : '') +
          (options.coverage.includeObjects && options.coverage.includeObjects.length > 0
              ? `,\n      a_include_objects => ${varchar2List(options.coverage.includeObjects)}`
              : '') +
          (options.coverage.excludeObjects && options.coverage.excludeObjects.length > 0
              ? `,\n      a_exclude_objects => ${varchar2List(options.coverage.excludeObjects)}`
              : '')
        : '';
    const sql = `DECLARE
   ${decls}
BEGIN
   ${inits}
   sys.dbms_output.enable(NULL);
   ut_runner.run(
      a_paths => ${varchar2List(paths)},
      a_reporters => ut_reporters(${reporters}),${tagsBind}
      a_random_test_order => ${randomOrder},
      a_random_test_order_seed => ${seedBind}${coverageArgs}
   );
   sys.dbms_output.disable;
END;`;
    return { sql, coverageId, htmlId };
}

export async function produceReport(conn: Connection, id: string, paths: string[], options: ProduceOptions = {}): Promise<ProduceSql> {
    const produced = buildProduceSql(id, paths, options);
    await conn.execute(produced.sql);
    return produced;
}

const CONSUME_SQL = `DECLARE
   l_reporter ut_realtime_reporter := ut_realtime_reporter();
BEGIN
   l_reporter.set_reporter_id(:id);
   :cur := l_reporter.get_lines_cursor(a_initial_timeout => :initialTimeout, a_timeout_sec => :nextTimeout);
END;`;

/** How long to wait for the first event and for each subsequent one before ut_output_buffer_base raises ORA-20215. */
export const DEFAULT_INITIAL_TIMEOUT_SEC = 60;
export const DEFAULT_NEXT_EVENT_TIMEOUT_SEC = 3600;

/**
 * Opens the realtime cursor immediately (does not wait for iteration).
 * Splitting this from the row-streaming generator matters: an async
 * generator function body only starts running on its first `.next()` call,
 * so if opening were folded into the generator, "start consumer, wait
 * 100ms, then start producer" would silently reduce to "start producer,
 * then start consumer" the moment someone iterates it lazily — which is
 * exactly the header-table race (SQL Developer issue #80) this ordering
 * exists to avoid.
 *
 * fetchArraySize=1 is mandatory — otherwise events arrive bundled at the
 * end instead of live (mirrors jdbcTemplate.setFetchSize(1) in
 * RealtimeReporterDao.consumeReport). prefetchRows must NOT be set to 0
 * here, despite that looking like the more natural pairing for streaming:
 * empirically (verified against a live utPLSQL 3.2.3 instance), pairing
 * prefetchRows:0 with this pipelined-table-function-backed REF CURSOR
 * makes the cursor yield zero rows every time, silently, regardless of
 * fetchArraySize, timeouts, or produce/consume ordering — a node-oracledb/
 * OCI interaction quirk with pipelined functions, not a data problem
 * (confirmed: fetchArraySize:1 alone streams all events correctly).
 *
 * a_timeout_sec must be passed explicitly (not left at its NULL default):
 * left NULL, the consumer returns an empty cursor immediately without
 * polling at all, again regardless of a_initial_timeout.
 */
export async function openConsumer(
    conn: Connection,
    id: string,
    initialTimeoutSeconds = DEFAULT_INITIAL_TIMEOUT_SEC,
    nextEventTimeoutSeconds = DEFAULT_NEXT_EVENT_TIMEOUT_SEC
): Promise<ResultSet<Record<string, unknown>>> {
    const result = await conn.execute<{ cur: ResultSet<Record<string, unknown>> }>(
        CONSUME_SQL,
        {
            id,
            initialTimeout: initialTimeoutSeconds,
            nextTimeout: nextEventTimeoutSeconds,
            cur: { dir: oracledb.BIND_OUT, type: oracledb.CURSOR }
        },
        { fetchArraySize: 1 }
    );
    return (result.outBinds as { cur: ResultSet<Record<string, unknown>> }).cur;
}

/**
 * Streams event rows from an already-open consumer cursor (see openConsumer).
 *
 * cancelConsumer() breaks and drops the underlying connection while this may
 * be mid-iteration; the next getRow() call then throws NJS-018 ("invalid
 * ResultSet") — confirmed against a live utPLSQL 3.2.3 instance. Without the
 * inner try/catch that exception propagated out of the for-await in the
 * caller (runOneProfile), which is exactly the case its own
 * token.isCancellationRequested check inside the loop body was meant to
 * handle gracefully; the check never got a chance to run because the crash
 * happened one getRow() call earlier, on the *next* iteration attempt. A
 * getRow() failure here is treated the same as end-of-stream instead.
 */
export async function* streamRows(rs: ResultSet<Record<string, unknown>>): AsyncGenerator<EventRow> {
    try {
        while (true) {
            let row: Record<string, unknown> | undefined;
            try {
                row = await rs.getRow();
            } catch {
                return;
            }
            if (!row) {
                return;
            }
            yield { itemType: String(row.ITEM_TYPE), text: String(row.TEXT ?? '') };
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
 * Drains a non-realtime reporter (coverage, html, …) fully after the
 * producing ut_runner.run block has already returned — no fetchArraySize=1
 * streaming needed since there is no live progress to show for these.
 */
export async function consumeNamedReporter(conn: Connection, reporterType: string, id: string): Promise<string> {
    const sql = `DECLARE
   l_reporter ${reporterType} := ${reporterType}();
BEGIN
   l_reporter.set_reporter_id(:id);
   :cur := l_reporter.get_lines_cursor();
END;`;
    const result = await conn.execute<{ cur: ResultSet<Record<string, unknown>> }>(
        sql,
        { id, cur: { dir: oracledb.BIND_OUT, type: oracledb.CURSOR } },
        { fetchArraySize: 100 }
    );
    const rs = (result.outBinds as { cur: ResultSet<Record<string, unknown>> }).cur;
    const lines: string[] = [];
    let row = await rs.getRow();
    while (row) {
        lines.push(String(row.TEXT ?? ''));
        row = await rs.getRow();
    }
    await rs.close();
    return lines.join('\n');
}

/**
 * Cancellation: break the session, then drop the connection. The DB session
 * itself keeps running to completion — same deliberate limitation as
 * RunnerPanel ("database session is not cancelled. This is not a bug.").
 */
export async function cancelConsumer(conn: Connection): Promise<void> {
    try {
        await conn.break();
    } catch {
        // ignore — connection may already be gone
    }
    try {
        await conn.close({ drop: true });
    } catch {
        // ignore
    }
}
