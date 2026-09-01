import { Connection } from 'oracledb';
import * as fs from 'node:fs';
import * as path from 'node:path';

const FIXTURE_SQL = fs.readFileSync(path.join(__dirname, 'fixture.sql'), 'utf8');
const SNIPPETS_FIXTURE_SQL = fs.readFileSync(path.join(__dirname, 'snippetsFixture.sql'), 'utf8');

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
