import assert from 'node:assert/strict';
import oracledb from 'oracledb';
import { installModuleStub, uncacheAllSrcModules } from '../unit/support/moduleStub';
import { createFakeVscode, createFakeSecretStorage } from '../unit/support/fakeVscode';
import { TEST_USER, TEST_OWNER, TEST_CONNECT_STRING, getTestPool, closeTestPool } from './support/db';
import { installFixture } from './support/fixture';
import { runPathsAndCollect } from './support/runProfile';
import * as dao from '../../src/db/utplsqlDao';

/**
 * Issue #19, symptoms 1 and 2, against a real Oracle instance — UNEXECUTED
 * in this environment (no Oracle database available; see this repo's
 * docker-compose fixture / docs for how to stand one up). Written and
 * typechecked so it documents the exact regression and is ready to run
 * wherever test/integration already runs against a live database.
 *
 * pool.ts imports 'vscode', so it needs the same fake-module technique
 * test/unit/pool.test.ts uses (see support/moduleStub.ts) rather than the
 * rest of test/integration's plain `oracledb from 'oracledb'` approach
 * (support/db.ts's own doc comment explains why it avoids src/db/pool.ts
 * entirely) — here the whole point is pool.ts's own pools Map/getPool
 * caching behaviour, which support/db.ts's raw pool deliberately bypasses.
 */
type PoolModule = typeof import('../../src/db/pool');

function loadPool(): { pool: PoolModule; uninstall(): void } {
    const { module: fakeVscode } = createFakeVscode();
    const stub = installModuleStub('vscode', fakeVscode);
    uncacheAllSrcModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pool = require('../../src/db/pool') as PoolModule;
    return {
        pool,
        uninstall() {
            stub.uninstall();
            uncacheAllSrcModules();
        }
    };
}

const REAL_PASSWORD = process.env.UTPLSQL_IT_PASSWORD ?? 'oracle';
const WRONG_PASSWORD = `${REAL_PASSWORD}-definitely-wrong`;

describe('pool against a real Oracle instance [integration, unexecuted here — no DB available]', function () {
    this.timeout(30000);

    it('symptom 1: fixing a wrong password only takes effect after the pool is invalidated, not before', async () => {
        const { pool, uninstall } = loadPool();
        try {
            const profileName = 'it-wrong-password';
            const profile = { name: profileName, user: TEST_USER, connectString: TEST_CONNECT_STRING };
            const secrets = createFakeSecretStorage({ [`utplsql.password.${profileName}`]: WRONG_PASSWORD });

            // Wrong password: the pool builds fine (poolMin: 0 defers the
            // actual auth attempt to the first checkout), but getConnection
            // fails with ORA-01017.
            const badPool = await pool.getPool(profile, secrets);
            await assert.rejects(() => badPool.getConnection(), /ORA-01017/);

            // Fix the stored secret — this alone is symptom 1: without
            // invalidating the pool, the very same getConnection() call
            // below would still fail with ORA-01017 forever, even though
            // the secret is now correct.
            await secrets.store(`utplsql.password.${profileName}`, REAL_PASSWORD);
            await pool.closePool(profileName);

            const fixedPool = await pool.getPool(profile, secrets);
            const conn = await fixedPool.getConnection();
            await conn.close();
        } finally {
            await pool.closePool('it-wrong-password');
            uninstall();
        }
    });

    it('symptom 2: closePool ends the profile\'s open Oracle sessions instead of leaving them running', async () => {
        const { pool, uninstall } = loadPool();
        try {
            const profileName = 'it-session-lifecycle';
            const profile = { name: profileName, user: TEST_USER, connectString: TEST_CONNECT_STRING };
            const secrets = createFakeSecretStorage({ [`utplsql.password.${profileName}`]: REAL_PASSWORD });

            const p = await pool.getPool(profile, secrets);
            const conn = await p.getConnection();
            const before = await conn.execute<{ CNT: number }>(
                `SELECT COUNT(*) AS cnt FROM v$session WHERE username = UPPER(:user)`,
                { user: TEST_USER }
            );
            assert.ok((before.rows?.[0]?.CNT ?? 0) > 0, 'expected at least this checked-out session to be visible in v$session');
            await conn.close();

            await pool.closePool(profileName);

            // A fresh, unrelated connection (not from the now-closed pool)
            // to observe v$session after the close.
            const observerPool = await pool.getPool(
                { name: 'it-session-lifecycle-observer', user: TEST_USER, connectString: TEST_CONNECT_STRING },
                createFakeSecretStorage({ 'utplsql.password.it-session-lifecycle-observer': REAL_PASSWORD })
            );
            const observerConn = await observerPool.getConnection();
            try {
                const after = await observerConn.execute<{ CNT: number }>(
                    `SELECT COUNT(*) AS cnt FROM v$session WHERE username = UPPER(:user) AND module LIKE '%it-session-lifecycle%'`,
                    { user: TEST_USER }
                );
                assert.equal(after.rows?.[0]?.CNT ?? 0, 0, "expected the closed pool's sessions to be gone from v$session");
            } finally {
                await observerConn.close();
                await pool.closePool('it-session-lifecycle-observer');
            }
        } finally {
            uninstall();
        }
    });
});

