import * as path from 'node:path';
import * as fs from 'node:fs';
import { runTests, downloadAndUnzipVSCode } from '@vscode/test-electron';

/**
 * Drives test/e2e/testExplorer.e2e.test.ts in a real VS Code extension host
 * (downloaded/cached under .vscode-test/, gitignored) against a real Oracle
 * instance — see docker-compose.yml / test/integration's own docs for how
 * to get one running locally, and .github/workflows/e2e.yml for CI. Needs
 * `npm run pretest:e2e` (esbuild-bundles the test file, since the extension
 * host loads it via its own require(), not ts-node) to have run first;
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

    await runTests({
        vscodeExecutablePath,
        extensionDevelopmentPath: repoRoot,
        extensionTestsPath,
        launchArgs: [workspaceDir, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-extensions']
    });
}

main().catch((err) => {
    console.error('e2e run failed:', err);
    process.exit(1);
});
