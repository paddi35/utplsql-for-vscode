import oracledb from 'oracledb';
import { ConnectionProfile, connectStringDeclaresTcps, getPassword, getWalletPassword } from './connections';
import { resolveTnsAdminDirWithSource } from './tnsnames';
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

/**
 * Exported so commands/index.ts's addConnection wizard (issue #25) can
 * surface this same validation at entry — when defaultSchema is typed, and
 * again defensively before persisting — instead of it firing for the first
 * time much later, at pool-creation time, after the profile is already
 * saved.
 */
export function validateSchemaName(schema: string): string {
    if (!SCHEMA_NAME_RE.test(schema)) {
        throw new Error(
            `utPLSQL: invalid defaultSchema '${schema}' — expected an unquoted Oracle identifier ([A-Za-z][A-Za-z0-9_$#]*).`
        );
    }
    return schema;
}

/**
 * Every checkout this extension can plausibly want at once against a single
 * connection profile, sized for the worst case rather than the common case
 * (issue #16):
 *   - two concurrent "Run"s against the same profile — the Test Explorer
 *     lets a second run start before the first finishes — at one producer +
 *     one consumer connection each = 4;
 *   - +1 for a resolveHandler call (expanding a tree node) or an "Export
 *     with Reporter" probe landing in the same window;
 *   - +1 headroom for a second such probe/resolve arriving before the first
 *     lets go.
 * = 6. Because poolMin is 0, node-oracledb only opens physical connections
 * as checkouts actually demand them — a single plain "Run" still opens
 * exactly 2, never 6 — so sizing for the worst case here costs nothing when
 * the pool is used lightly.
 *
 * This constant replaces what used to be BASE_POOL_MAX (2) plus a per-call
 * `extraReporters` argument (0 or 1) added on top of it. That only worked
 * when the call happened to be the one that *created* the pool: every later
 * getPool() call for the same profile got the cached pool straight back,
 * silently discarding whatever extraReporters it asked for, so the
 * effective poolMax for a profile was pinned by whichever caller ran first —
 * most commonly a plain run (extraReporters 0), giving poolMax 2, exactly
 * the number a single run itself consumes. Any concurrent checkout then sat
 * in node-oracledb's queue until its 60s default queueTimeout fired
 * NJS-040.
 *
 * Of the two sizing options the issue lists, this is option 1 (a single
 * worst-case constant) rather than option 2 (keep a per-call ceiling and
 * grow a cached pool towards it via pool.reconfigure({ poolMax })). Option 2
 * still needs a worst-case ceiling to grow towards — every caller would have
 * to agree on the same number this constant already is — and adds a
 * reconfigure race against whichever checkouts are in flight while it runs,
 * for no benefit over simply starting there. Option 1 is also what the issue
 * calls "the smallest, most predictable change".
 */
const POOL_MAX = 6;

/**
 * node-oracledb defaults queueTimeout to 60000ms. With POOL_MAX sized for
 * the worst case above, a checkout should essentially never need to queue
 * during normal use, so a shorter timeout is not "give up on legitimate
 * contention too soon" — it is "fail fast and say why" once something has
 * genuinely exhausted the pool (a runaway ut_runner.run that never returns,
 * or a future bug that leaks a connection instead of closing it). 15s is
 * long enough to ride out several resolveHandler/export probes landing in
 * the same instant, short enough that a stuck checkout turns into the
 * describeConnectionError() message below well short of a full minute.
 */
const QUEUE_TIMEOUT_MS = 15_000;

/**
 * node-oracledb's error code for "connection request timeout" — see
 * node_modules/oracledb/lib/errors.js's ERR_CONN_REQUEST_TIMEOUT — raised
 * when a pool.getConnection() checkout waits longer than queueTimeout.
 * errors.js's getErr() sets `.code` on every driver error it constructs, so
 * this is checked directly instead of pattern-matching `.message`.
 */
const POOL_TIMEOUT_ERROR_CODE = 'NJS-040';

function hasErrorCode(err: unknown, code: string): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

/**
 * Turns a pool.getConnection() rejection into a message a user can act on.
 * A bare NJS-040 ("connection request timeout...") reads as a database or
 * network problem, when it is actually this extension's own pool being
 * fully checked out by other in-flight work against the same profile (a
 * concurrent run, a coverage build, a tree resolve, an export) for longer
 * than queueTimeout. Every other error is passed through as String(err)
 * unchanged, exactly as every getConnection() call site already did before
 * this — an ORA- error from a broken connect string, say, is already clear
 * enough on its own.
 */
