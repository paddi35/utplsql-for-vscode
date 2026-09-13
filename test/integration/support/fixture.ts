import { Connection } from 'oracledb';
import * as fs from 'node:fs';
import * as path from 'node:path';

const FIXTURE_SQL = fs.readFileSync(path.join(__dirname, 'fixture.sql'), 'utf8');
const SNIPPETS_FIXTURE_SQL = fs.readFileSync(path.join(__dirname, 'snippetsFixture.sql'), 'utf8');
const XSS_FIXTURE_SQL = fs.readFileSync(path.join(__dirname, 'xssFixture.sql'), 'utf8');
const DEEP_TAGS_FIXTURE_SQL = fs.readFileSync(path.join(__dirname, 'deepTagsFixture.sql'), 'utf8');

/** Splits a sqlplus-style script on "/" terminator lines, like the docker init scripts do. */
function splitBlocks(sql: string): string[] {
    return sql
        .split(/^\s*\/\s*$/m)
        .map((b) => b.trim())
        .filter((b) => b.length > 0);
}

export const FIXTURE_OWNER_OBJECT = 'TEST_CALC_PKG';

/** test_suitepath_pkg's --%suitepath(...) group and object name (see fixture.sql) — issue #27's UT_LOGICAL_SUITE regression. */
export const SUITEPATH_GROUP_PATH = 'a.b.c';
export const SUITEPATH_FIXTURE_OBJECT = 'TEST_SUITEPATH_PKG';

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

/**
 * test_deep_tags_pkg's --%suitepath(...) group, --%context and its one
 * --%tags(deep_only) test (see deepTagsFixture.sql) -- issue #18's "tag
 * lives below anything materialized" regression. Only the group's own path
 * is asserted on literally (it is the annotation's argument verbatim, the
 * same convention SUITEPATH_GROUP_PATH above documents for test_suitepath_pkg);
 * the nested context's exact path segment naming (observed elsewhere in this
 * suite as "<name>_context_#<n>", e.g. test_calc_pkg's --%context(nested) ->
 * path segment "nested_context_#1") is not re-asserted here; the deep-tags
 * tests below match by item_name and tag instead, which does not depend on
 * that naming detail either way.
 */
export const DEEP_TAGS_FIXTURE_OWNER_OBJECT = 'TEST_DEEP_TAGS_PKG';
export const DEEP_TAGS_SUITEPATH_GROUP_PATH = 'deep.tags.group';
export const DEEP_TAGS_TAG = 'deep_only';
export const DEEP_TAGS_TAGGED_TEST = 'TEST_DEEP_TAGGED';
export const DEEP_TAGS_UNTAGGED_TEST = 'TEST_DEEP_UNTAGGED';

export async function installDeepTagsFixture(conn: Connection): Promise<void> {
    for (const block of splitBlocks(DEEP_TAGS_FIXTURE_SQL)) {
        await conn.execute(block);
    }
}
