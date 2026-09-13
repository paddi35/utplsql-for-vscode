import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getTestPool, closeTestPool } from '../integration/support/db';
import { installFixture, installXssFixture } from '../integration/support/fixture';
import { ExtensionApi } from '../../src/extension';
import { UtplsqlContext } from '../../src/testing/model';
import { runTests as runControllerTests } from '../../src/testing/runHandler';
import { buildSourceIndexWatcherCases } from './support/sourceIndexCases';
import { buildCoverageCases } from './support/coverageCases';
import { buildDiscoveryCachingCases } from './support/discoveryCachingCases';

const EXTENSION_ID = 'paddi35.utplsql-for-vscode';
const PROFILE_NAME = 'e2e-test';
const PACKAGE_LABEL = 'utplsql-vsc integration fixture';
const TNS_PROFILE_NAME = 'e2e-test-tns-scope';
/** Must match test/e2e/runTests.ts's TNS_ALIAS_ISSUE_12 — see that file's doc comment. */
const TNS_ALIAS_ISSUE_12 = 'UTPLSQL_E2E_TNS_ALIAS';

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
 * Two honest, distinct claims, not one — worth separating because it's easy
 * to overstate what this covers:
 *
 * 1. groupRequest's ensureSubtreeResolved runs regardless of RunTestsOptions
 *    (tags aren't even passed to groupRequest — only to runOneProfile, for
 *    the actual a_tags SQL). So a tag-scoped run on a package that was
 *    never individually expanded needs the exact same lazy-resolution fix
 *    as an untagged one; this case runs first (see the `cases` list below),
 *    while `pkg` still has 0 children, to actually exercise that. It
 *    overlaps with testPackageAttachesResultsAndSurvivesReResolution below
 *    on that front by design (defense in depth), not because it's proving
 *    something novel about resolution.
 * 2. What *is* novel here: this is the only case that runs a_tags against a
 *    real reporter end-to-end. buildProduceSql's unit tests already assert
 *    a_tags is bound as a plain varchar2 (not a ut_varchar2_list — see the
 *    CHANGELOG entry for why that distinction mattered); this confirms
 *    that SQL is also accepted and handled correctly by a live instance,
 *    and that runOneProfile's "mark anything a_tags left unfinalized as
 *    skipped" path (see its own doc comment) doesn't hang or throw.
 *
 * What this does *not* prove: that test_slow (the only test tagged 'slow')
 * is the only one that actually ran, or that the others were specifically
 * marked skipped — the public Testing API has no way to read a TestItem's
 * run status back out, only whether the TestItem itself exists. The label
 * assertions below are a floor (the tree didn't break), not a check on
 * a_tags' actual scoping behavior.
 */
async function testTagScopedRunResolvesAnUnexpandedPackage(ctx: UtplsqlContext, pkg: vscode.TestItem): Promise<void> {
    assert.equal(pkg.children.size, 0, 'fixture package must not already be individually expanded — that would invalidate this case');

    const cts = new vscode.CancellationTokenSource();
    try {
        await runOnPackage(ctx, pkg, cts.token, ['slow']);
    } finally {
        cts.dispose();
    }

    const after = new Map<string, vscode.TestItem>();
    collectSubtree(pkg, after);
    assert.ok(after.size > 0, 'a tag-scoped run on an unexpanded package must still resolve its subtree, the same as an untagged run');
    const labels = [...after.values()].map((i) => i.label);
    assert.ok(labels.includes('sleeps briefly to exercise realtime event streaming'), "the tagged test's TestItem should exist after a tag-scoped run");
    assert.ok(labels.includes('adds two numbers correctly'), "an untagged test's TestItem must still exist after a tag-scoped run");
}

/**
 * Reproduces the exact regression the lazy-tree-materialization fixes
 * addressed (see docs/performance.md's Findings): running a package that
 * was never individually expanded used to report zero results for any of
 * its tests (no matching TestItem for the streamed pre-test/post-test
 * events to attach status to), and re-resolving an already-run node used to
 * discard the TestItem objects a run had just attached results to.
 *
 * Deliberately does *not* assert `pkg.children.size === 0` beforehand: the
 * tag-scoped case above already runs first specifically to exercise that
 * precondition (see its own doc comment for why), and this case's actual
 * claims — every test gets a TestItem, re-resolving keeps the same objects
 * — hold regardless of what state `pkg` starts in.
 */
async function testPackageAttachesResultsAndSurvivesReResolution(ctx: UtplsqlContext, pkg: vscode.TestItem): Promise<void> {
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
 * Issue #23: runOneProfile() (src/testing/runHandler.ts) used to write two
 * unconditional lines to the output channel on *every* run regardless of
 * utplsql.trace — one embedding every selected TestItem.id, the other the
 * complete generated produce SQL — which at the documented
 * 1000-package/~15,000-test fixture scale was a real, measured hitch (see
 * docs/performance.md). test/unit/runLogging.test.ts proves the actual bound
 * on the pure formatters at that scale directly, without a database; this
 * e2e fixture only has one small package, so it cannot reproduce a
 * megabyte-sized line here. What it *can* check, against a real
 * vscode.OutputChannel in a real extension host, is that a normal
 * (untraced) run doesn't write either detailed line at all, and that the
 * run still completes normally.
 *
 * "Completes normally" is checked the same way
 * testPackageAttachesResultsAndSurvivesReResolution does — every expected
 * test's TestItem exists afterward — rather than by reading back a
 * pass/failed/skipped status: the public Testing API has no way to do the
 * latter (see testTagScopedRunResolvesAnUnexpandedPackage's doc comment
 * above); this file has consistently treated "the TestItem exists" as the
 * available floor rather than working around that gap, and this case is no
 * different.
 *
 * vscode.OutputChannel has no public read-back API either — appendLine() is
 * fire-and-forget from the extension's own point of view, the same
 * limitation in spirit. Shadowing ctx.output's own appendLine for the
 * duration of this one case (restored in `finally`, real output still
 * forwarded to the real channel) is the only way to observe from outside
 * runOneProfile what actually got written.
 *
 * Runs last in the `cases` list below, after `pkg` has already been resolved
 * by the earlier cases — deliberately not asserting an unexpanded starting
 * state here (see testTagScopedRunResolvesAnUnexpandedPackage for the case
 * that does), since this case's concern — output-channel volume and the run
 * still completing — is independent of whether ensureSubtreeResolved has
 * any actual resolving left to do.
 */
async function testUntracedRunKeepsOutputChannelSmall(ctx: UtplsqlContext, pkg: vscode.TestItem): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('utplsql');
    const previousTrace = cfg.get<boolean>('trace');
    await cfg.update('trace', false, vscode.ConfigurationTarget.Global);

    const originalAppendLine = ctx.output.appendLine.bind(ctx.output);
    const lines: string[] = [];
    ctx.output.appendLine = (value: string): void => {
        lines.push(value);
        originalAppendLine(value);
    };

    const cts = new vscode.CancellationTokenSource();
    try {
        await runOnPackage(ctx, pkg, cts.token);
    } finally {
        cts.dispose();
        ctx.output.appendLine = originalAppendLine;
        await cfg.update('trace', previousTrace, vscode.ConfigurationTarget.Global);
    }

    assert.ok(lines.length > 0, 'expected the run to write at least its unconditional summary line to the output channel');
    assert.ok(
        !lines.some((l) => l.includes('run paths for')),
        `utplsql.trace is off — the detailed per-item run-paths line must not appear in the output channel, got: ${JSON.stringify(lines)}`
    );
    assert.ok(
        !lines.some((l) => l.includes('produce SQL:')),
        `utplsql.trace is off — the produce SQL must not appear in the output channel, got: ${JSON.stringify(lines)}`
    );
    // Order-of-magnitude, not a tight bound — test/unit/runLogging.test.ts
    // covers the actual bound at 10,000 items. This fixture only has one
    // package with a handful of tests, so there is no megabyte-scale line to
    // reproduce here; this just confirms a real OutputChannel in a real
    // extension host isn't fed anything unexpectedly large for an ordinary
    // small run.
    const totalChars = lines.reduce((sum, l) => sum + l.length, 0);
    assert.ok(
        totalChars < 5000,
        `expected the untraced run's total output-channel content to stay small, got ${totalChars} characters across ${lines.length} line(s): ${JSON.stringify(lines)}`
    );

    const after = new Map<string, vscode.TestItem>();
    collectSubtree(pkg, after);
    assert.ok(
        [...after.values()].some((i) => i.label === 'adds two numbers correctly'),
        'the untraced run should still resolve/attach every test normally, not just avoid over-logging'
    );
}

/**
 * Regression case for issue #12: resolveTnsAdminDir() (src/db/tnsnames.ts)
 * used to fall back to sqldeveloper.connections.tnsConfiguration.path via
 * plain get(), which does not distinguish a global value from a workspace
 * one. That key belongs to a different extension (Oracle SQL Developer for
 * VSCode), whose declared scope this extension does not control, so a
 * workspace's own .vscode/settings.json could set it — redirecting
 * oracledb's configDir, and with it which tnsnames.ora a TNS-alias connect
 * string resolves against, at a directory the workspace chose. Because the
 * pool is then opened with the profile's real stored password, that is
 * silent credential exfiltration to whatever host the poisoned
 * tnsnames.ora names, triggered merely by opening the Testing view on a
 * trusted-looking workspace.
 *
 * This reproduces exactly that shape: TNS_ADMIN (an environment variable, so
 * the workspace cannot touch it — see runTests.ts's writeLegitTnsAdminDir)
 * legitimately resolves TNS_ALIAS_ISSUE_12 to the real test container,
 * while a workspace-scoped sqldeveloper.connections.tnsConfiguration.path
 * redefines the *same* alias to an unroutable address (192.0.2.0/24 is
 * reserved for documentation by RFC 5737 and guaranteed never to route). A
 * profile whose connectString is the bare alias should still resolve
 * through TNS_ADMIN and discover its schema/package normally; before the
 * fix, get() would have returned the poisoned workspace value first and
 * this would instead fail (or hang) trying to reach the unroutable host.
 */
async function testWorkspaceScopedSqlDeveloperTnsPathIsIgnored(ctx: UtplsqlContext, user: string, password: string, owner: string): Promise<void> {
    const poisonedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utplsql-e2e-poisoned-tns-'));
    try {
        const poisonedTnsnames =
            `${TNS_ALIAS_ISSUE_12} =\n` +
            `  (DESCRIPTION =\n` +
            `    (ADDRESS = (PROTOCOL = TCP)(HOST = 192.0.2.1)(PORT = 1521))\n` +
            `    (CONNECT_DATA = (SERVICE_NAME = POISON))\n` +
            `  )\n`;
        fs.writeFileSync(path.join(poisonedDir, 'tnsnames.ora'), poisonedTnsnames, 'utf8');

        await vscode.workspace
            .getConfiguration('sqldeveloper')
            .update('connections.tnsConfiguration.path', poisonedDir, vscode.ConfigurationTarget.Workspace);

        await vscode.workspace.getConfiguration('utplsql').update(
            'connections',
            [
                { name: PROFILE_NAME, user, connectString: process.env.UTPLSQL_IT_CONNECT_STRING ?? 'localhost:1521/FREEPDB1', defaultSchema: owner },
                { name: TNS_PROFILE_NAME, user, connectString: TNS_ALIAS_ISSUE_12, defaultSchema: owner }
            ],
            vscode.ConfigurationTarget.Global
        );
        await ctx.secrets.store(`utplsql.password.${TNS_PROFILE_NAME}`, password);

        await resolve(ctx.controller, undefined);
        const root = findChildByLabel(ctx.controller.items, TNS_PROFILE_NAME);
        assert.ok(root, `no root TestItem for profile '${TNS_PROFILE_NAME}'`);

        await resolve(ctx.controller, root);
        const schema = findChildByLabel(root.children, owner);
        assert.ok(
            schema,
            `no schema TestItem for owner '${owner}' via the TNS-alias profile — the pool likely tried to connect through the poisoned, workspace-scoped SQL Developer path instead of falling through to TNS_ADMIN`
        );

        await resolve(ctx.controller, schema);
        const pkg = findChildByLabel(schema.children, PACKAGE_LABEL);
        assert.ok(pkg, `fixture package '${PACKAGE_LABEL}' not found via the TNS-alias profile`);
    } finally {
        await vscode.workspace
            .getConfiguration('sqldeveloper')
            .update('connections.tnsConfiguration.path', undefined, vscode.ConfigurationTarget.Workspace);
        fs.rmSync(poisonedDir, { recursive: true, force: true });
    }
}

/**
 * The actual regression behind utplsql.perf.enabled/reportFile getting
 * "scope": "machine": both used to be window-scoped, so a workspace's own
 * .vscode/settings.json could turn perf tracing on and point its report
 * file anywhere on disk, including outside the workspace, and the very
 * first measure() span (materializeLevel, on any schema/path
 * resolveHandler call) would append to it. This writes exactly that
 * .vscode/settings.json shape into the already-open e2e workspace and
 * proves both halves of the fix: (b) VS Code itself never exposes the
 * workspace-level value to getConfiguration()/inspect() for a
 * machine-scoped setting -- not just hidden in the Settings UI -- and (a) a
 * real measure() span (re-resolving `schema`) never creates the outside
 * path, which follows from perf.enabled reading back as its default
 * `false` the same as if the file had never been written at all. Both
 * settings being machine-scoped is what makes this scenario fully inert
 * for a workspace-supplied config; src/perf.ts's own path validation
 * (see test/unit/perf.test.ts and test/integration/perf.test.ts) is the
 * separate belt-and-braces layer for a value that *did* come from a
 * trusted user/machine setting.
 */
async function testWorkspacePerfSettingsAreIgnored(ctx: UtplsqlContext, schema: vscode.TestItem): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'e2e workspace has no open folder to write .vscode/settings.json into');
    const vscodeDir = path.join(folder.uri.fsPath, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });
    const settingsPath = path.join(vscodeDir, 'settings.json');
    const previousSettings = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : undefined;
    const outsidePath = path.join(os.tmpdir(), `utplsql-e2e-perf-exploit-${Date.now()}.jsonl`);

    try {
        fs.writeFileSync(settingsPath, JSON.stringify({ 'utplsql.perf.enabled': true, 'utplsql.perf.reportFile': outsidePath }, null, 2));
        // VS Code's configuration service picks up an on-disk
        // .vscode/settings.json change via its file watcher asynchronously;
        // the cancellation case above waits on a comparable fixed delay for
        // a different async-VS-Code-internals reason.
        await new Promise((r) => setTimeout(r, 500));

        const inspectedEnabled = vscode.workspace.getConfiguration('utplsql').inspect<boolean>('perf.enabled');
        assert.equal(
            inspectedEnabled?.workspaceValue,
            undefined,
            'utplsql.perf.enabled must not accept a workspace-level value now that it is "scope": "machine"'
        );
        const inspectedFile = vscode.workspace.getConfiguration('utplsql').inspect<string>('perf.reportFile');
        assert.equal(
            inspectedFile?.workspaceValue,
            undefined,
            'utplsql.perf.reportFile must not accept a workspace-level value now that it is "scope": "machine"'
        );

        await resolve(ctx.controller, schema);

        assert.ok(!fs.existsSync(outsidePath), `utplsql.perf.reportFile pointed outside the workspace at '${outsidePath}' and it was still created`);
    } finally {
        if (previousSettings === undefined) {
            fs.rmSync(settingsPath, { force: true });
        } else {
            fs.writeFileSync(settingsPath, previousSettings);
        }
        fs.rmSync(outsidePath, { force: true });
    }
}