/**
 * Issue #16's own test cases, against a real Oracle instance — UNEXECUTED in
 * this environment (no Oracle database available). Uses support/db.ts's raw
 * pool rather than src/db/pool.ts's getPool() for the same reason
 * cancel.test.ts and streaming.test.ts do (support/db.ts's own doc comment):
 * these tests exercise pool *sizing/contention* behaviour that is identical
 * whether the pool comes from oracledb.createPool() directly or via
 * getPool() — support/db.ts's getTestPool() already mirrors src/db/pool.ts's
 * settings (poolMin: 0, poolMax: 6, matching the fixed POOL_MAX this fix
 * introduces) — and staying on the raw pool avoids the vscode module-stub
 * dance for tests that would otherwise gain nothing from it.
 */
describe('pool sizing under concurrency, real Oracle instance [integration, unexecuted here — no DB available]', function () {
    this.timeout(60000);

    afterEach(async () => {
        await closeTestPool();
    });

    it('acquiring poolMax + 1 short-lived connections concurrently all resolve, none reject with NJS-040', async () => {
        const pool = await getTestPool();
        const concurrency = pool.poolMax + 1;

        // Each task holds its connection just long enough to run one query,
        // so the pool.poolMax-th and (poolMax+1)-th checkouts have to queue
        // briefly behind an earlier one releasing — before this fix, a
        // burst like this against a poolMax: 2 pool (whichever caller
        // happened to create it) would need N/2 rounds of "wait for a
        // release", and any checkout that didn't get a turn within 60s
        // failed with NJS-040. Fully sized up front, poolMax 6 admits most
        // of a burst this size immediately.
        const results = await Promise.allSettled(
            Array.from({ length: concurrency }, async () => {
                const conn = await pool.getConnection();
                try {
                    await conn.execute('SELECT 1 FROM dual');
                } finally {
                    await conn.close();
                }
            })
        );

        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        assert.equal(rejected.length, 0, `expected every checkout to resolve, got ${rejected.length} rejection(s): ${rejected.map((r) => String(r.reason)).join('; ')}`);
    });

    it('a long-running run occupying producer+consumer does not block a concurrent getSuitesInfo call for more than a few seconds', async () => {
        const pool = await getTestPool();
        const producerConn = await pool.getConnection();
        const consumerConn = await pool.getConnection();
        await installFixture(producerConn);

        try {
            // test_calc_pkg.test_slow (fixture.sql) sleeps ~2s, so this run
            // occupies producerConn+consumerConn for at least that long —
            // long enough that a third caller sharing a poolMax: 2 pool
            // (this profile's old effective size whenever a plain run
            // created it first) would have to wait the full run out, and
            // longer than that if the queue also has to wait on
            // node-oracledb's default 60s queueTimeout.
            const runPromise = runPathsAndCollect(producerConn, consumerConn, [`${TEST_OWNER}:test_calc_pkg`]);

            const start = Date.now();
            const thirdConn = await pool.getConnection();
            try {
                const rows = await dao.getSuitesInfo(thirdConn, TEST_OWNER);
                const elapsedMs = Date.now() - start;
                assert.ok(rows.length > 0, 'expected getSuitesInfo to see at least test_calc_pkg');
                assert.ok(
                    elapsedMs < 5000,
                    `expected the concurrent getSuitesInfo call to return in a few seconds, not queue behind the run, took ${elapsedMs}ms`
                );
            } finally {
                await thirdConn.close();
            }

            await runPromise;
        } finally {
            await producerConn.close();
            await consumerConn.close();
        }
    });

    it('a root-resolve equivalent (hasSuites + getSuitesInfo) completes for two profiles in parallel', async () => {
        // Two independent pools standing in for two connection profiles
        // pointed at the same schema — controller.ts gives each profile its
        // own oracledb pool (poolAlias: profile.name), so two profiles never
        // actually contend for the same pool's connections; what this
        // guards against is a *single* profile's own root resolve
        // saturating its own pool (the controller.ts bug this issue also
        // fixes: holding a connection open across fetchSuiteRows(), which
        // opens a second one of its own).
        async function rootResolveEquivalent(pool: oracledb.Pool): Promise<number> {
            let owners = 0;
            // Mirrors controller.ts's fixed resolveHandler: the hasSuites
            // connection is closed before fetchSuiteRows()'s equivalent
            // (getSuitesInfo) opens its own, rather than held open across
            // it — that overlap was the actual bug this issue fixes.
            const conn = await pool.getConnection();
            try {
                if (await dao.hasSuites(conn, TEST_OWNER)) {
                    owners++;
                }
            } finally {
                await conn.close();
            }
            const suitesConn = await pool.getConnection();
            let rows: dao.SuiteInfoRow[];
            try {
                rows = await dao.getSuitesInfo(suitesConn, TEST_OWNER);
            } finally {
                await suitesConn.close();
            }
            return owners + rows.length;
        }

        const poolA = await oracledb.createPool({ user: TEST_USER, password: REAL_PASSWORD, connectString: TEST_CONNECT_STRING, poolMin: 0, poolMax: 6, poolIncrement: 1 });
        const poolB = await oracledb.createPool({ user: TEST_USER, password: REAL_PASSWORD, connectString: TEST_CONNECT_STRING, poolMin: 0, poolMax: 6, poolIncrement: 1 });
        try {
            const [resultA, resultB] = await Promise.all([rootResolveEquivalent(poolA), rootResolveEquivalent(poolB)]);
            assert.ok(resultA > 0, 'expected profile A to see at least one suite/owner');
            assert.ok(resultB > 0, 'expected profile B to see at least one suite/owner');
        } finally {
            await poolA.close(0);
            await poolB.close(0);
        }
    });
});
