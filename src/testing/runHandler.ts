import * as vscode from 'vscode';
import { Connection } from 'oracledb';
import { getProfile } from '../db/connections';
import { getPool, recyclePool } from '../db/pool';
import * as dao from '../db/utplsqlDao';
import { getCachedVersion } from '../db/versionCache';
import {
    CoverageOptions,
    ProduceOptions,
    buildProduceSql,
    cancelConsumer,
    consumeNamedReporter,
    newReporterId,
    openConsumer,
    streamRows
} from '../db/realtimeDao';
import { parseEvent } from '../model/eventParser';
import {
    Counter,
    PostSuiteEvent,
    PostTestEvent,
    SuiteItemInfo,
    TestItemInfo,
    isSuiteItem
} from '../model/events';
import { escalateStatus } from '../model/tree';
import { OwnedPath, dedupPathList, parseId, pathId } from './ids';
import { UtplsqlContext } from './model';

const CALLER_LINE_RE = /"[^"]+",\s+line\s*([0-9]+)/i;

function collectDescendants(item: vscode.TestItem, out: Map<string, vscode.TestItem>): void {
    out.set(item.id, item);
    item.children.forEach((child) => collectDescendants(child, out));
}

function collectAllItems(controller: vscode.TestController): Map<string, vscode.TestItem> {
    const all = new Map<string, vscode.TestItem>();
    controller.items.forEach((root) => collectDescendants(root, all));
    return all;
}

/** Which leaf/path items were actually requested, grouped by connection profile. */
function groupRequest(
    ctx: UtplsqlContext,
    request: vscode.TestRunRequest
): Map<string, { items: vscode.TestItem[]; paths: OwnedPath[] }> {
    const excluded = new Set((request.exclude ?? []).map((i) => i.id));
    const roots = request.include ?? [...ctx.controller.items].map(([, item]) => item);

    const selected: vscode.TestItem[] = [];
    for (const root of roots) {
        const descendants = new Map<string, vscode.TestItem>();
        collectDescendants(root, descendants);
        for (const item of descendants.values()) {
            if (!excluded.has(item.id) && item.id.includes('/path:')) {
                selected.push(item);
            }
        }
    }

    const byProfile = new Map<string, { items: vscode.TestItem[]; paths: OwnedPath[] }>();
    for (const item of selected) {
        const parsed = parseId(item.id);
        if (parsed.kind !== 'path') {
            continue;
        }
        const meta = ctx.meta.get(item.id);
        if (!meta) {
            continue;
        }
        const group = byProfile.get(parsed.profile) ?? { items: [], paths: [] };
        group.items.push(item);
        group.paths.push({ owner: meta.owner, suitepath: meta.suitepath });
        byProfile.set(parsed.profile, group);
    }
    for (const [profile, group] of byProfile) {
        byProfile.set(profile, { items: group.items, paths: dedupPathList(group.paths) });
    }
    return byProfile;
}

function findOrCreateItem(
    ctx: UtplsqlContext,
    known: Map<string, vscode.TestItem>,
    profile: string,
    owner: string,
    node: SuiteItemInfo | TestItemInfo,
    parent: vscode.TestItem
): vscode.TestItem {
    const id = pathId(profile, owner, node.id);
    const existing = known.get(id);
    if (existing) {
        return existing;
    }
    const label = 'name' in node && node.name ? node.name : node.id;
    const item = ctx.controller.createTestItem(id, label);
    parent.children.add(item);
    known.set(id, item);
    ctx.meta.set(id, { profile, owner, suitepath: node.id });
    return item;
}

/** "Baum abgleichen, fehlende Items nachlegen": adds any pre-run item missing from the discovered tree. */
function reconcileTree(
    ctx: UtplsqlContext,
    known: Map<string, vscode.TestItem>,
    profile: string,
    topLevel: Array<SuiteItemInfo | TestItemInfo>,
    requestedTopLevel: OwnedPath[],
    schemaItems: Map<string, vscode.TestItem>
): void {
    topLevel.forEach((node, i) => {
        const owner = requestedTopLevel[i]?.owner ?? requestedTopLevel[0]?.owner ?? '';
        const parent = schemaItems.get(owner) ?? [...schemaItems.values()][0];
        if (!parent) {
            return;
        }
        walk(node, owner, parent);
    });

    function walk(node: SuiteItemInfo | TestItemInfo, owner: string, parent: vscode.TestItem): void {
        const item = findOrCreateItem(ctx, known, profile, owner, node, parent);
        if (isSuiteItem(node)) {
            node.items.forEach((child) => walk(child, owner, item));
        }
    }
}

