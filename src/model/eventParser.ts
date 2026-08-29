import { XMLParser } from 'fast-xml-parser';
import {
    Counter,
    Expectation,
    PostRunEvent,
    PostSuiteEvent,
    PostTestEvent,
    PreRunEvent,
    PreSuiteEvent,
    PreTestEvent,
    SuiteItemInfo,
    TestItemInfo,
    UtplsqlEvent
} from './events';

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    trimValues: false,
    isArray: (name) => name === 'item' || name === 'expectation' || name === 'warning'
});

function asArray<T>(value: T | T[] | undefined): T[] {
    if (value === undefined) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value === 'object' && value !== null && '#text' in (value as Record<string, unknown>)) {
        return String((value as Record<string, unknown>)['#text']);
    }
    return String(value);
}

function num(value: unknown): number | undefined {
    const t = text(value);
    if (t === undefined || t === '') {
        return undefined;
    }
    const n = Number(t);
    return Number.isNaN(n) ? undefined : n;
}

function bool(value: unknown): boolean | undefined {
    const t = text(value);
    if (t === undefined) {
        return undefined;
    }
    return t === 'true' || t === '1';
}

function counter(node: Record<string, unknown> | undefined): Counter {
    const c = (node?.counter ?? {}) as Record<string, unknown>;
    return {
        disabled: num(c.disabled) ?? 0,
        success: num(c.success) ?? 0,
        failure: num(c.failure) ?? 0,
        error: num(c.error) ?? 0,
        warning: num(c.warning) ?? 0
    };
}

function warnings(node: Record<string, unknown> | undefined): string[] {
    const w = node?.warnings as Record<string, unknown> | undefined;
    if (!w) {
        return [];
    }
    return asArray(w.warning).map((x) => text(x) ?? '').filter((x) => x.length > 0);
}

function parseTestItem(node: Record<string, unknown>): TestItemInfo {
    return {
        id: text(node['@_id']) ?? '',
        executableType: text(node.executableType),
        ownerName: text(node.ownerName),
        objectName: text(node.objectName),
        procedureName: text(node.procedureName),
        disabled: bool(node.disabled),
        disabledReason: text(node.disabledReason),
        name: text(node.name),
        description: text(node.description),
        testNumber: num(node.testNumber)
    };
}

function parseSuiteItem(node: Record<string, unknown>): SuiteItemInfo {
    const itemsNode = node.items as Record<string, unknown> | undefined;
    const rawItems = itemsNode ? asArray(itemsNode.item) : [];
    const items = rawItems.map((raw) => {
        const item = raw as Record<string, unknown>;
        if (item.items !== undefined) {
            return parseSuiteItem(item);
        }
        return parseTestItem(item);
    });
    return {
        id: text(node['@_id']) ?? '',
        name: text(node.name),
        description: text(node.description),
        items
    };
}

function parseExpectations(node: Record<string, unknown>): Expectation[] {
    const fe = node.failedExpectations as Record<string, unknown> | undefined;
    if (!fe) {
        return [];
    }
    return asArray(fe.expectation).map((raw) => {
        const e = raw as Record<string, unknown>;
        return {
            description: text(e.description),
            message: text(e.message) ?? '',
            caller: text(e.caller)
        };
    });
}

/**
 * Parses a single <event> XML fragment produced by ut_realtime_reporter.
 * itemType comes from the ITEM_TYPE column and is the source of truth;
 * the type="…" attribute on <event> is only validated against it.
 * Never throws — parse failures are logged and skipped (SQL Developer #107).
 */
