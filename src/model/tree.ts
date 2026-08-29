import { Counter } from './events';

export type RunStatus = 'errored' | 'failed' | 'passed' | 'skipped' | 'unknown';

/**
 * Port of Item.getStatusIcon() escalation order: error beats failure beats
 * success beats disabled/skipped.
 */
export function escalateStatus(counter: Counter): RunStatus {
    if (counter.error > 0) {
        return 'errored';
    }
    if (counter.failure > 0) {
        return 'failed';
    }
    if (counter.success > 0) {
        return 'passed';
    }
    if (counter.disabled > 0) {
        return 'skipped';
    }
    return 'unknown';
}

export interface RunNode {
    id: string;
    parentId?: string;
    kind: 'suite' | 'context' | 'test';
    name?: string;
    started: boolean;
    finished: boolean;
    status: RunStatus;
    counter?: Counter;
    executionTimeMs?: number;
}

/**
 * Minimal in-memory aggregate of the tree being executed by one TestRun,
 * used to correlate pre-/post- events with previously discovered TestItems
 * and to fill in items that only appear in the pre-run tree (dynamic suites).
 */
export class RunTree {
    private readonly nodes = new Map<string, RunNode>();

    upsert(id: string, patch: Partial<RunNode> & { kind: RunNode['kind'] }): RunNode {
        const existing = this.nodes.get(id);
        const node: RunNode = existing
            ? { ...existing, ...patch }
            : {
                  id,
                  started: false,
                  finished: false,
                  status: 'unknown',
                  ...patch
              };
        this.nodes.set(id, node);
        return node;
    }

    get(id: string): RunNode | undefined {
        return this.nodes.get(id);
    }

    all(): RunNode[] {
        return [...this.nodes.values()];
    }
}
