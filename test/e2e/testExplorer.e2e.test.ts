import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { getTestPool, closeTestPool } from '../integration/support/db';
import { installFixture } from '../integration/support/fixture';
import { ExtensionApi } from '../../src/extension';
import { UtplsqlContext } from '../../src/testing/model';
import { runTests as runControllerTests } from '../../src/testing/runHandler';

const EXTENSION_ID = 'paddi35.utplsql-for-vscode';
const PROFILE_NAME = 'e2e-test';
const PACKAGE_LABEL = 'utplsql-vsc integration fixture';

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

async function runOnPackage(
    ctx: UtplsqlContext,
    pkg: vscode.TestItem,
    token: vscode.CancellationToken,
    tags?: string[]
): Promise<void> {
    await runControllerTests(ctx, new vscode.TestRunRequest([pkg]), token, tags ? { tags } : {});
}

/**
 * Reproduces the exact regression the lazy-tree-materialization fixes
 * addressed (see docs/performance.md's Findings): running a package that
 * was never individually expanded used to report zero results for any of
 * its tests (no matching TestItem for the streamed pre-test/post-test
 * events to attach status to), and re-resolving an already-run node used to
 * discard the TestItem objects a run had just attached results to.
 */
async function testUnexpandedPackageAttachesResults(ctx: UtplsqlContext, pkg: vscode.TestItem): Promise<void> {
    assert.equal(pkg.children.size, 0, 'fixture package must not already be individually expanded — that would invalidate this case');

    const expectedTestLabels = [
        'adds two numbers correctly',
        'fails on purpose to exercise the failed run state',
        'raises an unhandled exception to exercise the errored run state',
        'disabled test to exercise the skipped run state',
        'sleeps briefly to exercise realtime event streaming'
    ];

    const cts = new vscode.CancellationTokenSource();
    try {
        await runOnPackage(ctx, pkg, cts.token);
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

    // The other fix: re-resolving the package (what the Explorer does the
    // first time the user actually expands it, and what a run does every
    // time via ensureSubtreeResolved) must keep the same TestItem objects
    // the run just attached results to, not discard them.
    await resolve(ctx.controller, pkg);
    const afterReResolve = new Map<string, vscode.TestItem>();
    collectSubtree(pkg, afterReResolve);
    for (const [id, item] of afterRun) {
        assert.equal(afterReResolve.get(id), item, `TestItem '${id}' was replaced by re-resolving its already-run parent instead of being kept in place`);
    }
}

/**
 * `utplsql.runWithTags` (and any run with RunTestsOptions.tags) scopes
 * a_tags server-side: ut_runner only ever streams pre-/post-test events for
 * tests carrying one of the chosen tags. runOneProfile's own doc comment
 * calls this out explicitly — every enqueued item that never received a
 * terminal event (because a_tags filtered it out, or because the run was
 * cancelled — see the next case) is marked run.skipped() afterward instead
 * of being left showing as permanently "enqueued". This exercises that same
 * groupRequest -> ensureSubtreeResolved -> reconcileTree pipeline under
 * that narrower scope: only test_slow carries the 'slow' tag, so it should
 * be the only test that actually executes, but every test's TestItem must
 * still exist and be addressable afterward — a_tags narrows what runs, not
 * what the tree knows about.
 */
async function testTagFilteringLeavesUntaggedTestsAddressable(ctx: UtplsqlContext, pkg: vscode.TestItem): Promise<void> {
    const cts = new vscode.CancellationTokenSource();
    try {
        await runOnPackage(ctx, pkg, cts.token, ['slow']);
    } finally {
        cts.dispose();
    }

    const after = new Map<string, vscode.TestItem>();
    collectSubtree(pkg, after);
    const labels = [...after.values()].map((i) => i.label);
    assert.ok(labels.includes('sleeps briefly to exercise realtime event streaming'), "the tagged test's TestItem should exist after a tag-scoped run");
    assert.ok(
        labels.includes('adds two numbers correctly'),
        "an untagged test's TestItem must still exist after a tag-scoped run that never executed it — a_tags narrows what ut_runner runs, not what the tree resolves"
    );
}

/**
 * Cancelling mid-run must not hang runTests(), and must not leave the
 * connection pool or the Explorer tree in a state that breaks the next,
 * uncancelled run — the same concern test/integration/cancel.test.ts
 * verifies at the raw connection-pool level, checked here at the level
 * that actually matters to a user: does the Test Explorer keep working.
 */
async function testCancellationLeavesStateUsable(ctx: UtplsqlContext, pkg: vscode.TestItem): Promise<void> {
    const cts = new vscode.CancellationTokenSource();
    const cancelledRun = runOnPackage(ctx, pkg, cts.token);
    // test_slow's 2s dbms_session.sleep gives a wide, reliable window in
    // which the run is genuinely still streaming (not already finished)
    // when cancellation fires.
    await new Promise((resolve) => setTimeout(resolve, 300));
    cts.cancel();
    await cancelledRun; // must resolve (not hang, not throw) even when cancelled mid-stream
    cts.dispose();

    const cts2 = new vscode.CancellationTokenSource();
    try {
        await runOnPackage(ctx, pkg, cts2.token);
    } finally {
        cts2.dispose();
    }

    const after = new Map<string, vscode.TestItem>();
    collectSubtree(pkg, after);
    assert.ok(
        [...after.values()].some((i) => i.label === 'adds two numbers correctly'),
        'a normal run after a cancelled one should still attach results correctly, not leave the pool/tree unusable'
    );
}

/**
 * End-to-end regression suite run against a real Oracle+utPLSQL instance and
 * a real VS Code extension host (not a mock `vscode` module) via
 * @vscode/test-electron — see test/e2e/runTests.ts for how this file is
 * launched. Covers the tree-materialization/run-resolution fixes, plus the
 * two scenarios (tag filtering, cancellation) that share their
 * enqueued-but-never-finalized handling with those fixes; see
 * docs/performance.md's Findings/Open follow-ups.
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
        // Discover root -> schema -> the fixture package, exactly as the
        // Explorer does on first expand of each level.
        await resolve(ctx.controller, undefined);
        const root = findChildByLabel(ctx.controller.items, PROFILE_NAME);
        assert.ok(root, `no root TestItem for profile '${PROFILE_NAME}'`);

        await resolve(ctx.controller, root);
        const schema = findChildByLabel(root.children, owner);
        assert.ok(schema, `no schema TestItem for owner '${owner}'`);

        await resolve(ctx.controller, schema);
        const pkg = findChildByLabel(schema.children, PACKAGE_LABEL);
        assert.ok(pkg, `fixture package '${PACKAGE_LABEL}' not found under the schema — did installFixture run?`);

        const cases: Array<[string, () => Promise<void>]> = [
            ['running an unexpanded package attaches results to every test', () => testUnexpandedPackageAttachesResults(ctx, pkg!)],
            ['a tag-scoped run keeps untagged tests addressable', () => testTagFilteringLeavesUntaggedTestsAddressable(ctx, pkg!)],
            ['cancelling a run leaves the pool/tree usable for the next one', () => testCancellationLeavesStateUsable(ctx, pkg!)]
        ];

        const failures: string[] = [];
        for (const [name, testCase] of cases) {
            try {
                await testCase();
                console.log(`[e2e] PASS: ${name}`);
            } catch (err) {
                failures.push(name);
                console.error(`[e2e] FAIL: ${name}`, err);
            }
        }
        if (failures.length > 0) {
            throw new Error(`${failures.length}/${cases.length} e2e case(s) failed: ${failures.join('; ')}`);
        }
    } finally {
        await vscode.workspace.getConfiguration('utplsql').update('connections', [], vscode.ConfigurationTarget.Global);
        await closeTestPool();
    }
}
