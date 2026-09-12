import assert from 'node:assert/strict';
import { PerKeyDebouncer } from '../../src/workspace/perKeyDebouncer';
import { SourceLocationIndex } from '../../src/workspace/sourceLocationIndex';
import { ParsedIndexEntry } from '../../src/workspace/plsqlParser';

/**
 * SourceIndex itself (src/workspace/sourceIndex.ts) has `import * as vscode
 * from 'vscode'` at the top of its file, so it cannot be loaded here at
 * all — not even to reach its "pure" methods — outside the extension host
 * (see test/e2e for that coverage). What actually needed fixing for #20/#26
 * was extracted into two vscode-free modules instead, so this file exercises
 * those directly:
 *
 *  - PerKeyDebouncer: the per-URI debounce that replaced SourceIndex's
 *    single shared refreshTimer field (#20).
 *  - SourceLocationIndex: the add/remove/lookup map SourceIndex delegates
 *    to, including the body-over-spec lookup preference and the
 *    remove-then-add rename safety a FileSystemWatcher's onDidChange
 *    depends on (#26).
 *
 * See plsqlParser.test.ts for the companion "a moved procedure yields new
 * offsets" case that gives the debounce tests below actual teeth: without
 * it, a fix that reindexed but always produced the same range would still
 * pass.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Short enough to keep the suite fast, long enough (vs. a 10x wait) to be
// reliable on a loaded CI runner without ever being mistaken for a real
// 400ms production debounce window.
const DEBOUNCE_MS = 20;
const SETTLE_MS = DEBOUNCE_MS * 5;

describe('PerKeyDebouncer', () => {
    it('runs both callbacks when key A then key B are scheduled inside the debounce window', async () => {
        // This is the bug #20 reports: SourceIndex's single shared
        // refreshTimer field meant scheduling B's reindex cancelled A's
        // still-pending one, so only the last-touched document was ever
        // reparsed. Per-key debouncing must not reproduce that.
        const debouncer = new PerKeyDebouncer(DEBOUNCE_MS);
        const fired: string[] = [];
        debouncer.schedule('A', () => fired.push('A'));
        debouncer.schedule('B', () => fired.push('B'));

        await sleep(SETTLE_MS);

        assert.deepEqual(fired.sort(), ['A', 'B']);
    });

    it("collapses two schedules of the same key into one call using the latest payload", async () => {
        const debouncer = new PerKeyDebouncer(DEBOUNCE_MS);
        const fired: string[] = [];
        debouncer.schedule('A', () => fired.push('stale'));
        debouncer.schedule('A', () => fired.push('fresh'));

        await sleep(SETTLE_MS);

        assert.deepEqual(fired, ['fresh']);
    });

    it('dispose cancels every pending timer, for every key', async () => {
        const debouncer = new PerKeyDebouncer(DEBOUNCE_MS);
        const fired: string[] = [];
        debouncer.schedule('A', () => fired.push('A'));
        debouncer.schedule('B', () => fired.push('B'));

        debouncer.dispose();
        await sleep(SETTLE_MS);

        assert.deepEqual(fired, []);
        assert.equal(debouncer.size, 0);
    });

    it('cancel drops one pending key without running it or touching other keys', async () => {
        const debouncer = new PerKeyDebouncer(DEBOUNCE_MS);
        const fired: string[] = [];
        debouncer.schedule('A', () => fired.push('A'));
        debouncer.schedule('B', () => fired.push('B'));

        debouncer.cancel('A');
        await sleep(SETTLE_MS);

        assert.deepEqual(fired, ['B']);
    });

    it('removes a key from the pending set once its callback has fired, so it cannot leak across thousands of edits', async () => {
        const debouncer = new PerKeyDebouncer(DEBOUNCE_MS);
        const keyCount = 2000;
        for (let i = 0; i < keyCount; i++) {
            debouncer.schedule(`doc-${i}`, () => undefined);
        }
        assert.equal(debouncer.size, keyCount);

        await sleep(SETTLE_MS);

        assert.equal(debouncer.size, 0);
    });
});

function entry(key: string, isBody: boolean, line = 0): ParsedIndexEntry {
    return {
        key,
        isBody,
        start: { offset: line * 100, line, character: 0 },
        end: { offset: line * 100 + key.length, line, character: key.length }
    };
}

describe('SourceLocationIndex', () => {
    it('setOwnerEntries then removeOwner leaves lookup undefined for every key that owner contributed', () => {
        const index = new SourceLocationIndex<string>();
        index.setOwnerEntries('file:///a.pkb', 'owner-a', [entry('PKG_A', true), entry('PKG_A.PROC1', true, 1)]);

        index.removeOwner('file:///a.pkb');

        assert.equal(index.lookup('PKG_A'), undefined);
        assert.equal(index.lookup('PKG_A.PROC1'), undefined);
    });

    it('removeOwner for an owner that contributed nothing is a no-op and leaves other owners untouched', () => {
        const index = new SourceLocationIndex<string>();
        index.setOwnerEntries('file:///a.pkb', 'owner-a', [entry('PKG_A', true)]);

        index.removeOwner('file:///never-indexed.pkb');

        assert.equal(index.lookup('PKG_A')?.owner, 'owner-a');
    });

    it('keeps two owners declaring the same package name, preferring the body over the spec', () => {
        const index = new SourceLocationIndex<string>();
        index.setOwnerEntries('file:///pkg.pks', 'spec-owner', [entry('PKG', false)]);
        index.setOwnerEntries('file:///pkg.pkb', 'body-owner', [entry('PKG', true)]);

        const preferred = index.lookup('PKG');

        assert.equal(preferred?.owner, 'body-owner');
        assert.equal(preferred?.isBody, true);
    });

    it('falls back to the surviving spec once the body owner is removed, proving both stayed indexed all along', () => {
        const index = new SourceLocationIndex<string>();
        index.setOwnerEntries('file:///pkg.pks', 'spec-owner', [entry('PKG', false)]);
        index.setOwnerEntries('file:///pkg.pkb', 'body-owner', [entry('PKG', true)]);
        assert.equal(index.lookup('PKG')?.owner, 'body-owner', 'precondition: body must be preferred before the removal this test is about');

        index.removeOwner('file:///pkg.pkb');

        assert.equal(index.lookup('PKG')?.owner, 'spec-owner');
    });

    it('re-indexing a file whose package was renamed drops the old key as well as adding the new one', () => {
        const index = new SourceLocationIndex<string>();
        index.setOwnerEntries('file:///a.pkb', 'owner-a', [entry('OLD_PKG', true)]);

        // Same ownerKey as before: this is what SourceIndex.addEntries does
        // on every re-index of the same file, not just on a rename — the
        // rename case only differs in that the new parseSource() output no
        // longer contains OLD_PKG at all.
        index.setOwnerEntries('file:///a.pkb', 'owner-a', [entry('NEW_PKG', true)]);

        assert.equal(index.lookup('OLD_PKG'), undefined);
        assert.equal(index.lookup('NEW_PKG')?.owner, 'owner-a');
    });

    it('lookup matches keys case-insensitively, mirroring parseSource always upper-casing them', () => {
        const index = new SourceLocationIndex<string>();
        index.setOwnerEntries('file:///a.pkb', 'owner-a', [entry('PKG_A', true)]);

        assert.equal(index.lookup('pkg_a')?.owner, 'owner-a');
    });
});