/**
 * End-to-end regression suite run against a real Oracle+utPLSQL instance and
 * a real VS Code extension host (not a mock `vscode` module) via
 * @vscode/test-electron — see test/e2e/runTests.ts for how this file is
 * launched. Covers the tree-materialization/run-resolution fixes, a
 * tag-scoped run against a real reporter, cancellation, (issue #23) that
 * an untraced run's output-channel footprint stays small, (issue #12) that
 * a workspace-scoped SQL Developer TNS path cannot redirect a credentialed
 * connection, (issue #11) that a workspace cannot turn on or redirect perf
 * instrumentation via its own .vscode/settings.json, (issue #28, via
 * support/coverageCases.ts) the runCoverage profile end to end — local-file
 * and virtual-source FileCoverage/StatementCoverage, cancellation, the
 * Cobertura reporter, the HTML report's file-instead-of-webview behaviour
 * (issue #13) including an XSS-payload passthrough case, and (issue #15)
 * cross-profile dba_/all_ cache ordering — (issues #17/#22/#27, via
 * support/discoveryCachingCases.ts) single-flighted suite-row discovery,
 * per-owner object-type cache priming, and the UT_LOGICAL_SUITE suitepath
 * grouping node, and (issues #20/#26, via support/sourceIndexCases.ts)
 * SourceIndex's per-URI debounce and its FileSystemWatcher; see
 * docs/performance.md's Findings/Open follow-ups.
 */
