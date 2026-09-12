import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { listTnsAliases, pickTnsAdminDir } from '../../src/db/tnsAdminDir';

function tnsEntry(alias: string, host: string, port: number, serviceName: string): string {
    return `${alias} =\n  (DESCRIPTION =\n    (ADDRESS = (PROTOCOL = TCP)(HOST = ${host})(PORT = ${port}))\n    (CONNECT_DATA = (SERVICE_NAME = ${serviceName}))\n  )\n`;
}

async function writeTnsnamesDir(contents: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'utplsql-tnsnames-'));
    await fs.writeFile(path.join(dir, 'tnsnames.ora'), contents, 'utf8');
    return dir;
}

/**
 * Filesystem-level companion to test/unit/tnsAdminDir.test.ts: that suite
 * pins pickTnsAdminDir()'s scope-selection logic against plain object
 * literals (no disk access at all); this suite pins the parts that
 * actually touch disk — oracledb's own tnsnames.ora parsing, and that a
 * workspace-scoped SQL Developer path's aliases genuinely never reach the
 * alias list once pickTnsAdminDir has excluded that directory.
 *
 * Issue #12's own test-case list frames the second case here as "assert
 * that alias is never offered by pickConnectString()'s TNS list" —
 * pickConnectString() (src/commands/index.ts) is a private, unexported
 * function in a file that is out of scope for this change (owned by
 * another in-flight edit), and it is a thin QuickPick wrapper that does
 * nothing but `if (tnsDir) { listTnsAliases(tnsDir) }` with
 * resolveTnsAdminDir()'s result as tnsDir. Exercising that exact pair of
 * calls — pickTnsAdminDir() standing in for resolveTnsAdminDir()'s vscode
 * plumbing, then the real listTnsAliases() — gives the same guarantee
 * pickConnectString() would, without needing to export or modify it.
 *
 * Both imports come from tnsAdminDir.ts rather than tnsnames.ts, which
 * re-exports them: tnsnames.ts also imports 'vscode' (for
 * resolveTnsAdminDirWithSource()'s own plumbing), which is not resolvable
 * outside the extension host, and this suite runs the same way the rest of
 * test/integration does — plain mocha/ts-node, no @vscode/test-electron.
 */
describe('tnsnames filesystem resolution [integration]', () => {
    it("reads back the single alias defined in a directory's tnsnames.ora", async () => {
        const dir = await writeTnsnamesDir(tnsEntry('LEGIT_ALIAS', 'legit-host.example', 1521, 'FREEPDB1'));
        try {
            assert.deepEqual(await listTnsAliases(dir), ['LEGIT_ALIAS']);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it('resolves to the global SQL Developer directory and its alias, never the workspace-scoped one', async () => {
        const legitDir = await writeTnsnamesDir(tnsEntry('GOOD_ALIAS', 'good-host.example', 1521, 'FREEPDB1'));
        const poisonedDir = await writeTnsnamesDir(tnsEntry('POISONED_ALIAS', 'attacker.example', 1521, 'X'));
        try {
            // Prerequisite check: if the poisoned fixture didn't actually
            // define its own alias, "it never shows up" below would pass
            // for the wrong reason.
            assert.deepEqual(await listTnsAliases(poisonedDir), ['POISONED_ALIAS']);

            const resolution = pickTnsAdminDir({
                own: undefined,
                sqldevInspect: { globalValue: legitDir, workspaceValue: poisonedDir },
                envTnsAdmin: undefined
            });
            assert.equal(resolution.dir, legitDir);

            const aliases = await listTnsAliases(resolution.dir);
            assert.deepEqual(aliases, ['GOOD_ALIAS']);
            assert.ok(!aliases.includes('POISONED_ALIAS'), "the workspace-scoped directory's alias must never be offered");
        } finally {
            await fs.rm(legitDir, { recursive: true, force: true });
            await fs.rm(poisonedDir, { recursive: true, force: true });
        }
    });

    it('never selects a SQL Developer directory that exists only as a workspace value, so its alias is never even looked up', async () => {
        const poisonedDir = await writeTnsnamesDir(tnsEntry('POISONED_ALIAS', 'attacker.example', 1521, 'X'));
        try {
            const resolution = pickTnsAdminDir({ own: undefined, sqldevInspect: { workspaceValue: poisonedDir }, envTnsAdmin: undefined });
            assert.equal(resolution.dir, undefined);
            // pickConnectString() only calls listTnsAliases when
            // resolveTnsAdminDir() returns a directory (`if (tnsDir) {
            // ... }`) — with resolution.dir undefined here, that call site
            // is skipped entirely, so POISONED_ALIAS is structurally
            // unreachable, not merely absent from a returned list.
        } finally {
            await fs.rm(poisonedDir, { recursive: true, force: true });
        }
    });

    it('returns no aliases for a directory with no tnsnames.ora, rather than throwing', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'utplsql-tnsnames-empty-'));
        try {
            assert.deepEqual(await listTnsAliases(dir), []);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it('returns no aliases for a directory whose tnsnames.ora is malformed, rather than throwing', async () => {
        const dir = await writeTnsnamesDir('this is not a valid tnsnames.ora file at all {{{\n=== garbage ===\n');
        try {
            assert.deepEqual(await listTnsAliases(dir), []);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});