export function parseEvent(
    itemType: string,
    xml: string,
    log: (message: string) => void = () => undefined
): UtplsqlEvent | undefined {
    try {
        const doc = parser.parse(xml) as Record<string, unknown>;
        const eventNode = doc.event as Record<string, unknown> | undefined;
        if (!eventNode) {
            log(`utPLSQL: event XML without <event> root, itemType=${itemType}`);
            return undefined;
        }
        const attrType = text(eventNode['@_type']);
        if (attrType && attrType !== itemType) {
            log(`utPLSQL: event type mismatch, column=${itemType} attribute=${attrType}`);
        }

        switch (itemType) {
            case 'pre-run': {
                const itemsNode = eventNode.items as Record<string, unknown> | undefined;
                const rawItems = itemsNode ? asArray(itemsNode.item) : [];
                const items = rawItems.map((raw) => {
                    const item = raw as Record<string, unknown>;
                    return item.items !== undefined ? parseSuiteItem(item) : parseTestItem(item);
                });
                const event: PreRunEvent = {
                    type: 'pre-run',
                    totalNumberOfTests: num(eventNode.totalNumberOfTests) ?? 0,
                    items
                };
                return event;
            }
            case 'post-run': {
                // All fields sit inside a nested <run> element (print_start_node('run')
                // in after_calling_run), not directly on <event> — same shape as
                // pre-suite/pre-test below.
                const runNode = (eventNode.run ?? eventNode) as Record<string, unknown>;
                const event: PostRunEvent = {
                    type: 'post-run',
                    startTime: text(runNode.startTime),
                    endTime: text(runNode.endTime),
                    executionTime: num(runNode.executionTime),
                    counter: counter(runNode),
                    errorStack: text(runNode.errorStack),
                    serverOutput: text(runNode.serverOutput),
                    warnings: warnings(runNode)
                };
                return event;
            }
            case 'pre-suite': {
                const suiteNode = (eventNode.suite ?? eventNode) as Record<string, unknown>;
                const event: PreSuiteEvent = { type: 'pre-suite', suite: parseSuiteItem(suiteNode) };
                return event;
            }
            case 'post-suite': {
                // Fields nested inside <suite id="…"> (print_start_node('suite', 'id', …)
                // in after_calling_suite), not directly on <event>.
                const suiteNode = (eventNode.suite ?? eventNode) as Record<string, unknown>;
                const event: PostSuiteEvent = {
                    type: 'post-suite',
                    id: text(suiteNode['@_id']) ?? text(suiteNode.id) ?? '',
                    startTime: text(suiteNode.startTime),
                    endTime: text(suiteNode.endTime),
                    executionTime: num(suiteNode.executionTime),
                    counter: counter(suiteNode),
                    errorStack: text(suiteNode.errorStack),
                    serverOutput: text(suiteNode.serverOutput),
                    warnings: warnings(suiteNode)
                };
                return event;
            }
            case 'pre-test': {
                const testNode = (eventNode.test ?? eventNode) as Record<string, unknown>;
                const event: PreTestEvent = { type: 'pre-test', test: parseTestItem(testNode) };
                return event;
            }
            case 'post-test': {
                // Fields nested inside <test id="…"> (print_start_node('test', 'id', …)
                // in after_calling_test), not directly on <event> — this was the actual
                // bug behind "0 passed, 0 failed" and empty ids: reading straight off
                // eventNode silently returned '' / all-zero counters instead of failing
                // loudly, because every field lookup here is optional-chained.
                const testNode = (eventNode.test ?? eventNode) as Record<string, unknown>;
                const event: PostTestEvent = {
                    type: 'post-test',
                    id: text(testNode['@_id']) ?? text(testNode.id) ?? '',
                    startTime: text(testNode.startTime),
                    endTime: text(testNode.endTime),
                    executionTime: num(testNode.executionTime),
                    counter: counter(testNode),
                    errorStack: text(testNode.errorStack),
                    serverOutput: text(testNode.serverOutput),
                    warnings: warnings(testNode),
                    failedExpectations: parseExpectations(testNode)
                };
                return event;
            }
            default:
                log(`utPLSQL: unknown ITEM_TYPE '${itemType}', event skipped`);
                return undefined;
        }
    } catch (err) {
        log(`utPLSQL: failed to parse event XML (itemType=${itemType}): ${String(err)}`);
        return undefined;
    }
}