function appendOutputCrlf(run: vscode.TestRun, text: string | undefined, item?: vscode.TestItem): void {
    if (!text) {
        return;
    }
    run.appendOutput(text.replace(/\r?\n/g, '\r\n') + '\r\n', undefined, item);
}

/**
 * failedExpectations.caller carries the call site as `"<file>", line <n>`
 * (Expectation.getCallerLine()'s regex); combined with the TestItem's own
 * uri (from the workspace index) this points VS Code at the failing
 * assertion inside the package body rather than just the test procedure.
 */
function toTestMessages(event: PostTestEvent, item: vscode.TestItem): vscode.TestMessage[] {
    return event.failedExpectations.map((exp) => {
        const message = new vscode.TestMessage(exp.message);
        if (exp.caller && item.uri) {
            const m = CALLER_LINE_RE.exec(exp.caller);
            if (m) {
                const line = Math.max(0, parseInt(m[1], 10) - 1);
                message.location = new vscode.Location(item.uri, new vscode.Position(line, 0));
            }
        }
        return message;
    });
}

function applyPostCounters(
    run: vscode.TestRun,
    item: vscode.TestItem,
    counter: Counter,
    durationMs: number | undefined,
    messages: vscode.TestMessage[] = []
): void {
    const status = escalateStatus(counter);
    switch (status) {
        case 'errored':
            run.errored(item, messages, durationMs);
            break;
        case 'failed':
            run.failed(item, messages, durationMs);
            break;
        case 'passed':
            run.passed(item, durationMs);
            break;
        case 'skipped':
            run.skipped(item);
            break;
        default:
            run.skipped(item);
    }
}

interface RunOneProfileOptions {
    coverage?: CoverageOptions;
    tags?: string[];
    randomOrder?: boolean;
    randomOrderSeed?: number;
}

export interface RunOneProfileResult {
    coverageXml?: string;
    htmlReport?: string;
}

