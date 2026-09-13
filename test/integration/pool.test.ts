import assert from 'node:assert/strict';
import { installModuleStub, uncacheAllSrcModules } from '../unit/support/moduleStub';
import { createFakeVscode, createFakeSecretStorage } from '../unit/support/fakeVscode';
import { TEST_USER, TEST_CONNECT_STRING } from './support/db';

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
