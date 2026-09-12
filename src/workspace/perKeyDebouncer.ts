/**
 * Debounces work per key: scheduling key A and then key B inside the delay
 * window still runs *both* eventual callbacks, each `delayMs` after its own
 * most recent call. A single shared `setTimeout` field cannot do this — see
 * SourceIndex's original `scheduleReindex` (#20), where `clearTimeout` on
 * one shared field cancelled whatever was pending for *any* document, so a
 * burst of edits across two open documents inside one 400ms window silently
 * dropped the first document's re-index and only the last-touched one was
 * ever reparsed. Nothing recovered automatically; the index just stayed
 * stale for that document until it was reopened or the window reloaded.
 *
 * Kept vscode-free (the same split virtualSourcePath.ts documents for the
 * virtual-source URI grammar) so this fix is reachable by plain mocha
 * instead of the extension host, which SourceIndex requires just by having
 * `import * as vscode from 'vscode'` at the top of its file — a test can't
 * dodge that by only calling the "pure" parts.
 *
 * Re-scheduling the same key before its timer fires collapses to a single
 * call: the previous timer is cancelled and a new one takes over the key,
 * so "runs once, with the latest payload" falls out of always replacing the
 * stored callback (whatever it closes over) rather than queueing calls up.
 */
export class PerKeyDebouncer {
    private readonly timers = new Map<string, NodeJS.Timeout>();

    constructor(private readonly delayMs: number) {}

    /** Number of keys with a callback still pending — for tests asserting fired keys don't linger and leak. */
    get size(): number {
        return this.timers.size;
    }

    /**
     * Schedules `run` to fire after `delayMs`, replacing (and cancelling)
     * whatever was already pending for this exact key. Other keys' pending
     * timers are untouched — that per-key isolation is the entire point.
     */
    schedule(key: string, run: () => void): void {
        const existing = this.timers.get(key);
        if (existing) {
            clearTimeout(existing);
        }
        this.timers.set(
            key,
            setTimeout(() => {
                this.timers.delete(key);
                run();
            }, this.delayMs)
        );
    }

    /** Cancels `key`'s pending callback without running it. No-op if nothing is pending for it. */
    cancel(key: string): void {
        const existing = this.timers.get(key);
        if (existing) {
            clearTimeout(existing);
            this.timers.delete(key);
        }
    }

    /** Cancels every still-pending timer, for every key — e.g. when the owner is disposed. */
    dispose(): void {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
    }
}
