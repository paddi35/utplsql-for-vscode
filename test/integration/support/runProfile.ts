import { Connection } from 'oracledb';
import { ProduceOptions, buildProduceSql, newReporterId, openConsumer, streamRows, consumeNamedReporter } from '../../../src/db/realtimeDao';
import { parseEvent } from '../../../src/model/eventParser';
import { UtplsqlEvent } from '../../../src/model/events';

export interface CollectedEvent {
    event: UtplsqlEvent;
    /** ms since the run started, for the streaming-timing assertions in streaming.test.ts. */
    elapsedMs: number;
}

export interface RunResult {
    events: CollectedEvent[];
    coverageXml?: string;
}

/**
 * Mirrors runOneProfile()'s produce/consume choreography in
 * src/testing/runHandler.ts (open the consumer cursor, wait 100ms, only then
 * start the producer, stream events, then drain the coverage reporter if
 * requested) without the vscode.TestController/TestRun plumbing that file is
 * built around — this project's DB protocol layer (db/*, model/*) is meant
 * to be IDE-independent, so it can be driven directly against a real utPLSQL
 * schema here.
 */
export async function runPathsAndCollect(
    producerConn: Connection,
    consumerConn: Connection,
    paths: string[],
    options: ProduceOptions = {}
): Promise<RunResult> {
    const id = newReporterId();
    const rs = await openConsumer(consumerConn, id);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const produced = buildProduceSql(id, paths, options);
    const producePromise = producerConn.execute(produced.sql);

    const start = Date.now();
    const events: CollectedEvent[] = [];
    for await (const row of streamRows(rs)) {
        const event = parseEvent(row.itemType, row.text);
        if (event) {
            events.push({ event, elapsedMs: Date.now() - start });
        }
    }
    await producePromise;

    let coverageXml: string | undefined;
    if (options.coverage) {
        coverageXml = await consumeNamedReporter(producerConn, options.coverage.reporter, produced.coverageId!);
    }
    return { events, coverageXml };
}
