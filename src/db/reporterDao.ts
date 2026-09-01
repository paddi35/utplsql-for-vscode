import oracledb, { Connection, ResultSet } from 'oracledb';
import { DEFAULT_INITIAL_TIMEOUT_SEC, DEFAULT_NEXT_EVENT_TIMEOUT_SEC, newReporterId } from './realtimeDao';

function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function varchar2List(values: string[]): string {
    return values.length === 0 ? 'ut_varchar2_list()' : `ut_varchar2_list(${values.map(quoteLiteral).join(', ')})`;
}

export interface RunWithReporterOptions {
    /** a_client_character_set — the charset the exported text is transcoded to, e.g. for a file export whose destination expects UTF-8 regardless of the DB session's default. */
    clientCharacterSet?: string;
    /** a_color_console — ANSI colors in the reporter's own text output (meaningful for e.g. ut_documentation_reporter, not for a machine-readable format like JUnit/Sonar). */
    colorConsole?: boolean;
}

/** Pure SQL builder for runWithReporter's producer block, split out so the a_color_console/a_client_character_set wiring is unit-testable without a real connection. */
export function buildRunWithReporterSql(id: string, reporterType: string, paths: string[], options: RunWithReporterOptions = {}): string {
    // No separate output_buffer.init() call: set_reporter_id() already runs
    // output_buffer.init(a_reporter_id) internally (see realtimeDao.ts's
    // reportersClause doc comment) — calling init() again afterward with no
    // argument would regenerate a random output_id and desync producer from
    // consumer.
    const runArgs =
        `a_paths => ${varchar2List(paths)}, a_reporters => ut_reporters(l_reporter)` +
        (options.colorConsole ? `, a_color_console => true` : '') +
        (options.clientCharacterSet ? `, a_client_character_set => ${quoteLiteral(options.clientCharacterSet)}` : '');
    return `DECLARE
   l_reporter ${reporterType} := ${reporterType}();
BEGIN
   l_reporter.set_reporter_id('${id}');
   ut_runner.run(${runArgs});
END;`;
}

/**
 * Runs ut_runner with a single named reporter type (validated by the caller
 * against ut_runner.get_reporters_list()) and returns the full text output.
 * Used by utplsql.runWithReporter — export path equivalent to
 * `utplsql-cli run -f=<reporter> -o=<file>`. Needs two sessions like the
 * realtime reporter: producerConn runs ut_runner.run, consumerConn drains
 * get_lines_cursor(); the consumer is started first (100ms head start).
 */
export async function runWithReporter(
    producerConn: Connection,
    consumerConn: Connection,
    reporterType: string,
    paths: string[],
    options: RunWithReporterOptions = {}
): Promise<string> {
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

    const lines: string[] = [];
    const consumePromise = (async () => {
        const result = await consumerConn.execute<{ cur: ResultSet<Record<string, unknown>> }>(
            consumeSql,
            {
                id,
                initialTimeout: DEFAULT_INITIAL_TIMEOUT_SEC,
                nextTimeout: DEFAULT_NEXT_EVENT_TIMEOUT_SEC,
                cur: { dir: oracledb.BIND_OUT, type: oracledb.CURSOR }
            },
            { fetchArraySize: 50 }
        );
        const rs = (result.outBinds as { cur: ResultSet<Record<string, unknown>> }).cur;
        let row = await rs.getRow();
        while (row) {
            lines.push(String(row.TEXT ?? ''));
            row = await rs.getRow();
        }
        await rs.close();
    })();

    await new Promise((resolve) => setTimeout(resolve, 100));
    await producerConn.execute(produceSql);
    await consumePromise;
    return lines.join('\r\n');
}
