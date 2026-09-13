import assert from 'node:assert/strict';
import oracledb from 'oracledb';
import { installModuleStub, uncacheAllSrcModules } from './support/moduleStub';
import { createFakeVscode, createFakeSecretStorage } from './support/fakeVscode';

type PoolModule = typeof import('../../src/db/pool');

/**
 * pool.ts imports the real oracledb driver — deliberately not stubbed here,
 * unlike 'vscode': node-oracledb Thin mode's createPool() with poolMin: 0
 * (this codebase's default, see pool.ts's own BASE_POOL_MAX comment) does
 * not eagerly open a connection, so a syntactically valid but unreachable
 * Easy-Connect string resolves a real pool object near-instantly, with no
 * database required — exactly what these tests need to exercise
 * getPool()/closePool()'s pools Map bookkeeping for real. It also sidesteps
 * a real gotcha found while writing this: repeatedly monkeypatching
 * Module._resolveFilename to fake 'oracledb' across many require() calls in
 * the same mocha process turned out to be unreliable — some later
 * require("oracledb") calls silently resolved to the real, already-cached
 * module instead of the just-installed fake, for reasons that didn't
 * reduce to a specific Node/tsx caching layer worth fighting further.
 * pool.ts imports connections.ts (for getPassword) and tnsnames.ts (for
 * resolveTnsAdminDir), both of which import 'vscode' for real — see
 * connections.test.ts's loadConnections for why loading it has to be a
 * dynamic require() inside a test body rather than a top-level import, and
 * support/moduleStub.ts for the substitution mechanism itself.
 */
function loadPool(): { pool: PoolModule; uninstall(): void } {
    const { module: fakeVscode } = createFakeVscode();
    const vscodeStub = installModuleStub('vscode', fakeVscode);

    uncacheAllSrcModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pool = require('../../src/db/pool') as PoolModule;
    return {
        pool,
        uninstall() {
            vscodeStub.uninstall();
            uncacheAllSrcModules();
        }
    };
}

/** A connect string real oracledb accepts as well-formed without ever needing to reach it, given poolMin: 0. */
const UNREACHABLE_CONNECT_STRING = 'localhost:19999/doesnotexist';

