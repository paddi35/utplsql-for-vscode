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
 * That reasoning depends on the two sides actually agreeing. Nothing
 * previously enforced it: a future change to either the docker fixture's
 * defaults or db.ts's would silently break "works out of the box" for
 * whichever side did not know about the other -- exactly the kind of drift
 * this repository already guards elsewhere (see manifest.test.ts). This file
 * extracts each default from its source of truth via a plain regex (no YAML
 * parser needed for the one value read from docker-compose.yml) and compares
 * them, rather than duplicating the literals here and hoping they are kept
 * in sync by hand.
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

describe('integration test fixture defaults match the docker fixture they describe', () => {
    const dbTs = read('test/integration/support/db.ts');
    const compose = read('docker-compose.yml');
    const installUtplsql = read('docker/oracle-utplsql/init-scripts/10-install-utplsql.sh');
    const createUnprivUser = read('docker/oracle-utplsql/init-scripts/16-create-unprivileged-user.sh');

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
});
