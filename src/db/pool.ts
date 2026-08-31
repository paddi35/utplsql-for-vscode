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

/**
 * CURRENT_SCHEMA cannot be set through a bind variable, so defaultSchema is
 * interpolated into the ALTER SESSION statement below. Connection profiles
 * are ordinary settings, which a workspace can contribute, so the value is
 * validated as an unquoted Oracle identifier rather than trusted.
 */
const SCHEMA_NAME_RE = /^[A-Za-z][A-Za-z0-9_$#]*$/;

function validateSchemaName(schema: string): string {
    if (!SCHEMA_NAME_RE.test(schema)) {
        throw new Error(
            `utPLSQL: invalid defaultSchema '${schema}' — expected an unquoted Oracle identifier ([A-Za-z][A-Za-z0-9_$#]*).`
        );
    }
    return schema;
}

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
    const schema = profile.defaultSchema ? validateSchemaName(profile.defaultSchema) : undefined;
    const pool = await oracledb.createPool({
        user: profile.user,
        password,
        connectString: profile.connectString,
        poolMin: 0,
        poolMax: BASE_POOL_MAX + extraReporters,
        poolIncrement: 1,
        poolAlias: profile.name,
        // Runs for every newly created session in this pool, so the profile's
        // schema applies to every checkout — including the call sites that
        // take pool.getConnection() directly instead of going through
        // getConnection() below. Setting it per checkout instead used to
        // leave it to chance: an altered session kept CURRENT_SCHEMA when it
        // returned to the pool and was handed to an unrelated caller, while
        // a freshly created one had it unset.
        ...(schema
            ? {
                  sessionCallback: (
                      conn: oracledb.Connection,
                      _requestedTag: string,
                      cb: (error?: unknown) => void
                  ) => {
                      conn.execute(`ALTER SESSION SET CURRENT_SCHEMA = ${schema}`).then(
                          () => cb(),
                          (err) => cb(err)
                      );
                  }
              }
            : {}),
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
    return pool.getConnection();
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
