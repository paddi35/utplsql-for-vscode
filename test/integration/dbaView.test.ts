import assert from 'node:assert/strict';
import { Connection } from 'oracledb';
import * as dao from '../../src/db/utplsqlDao';
import { getTestConnection, closeTestPool, getUnprivilegedTestConnection, closeUnprivilegedTestPool, TEST_OWNER } from './support/db';
import { installFixture, FIXTURE_OWNER_OBJECT } from './support/fixture';

/**
 * Regression coverage for issue #15: isDbaViewAccessible()/getDbaView() used
 * to cache their dba_/all_ answer in a single module-level variable with no
 * key, so whichever connection profile probed it first decided the view
 * prefix for every other profile for the rest of the session — either
 * ORA-00942 for an unprivileged profile probed second, or a silently
 * downgraded coverage scope for a privileged one probed second.
 *
 * Needs a second, deliberately unprivileged DB user alongside the normal
 * fixture owner (see support/db.ts's UNPRIV_TEST_USER doc comment for why
 * that isn't part of the default docker-compose fixture). Every test here
 * skips itself via `this.skip()` when that user isn't configured, the same
 * way a missing optional fixture is handled elsewhere in this suite, rather
 * than failing.
 */
describe('per-profile dba_/all_ view caching against a real schema [integration]', function () {
    this.timeout(30000);
    let privilegedConn: Connection;
    let unprivilegedConn: Connection | undefined;

    before(async () => {
        privilegedConn = await getTestConnection();
        await installFixture(privilegedConn);
        unprivilegedConn = await getUnprivilegedTestConnection();
    });

    after(async () => {
        await privilegedConn.close();
        await closeTestPool();
        if (unprivilegedConn) {
            await unprivilegedConn.close();
        }
        await closeUnprivilegedTestPool();
    });

    beforeEach(function () {
        if (!unprivilegedConn) {
            this.skip();
        }
    });

    it('resolves dba_ for the privileged user and all_ for the unprivileged one, in both probe orders', async () => {
        // Distinct profile names per assertion (rather than reusing one)
        // isolate this test from the module-level cache's state instead of
        // depending on clearDbaViewCache() to reset it first — the same
        // cache-keying this test exists to prove works at all.
        dao.clearDbaViewCache();
        assert.equal(await dao.getDbaView(privilegedConn, 'priv-then-unpriv-a'), 'dba_');
        assert.equal(await dao.getDbaView(unprivilegedConn!, 'priv-then-unpriv-b'), 'all_');

        assert.equal(await dao.getDbaView(unprivilegedConn!, 'unpriv-then-priv-a'), 'all_');
        assert.equal(await dao.getDbaView(privilegedConn, 'unpriv-then-priv-b'), 'dba_');
    });

    it('lets includes()/getPackageObjectTypes()/getObjectSource() succeed for the unprivileged user after the privileged one was probed first — the ORA-00942 the bug produced', async () => {
        dao.clearDbaViewCache();
        // Probe the privileged connection under one profile name first, the
        // same order the bug report describes: whichever profile a user
        // happens to expand first in the Test Explorer wins the cache
        // before this fix.
        await dao.getDbaView(privilegedConn, 'priv-probed-first');

        await assert.doesNotReject(dao.includes(unprivilegedConn!, TEST_OWNER, ['CALC_PKG'], 'unpriv-second'));
        await assert.doesNotReject(dao.getPackageObjectTypes(unprivilegedConn!, TEST_OWNER, [FIXTURE_OWNER_OBJECT], 'unpriv-second'));
        await assert.doesNotReject(dao.getObjectSource(unprivilegedConn!, TEST_OWNER, FIXTURE_OWNER_OBJECT, 'PACKAGE BODY', 'unpriv-second'));
    });

    it('does not let the unprivileged profile probed first downgrade the privileged one probed second', async () => {
        dao.clearDbaViewCache();
        await dao.getDbaView(unprivilegedConn!, 'unpriv-probed-first');

        // If the privileged connection were still forced onto all_* here,
        // this would silently return fewer dependencies (or none) instead of
        // throwing — the "worse of the two" failure mode issue #15
        // describes, so the assertion is on the *value*, not just that the
        // call didn't reject.
        const deps = await dao.includes(privilegedConn, TEST_OWNER, ['TEST_CALC_PKG'], 'priv-second');
        assert.ok(
            deps.some((d) => d.owner === TEST_OWNER && d.name === 'CALC_PKG'),
            `expected CALC_PKG among TEST_CALC_PKG's dependencies via dba_dependencies, got ${JSON.stringify(deps)}`
        );
    });
});