describe('pool (real oracledb, unreachable host, poolMin 0 — no database needed)', () => {
    it('closePool(name) removes the cached entry so the next getPool() call creates a new pool object', async () => {
        const { pool, uninstall } = loadPool();
        try {
            const secrets = createFakeSecretStorage({ 'utplsql.password.unit-test-dev': 'pw' });
            const profile = { name: 'unit-test-dev', user: 'hr', connectString: UNREACHABLE_CONNECT_STRING };

            const first = await pool.getPool(profile, secrets);
            const second = await pool.getPool(profile, secrets);
            assert.equal(second, first, 'expected getPool to cache the pool across calls');

            await pool.closePool('unit-test-dev');
            const third = await pool.getPool(profile, secrets);
            assert.notEqual(third, first, 'expected a fresh pool object after closePool');

            await pool.closePool('unit-test-dev');
        } finally {
            uninstall();
        }
    });

    it('closePool on an unknown name is a no-op and does not throw', async () => {
        const { pool, uninstall } = loadPool();
        try {
            await assert.doesNotReject(() => pool.closePool('does-not-exist'));
        } finally {
            uninstall();
        }
    });

    it('recyclePool on an unknown name is also a no-op and does not throw', async () => {
        const { pool, uninstall } = loadPool();
        try {
            await assert.doesNotReject(() => pool.recyclePool('does-not-exist'));
        } finally {
            uninstall();
        }
    });

    it('getPool throws a clear error when no password is stored for the profile', async () => {
        const { pool, uninstall } = loadPool();
        try {
            const secrets = createFakeSecretStorage();
            await assert.rejects(
                () => pool.getPool({ name: 'unit-test-nopw', user: 'hr', connectString: UNREACHABLE_CONNECT_STRING }, secrets),
                /No password stored for connection 'unit-test-nopw'/
            );
        } finally {
            uninstall();
        }
    });

    /**
     * Issue #16 regression coverage: getPool() used to take an
     * `extraReporters` argument that only sized the pool when the call
     * happened to be the one that created it — every later call for the same
     * profile got the cached pool back with whatever poolMax the first
     * caller asked for, silently discarding its own request. The fix (option
     * 1 of the three the issue lists) drops that parameter entirely for one
     * fixed worst-case constant (pool.ts's POOL_MAX, currently 6), so there
     * is no longer a "first caller wins" sizing decision to get wrong —
     * these tests pin that every getPool() call, regardless of who makes it
     * or in what order, produces a pool sized to the same worst-case
     * constant.
     */
    it('getPool sizes every pool to the same fixed worst-case poolMax, regardless of call order', async () => {
        const { pool, uninstall } = loadPool();
        try {
            const secrets = createFakeSecretStorage({ 'utplsql.password.unit-test-sizing': 'pw' });
            const profile = { name: 'unit-test-sizing', user: 'hr', connectString: UNREACHABLE_CONNECT_STRING };

            const first = await pool.getPool(profile, secrets);
            const second = await pool.getPool(profile, secrets);
            assert.equal(first.poolMax, second.poolMax, 'expected repeated getPool() calls to observe the same poolMax');
            assert.ok(first.poolMax >= 4, `expected a worst-case poolMax covering at least two concurrent runs (4), got ${first.poolMax}`);

            await pool.closePool('unit-test-sizing');
        } finally {
            uninstall();
        }
    });

    it('two different profile names get two independently sized pools, each with the same fixed poolMax', async () => {
        const { pool, uninstall } = loadPool();
        try {
            const secrets = createFakeSecretStorage({
                'utplsql.password.unit-test-a': 'pw',
                'utplsql.password.unit-test-b': 'pw'
            });
            const a = await pool.getPool({ name: 'unit-test-a', user: 'hr', connectString: UNREACHABLE_CONNECT_STRING }, secrets);
            const b = await pool.getPool({ name: 'unit-test-b', user: 'hr', connectString: UNREACHABLE_CONNECT_STRING }, secrets);
            assert.notEqual(a, b, 'expected two different profile names to get two different pool objects');
            assert.equal(a.poolMax, b.poolMax, 'expected both pools to be sized the same, since sizing no longer varies per caller');

            await pool.closePool('unit-test-a');
            await pool.closePool('unit-test-b');
        } finally {
            uninstall();
        }
    });

    it('after recyclePool(name), the next getPool() call creates a fresh pool that is still sized to the worst-case poolMax', async () => {
        const { pool, uninstall } = loadPool();
        try {
            const secrets = createFakeSecretStorage({ 'utplsql.password.unit-test-recycle': 'pw' });
            const profile = { name: 'unit-test-recycle', user: 'hr', connectString: UNREACHABLE_CONNECT_STRING };

            const first = await pool.getPool(profile, secrets);
            await pool.recyclePool('unit-test-recycle');
            const second = await pool.getPool(profile, secrets);

            assert.notEqual(second, first, 'expected a fresh pool object after recyclePool');
            assert.equal(second.poolMax, first.poolMax, 'expected the re-created pool to be sized the same as the original');

            await pool.closePool('unit-test-recycle');
        } finally {
            uninstall();
        }
    });

    it('getPool sets an explicit queueTimeout shorter than node-oracledb\'s 60s default', async () => {
        const { pool, uninstall } = loadPool();
        try {
            const secrets = createFakeSecretStorage({ 'utplsql.password.unit-test-queue': 'pw' });
            const created = await pool.getPool({ name: 'unit-test-queue', user: 'hr', connectString: UNREACHABLE_CONNECT_STRING }, secrets);
            assert.ok(created.queueTimeout > 0, 'expected a positive, explicit queueTimeout rather than the driver leaving it at its own default');
            assert.ok(created.queueTimeout < 60_000, `expected queueTimeout to be set well below node-oracledb's 60s default, got ${created.queueTimeout}ms`);

            await pool.closePool('unit-test-queue');
        } finally {
            uninstall();
        }
    });

    /**
     * oracledb.Pool does not expose walletLocation/walletPassword back as
     * readable properties the way it does poolMax/queueTimeout/connectString
     * above, so these two tests intercept oracledb.createPool() itself
     * instead — a single mutable property on the same real, cached module
     * object pool.ts's own `import oracledb from 'oracledb'` resolves to
     * (unlike the module-resolution stubbing this file's top comment found
     * unreliable, monkeypatching one already-loaded function is a plain,
     * synchronous property swap). Always restored in a finally block so it
     * cannot leak into another test.
     */
    describe('walletLocation/walletPassword (issue #83)', () => {
        function interceptCreatePool(): { captured(): oracledb.PoolAttributes | undefined; restore(): void } {
            const realCreatePool = oracledb.createPool;
            let captured: oracledb.PoolAttributes | undefined;
            (oracledb as unknown as { createPool: typeof oracledb.createPool }).createPool = ((attrs: oracledb.PoolAttributes) => {
                captured = attrs;
                return realCreatePool(attrs);
            }) as typeof oracledb.createPool;
            return {
                captured: () => captured,
                restore: () => {
                    oracledb.createPool = realCreatePool;
                }
            };
        }

        it('passes walletLocation and the stored wallet password through to createPool when the profile configures a wallet', async () => {
            const { pool, uninstall } = loadPool();
            try {
                const secrets = createFakeSecretStorage({
                    'utplsql.password.unit-test-wallet': 'pw',
                    'utplsql.walletPassword.unit-test-wallet': 'walletpw'
                });
                const intercepted = interceptCreatePool();
                try {
                    await pool.getPool(
                        { name: 'unit-test-wallet', user: 'hr', connectString: UNREACHABLE_CONNECT_STRING, walletLocation: '/opt/wallet' },
                        secrets
                    );
                } finally {
                    intercepted.restore();
                }
                assert.equal(intercepted.captured()?.walletLocation, '/opt/wallet');
                assert.equal(intercepted.captured()?.walletPassword, 'walletpw');

                await pool.closePool('unit-test-wallet');
            } finally {
                uninstall();
            }
        });

        it('omits walletLocation/walletPassword from createPool when the profile has no wallet configured', async () => {
            const { pool, uninstall } = loadPool();
            try {
                const secrets = createFakeSecretStorage({ 'utplsql.password.unit-test-nowallet': 'pw' });
                const intercepted = interceptCreatePool();
                try {
                    await pool.getPool({ name: 'unit-test-nowallet', user: 'hr', connectString: UNREACHABLE_CONNECT_STRING }, secrets);
                } finally {
                    intercepted.restore();
                }
                assert.equal(intercepted.captured()?.walletLocation, undefined);
                assert.equal(intercepted.captured()?.walletPassword, undefined);

                await pool.closePool('unit-test-nowallet');
            } finally {
                uninstall();
            }
        });

        it('does not look up a wallet password when the profile has no walletLocation, even if one happens to be stored', async () => {
            const { pool, uninstall } = loadPool();
            try {
                // A leftover secret from a wallet that was since removed from the profile — must not resurface.
                const secrets = createFakeSecretStorage({
                    'utplsql.password.unit-test-stale-wallet-secret': 'pw',
                    'utplsql.walletPassword.unit-test-stale-wallet-secret': 'stale'
                });
                const intercepted = interceptCreatePool();
                try {
                    await pool.getPool({ name: 'unit-test-stale-wallet-secret', user: 'hr', connectString: UNREACHABLE_CONNECT_STRING }, secrets);
                } finally {
                    intercepted.restore();
                }
                assert.equal(intercepted.captured()?.walletPassword, undefined);

                await pool.closePool('unit-test-stale-wallet-secret');
            } finally {
                uninstall();
            }
        });
    });

    describe('describeConnectionError', () => {
        it('turns an NJS-040 pool-timeout error into an actionable message naming the profile and the pool max', async () => {
            const { pool, uninstall } = loadPool();
            try {
                const njsTimeout = Object.assign(new Error('NJS-040: connection request timeout. Request exceeded "queueTimeout" of 15000'), {
                    code: 'NJS-040'
                });
                const message = pool.describeConnectionError(njsTimeout, 'my-profile');
                assert.match(message, /no free connection for 'my-profile'/);
                assert.match(message, /pool max \d+/);
            } finally {
                uninstall();
            }
        });

        it('passes every other error through as String(err), unchanged', async () => {
            const { pool, uninstall } = loadPool();
            try {
                const oraError = new Error('ORA-12154: TNS:could not resolve the connect identifier specified');
                assert.equal(pool.describeConnectionError(oraError, 'my-profile'), String(oraError));

                const notAnError = 'just a string rejection';
                assert.equal(pool.describeConnectionError(notAnError, 'my-profile'), String(notAnError));
            } finally {
                uninstall();
            }
        });
    });

    describe('setPoolOutputChannel / TNS_ADMIN source logging (issue #12 follow-up)', () => {
        /** Minimal structural stand-in for vscode.OutputChannel — only appendLine is called by pool.ts. */
        function createFakeOutputChannel(): { appendLine(line: string): void; lines: string[] } {
            const lines: string[] = [];
            return { lines, appendLine: (line: string) => lines.push(line) };
        }

        it('logs which source won (own setting) when a new pool is created', async () => {
            const { module: fakeVscode } = createFakeVscode({ 'utplsql.connections.tnsAdminPath': 'C:\\tns\\own' });
            const vscodeStub = installModuleStub('vscode', fakeVscode);
            uncacheAllSrcModules();
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const pool = require('../../src/db/pool') as PoolModule;
            try {
                const output = createFakeOutputChannel();
                pool.setPoolOutputChannel(output as unknown as Parameters<PoolModule['setPoolOutputChannel']>[0]);
                const secrets = createFakeSecretStorage({ 'utplsql.password.unit-test-tns-own': 'pw' });
                await pool.getPool({ name: 'unit-test-tns-own', user: 'hr', connectString: UNREACHABLE_CONNECT_STRING }, secrets);

                assert.ok(
                    output.lines.some((l) => l.includes('unit-test-tns-own') && l.includes('C:\\tns\\own') && l.includes('tnsAdminPath')),
                    `expected a log line naming the profile, the resolved directory and the winning source, got: ${JSON.stringify(output.lines)}`
                );

                await pool.closePool('unit-test-tns-own');
            } finally {
                vscodeStub.uninstall();
                uncacheAllSrcModules();
            }
        });

        it('logs that no TNS_ADMIN directory is configured when none of the three sources are set', async () => {
            const { module: fakeVscode } = createFakeVscode();
            const vscodeStub = installModuleStub('vscode', fakeVscode);
            uncacheAllSrcModules();
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const pool = require('../../src/db/pool') as PoolModule;
            try {
                const output = createFakeOutputChannel();
                pool.setPoolOutputChannel(output as unknown as Parameters<PoolModule['setPoolOutputChannel']>[0]);
                const secrets = createFakeSecretStorage({ 'utplsql.password.unit-test-tns-none': 'pw' });
                await pool.getPool({ name: 'unit-test-tns-none', user: 'hr', connectString: UNREACHABLE_CONNECT_STRING }, secrets);

                assert.ok(
                    output.lines.some((l) => l.includes('unit-test-tns-none') && l.includes('no tnsnames.ora directory configured')),
                    `expected a log line noting no TNS_ADMIN source is configured, got: ${JSON.stringify(output.lines)}`
                );

                await pool.closePool('unit-test-tns-none');
            } finally {
                vscodeStub.uninstall();
                uncacheAllSrcModules();
            }
        });
    });
});
