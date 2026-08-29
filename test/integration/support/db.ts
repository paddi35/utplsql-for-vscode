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
const TEST_CONNECT_STRING = process.env.UTPLSQL_IT_CONNECT_STRING ?? 'localhost:1521/FREEPDB1';

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
