import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { UtplsqlContext } from '../../../src/testing/model';
import { VIRTUAL_SOURCE_SCHEME } from '../../../src/workspace/virtualSource';

/**
 * A body-only copy of test/integration/support/fixture.sql's TEST_CALC_PKG
 * package body, written to the e2e workspace as an actual .pkb file rather
 * than only existing compiled in the DB. Bodies are trimmed to a bare
 * `ut.expect(1).to_equal(1)` — this file is never compiled or run, it only
 * needs to parse the same PACKAGE BODY / PROCEDURE declarations the real
 * fixture has, so SourceIndex can map TEST_CALC_PKG's DB-discovered rows
 * (objectName/itemName) onto it the way it would for any project that
 * checks its packages out locally instead of treating the DB as the only
 * source of truth — without a local file, resolveLocation() always misses
 * and every case below would be exercising the virtual-source fallback
 * instead of the local-file path #20/#26 are actually about.
 */
const TEST_CALC_PKG_BODY = `create or replace package body test_calc_pkg is

  procedure test_add is
  begin
    ut.expect(1).to_equal(1);
  end test_add;

  procedure test_fail_on_purpose is
  begin
    ut.expect(1).to_equal(1);
  end test_fail_on_purpose;

  procedure test_raises_error is
  begin
    ut.expect(1).to_equal(1);
  end test_raises_error;

  procedure test_disabled_case is
  begin
    ut.expect(1).to_equal(1);
  end test_disabled_case;

  procedure test_slow is
  begin
    ut.expect(1).to_equal(1);
  end test_slow;

  procedure test_nested is
  begin
    ut.expect(1).to_equal(1);
  end test_nested;

end test_calc_pkg;
/
`;

async function resolveItem(controller: vscode.TestController, item: vscode.TestItem | undefined): Promise<void> {
    await controller.resolveHandler?.(item);
}

/** Depth-first search, unlike testExplorer.e2e.test.ts's findChildByLabel/collectSubtree pair — cases here only ever need one named item at a time, not the whole subtree. */
function findTestItem(root: vscode.TestItem, label: string): vscode.TestItem | undefined {
    let found: vscode.TestItem | undefined;
    const visit = (collection: vscode.TestItemCollection): void => {
        collection.forEach((item) => {
            if (found) {
                return;
            }
            if (item.label === label) {
                found = item;
                return;
            }
            visit(item.children);
        });
    };
    visit(root.children);
    return found;
}

function fullDocumentRange(doc: vscode.TextDocument): vscode.Range {
    return new vscode.Range(new vscode.Position(0, 0), doc.lineAt(doc.lineCount - 1).range.end);
}

