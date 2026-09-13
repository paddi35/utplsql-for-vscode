import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { UtplsqlContext } from '../../../src/testing/model';
import { runTests as runControllerTests } from '../../../src/testing/runHandler';

/**
 * Discovery/caching cases from the agent that fixed issues #17, #22 and #27
 * (merged into main as fix/15-17-22-27-caching) — drafted by that agent
 * without being able to run any of it either, and adapted here to this
 * file's own conventions/mechanics after verifying its assumptions against
 * the actual (now-merged) src/testing/controller.ts, objectTypeCache.ts and
 * singleFlight.ts. Issue #15 (the cross-profile dba_/all_ cache) is folded
 * into coverageCases.ts instead, per that agent's own note that it overlaps
 * the coverage work more than this "tree discovery mechanics" group.
 *
 * #17/#22 both need a *cold* cache to be meaningful: suiteRowsCache and
 * objectTypeCache (controller.ts) are keyed by connection-profile name, but
 * by the time any case in testExplorer.e2e.test.ts's own `cases` array runs,
 * the default profile's caches are already warm (run()'s setup resolves
 * root -> schema before any case starts). Registering a second connection
 * profile pointed at the exact same schema — same trick issue #12's
 * TNS-alias case and issue #11's perf-settings case already use elsewhere in
 * this suite for an unrelated reason — gives both cases a genuinely cold
 * cache namespace without disturbing the default profile's already-resolved
 * `pkg`/`schema` any other case depends on.
 *
 * Must run before sourceIndexCases.ts's cases: #22's assertion depends on
 * TEST_CALC_PKG still having no local workspace file (so materializing its
 * tree still needs a virtual-source object-type lookup at all) — the same
 * precondition sourceIndexCases.ts's own first case then goes on to change
 * for the rest of the suite by writing test_calc_pkg.pkb to disk.
 */

function findChild(collection: vscode.TestItemCollection, label: string): vscode.TestItem | undefined {
    let found: vscode.TestItem | undefined;
    collection.forEach((item) => {
        if (item.label === label) {
            found = item;
        }
    });
    return found;
}

async function resolveItem(controller: vscode.TestController, item: vscode.TestItem | undefined): Promise<void> {
    await controller.resolveHandler?.(item);
}

function collectSubtree(item: vscode.TestItem, out: Map<string, vscode.TestItem>): void {
    item.children.forEach((child) => {
        out.set(child.id, child);
        collectSubtree(child, out);
    });
}

/** Wraps ctx.output.appendLine for the duration of `fn`, the only way to observe what a real vscode.OutputChannel was told to log (no read-back API exists). */
async function withOutputTap<T>(ctx: UtplsqlContext, fn: (lines: string[]) => Promise<T>): Promise<T> {
    const lines: string[] = [];
    const originalAppendLine = ctx.output.appendLine.bind(ctx.output);
    ctx.output.appendLine = (value: string): void => {
        lines.push(value);
        originalAppendLine(value);
    };
    try {
        return await fn(lines);
    } finally {
        ctx.output.appendLine = originalAppendLine;
    }
}

async function withPerfEnabled<T>(fn: () => Promise<T>): Promise<T> {
    const cfg = vscode.workspace.getConfiguration('utplsql');
    const previous = cfg.get<boolean>('perf.enabled');
    await cfg.update('perf.enabled', true, vscode.ConfigurationTarget.Global);
    try {
        return await fn();
    } finally {
        await cfg.update('perf.enabled', previous, vscode.ConfigurationTarget.Global);
    }
}

/** Recursively resolves+searches by label, since the exact tree shape a --%suitepath(a.b.c) annotation produces (one grouping level per segment, or something flatter) is not something this environment can verify against a live instance. Returns the path from `item` (inclusive) down to the match. */
async function findLabelDeep(controller: vscode.TestController, item: vscode.TestItem, label: string, trail: vscode.TestItem[] = []): Promise<vscode.TestItem[] | undefined> {
    const here = [...trail, item];
    if (item.label === label) {
        return here;
    }
    if (item.canResolveChildren && item.children.size === 0) {
        await controller.resolveHandler?.(item);
    }
    const children: vscode.TestItem[] = [];
    item.children.forEach((c) => children.push(c));
    for (const child of children) {
        const found = await findLabelDeep(controller, child, label, here);
        if (found) {
            return found;
        }
    }
    return undefined;
}

