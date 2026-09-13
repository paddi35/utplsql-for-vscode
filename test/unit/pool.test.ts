import assert from 'node:assert/strict';
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
 * reduce to a specific Node/ts-node caching layer worth fighting further.
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
});
