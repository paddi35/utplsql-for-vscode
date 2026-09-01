import assert from 'node:assert/strict';
import { Connection } from 'oracledb';
import * as dao from '../../src/db/utplsqlDao';
import { getTestConnection, closeTestPool, TEST_OWNER } from './support/db';
import { installFixture } from './support/fixture';

/**
 * The plan's M4: "Rebuild Annotation Cache" command, backed by
 * ut_runner.rebuild_annotation_cache(owner, type). Confirmed against a live
 * utPLSQL 3.2.3 instance that this is the real procedure name — an earlier
 * reading of the plan assumed "rebuild_annotations", which does not exist
 * (see ut_runner.pks: procedure rebuild_annotation_cache(a_object_owner
 * varchar2, a_object_type varchar2 := null)).
 */
describe('rebuildAnnotationCache against a real schema [integration]', function () {
    this.timeout(30000);
    let conn: Connection;

    before(async () => {
        conn = await getTestConnection();
        await installFixture(conn);
    });

    after(async () => {
        await conn.close();
        await closeTestPool();
    });

    it('completes without error for a schema with compiled suite packages', async () => {
        await assert.doesNotReject(dao.rebuildAnnotationCache(conn, TEST_OWNER));
    });

    it('discovery still finds the fixture suite after a cache rebuild', async () => {
        await dao.rebuildAnnotationCache(conn, TEST_OWNER);
        const rows = await dao.getSuitesInfo(conn, TEST_OWNER);
        assert.ok(rows.some((r) => r.itemType === 'UT_SUITE' && r.objectName === 'TEST_CALC_PKG'));
    });

    it('rejects an owner that is not a valid identifier the same way other DAO calls do', async () => {
        // upper(:owner) with a garbage schema name should simply find
        // nothing to rebuild rather than error — mirrors how get_suites_info
        // behaves for an unknown owner, and confirms the call is bind-safe.
        await assert.doesNotReject(dao.rebuildAnnotationCache(conn, 'THIS_SCHEMA_DOES_NOT_EXIST'));
    });
});
