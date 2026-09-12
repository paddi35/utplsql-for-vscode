import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { getTestPool, closeTestPool } from '../integration/support/db';
import { installFixture } from '../integration/support/fixture';
import { ExtensionApi } from '../../src/extension';
import { runTests as runControllerTests } from '../../src/testing/runHandler';

const EXTENSION_ID = 'paddi35.utplsql-for-vscode';
const PROFILE_NAME = 'e2e-test';

function findChildByLabel(collection: vscode.TestItemCollection, label: string): vscode.TestItem | undefined {
    let found: vscode.TestItem | undefined;
    collection.forEach((item) => {
        if (item.label === label) {
            found = item;
        }
    });
    return found;
}

function collectSubtree(item: vscode.TestItem, out: Map<string, vscode.TestItem>): void {
    item.children.forEach((child) => {
        out.set(child.id, child);
        collectSubtree(child, out);
    });
}

async function resolve(controller: vscode.TestController, item: vscode.TestItem | undefined): Promise<void> {
    await controller.resolveHandler?.(item);
}

/**
 * End-to-end regression test for the tree-materialization/run-resolution
 * fixes described in docs/performance.md's Findings section, run against a
 * real Oracle+utPLSQL instance and a real VS Code extension host (not a
 * mock `vscode` module) via @vscode/test-electron — see test/e2e/runTests.ts
 * for how this file is launched.
 *
 * It reproduces exactly the scenario that used to fail before those fixes:
 * a package that the user only expanded one level into (they've seen it in
 * the sidebar, but never opened it to see its individual tests) is run
 * directly. Before the fix, groupRequest only ever saw whatever was already
 * materialized in item.children — nothing, for an unopened package — so
 * reconcileTree's known map stayed empty and every streamed pre-test/
 * post-test event silently found no TestItem to attach status to: the run
 * completed but the Explorer and Test Results panel showed nothing for any
 * test in that package. Separately, resolveHandler used to unconditionally
 * wipe and rebuild a node's children on every resolve; since a run now
 * resolves nodes it did not create, and the editor itself may re-resolve an
 * already-resolved node (e.g. after a reload), that wipe would discard the
 * exact TestItem objects a just-finished run had attached results to.
 */
export async function run(): Promise<void> {
    const pool = await getTestPool();
    const setupConn = await pool.getConnection();
    try {
        await installFixture(setupConn);
    } finally {
        await setupConn.close();
    }

    const ext = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
    assert.ok(ext, `extension '${EXTENSION_ID}' not found — is the id in package.json still "publisher.name"?`);
    const api = await ext.activate();
    const { ctx } = api;

    const connectString = process.env.UTPLSQL_IT_CONNECT_STRING ?? 'localhost:1521/FREEPDB1';
    const user = process.env.UTPLSQL_IT_USER ?? 'ut3';
    const password = process.env.UTPLSQL_IT_PASSWORD ?? 'oracle';
    const owner = user.toUpperCase();

    await vscode.workspace
        .getConfiguration('utplsql')
        .update('connections', [{ name: PROFILE_NAME, user, connectString, defaultSchema: owner }], vscode.ConfigurationTarget.Global);
    await ctx.secrets.store(`utplsql.password.${PROFILE_NAME}`, password);

    try {
        // Discover root -> schema, exactly as the Explorer does on first
        // expand of each level. Deliberately stop at the schema: the
        // package under test must NOT be individually expanded before the
        // run below, since that's the whole point of this test.
        await resolve(ctx.controller, undefined);
        const root = findChildByLabel(ctx.controller.items, PROFILE_NAME);
        assert.ok(root, `no root TestItem for profile '${PROFILE_NAME}'`);

        await resolve(ctx.controller, root);
        const schema = findChildByLabel(root.children, owner);
        assert.ok(schema, `no schema TestItem for owner '${owner}'`);

        await resolve(ctx.controller, schema);
        const pkg = findChildByLabel(schema.children, 'utplsql-vsc integration fixture');
        assert.ok(pkg, "fixture package 'utplsql-vsc integration fixture' not found under the schema — did installFixture run?");
        assert.equal(pkg.children.size, 0, 'fixture package must not already be individually expanded — that would invalidate this test');

        const expectedTestLabels = [
            'adds two numbers correctly',
            'fails on purpose to exercise the failed run state',
            'raises an unhandled exception to exercise the errored run state',
            'disabled test to exercise the skipped run state',
            'sleeps briefly to exercise realtime event streaming'
        ];

        const cts = new vscode.CancellationTokenSource();
        try {
            await runControllerTests(ctx, new vscode.TestRunRequest([pkg]), cts.token);
        } finally {
            cts.dispose();
        }

        // The fix: every test in the package gets a real TestItem attached
        // during the run, even though the package itself was never
        // individually expanded beforehand.
        const afterRun = new Map<string, vscode.TestItem>();
        collectSubtree(pkg, afterRun);
        const afterRunLabels = [...afterRun.values()].map((i) => i.label);
        for (const label of expectedTestLabels) {
            assert.ok(afterRunLabels.includes(label), `expected a TestItem for '${label}' after running the unexpanded package, found: ${afterRunLabels.join(', ')}`);
        }
        const nestedContext = [...afterRun.values()].find((i) => i.label === 'nested');
        assert.ok(nestedContext, "expected a 'nested' context TestItem under the package");
        const nestedTest = [...nestedContext!.children].find(([, i]) => i.label === 'test nested inside a suite context');
        assert.ok(nestedTest, "expected 'test nested inside a suite context' under the nested context");

        // The other fix: re-resolving the package (what the Explorer does
        // the first time the user actually expands it, and what a run does
        // every time via ensureSubtreeResolved) must keep the same TestItem
        // objects the run just attached results to, not discard them.
        await resolve(ctx.controller, pkg);
        const afterReResolve = new Map<string, vscode.TestItem>();
        collectSubtree(pkg, afterReResolve);
        for (const [id, item] of afterRun) {
            assert.equal(afterReResolve.get(id), item, `TestItem '${id}' was replaced by re-resolving its already-run parent instead of being kept in place`);
        }
    } finally {
        await vscode.workspace.getConfiguration('utplsql').update('connections', [], vscode.ConfigurationTarget.Global);
        await closeTestPool();
    }
}
