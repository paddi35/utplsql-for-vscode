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
 * dbaView.test.ts (issue #15): the bug is only reproducible with two
 * connections that see the data dictionary differently.
 *
 * The defaults match what the docker fixture provisions (see
 * docker/oracle-utplsql/init-scripts/16-create-unprivileged-user.sh), so the
 * regression runs out of the box there. Against any other database the user
 * will simply not exist, and getUnprivilegedTestConnection() reports that as
 * "not configured" rather than failing the suite -- the tests needing it skip
 * themselves. Override both env vars to point at a different pair.
 */
export const UNPRIV_TEST_USER = process.env.UTPLSQL_IT_UNPRIV_USER ?? 'utplsql_vsc_unpriv';
const UNPRIV_TEST_PASSWORD = process.env.UTPLSQL_IT_UNPRIV_PASSWORD ?? TEST_PASSWORD;

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

/**
 * The unprivileged connection, or undefined when this database has no such
 * user -- see UNPRIV_TEST_USER's doc comment above.
 *
 * poolMin: 0 means createPool() does not authenticate; a missing or
 * differently-named user only surfaces as ORA-01017 on the first checkout,
 * which is what is translated into "not configured" here. Any other error
 * is a real problem with a database that does have the user, and is
 * rethrown.
 */
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
    try {
        return await unprivPool.getConnection();
    } catch (err) {
        if (String(err).includes('ORA-01017')) {
            await closeUnprivilegedTestPool();
            return undefined;
        }
        throw err;
    }
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
