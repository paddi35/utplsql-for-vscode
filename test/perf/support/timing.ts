import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TimedRun<T> {
    result: T;
    ms: number;
}

export async function timed<T>(fn: () => Promise<T>): Promise<TimedRun<T>> {
    const start = process.hrtime.bigint();
    const result = await fn();
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    return { result, ms };
}

export function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function p95(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    return sorted[Math.max(0, idx)];
}

export interface PerfMeasurement {
    name: string;
    unit: 'ms' | 'events/s' | 'count';
    value: number;
    samples?: number[];
    meta?: Record<string, unknown>;
}

/**
 * Appends one JSON-lines report per run to test-results/perf-report.jsonl
 * (created on first write) -- deliberately not overwritten, so a CI history
 * of runs accumulates as a trend rather than only ever showing the latest
 * number. Never asserted against directly (timings are machine-dependent);
 * this is for a human or a future trend job to read.
 */
export function recordMeasurement(measurement: PerfMeasurement): void {
    const dir = path.join(__dirname, '..', '..', '..', 'test-results');
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ...measurement, timestamp: new Date().toISOString() });
    fs.appendFileSync(path.join(dir, 'perf-report.jsonl'), line + '\n', 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[perf] ${measurement.name}: ${measurement.value.toFixed(2)} ${measurement.unit}`);
}
