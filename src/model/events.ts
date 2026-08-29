/**
 * Typed representation of the six ut_realtime_reporter event types.
 * Mirrors the XML shape emitted by ut_realtime_reporter.tpb.
 */

export interface Counter {
    disabled: number;
    success: number;
    failure: number;
    error: number;
    warning: number;
}

export interface Expectation {
    description?: string;
    message: string;
    caller?: string;
}

export interface TestItemInfo {
    id: string;
    executableType?: string;
    ownerName?: string;
    objectName?: string;
    procedureName?: string;
    disabled?: boolean;
    disabledReason?: string;
    name?: string;
    description?: string;
    testNumber?: number;
}

export interface SuiteItemInfo {
    id: string;
    name?: string;
    description?: string;
    items: Array<SuiteItemInfo | TestItemInfo>;
}

export function isSuiteItem(item: SuiteItemInfo | TestItemInfo): item is SuiteItemInfo {
    return Array.isArray((item as SuiteItemInfo).items);
}

export type EventType = 'pre-run' | 'post-run' | 'pre-suite' | 'post-suite' | 'pre-test' | 'post-test';

export interface PreRunEvent {
    type: 'pre-run';
    totalNumberOfTests: number;
    items: Array<SuiteItemInfo | TestItemInfo>;
}

export interface PostRunEvent {
    type: 'post-run';
    startTime?: string;
    endTime?: string;
    executionTime?: number;
    counter: Counter;
    errorStack?: string;
    serverOutput?: string;
    warnings?: string[];
}

export interface PreSuiteEvent {
    type: 'pre-suite';
    suite: SuiteItemInfo;
}

export interface PostSuiteEvent {
    type: 'post-suite';
    id: string;
    startTime?: string;
    endTime?: string;
    executionTime?: number;
    counter: Counter;
    errorStack?: string;
    serverOutput?: string;
    warnings?: string[];
}

export interface PreTestEvent {
    type: 'pre-test';
    test: TestItemInfo;
}

export interface PostTestEvent {
    type: 'post-test';
    id: string;
    startTime?: string;
    endTime?: string;
    executionTime?: number;
    counter: Counter;
    errorStack?: string;
    serverOutput?: string;
    warnings?: string[];
    failedExpectations: Expectation[];
}

export type UtplsqlEvent =
    | PreRunEvent
    | PostRunEvent
    | PreSuiteEvent
    | PostSuiteEvent
    | PreTestEvent
    | PostTestEvent;
