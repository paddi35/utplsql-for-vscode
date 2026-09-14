import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * test/integration/support/db.ts hardcodes default test credentials
 * (ut3/oracle/localhost:1521/FREEPDB1, plus the unprivileged user's name) so
 * the integration suite runs against docker-compose.yml's fixture "out of
 * the box", with no setup beyond `docker compose up`. The security review
 * judged this safe only in combination with finding #1 (the dev database
 * must not be reachable from outside the host) and noted the defaults are
 * "not credentials for anything that exists outside a developer's machine or
 * a CI runner" *because* they describe this disposable container specifically
 * (issue #81).
 *
 * That reasoning depends on every side actually agreeing. Nothing previously
 * enforced it: a future change to any one of these would silently break
 * "works out of the box" for whichever side did not know about the others --
 * exactly the kind of drift this repository already guards elsewhere (see
 * manifest.test.ts). Issue #81 named two locations for the hardcoded
 * defaults -- db.ts and .github/workflows/e2e.yml's env block -- and there
 * are two more of the same shape this file also checks: test/e2e/runTests.ts
 * independently hardcodes HOST/PORT/SERVICE defaults that must combine to
 * the same connect string as db.ts's, and 16-create-unprivileged-user.sh
 * hardcodes its own copy of UTPLSQL_TARGET_PDB's default alongside
 * 10-install-utplsql.sh's. This file extracts each default from its source
 * of truth via a plain regex (no YAML parser needed for the values read from
 * docker-compose.yml/e2e.yml) and compares them, rather than duplicating the
 * literals here and hoping they are kept in sync by hand.
 */

const ROOT = process.cwd();

function read(relativePath: string): string {
    return fs.readFileSync(path.resolve(ROOT, relativePath), 'utf8');
}

/** Extracts `<envVar>` from a `process.env.<envVar> ?? '<default>'` (or `??` with double quotes) expression. */
function jsDefault(source: string, envVar: string): string {
    const re = new RegExp(`process\\.env\\.${envVar}\\s*\\?\\?\\s*['"]([^'"]+)['"]`);
    const match = re.exec(source);
    assert.ok(match, `expected to find 'process.env.${envVar} ?? "<default>"' in the source`);
    return match![1];
}

/** Extracts `<default>` from a bash `"${<envVar>:-<default>}"` expression. */
function bashDefault(source: string, envVar: string): string {
    const re = new RegExp(`\\$\\{${envVar}:-([^}]+)\\}`);
    const match = re.exec(source);
    assert.ok(match, `expected to find '\${${envVar}:-<default>}' in the source`);
    return match![1];
}

/** Extracts `<value>` from a GitHub Actions `<envVar>: <value>` line inside an env: block. */
function workflowEnvValue(source: string, envVar: string): string {
    const re = new RegExp(`^\\s*${envVar}:\\s*(.+)$`, 'm');
    const match = re.exec(source);
    assert.ok(match, `expected to find '${envVar}: <value>' in the source`);
    return match![1].trim();
}

describe('integration test fixture defaults match the docker fixture they describe', () => {
    const dbTs = read('test/integration/support/db.ts');
    const compose = read('docker-compose.yml');
    const installUtplsql = read('docker/oracle-utplsql/init-scripts/10-install-utplsql.sh');
    const createUnprivUser = read('docker/oracle-utplsql/init-scripts/16-create-unprivileged-user.sh');
    const e2eWorkflow = read('.github/workflows/e2e.yml');
    const runTests = read('test/e2e/runTests.ts');

    it("TEST_USER's default matches the schema 10-install-utplsql.sh creates", () => {
        assert.equal(jsDefault(dbTs, 'UTPLSQL_IT_USER').toUpperCase(), bashDefault(installUtplsql, 'UTPLSQL_SCHEMA'));
    });

    it("TEST_PASSWORD's default matches docker-compose.yml's ORACLE_PASSWORD default", () => {
        assert.equal(jsDefault(dbTs, 'UTPLSQL_IT_PASSWORD'), bashDefault(compose, 'ORACLE_PASSWORD'));
    });

    it("TEST_CONNECT_STRING's default port and PDB match docker-compose.yml's published port and 10-install-utplsql.sh's target PDB", () => {
        const connectString = jsDefault(dbTs, 'UTPLSQL_IT_CONNECT_STRING');
        const portMatch = /:(\d+)\/([^/'"]+)$/.exec(connectString);
        assert.ok(portMatch, `expected TEST_CONNECT_STRING's default ('${connectString}') to end in ':<port>/<PDB>'`);
        const [, port, pdb] = portMatch!;

        // Tolerates docker-compose.yml's "hostport:containerport" form as well as
        // a "bind-address:hostport:containerport" form (see finding #1) -- either
        // way, the *host* port is the one a test connecting from outside the
        // container needs.
        const publishedPortMatch = /ports:\s*\n\s*-\s*"(?:[^:"]+:)?(\d+):\d+"/.exec(compose);
        assert.ok(publishedPortMatch, "expected to find a published port mapping in docker-compose.yml's ports:");
        assert.equal(port, publishedPortMatch![1]);

        assert.equal(pdb, bashDefault(installUtplsql, 'UTPLSQL_TARGET_PDB'));
    });

    it("UNPRIV_TEST_USER's default matches the user 16-create-unprivileged-user.sh creates", () => {
        assert.equal(jsDefault(dbTs, 'UTPLSQL_IT_UNPRIV_USER'), bashDefault(createUnprivUser, 'UTPLSQL_IT_UNPRIV_USER'));
    });

    it("16-create-unprivileged-user.sh's own TARGET_PDB default matches 10-install-utplsql.sh's, not just db.ts's", () => {
        // A drift here wouldn't trip the connect-string check above at all:
        // it would silently degrade UNPRIV_TEST_USER's ALTER SESSION SET
        // CONTAINER to the wrong PDB, which getUnprivilegedTestConnection()
        // (db.ts) reports as "not configured" (ORA-01017) rather than as a
        // failure, and the tests needing it just skip themselves.
        assert.equal(bashDefault(createUnprivUser, 'UTPLSQL_TARGET_PDB'), bashDefault(installUtplsql, 'UTPLSQL_TARGET_PDB'));
    });

    it("e2e.yml's hardcoded UTPLSQL_IT_* env values match db.ts's defaults", () => {
        // ci.yml/e2e.yml sets these explicitly rather than relying on
        // db.ts's own `?? '<default>'` fallback, so a change to one side's
        // literal has nothing to keep it in sync with the other's.
        assert.equal(workflowEnvValue(e2eWorkflow, 'UTPLSQL_IT_USER'), jsDefault(dbTs, 'UTPLSQL_IT_USER'));
        assert.equal(workflowEnvValue(e2eWorkflow, 'UTPLSQL_IT_PASSWORD'), jsDefault(dbTs, 'UTPLSQL_IT_PASSWORD'));
        assert.equal(workflowEnvValue(e2eWorkflow, 'UTPLSQL_IT_CONNECT_STRING'), jsDefault(dbTs, 'UTPLSQL_IT_CONNECT_STRING'));
    });

    it("runTests.ts's HOST/PORT/SERVICE defaults combine to the same connect string as db.ts's TEST_CONNECT_STRING default", () => {
        // writeLegitTnsAdminDir() (runTests.ts) builds a real tnsnames.ora
        // from these three independently of db.ts's single combined
        // connect-string default -- issue #12's regression fixture depends
        // on both describing the same container.
        const host = jsDefault(runTests, 'UTPLSQL_IT_HOST');
        const port = jsDefault(runTests, 'UTPLSQL_IT_PORT');
        const service = jsDefault(runTests, 'UTPLSQL_IT_SERVICE');
        assert.equal(`${host}:${port}/${service}`, jsDefault(dbTs, 'UTPLSQL_IT_CONNECT_STRING'));
    });
});
