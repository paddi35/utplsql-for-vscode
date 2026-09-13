import assert from 'node:assert/strict';
import { Connection, ResultSet } from 'oracledb';
import { buildRunWithReporterSql, CancellationSignal, runWithReporter } from '../../src/db/reporterDao';

describe('buildRunWithReporterSql', () => {
    it('quotes paths and omits a_color_console/a_client_character_set by default', () => {
        const sql = buildRunWithReporterSql('abc123', 'ut_documentation_reporter', ['UT3:test_pkg']);
        assert.match(sql, /a_paths => ut_varchar2_list\('UT3:test_pkg'\)/);
        assert.doesNotMatch(sql, /a_color_console/);
        assert.doesNotMatch(sql, /a_client_character_set/);
    });

    it('adds a_color_console => true when requested', () => {
        const sql = buildRunWithReporterSql('abc123', 'ut_documentation_reporter', ['UT3'], { colorConsole: true });
        assert.match(sql, /a_color_console => true/);
    });

    it('quotes a_client_character_set as a varchar2 literal, escaping embedded quotes', () => {
        const sql = buildRunWithReporterSql('abc123', 'ut_documentation_reporter', ['UT3'], { clientCharacterSet: "AL32UTF8'; --" });
        assert.match(sql, /a_client_character_set => 'AL32UTF8''; --'/);
    });

    it('uses the given reporter type for both the declaration and constructor call', () => {
        const sql = buildRunWithReporterSql('abc123', 'ut_junit_reporter', ['UT3']);
        assert.match(sql, /l_reporter ut_junit_reporter := ut_junit_reporter\(\)/);
    });

    it('rejects a reporter type that is not a plain identifier', () => {
        assert.throws(() => buildRunWithReporterSql('abc123', "ut_junit_reporter(); harmful_call; --", ['UT3']), /invalid reporter type/);
    });
});

/**
 * Minimal fake of vscode.CancellationToken/CancellationTokenSource — see
 * CancellationSignal's doc comment in reporterDao.ts for why runWithReporter
 * accepts this shape rather than importing the real `vscode` module, which
 * this suite (plain tsx/mocha, no extension host) cannot load.
 */
function fakeToken(initiallyCancelled = false): { signal: CancellationSignal; cancel: () => void } {
    let cancelled = initiallyCancelled;
    let listener: (() => void) | undefined;
    return {
        signal: {
            get isCancellationRequested() {
                return cancelled;
            },
            onCancellationRequested(l: () => void) {
                listener = l;
                return { dispose: () => (listener = undefined) };
            }
        },
        cancel: () => {
            cancelled = true;
            listener?.();
        }
    };
}

/** A Connection double whose every method fails the test if called — proves a code path never touches it. */
function unusedConnection(): Connection {
    const fail = (name: string) => async () => {
        throw new Error(`${name}() should not have been called`);
    };
    return { execute: fail('execute'), break: fail('break'), close: fail('close') } as unknown as Connection;
}

describe('runWithReporter cancellation', () => {
    it('an already-cancelled token short-circuits before either connection is sent a single statement, and resolves rather than hanging', async () => {
        const { signal } = fakeToken(true);
        const result = await runWithReporter(unusedConnection(), unusedConnection(), 'ut_documentation_reporter', ['UT3:test_pkg'], {}, signal);
        assert.deepEqual(result, { output: '', cancelled: true });
    });

    it('cancelling mid-drain calls break() then close({drop: true}) on the consumer exactly once, and treats the resulting getRow() rejection as end-of-stream rather than an error', async () => {
        const { signal, cancel } = fakeToken();
        const calls: string[] = [];
        let notifyClosed: () => void;
        const closed = new Promise<void>((resolve) => (notifyClosed = resolve));

        let getRowCount = 0;
        const rs = {
            getRow: async () => {
                getRowCount++;
                if (getRowCount === 1) {
                    return { TEXT: 'first line' };
                }
                // Mirrors what cancelConsumer()'s break()+drop does to a live
                // connection mid-fetch (see realtimeDao.ts's streamRows doc
                // comment): the *next* getRow() call throws NJS-018.
                cancel();
                throw new Error('NJS-018: invalid result set');
            },
            close: async () => undefined
        } as unknown as ResultSet<Record<string, unknown>>;

        const consumerConn = {
            execute: async () => ({ outBinds: { cur: rs } }),
            break: async () => {
                calls.push('break');
            },
            close: async (opts?: unknown) => {
                calls.push(`close:${JSON.stringify(opts)}`);
                notifyClosed();
            }
        } as unknown as Connection;
        const producerConn = { execute: async () => undefined } as unknown as Connection;

        const result = await runWithReporter(producerConn, consumerConn, 'ut_documentation_reporter', ['UT3:test_pkg'], {}, signal);
        // cancelConsumer() is fired-and-forgotten from the subscription (see
        // runWithReporter's doc comment) — wait for its close() to actually
        // land before asserting on `calls`, rather than racing it.
        await closed;

        assert.equal(result.cancelled, true);
        assert.equal(result.output, 'first line');
        assert.deepEqual(calls, ['break', 'close:{"drop":true}']);
    });

    it('always attaches the producer statement\'s rejection, never leaving it floating', async () => {
        const { signal } = fakeToken();
        let getRowCount = 0;
        const rs = {
            // A few rows before end-of-stream, so the drain loop is still
            // running (not yet awaiting the producer) when the producer's
            // own promise below has already rejected — the same ordering
            // runOneProfile's produceError comment describes for the run path.
            getRow: async () => (++getRowCount <= 3 ? { TEXT: `line${getRowCount}` } : undefined),
            close: async () => undefined
        } as unknown as ResultSet<Record<string, unknown>>;
        const consumerConn = {
            execute: async () => ({ outBinds: { cur: rs } }),
            break: async () => undefined,
            close: async () => undefined
        } as unknown as Connection;
        const producerError = new Error('ORA-06550: PL/SQL compile error');
        const producerConn = {
            execute: async () => {
                throw producerError;
            }
        } as unknown as Connection;

        await assert.rejects(
            () => runWithReporter(producerConn, consumerConn, 'ut_documentation_reporter', ['UT3:test_pkg'], {}, signal),
            (err: unknown) => err === producerError
        );
    });
});
