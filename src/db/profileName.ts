/**
 * Pure validation for connection profile names. Kept vscode-free — the same
 * split singleFlight.ts/objectTypeCache.ts use elsewhere in this codebase —
 * so it is directly testable with plain mocha and so test/unit/ids.test.ts's
 * round-trip property test can import it without needing a fake 'vscode'
 * module the way test/unit/connections.test.ts does for the rest of
 * src/db/connections.ts (which re-exports this).
 *
 * A profile name becomes a SecretStorage key (connections.ts's
 * SECRET_PREFIX + name), an oracledb poolAlias (pool.ts's getPool), and part
 * of every TestItem.id (ids.ts: `conn:<profile>` / `conn:<profile>/schema:…`
 * / `conn:<profile>/path:…`). parseId splits an id on its *first* '/' to
 * separate the profile from the rest, so a profile name containing '/'
 * cannot round-trip — `conn:a/b` parses as profile 'a' with rest 'b', which
 * matches neither 'schema:' nor 'path:' and throws. ':' is rejected too: it
 * is the separator ids.ts uses one level down (`path:<OWNER>:<suitepath>`),
 * and is not a safe character for an oracledb poolAlias either — see
 * test/unit/ids.test.ts's round-trip guard, which is the actual property
 * these two bans exist to protect.
 */
export function validateProfileName(name: string, existingNames: readonly string[] = []): string | undefined {
    if (!name) {
        return 'Connection profile name must not be empty.';
    }
    if (name.includes('/')) {
        return "Connection profile name must not contain '/'.";
    }
    if (name.includes(':')) {
        return "Connection profile name must not contain ':'.";
    }
    if (existingNames.includes(name)) {
        return `Connection profile '${name}' already exists.`;
    }
    return undefined;
}
