import oracledb from 'oracledb';

/**
 * Raw oracledb pool for the integration suite — deliberately not
 * '../../../src/db/pool', which imports 'vscode' and therefore cannot load
 * outside the extension host. These settings mirror src/db/pool.ts's
 * module-level defaults so CLOB/output-format behavior matches production.
 */
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.fetchAsString = [oracledb.CLOB];

/**
 * Defaults match docker-compose.yml (gvenzl/oracle-free, FREEPDB1) with the
 * UT3 schema that 10-install-utplsql.sh installs utPLSQL into — the same
 * "claude_db" connection used interactively against that container.
 * Override via env vars to point at a different utPLSQL-equipped schema.
 */
export const TEST_USER = process.env.UTPLSQL_IT_USER ?? 'ut3';
export const TEST_OWNER = TEST_USER.toUpperCase();
const TEST_PASSWORD = process.env.UTPLSQL_IT_PASSWORD ?? 'oracle';
export const TEST_CONNECT_STRING = process.env.UTPLSQL_IT_CONNECT_STRING ?? 'localhost:1521/FREEPDB1';

/**
 * A second, deliberately unprivileged user (no SELECT ANY DICTIONARY / DBA
 * role) for the dba_/all_ view-prefix cross-profile regression in
 * dbaView.test.ts (issue #15). Unset by default: the docker-compose fixture
 * this suite normally runs against (docker/oracle-utplsql) provisions only
 * the one utPLSQL-owning schema, and adding a second user there is an
 * init-scripts change outside this test suite's scope. Set both env vars to
 * exercise the two-user regression locally/in CI once such a user exists;
 * tests that need it skip themselves via `this.skip()` when it doesn't.
 */
export const UNPRIV_TEST_USER = process.env.UTPLSQL_IT_UNPRIV_USER;
const UNPRIV_TEST_PASSWORD = process.env.UTPLSQL_IT_UNPRIV_PASSWORD;

let pool: oracledb.Pool | undefined;

export async function getTestPool(): Promise<oracledb.Pool> {
    if (!pool) {
        pool = await oracledb.createPool({
            user: TEST_USER,
            password: TEST_PASSWORD,
            connectString: TEST_CONNECT_STRING,
            poolMin: 0,
            poolMax: 6,
            poolIncrement: 1
        });
    }
    return pool;
}

export async function getTestConnection(): Promise<oracledb.Connection> {
    return (await getTestPool()).getConnection();
}

/** Drops the shared pool so a subsequent getTestPool() creates a fresh one — see cancel.test.ts. */
export async function recycleTestPool(): Promise<void> {
    if (!pool) {
        return;
    }
    const current = pool;
    pool = undefined;
    try {
        await current.close(0);
    } catch {
        // best-effort — see src/db/pool.ts's recyclePool() for why this can fail
    }
}

export async function closeTestPool(): Promise<void> {
    await recycleTestPool();
}

let unprivPool: oracledb.Pool | undefined;

/** Undefined unless UTPLSQL_IT_UNPRIV_USER/UTPLSQL_IT_UNPRIV_PASSWORD are set — see that pair's doc comment above. */
export async function getUnprivilegedTestConnection(): Promise<oracledb.Connection | undefined> {
    if (!UNPRIV_TEST_USER || !UNPRIV_TEST_PASSWORD) {
        return undefined;
    }
    if (!unprivPool) {
        unprivPool = await oracledb.createPool({
            user: UNPRIV_TEST_USER,
            password: UNPRIV_TEST_PASSWORD,
            connectString: TEST_CONNECT_STRING,
            poolMin: 0,
            poolMax: 2,
            poolIncrement: 1
        });
    }
    return unprivPool.getConnection();
}

/**
 * Whether the test schema may read v$session.
 *
 * cancel.test.ts and pool.test.ts both assert on session *lifecycle* --
 * that a cancelled export leaves nothing behind, and that closePool()
 * really ends a profile's sessions -- which cannot be observed from
 * inside the sessions themselves. The docker fixture grants it (see
 * docker/oracle-utplsql/init-scripts/15-grant-session-view.sh), but that
 * script only runs when the database is first created, so an older
 * container or a different database will not have it; there the two
 * suites skip rather than fail with ORA-00942.
 *
 * Probed with a no-row query so it costs nothing and cannot depend on
 * what happens to be connected at the time.
 */
export async function canReadSessionView(conn: oracledb.Connection): Promise<boolean> {
    try {
        await conn.execute('SELECT sid FROM v$session WHERE 1 = 0');
        return true;
    } catch (err) {
        if (String(err).includes('ORA-00942')) {
            return false;
        }
        throw err;
    }
}

export async function closeUnprivilegedTestPool(): Promise<void> {
    if (!unprivPool) {
        return;
    }
    const current = unprivPool;
    unprivPool = undefined;
    try {
        await current.close(0);
    } catch {
        // best-effort — see src/db/pool.ts's recyclePool() for why this can fail
    }
}