async function runOneProfile(
    ctx: UtplsqlContext,
    run: vscode.TestRun,
    profile: string,
    items: vscode.TestItem[],
    paths: OwnedPath[],
    token: vscode.CancellationToken,
    options: RunOneProfileOptions = {}
): Promise<RunOneProfileResult> {
    const cfg = getProfile(profile);
    if (!cfg) {
        items.forEach((i) => run.errored(i, new vscode.TestMessage(`Unknown connection profile '${profile}'`)));
        return {};
    }
    const known = collectAllItems(ctx.controller);
    const schemaItems = new Map<string, vscode.TestItem>();
    for (const item of items) {
        run.enqueued(item);
        const meta = ctx.meta.get(item.id);
        if (meta && !schemaItems.has(meta.owner)) {
            const schema = known.get(`conn:${profile}/schema:${meta.owner}`);
            if (schema) {
                schemaItems.set(meta.owner, schema);
            }
        }
    }

    const pool = await getPool(cfg, ctx.secrets, options.coverage ? 1 : 0);
    const producerConn = await pool.getConnection();

    const version = await getCachedVersion(producerConn, profile);
    const unsupported = dao.checkRealtimeReporterSupport(version, profile);
    if (unsupported) {
        items.forEach((i) => run.errored(i, new vscode.TestMessage(unsupported)));
        ctx.output.appendLine(`utPLSQL: ${unsupported}`);
        await safeClose(producerConn);
        return {};
    }

    const consumerConn = await pool.getConnection();
    const id = newReporterId();
    const runPaths = paths.map((p) => `${p.owner}:${p.suitepath}`);
    ctx.output.appendLine(`utPLSQL: run paths for '${profile}' = ${JSON.stringify(runPaths)} (from ${items.length} selected item(s): ${items.map((i) => i.id).join(', ')})`);

    let cancelled = false;
    const cancelSub = token.onCancellationRequested(() => {
        cancelled = true;
        void cancelConsumer(consumerConn);
    });

    const activeItems = new Map<string, vscode.TestItem>();
    try {
        // Consumer must open its cursor before the producer starts, to avoid
        // the header-table race (SQL Developer issue #80 / ORA-00001 on the
        // reporter's output buffer). openConsumer() executes eagerly, unlike
        // an async generator, so this really does happen before the produce
        // SQL below is sent.
        const rs = await openConsumer(consumerConn, id);
        await new Promise((resolve) => setTimeout(resolve, 100));

        const produceOptions: ProduceOptions = {
            coverage: options.coverage,
            tags: options.tags,
            randomOrder: options.randomOrder,
            seed: options.randomOrderSeed
        };
        const produced = buildProduceSql(id, runPaths, produceOptions);
        ctx.output.appendLine(`utPLSQL: produce SQL:\n${produced.sql}`);
        // The producer runs concurrently with the consumer loop below and can
        // fail long before the await further down is reached — a bad suite
        // path or a compile error in the block fails almost immediately,
        // while the consumer is still sitting on its initial timeout. Leaving
        // the rejection unattached for that window makes it an unhandled
        // rejection in the extension host, so it is captured here and
        // re-thrown (into the catch below, which errors the items) once the
        // loop has finished.
        let produceError: unknown;
        const producePromise = producerConn.execute(produced.sql).catch((err: unknown) => {
            produceError = err;
        });

        for await (const row of streamRows(rs)) {
            ctx.output.appendLine(`utPLSQL: received event itemType='${row.itemType}'`);
            if (token.isCancellationRequested) {
                ctx.output.appendLine('utPLSQL: cancellation requested, stopping consumption');
                break;
            }
            const event = parseEvent(row.itemType, row.text, (msg) => ctx.output.appendLine(msg));
            if (!event) {
                ctx.output.appendLine(`utPLSQL: parseEvent returned undefined for itemType='${row.itemType}', raw text follows:\n${row.text}`);
                continue;
            }
            switch (event.type) {
                case 'pre-run': {
                    reconcileTree(ctx, known, profile, event.items, paths, schemaItems);
                    appendOutputCrlf(run, `utPLSQL: running ${event.totalNumberOfTests} test(s) on '${profile}'…`);
                    break;
                }
                case 'pre-suite': {
                    const lookupId = pathId(profile, guessOwner(event.suite.id, paths, known, profile), event.suite.id);
                    const item = known.get(lookupId);
                    ctx.output.appendLine(`utPLSQL: pre-suite id='${event.suite.id}' -> lookup '${lookupId}' -> ${item ? 'FOUND' : 'NOT FOUND'}`);
                    if (item) {
                        run.started(item);
                        activeItems.set(event.suite.id, item);
                    }
                    break;
                }
                case 'pre-test': {
                    const lookupId = pathId(profile, guessOwner(event.test.id, paths, known, profile), event.test.id);
                    const item = known.get(lookupId);
                    ctx.output.appendLine(`utPLSQL: pre-test id='${event.test.id}' -> lookup '${lookupId}' -> ${item ? 'FOUND' : 'NOT FOUND'}`);
                    if (item) {
                        run.started(item);
                        activeItems.set(event.test.id, item);
                    }
                    break;
                }
                case 'post-test': {
                    const item = activeItems.get(event.id) ?? known.get(pathId(profile, guessOwner(event.id, paths, known, profile), event.id));
                    ctx.output.appendLine(`utPLSQL: post-test id='${event.id}' -> ${item ? 'FOUND' : 'NOT FOUND'}, counter=${JSON.stringify(event.counter)}`);
                    if (item) {
                        const durationMs = event.executionTime !== undefined ? event.executionTime * 1000 : undefined;
                        applyPostCounters(run, item, event.counter, durationMs, toTestMessages(event, item));
                        // Always emit at least a pass/fail summary line — serverOutput/
                        // errorStack are only present when the test itself called
                        // dbms_output, otherwise the VS Code Test Results panel would
                        // show "did not record any output" with no way to tell it
                        // actually ran.
                        const status = escalateStatus(event.counter).toUpperCase();
                        const durationSuffix = durationMs !== undefined ? ` (${Math.round(durationMs)} ms)` : '';
                        appendOutputCrlf(run, `${status} ${event.id}${durationSuffix}`, item);
                        appendOutputCrlf(run, event.serverOutput, item);
                        appendOutputCrlf(run, event.errorStack, item);
                    }
                    break;
                }
                case 'post-suite': {
                    const item = activeItems.get(event.id) ?? known.get(pathId(profile, guessOwner(event.id, paths, known, profile), event.id));
                    if (item) {
                        // Roll up the suite's own status from its aggregated counter —
                        // without this, run.started() was the last call ever made for
                        // the suite item, so it never reaches a terminal state and the
                        // Test Results panel shows "did not report any output" for it.
                        const durationMs = event.executionTime !== undefined ? event.executionTime * 1000 : undefined;
                        applyPostCounters(run, item, event.counter, durationMs);
                        appendOutputCrlf(run, event.serverOutput, item);
                        (event as PostSuiteEvent).warnings?.forEach((w) => appendOutputCrlf(run, w, item));
                        appendOutputCrlf(run, event.errorStack, item);
                    }
                    break;
                }
                case 'post-run': {
                    const c = event.counter;
                    appendOutputCrlf(
                        run,
                        `utPLSQL: ${c.success} passed, ${c.failure} failed, ${c.error} errored, ${c.disabled} skipped` +
                            (event.executionTime !== undefined ? ` in ${event.executionTime.toFixed(3)}s` : '')
                    );
                    appendOutputCrlf(run, event.serverOutput);
                    appendOutputCrlf(run, event.errorStack);
                    (event.warnings ?? []).forEach((w) => appendOutputCrlf(run, w));
                    break;
                }
            }
        }
        await producePromise;
        if (produceError !== undefined) {
            throw produceError;
        }

        if (options.coverage && !token.isCancellationRequested) {
            const coverageXml = await consumeNamedReporter(producerConn, options.coverage.reporter, produced.coverageId!);
            const htmlReport = options.coverage.htmlReport
                ? await consumeNamedReporter(producerConn, 'ut_coverage_html_reporter', produced.htmlId!)
                : undefined;
            return { coverageXml, htmlReport };
        }
        return {};
    } catch (err) {
        items.forEach((i) => run.errored(i, new vscode.TestMessage(String(err))));
        ctx.output.appendLine(`utPLSQL: run failed for profile '${profile}': ${String(err)}`);
        return {};
    } finally {
        cancelSub.dispose();
        await safeClose(producerConn);
        await safeClose(consumerConn);
        // Only after both connections are safely closed: recyclePool()'s
        // pool.close(0) would otherwise risk forcibly tearing down
        // producerConn while ut_runner.run is still executing server-side
        // (see recyclePool()'s doc comment for why it's needed at all).
        if (cancelled) {
            await recyclePool(profile);
        }
    }
}

