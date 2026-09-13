import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { runTests, downloadAndUnzipVSCode } from '@vscode/test-electron';

/**
 * Alias name shared with testExplorer.e2e.test.ts's TNS-admin-scope
 * regression case (issue #12): the tnsnames.ora written by
 * writeLegitTnsAdminDir() below defines it pointing at the real test
 * container, and that test's poisoned, workspace-scoped tnsnames.ora
 * redefines the *same* alias pointing nowhere routable. Kept as a literal
 * in both files rather than a shared constant module — this file runs via
 * tsx, the other is esbuild-bundled independently of it (see
 * pretest:e2e) — a literal is simpler to keep in sync than a module neither
 * file otherwise needs.
 */
const TNS_ALIAS_ISSUE_12 = 'UTPLSQL_E2E_TNS_ALIAS';

/**
 * Writes a real tnsnames.ora resolving TNS_ALIAS_ISSUE_12 to the same
 * container testExplorer.e2e.test.ts's main profile reaches via an
 * Easy-Connect string, and returns its directory. This is handed to the
 * extension host only via the TNS_ADMIN environment variable (never a
 * vscode setting) specifically because a workspace cannot set process
 * environment variables — issue #12's fix makes the SQL Developer fallback
 * setting equally untouchable by a workspace, but TNS_ADMIN already was,
 * which is what makes it the right "legitimate" source to contrast a
 * poisoned, workspace-scoped one against in that regression case. Without
 * some source the workspace cannot reach, that case would have no way to
 * tell "ignored the poisoned value and fell through" apart from "cannot
 * resolve the alias at all".
 */
function writeLegitTnsAdminDir(): string {
    const host = process.env.UTPLSQL_IT_HOST ?? 'localhost';
    const port = process.env.UTPLSQL_IT_PORT ?? '1521';
    const service = process.env.UTPLSQL_IT_SERVICE ?? 'FREEPDB1';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utplsql-e2e-tns-admin-'));
    const tnsnames = `${TNS_ALIAS_ISSUE_12} =\n  (DESCRIPTION =\n    (ADDRESS = (PROTOCOL = TCP)(HOST = ${host})(PORT = ${port}))\n    (CONNECT_DATA = (SERVICE_NAME = ${service}))\n  )\n`;
    fs.writeFileSync(path.join(dir, 'tnsnames.ora'), tnsnames, 'utf8');
    return dir;
}

/**
 * Drives test/e2e/testExplorer.e2e.test.ts in a real VS Code extension host
 * (downloaded/cached under .vscode-test/, gitignored) against a real Oracle
 * instance — see docker-compose.yml / test/integration's own docs for how
 * to get one running locally, and .github/workflows/e2e.yml for CI. Needs
 * `npm run pretest:e2e` (esbuild-bundles the test file, since the extension
 * host loads it via its own require(), not tsx) to have run first;
 * `npm run test:e2e` does this automatically via the matching pretest hook.
 */
async function main(): Promise<void> {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const extensionTestsPath = path.join(repoRoot, 'test', 'e2e', 'out', 'testExplorer.e2e.test.js');
    if (!fs.existsSync(extensionTestsPath)) {
        throw new Error(`${extensionTestsPath} does not exist — run "npm run pretest:e2e" first (test:e2e does this automatically).`);
    }

    const vscodeExecutablePath = await downloadAndUnzipVSCode('stable');
    const workspaceDir = path.join(repoRoot, 'test', 'e2e', 'out', 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    const legitTnsAdminDir = writeLegitTnsAdminDir();

    await runTests({
        vscodeExecutablePath,
        extensionDevelopmentPath: repoRoot,
        extensionTestsPath,
        extensionTestsEnv: { TNS_ADMIN: legitTnsAdminDir },
        launchArgs: [workspaceDir, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-extensions']
    });
}

main().catch((err) => {
    console.error('e2e run failed:', err);
    process.exit(1);
});