export function describeConnectionError(err: unknown, profileName: string): string {
    if (hasErrorCode(err, POOL_TIMEOUT_ERROR_CODE)) {
        return (
            `utPLSQL: no free connection for '${profileName}' (pool max ${POOL_MAX}) — a run, coverage build, ` +
            'tree resolve, or export is already using all of them. Wait for it to finish, then try again.'
        );
    }
    return String(err);
}

let outputRef: vscode.OutputChannel | undefined;
/**
 * Wired up once from controller.ts's own output channel (same pattern as
 * perf.ts's setPerfOutputChannel), so pool creation logs a line alongside
 * the rest of the utPLSQL log instead of getPool() creating its own
 * duplicate output channel.
 */
export function setPoolOutputChannel(output: vscode.OutputChannel): void {
    outputRef = output;
}

const TNS_ADMIN_SOURCE_LABEL: Record<'own' | 'sqldeveloper' | 'env' | 'none', string> = {
    own: 'the utplsql.connections.tnsAdminPath setting',
    sqldeveloper: "the SQL Developer for VSCode extension's tnsConfiguration.path setting",
    env: 'the TNS_ADMIN environment variable',
    none: 'none'
};

/**
 * Resolves the TNS_ADMIN directory for a new pool and logs which of
 * pickTnsAdminDir()'s three sources won — issue #12 added
 * resolveTnsAdminDirWithSource() for exactly this logging but left it
 * unwired here, since pool.ts was out of scope for that fix.
 */
function resolveAndLogTnsAdminDir(profileName: string): string | undefined {
    const { dir, source } = resolveTnsAdminDirWithSource();
    if (dir) {
        outputRef?.appendLine(`utPLSQL: pool for '${profileName}' — using tnsnames.ora directory '${dir}' (from ${TNS_ADMIN_SOURCE_LABEL[source]}).`);
    } else {
        outputRef?.appendLine(`utPLSQL: pool for '${profileName}' — no tnsnames.ora directory configured (own setting / SQL Developer / TNS_ADMIN all unset).`);
    }
    return dir;
}

export async function getPool(profile: ConnectionProfile, secrets: vscode.SecretStorage): Promise<oracledb.Pool> {
    const existing = pools.get(profile.name);
    if (existing) {
        return existing;
    }
    const password = await getPassword(secrets, profile.name);
    if (!password) {
        throw new Error(`No password stored for connection '${profile.name}'. Run "utPLSQL: Set Password for Connection" first.`);
    }
    const configDir = resolveAndLogTnsAdminDir(profile.name);
    // The addConnection wizard warns about this same mismatch at entry
    // (commands/index.ts), but that only fires for a profile created through
    // the wizard — one added by hand in settings.json, or edited after the
    // fact to add walletLocation or change connectString, reaches pool
    // creation with nothing having checked it. Logged rather than a
    // showWarningMessage popup: getPool() runs on every test run once the
    // pool is (re)created, and pool.ts otherwise only logs to outputRef
    // (see resolveAndLogTnsAdminDir above), never pops up its own dialogs.
    if (profile.walletLocation && !connectStringDeclaresTcps(profile.connectString)) {
        outputRef?.appendLine(
            `utPLSQL: pool for '${profile.name}' — a wallet directory is configured, but connectString does not declare TCPS; ` +
                'node-oracledb only uses the wallet for a tcps:// (or PROTOCOL=TCPS) connection, so this profile will connect ' +
                'in the clear without it, unless it is a TNS alias whose own tnsnames.ora entry specifies PROTOCOL=TCPS.'
        );
    }
    const schema = profile.defaultSchema ? validateSchemaName(profile.defaultSchema) : undefined;
    // walletPassword is optional even with a walletLocation set — an
    // auto-login wallet (cwallet.sso) needs none. node-oracledb's Thin mode
    // reads walletLocation/walletPassword straight from PoolAttributes,
    // no initOracleClient()/Thick mode involved.
    const walletPassword = profile.walletLocation ? await getWalletPassword(secrets, profile.name) : undefined;
    const pool = await oracledb.createPool({
        user: profile.user,
        password,
        connectString: profile.connectString,
        poolMin: 0,
        poolMax: POOL_MAX,
        poolIncrement: 1,
        poolAlias: profile.name,
        queueTimeout: QUEUE_TIMEOUT_MS,
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
        ...(configDir ? { configDir } : {}),
        ...(profile.walletLocation ? { walletLocation: profile.walletLocation } : {}),
        ...(walletPassword ? { walletPassword } : {})
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