export async function run(): Promise<void> {
    const pool = await getTestPool();
    const setupConn = await pool.getConnection();
    try {
        await installFixture(setupConn);
        // Coverage's HTML-report XSS case (coverageCases.ts) needs
        // test_xss_pkg discoverable from the very first schema resolve
        // below, the same as installFixture's own packages.
        await installXssFixture(setupConn);
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

        const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(workspaceUri, 'expected the e2e run to open exactly one workspace folder (see runTests.ts)');

        // Order matters: the tag-scoped case needs `pkg` to still be
        // unexpanded (0 children) when it starts, so it must run first —
        // see its own doc comment. The coverage and discovery-caching
        // groups don't depend on pkg's starting state, but the
        // discovery-caching group (issue #22) does depend on test_calc_pkg
        // still having no local workspace file, so both new groups must
        // come before the sourceIndexCases.ts cases, which are appended
        // last because their final case deletes test_calc_pkg.pkb from
        // disk (see that file's own doc comment for why they, in turn, must
        // run in the order they're built in).
        const connInfo = { user, password, connectString, owner };
        const cases: Array<[string, () => Promise<void>]> = [
            ['a tag-scoped run resolves an unexpanded package', () => testTagScopedRunResolvesAnUnexpandedPackage(ctx, pkg!)],
            ['running a package attaches results to every test and survives re-resolution', () => testPackageAttachesResultsAndSurvivesReResolution(ctx, pkg!)],
            ['cancelling a run leaves the pool/tree usable for the next one', () => testCancellationLeavesStateUsable(ctx, pkg!)],
            ['an untraced run keeps the output channel small', () => testUntracedRunKeepsOutputChannelSmall(ctx, pkg!)],
            [
                'a workspace-scoped SQL Developer TNS path is ignored in favour of TNS_ADMIN (issue #12)',
                () => testWorkspaceScopedSqlDeveloperTnsPathIsIgnored(ctx, user, password, owner)
            ],
            ['a workspace-supplied utplsql.perf.* setting is ignored (scope: machine)', () => testWorkspacePerfSettingsAreIgnored(ctx, schema!)],
            ...buildCoverageCases(ctx, schema!, pkg!, workspaceUri!, connInfo, PACKAGE_LABEL),
            ...buildDiscoveryCachingCases(ctx, schema!, connInfo, PACKAGE_LABEL),
            ...buildSourceIndexWatcherCases(ctx, pkg!, workspaceUri!)
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