function guessOwner(suitepath: string, paths: OwnedPath[], known: Map<string, vscode.TestItem>, profile: string): string {
    for (const p of paths) {
        if (p.suitepath === suitepath || suitepath.startsWith(`${p.suitepath}.`)) {
            return p.owner;
        }
    }
    // Same weakness as SQL Developer: suitepaths don't carry the owner, so a
    // collision across schemas in one run picks the first candidate whose
    // id is already known.
    for (const p of paths) {
        if (known.has(pathId(profile, p.owner, suitepath))) {
            return p.owner;
        }
    }
    return paths[0]?.owner ?? '';
}

async function safeClose(conn: Connection): Promise<void> {
    try {
        await conn.close();
    } catch {
        // already closed/dropped by cancellation
    }
}

export interface RunTestsOptions {
    tags?: string[];
}

/**
 * a_random_test_order_seed only ever goes *into* ut_runner.run — the
 * realtime reporter protocol never echoes back which seed the database
 * ended up using when the caller left it unset, so "reproduce this run"
 * only actually works once the user has set utplsql.run.randomOrderSeed
 * themselves. Logging the seed we did/didn't pass (rather than pretending
 * to read one back) keeps that honest.
 */
export function readRandomOrderConfig(): { randomOrder: boolean; randomOrderSeed?: number } {
    const cfg = vscode.workspace.getConfiguration('utplsql');
    const randomOrder = cfg.get<boolean>('run.randomOrder', false);
    const seed = cfg.get<number>('run.randomOrderSeed', 0);
    return { randomOrder, randomOrderSeed: randomOrder && seed > 0 ? seed : undefined };
}

export async function runTests(
    ctx: UtplsqlContext,
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    options: RunTestsOptions = {}
): Promise<void> {
    const run = ctx.controller.createTestRun(request);
    const { randomOrder, randomOrderSeed } = readRandomOrderConfig();
    if (randomOrder) {
        ctx.output.appendLine(
            randomOrderSeed !== undefined
                ? `utPLSQL: random test order enabled (seed ${randomOrderSeed})`
                : 'utPLSQL: random test order enabled (no seed set — set utplsql.run.randomOrderSeed to reproduce this order)'
        );
    }
    try {
        const grouped = groupRequest(ctx, request);
        for (const [profile, group] of grouped) {
            if (token.isCancellationRequested) {
                group.items.forEach((i) => run.skipped(i));
                continue;
            }
            await runOneProfile(ctx, run, profile, group.items, group.paths, token, { tags: options.tags, randomOrder, randomOrderSeed });
        }
    } finally {
        run.end();
    }
}

export { groupRequest, runOneProfile };