export function buildDiscoveryCachingCases(
    ctx: UtplsqlContext,
    schema: vscode.TestItem,
    connInfo: { user: string; password: string; connectString: string; owner: string },
    packageLabel: string
): Array<[string, () => Promise<void>]> {
    const CACHE_PROFILE_NAME = 'e2e-test-cache';
    let cacheSchema: vscode.TestItem | undefined;

    async function registerCacheProfileOnce(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('utplsql');
        const previousConnections = cfg.get<Array<Record<string, unknown>>>('connections', []);
        if (previousConnections.some((c) => c.name === CACHE_PROFILE_NAME)) {
            return;
        }
        await cfg.update(
            'connections',
            [...previousConnections, { name: CACHE_PROFILE_NAME, user: connInfo.user, connectString: connInfo.connectString, defaultSchema: connInfo.owner }],
            vscode.ConfigurationTarget.Global
        );
        await ctx.secrets.store(`utplsql.password.${CACHE_PROFILE_NAME}`, connInfo.password);
    }

    /**
     * Issue #17: fetchSuiteRows (controller.ts) used to cache only the
     * *resolved* getSuitesInfo result, so two resolveHandler(root) calls
     * that both arrive before the first one finishes each started their own
     * full round trip. Two concurrent resolves of a freshly-registered
     * profile's root — a cold suiteRowsCache entry — should single-flight
     * into exactly one getSuitesInfo call regardless.
     */
    async function testSingleFlightedGetSuitesInfo(): Promise<void> {
        await registerCacheProfileOnce();
        await withPerfEnabled(() =>
            withOutputTap(ctx, async (lines) => {
                await resolveItem(ctx.controller, undefined);
                const cacheRoot = findChild(ctx.controller.items, CACHE_PROFILE_NAME);
                assert.ok(cacheRoot, `no root TestItem for '${CACHE_PROFILE_NAME}'`);

                await Promise.all([resolveItem(ctx.controller, cacheRoot!), resolveItem(ctx.controller, cacheRoot!)]);

                cacheSchema = findChild(cacheRoot!.children, connInfo.owner);
                assert.ok(cacheSchema, `expected the schema '${connInfo.owner}' to populate after concurrently resolving the cache-test profile's root`);

                const suitesInfoLines = lines.filter((l) => /\[perf\] getSuitesInfo/.test(l));
                assert.equal(
                    suitesInfoLines.length,
                    1,
                    `expected exactly one getSuitesInfo round trip for two concurrent resolveHandler(root) calls on a cold cache, got: ${JSON.stringify(suitesInfoLines)}`
                );
            })
        );
    }

    /**
     * Issue #22: resolveVirtualTypes/objectTypeCache used to be asked fresh
     * for every materialized tree level, even though a package's PACKAGE/
     * PACKAGE BODY answer is stable for the life of a discovery cache.
     * Running the cache-test profile's own copy of the fixture package,
     * unexpanded (ensureSubtreeResolved walks every level from schema down
     * to each test in one call), should need at most one getPackageObjectTypes
     * round trip for the whole owner — not one per level. Depends on
     * testSingleFlightedGetSuitesInfo above having already discovered
     * `cacheSchema`.
     */
    async function testObjectTypeCachePrimedOncePerOwner(): Promise<void> {
        await registerCacheProfileOnce();
        assert.ok(cacheSchema, 'expected the cache-test profile schema to already be discovered by the single-flight case above');

        await withPerfEnabled(() =>
            withOutputTap(ctx, async (lines) => {
                await resolveItem(ctx.controller, cacheSchema!);
                const cachePkg = findChild(cacheSchema!.children, packageLabel);
                assert.ok(cachePkg, `fixture package '${packageLabel}' not found via the cache-test profile`);
                assert.equal(cachePkg!.children.size, 0, "the cache-test profile's package must not already be individually expanded — that would invalidate this case");

                const cts = new vscode.CancellationTokenSource();
                try {
                    await runControllerTests(ctx, new vscode.TestRunRequest([cachePkg!]), cts.token);
                } finally {
                    cts.dispose();
                }

                const afterRun = new Map<string, vscode.TestItem>();
                collectSubtree(cachePkg!, afterRun);
                assert.ok(
                    [...afterRun.values()].some((i) => i.label === 'adds two numbers correctly'),
                    'expected every test under the cache-test profile package to still resolve to a TestItem'
                );

                const objectTypeLines = lines.filter((l) => /\[perf\] getPackageObjectTypes/.test(l));
                assert.ok(
                    objectTypeLines.length <= 1,
                    `expected at most one getPackageObjectTypes round trip for the whole owner (batched across every resolved level, or zero if a level never needed a virtual-source lookup), got: ${JSON.stringify(objectTypeLines)}`
                );
            })
        );
    }

    /**
     * Issue #27: a --%suitepath(...) grouping node's item_type
     * (UT_LOGICAL_SUITE) used to be silently cast into the same
     * SuiteInfoRow['itemType'] union as UT_SUITE/UT_SUITE_CONTEXT/UT_TEST.
     * test_suitepath_pkg (fixture.sql) exists purely to give the a.b.c
     * suitepath group a real leaf (test_in_group) to reach and run.
     */
    async function testSuitepathGroupMaterializesAndRuns(): Promise<void> {
        const leafLabel = 'exists only to give the a.b.c suitepath group a real leaf';
        const trail = await findLabelDeep(ctx.controller, schema, leafLabel);
        assert.ok(trail, `expected to find a TestItem labeled '${leafLabel}' somewhere under the schema`);
        assert.ok(
            trail!.length >= 3,
            `expected the leaf to be reachable through at least one --%suitepath grouping container between the schema and the leaf, got a ${trail!.length}-deep path: ${trail!.map((i) => i.label).join(' > ')}`
        );

        const groupContainer = trail![1];
        const cts = new vscode.CancellationTokenSource();
        try {
            await assert.doesNotReject(
                runControllerTests(ctx, new vscode.TestRunRequest([groupContainer]), cts.token),
                'expected running the a.b.c suitepath group node to complete without throwing'
            );
        } finally {
            cts.dispose();
        }

        const stillThere = await findLabelDeep(ctx.controller, schema, leafLabel);
        assert.ok(stillThere, 'expected the leaf test to still exist as a TestItem after running its suitepath group — the public Testing API has no way to read back pass/fail status, so this is the same floor every other case in this suite checks');
    }

    return [
        ['fetchSuiteRows single-flights concurrent resolveHandler(root) calls into one getSuitesInfo round trip (issue #17)', testSingleFlightedGetSuitesInfo],
        ["resolveVirtualTypes primes an owner's object-type cache once, not once per resolved tree level (issue #22)", testObjectTypeCachePrimedOncePerOwner],
        ['a --%suitepath grouping node (UT_LOGICAL_SUITE) materializes its leaf and runs like any other suite (issue #27)', testSuitepathGroupMaterializesAndRuns]
    ];
}
