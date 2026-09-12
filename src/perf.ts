import * as vscode from 'vscode';
import * as fs from 'node:fs';

/**
 * Opt-in timing instrumentation for the Test Explorer tree build and run
 * paths (see docs/performance.md). Disabled by default -- mark()/measure()
 * are near-free no-ops unless utplsql.perf.enabled is set, so this carries
 * no cost for the normal user who never touches it.
 */
function isEnabled(): boolean {
    return vscode.workspace.getConfiguration('utplsql').get<boolean>('perf.enabled', false);
}

function reportFile(): string | undefined {
    return vscode.workspace.getConfiguration('utplsql').get<string>('perf.reportFile');
}

let outputRef: vscode.OutputChannel | undefined;
/** Wired up once from extension.ts/controller.ts's own output channel, so perf lines land alongside the rest of the utPLSQL log. */
export function setPerfOutputChannel(output: vscode.OutputChannel): void {
    outputRef = output;
}

function emit(name: string, ms: number, meta?: Record<string, unknown>): void {
    const line = `utPLSQL: [perf] ${name}: ${ms.toFixed(1)}ms${meta ? ' ' + JSON.stringify(meta) : ''}`;
    outputRef?.appendLine(line);
    const file = reportFile();
    if (file) {
        try {
            fs.appendFileSync(file, JSON.stringify({ name, ms, meta, timestamp: new Date().toISOString() }) + '\n', 'utf8');
        } catch {
            // best-effort -- a bad utplsql.perf.reportFile path must not break the actual operation being measured
        }
    }
}

/** Times an async operation and reports it (see emit()) when utplsql.perf.enabled is set. Always returns/throws exactly what fn() does. */
export async function measure<T>(name: string, fn: () => Promise<T>, meta?: Record<string, unknown>): Promise<T> {
    if (!isEnabled()) {
        return fn();
    }
    const start = process.hrtime.bigint();
    try {
        return await fn();
    } finally {
        emit(name, Number(process.hrtime.bigint() - start) / 1e6, meta);
    }
}

/** A running count + first/last timestamp, for streams of many small events (e.g. one per pre-/post- test) rather than one big measure() span. */
export class PerfCounter {
    private count = 0;
    private firstMs?: number;
    private lastMs?: number;
    private readonly enabled = isEnabled();

    increment(): void {
        if (!this.enabled) {
            return;
        }
        const now = Date.now();
        this.firstMs ??= now;
        this.lastMs = now;
        this.count++;
    }

    /** Reports the count and effective events/s, if any events were recorded, since the last report() call. */
    report(name: string, meta?: Record<string, unknown>): void {
        if (!this.enabled || this.count === 0) {
            return;
        }
        const elapsedMs = Math.max(1, (this.lastMs ?? 0) - (this.firstMs ?? 0));
        emit(name, elapsedMs, { count: this.count, eventsPerSecond: (this.count / elapsedMs) * 1000, ...meta });
    }
}
