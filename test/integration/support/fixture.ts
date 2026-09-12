import { Connection } from 'oracledb';
import * as fs from 'node:fs';
import * as path from 'node:path';

const FIXTURE_SQL = fs.readFileSync(path.join(__dirname, 'fixture.sql'), 'utf8');
const SNIPPETS_FIXTURE_SQL = fs.readFileSync(path.join(__dirname, 'snippetsFixture.sql'), 'utf8');
const XSS_FIXTURE_SQL = fs.readFileSync(path.join(__dirname, 'xssFixture.sql'), 'utf8');

/** Splits a sqlplus-style script on "/" terminator lines, like the docker init scripts do. */
function splitBlocks(sql: string): string[] {
    return sql
        .split(/^\s*\/\s*$/m)
        .map((b) => b.trim())
        .filter((b) => b.length > 0);
}

export const FIXTURE_OWNER_OBJECT = 'TEST_CALC_PKG';

export async function installFixture(conn: Connection): Promise<void> {
    for (const block of splitBlocks(FIXTURE_SQL)) {
        await conn.execute(block);
    }
}

export const SNIPPETS_FIXTURE_OWNER_OBJECT = 'TEST_SNIPPETS_PKG';

export async function installSnippetsFixture(conn: Connection): Promise<void> {
    for (const block of splitBlocks(SNIPPETS_FIXTURE_SQL)) {
        await conn.execute(block);
    }
}

/**
 * The literal "</script><script>...</script>" payload xssFixture.sql embeds
 * as both a quoted-identifier package name and a source comment. Shared
 * here so coverage.test.ts's assertion and the fixture's own source text
 * cannot silently drift apart from each other.
 */
export const XSS_PAYLOAD = '</script><script>window.__pwned=1</script>';
export const XSS_TEST_PATH = 'test_xss_pkg.test_calls_payload_pkg';

export async function installXssFixture(conn: Connection): Promise<void> {
    for (const block of splitBlocks(XSS_FIXTURE_SQL)) {
        await conn.execute(block);
    }
}
