import oracledb from 'oracledb';
import { ConnectionProfile, getPassword } from './connections';
import { resolveTnsAdminDir } from './tnsnames';
import * as vscode from 'vscode';

// node-oracledb defaults to Thin mode as long as initOracleClient() is never
// called. `npm run prune all` (see package.json) strips the bundled Thick
// binaries so there is nothing to accidentally activate.
oracledb.fetchAsString = [oracledb.CLOB];
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

const pools = new Map<string, oracledb.Pool>();

/** Two sessions per run are mandatory: one produces, one consumes. */
const BASE_POOL_MAX = 2;

export async function getPool(
    profile: ConnectionProfile,
    secrets: vscode.SecretStorage,
    extraReporters = 1
): Promise<oracledb.Pool> {
    const existing = pools.get(profile.name);
    if (existing) {
        return existing;
    }
    const password = await getPassword(secrets, profile.name);
    if (!password) {
        throw new Error(`No password stored for connection '${profile.name}'. Run "utPLSQL: Set Password for Connection" first.`);
    }
    const configDir = resolveTnsAdminDir();
    const pool = await oracledb.createPool({
        user: profile.user,
        password,
        connectString: profile.connectString,
        poolMin: 0,
        poolMax: BASE_POOL_MAX + extraReporters,
        poolIncrement: 1,
        poolAlias: profile.name,
        ...(configDir ? { configDir } : {})
    });
    pools.set(profile.name, pool);
    return pool;
}

export async function getConnection(
    profile: ConnectionProfile,
    secrets: vscode.SecretStorage
): Promise<oracledb.Connection> {
    const pool = await getPool(profile, secrets);
    const conn = await pool.getConnection();
    if (profile.defaultSchema) {
        await conn.execute(`ALTER SESSION SET CURRENT_SCHEMA = ${profile.defaultSchema}`);
    }
    return conn;
}

export async function closePool(name: string): Promise<void> {
    const pool = pools.get(name);
    if (pool) {
        await pool.close(0);
        pools.delete(name);
    }
}

export async function closeAllPools(): Promise<void> {
    await Promise.all([...pools.keys()].map((name) => closePool(name)));
}

/**
 * Drops the cached pool for a profile so the next getPool() call creates a
 * fresh one. Required after Connection.break() (used by cancelConsumer() to
 * cancel a running test): confirmed against a live node-oracledb 6.10 Thin
 * pool that break() leaves the *pool* itself in a state where every
 * subsequently issued connection — not just the broken one — fails its next
 * statement with ORA-01013 ("User requested cancel of current operation"),
 * even though the broken connection was already closed with drop:true.
 * Closing the poisoned pool and letting getPool() recreate it is unaffected
 * by this and immediately recovers. Without this, cancelling one test run
 * would silently break every later run against the same connection profile
 * until the extension host was reloaded.
 */
export async function recyclePool(name: string): Promise<void> {
    const pool = pools.get(name);
    if (!pool) {
        return;
    }
    pools.delete(name);
    try {
        await pool.close(0);
    } catch {
        // best-effort teardown of an already-poisoned pool — what matters is
        // that it is no longer cached, so the next getPool() call is clean.
    }
}
