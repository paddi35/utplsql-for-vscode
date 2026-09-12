import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { createReportFileGuard, ReportFileGuard } from './perfReportPath';

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

/**
 * utplsql.perf.enabled/reportFile are now "scope": "machine" (package.json)
 * -- a workspace's own .vscode/settings.json can no longer set either,
 * which is the actual fix for the arbitrary-file-append primitive
 * reportFile used to be: previously a workspace could point it at any path
 * on disk and it would be appended to on the very first measure() span (any
 * Test Explorer expand -- getSuitesInfo/materializeLevel/groupRequest are
 * all instrumented). This guard is the belt-and-braces half: it resolves
 * even a legitimately user/machine-configured reportFile and refuses to
 * write outside an open workspace folder, logging the rejection once
 * instead of disappearing into a bare catch {}.
 *
 * Deliberately checks only workspace folders, not also the extension's own
 * globalStorageUri/logUri as first suggested: obtaining either needs the
 * vscode.ExtensionContext passed to activate() (extension.ts), and this fix
 * does not touch extension.ts or controller.ts's setPerfOutputChannel()
 * call site. isReportFileAllowed()/createReportFileGuard() (see
 * perfReportPath.ts) take allowedRoots as plain strings for exactly this
 * reason -- closing that gap later is a matter of passing more roots in,
 * not changing the validation logic itself.
 *
 * Created lazily and cached for the extension host session, so
 * workspaceFolders reflects whatever is actually open by the time perf
 * tracing first runs, and so "warn once" (see createReportFileGuard) means
 * once per session rather than once per call.
 */
let reportGuard: ReportFileGuard | undefined;
function getReportGuard(): ReportFileGuard {
    reportGuard ??= createReportFileGuard(
        (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
        (rejected) =>
            outputRef?.appendLine(
                `utPLSQL: [perf] ignoring utplsql.perf.reportFile '${rejected}' -- it must resolve inside an open workspace folder.`
            )
    );
    return reportGuard;
}

function emit(name: string, ms: number, meta?: Record<string, unknown>): void {
    const line = `utPLSQL: [perf] ${name}: ${ms.toFixed(1)}ms${meta ? ' ' + JSON.stringify(meta) : ''}`;
    outputRef?.appendLine(line);
    const file = reportFile();
    if (!file || !getReportGuard().check(file)) {
        return;
    }
    // fs.appendFile, not the previous appendFileSync: perf instrumentation
    // must not block the extension host on disk I/O. The empty callback
    // keeps the same best-effort contract the old try/catch had -- the path
    // itself is already validated above, so a failure here (disk full,
    // permissions, a race with the file being deleted) has nothing
    // actionable left to do beyond being dropped.
    fs.appendFile(file, JSON.stringify({ name, ms, meta, timestamp: new Date().toISOString() }) + '\n', 'utf8', () => undefined);
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