/** Inserts `byLines` blank lines directly above the first line containing `marker`, the same shape a moved procedure takes after a git checkout/formatter run. */
function shiftDown(text: string, marker: string, byLines: number): string {
    const lines = text.split('\n');
    const idx = lines.findIndex((l) => l.includes(marker));
    if (idx === -1) {
        throw new Error(`shiftDown: marker '${marker}' not found`);
    }
    lines.splice(idx, 0, ...new Array(byLines).fill(''));
    return lines.join('\n');
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The debounce window is 400ms (sourceIndex.ts's REINDEX_DEBOUNCE_MS); this
 * waits comfortably past it plus whatever the FileSystemWatcher's own OS
 * file-event latency adds — generous on purpose since, unlike the
 * PerKeyDebouncer unit tests, there is no reason to keep this window tight,
 * and a flaky e2e failure here is far more expensive to re-diagnose.
 */
const DEBOUNCE_SETTLE_MS = 700;

/** The package these cases index and re-index, as SourceIndex keys it (upper-cased, no owner). */
const PACKAGE_NAME = 'TEST_CALC_PKG';

/**
 * Builds the #20/#26 end-to-end cases as `[name, fn]` pairs, in the same
 * shape testExplorer.e2e.test.ts's own `cases` array uses, so its existing
 * run()/failure-collection loop can just concatenate them in rather than
 * this module needing its own copy of that plumbing.
 *
 * Order matters for the first four, and later ones depend on earlier ones
 * having run, same as testExplorer.e2e.test.ts's own
 * tag-scoped-must-run-first case:
 *  1. writes test_calc_pkg.pkb and establishes that TEST_CALC_PKG's
 *     TestItems now resolve to it locally instead of falling back to a
 *     virtual utplsql-source:// document;
 *  2. edits it (and a second, unrelated document) from inside the editor —
 *     the #20 scenario;
 *  3. edits it again, this time only on disk, outside any editor — the
 *     #26 FileSystemWatcher scenario, which 2. cannot exercise since an
 *     open editor's own onDidChangeTextDocument would mask a missing
 *     watcher;
 *  4. deletes it — the other #26 scenario, necessarily before 5. since
 *     nothing after it could still depend on the file existing.
 * The fifth case (files.associations) is independent of test_calc_pkg.pkb
 * entirely and only needs to run somewhere after buildFullIndex() has been
 * exercised at least once; it is placed last for that reason, not because
 * anything before it depends on it.
 */
export function buildSourceIndexWatcherCases(ctx: UtplsqlContext, pkg: vscode.TestItem, workspaceUri: vscode.Uri): Array<[string, () => Promise<void>]> {
    const fileUri = vscode.Uri.joinPath(workspaceUri, 'test_calc_pkg.pkb');
    const scratchUri = vscode.Uri.joinPath(workspaceUri, 'scratch_pkg.pkb');

    return [
        [
            'a local file matching a DB-known suite package is picked up and used for its TestItems locations',
            async () => {
                await vscode.workspace.fs.writeFile(fileUri, Buffer.from(TEST_CALC_PKG_BODY, 'utf8'));
                // Forced rather than left to the activation-time scan or a
                // config change, since neither would have fired again by
                // this point in the run — this is what a normal window
                // reload with the file already on disk would do for free.
                await ctx.sourceIndex.buildFullIndex();
                await resolveItem(ctx.controller, pkg);

                const testAdd = findTestItem(pkg, 'adds two numbers correctly');
                assert.ok(testAdd, "expected a TestItem for 'adds two numbers correctly'");
                assert.equal(
                    testAdd!.uri?.toString(),
                    fileUri.toString(),
                    'expected the test to now point at the local file instead of falling back to a virtual utplsql-source:// document'
                );
            }
        ],
        [
            'editing two open documents inside the debounce window reindexes both, not just the last one touched',
            async () => {
                await vscode.workspace.fs.writeFile(
                    scratchUri,
                    Buffer.from('create or replace package body scratch_pkg is\nend scratch_pkg;\n/\n', 'utf8')
                );
                const doc = await vscode.workspace.openTextDocument(fileUri);
                await vscode.workspace.openTextDocument(scratchUri);

                // Asserted against SourceIndex, not against the TestItem's
                // range. A TestItem's range does not come from the local file
                // at all: resolveLocation (controller.ts) takes the *file* from
                // SourceIndex and the *line* from the row's itemLineNo, i.e.
                // from what utPLSQL reports out of the database. Editing a
                // local file therefore cannot move a TestItem, by design --
                // only recompiling the database object can. What #20 actually
                // fixes is that the index itself stays current, which is what
                // decides which file a test resolves to and what
                // getPathAtCursor answers for run-at-cursor, so that is what
                // this case has to look at.
                const beforeLocation = ctx.sourceIndex.lookupProcedure(PACKAGE_NAME, 'TEST_ADD');
                assert.ok(beforeLocation, 'expected TEST_ADD to already be indexed from the previous case');
                const originalLine = beforeLocation!.range.start.line;

                const shiftedBody = shiftDown(doc.getText(), 'procedure test_add', 7);
                const edit = new vscode.WorkspaceEdit();
                edit.replace(fileUri, fullDocumentRange(doc), shiftedBody);
                await vscode.workspace.applyEdit(edit);

                // Inside the very same 400ms window: editing this second,
                // otherwise-unrelated document must not cancel
                // test_calc_pkg.pkb's still-pending reindex the way a
                // single shared refreshTimer field would (#20's actual bug).
                const scratchEdit = new vscode.WorkspaceEdit();
                scratchEdit.insert(scratchUri, new vscode.Position(0, 0), '-- touched\n');
                await vscode.workspace.applyEdit(scratchEdit);

                await doc.save();
                await settle(DEBOUNCE_SETTLE_MS);

                const after = ctx.sourceIndex.lookupProcedure(PACKAGE_NAME, 'TEST_ADD');
                assert.ok(after, 'expected TEST_ADD to still be indexed after the edit');
                assert.equal(
                    after!.range.start.line,
                    originalLine + 7,
                    "TEST_ADD must be indexed at its new line — with the pre-#20-fix single shared timer, scheduling scratch_pkg.pkb's reindex would have cancelled this one and left the stale pre-edit line"
                );

                // The other half of the same guarantee: the second document
                // was not merely spared from cancelling this one, it was
                // itself indexed. A debouncer that kept one timer but
                // reordered the victims would pass the assertion above alone.
                assert.ok(
                    ctx.sourceIndex.lookupPackage('SCRATCH_PKG'),
                    'expected scratch_pkg.pkb to have been indexed too, not just spared from cancelling the other reindex'
                );
            }
        ],
        [
            'a file changed on disk outside the editor is re-indexed by the FileSystemWatcher without a reload',
            async () => {
                // Again against SourceIndex rather than the TestItem -- see
                // the previous case for why a TestItem cannot move when only
                // the local file changes.
                const before = ctx.sourceIndex.lookupProcedure(PACKAGE_NAME, 'TEST_NESTED');
                assert.ok(before, 'expected TEST_NESTED to already be indexed');
                const originalLine = before!.range.start.line;

                const bytes = await vscode.workspace.fs.readFile(fileUri);
                const shifted = shiftDown(Buffer.from(bytes).toString('utf8'), 'procedure test_nested', 4);
                // Written straight to disk, deliberately not through
                // workspace.applyEdit/an open editor: this is the `git
                // checkout`/external-tool scenario #26 describes, which
                // only a FileSystemWatcher — not onDidChangeTextDocument —
                // can ever notice. (test_calc_pkg.pkb happens to still be
                // open from the previous case and not dirty, so VS Code
                // will also revert its buffer from this write and fire its
                // own onDidChangeTextDocument — harmless, since that just
                // means the same reindex gets scheduled from two triggers
                // instead of one, and #20's per-key debouncer collapses
                // that back down to a single call same as it would for any
                // other double-edit.)
                await vscode.workspace.fs.writeFile(fileUri, Buffer.from(shifted, 'utf8'));

                await settle(DEBOUNCE_SETTLE_MS);

                const after = ctx.sourceIndex.lookupProcedure(PACKAGE_NAME, 'TEST_NESTED');
                assert.ok(after, 'expected TEST_NESTED to still be indexed after the on-disk edit');
                assert.equal(
                    after!.range.start.line,
                    originalLine + 4,
                    'TEST_NESTED must be indexed at its new line even though no editor ever opened it for this change — without a FileSystemWatcher nothing would have noticed the write at all'
                );
            }
        ],
        [
            'deleting the file on disk falls back to a virtual utplsql-source:// location instead of keeping a dead file path',
            async () => {
                await vscode.workspace.fs.delete(fileUri);

                await settle(DEBOUNCE_SETTLE_MS);
                await resolveItem(ctx.controller, pkg);

                const after = findTestItem(pkg, 'adds two numbers correctly');
                assert.ok(after, "expected 'adds two numbers correctly' to still exist as a TestItem");
                assert.equal(
                    after!.uri?.scheme,
                    VIRTUAL_SOURCE_SCHEME,
                    'expected the deleted local file to fall back to a virtual utplsql-source:// uri instead of "go to test" pointing at a now-dead file path'
                );
            }
        ],
        [
            'a files.associations pattern for an extension no contributed language declares is still picked up',
            async () => {
                // collectGlobPatterns() (languageIndex.ts) builds its glob
                // list from two sources: extensions a language contribution
                // declares (.pkb/.pks/... from this extension's own
                // package.json, exercised by every other case above) and
                // files.associations entries pointing at a configured
                // language id. Only the latter is exercised here — it is
                // the one #26 singles out as "the easiest one to break when
                // adding watchers", since a watcher wired up purely from
                // package.json's static contributions would silently miss
                // it.
                const config = vscode.workspace.getConfiguration('files');
                const customUri = vscode.Uri.joinPath(workspaceUri, 'custom_pkg.utplsqltest');
                try {
                    await config.update('associations', { '*.utplsqltest': 'oracle-sql' }, vscode.ConfigurationTarget.Global);
                    await vscode.workspace.fs.writeFile(
                        customUri,
                        Buffer.from('create or replace package body custom_pkg is\n  procedure custom_proc;\nend custom_pkg;\n/\n', 'utf8')
                    );
                    // onConfigurationChanged already triggers buildFullIndex()
                    // for a files.associations change; forced explicitly here
                    // (as case 1 also does) so the assertion below doesn't
                    // race that background call.
                    await ctx.sourceIndex.buildFullIndex();

                    const location = ctx.sourceIndex.lookupProcedure('CUSTOM_PKG', 'CUSTOM_PROC');
                    assert.ok(location, 'expected the .utplsqltest file, matched only via files.associations, to be indexed');
                    assert.equal(location!.uri.toString(), customUri.toString());
                } finally {
                    await config.update('associations', {}, vscode.ConfigurationTarget.Global);
                }
            }
        ]
    ];
}
