import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseSource } from '../../src/workspace/plsqlParser';
import { SourceLocationIndex } from '../../src/workspace/sourceLocationIndex';
import { PerKeyDebouncer } from '../../src/workspace/perKeyDebouncer';

/**
 * The "Integration (filesystem only, no DB)" coverage #20/#26 ask for,
 * exercised against a real temp directory and real timers instead of a
 * live Oracle instance. It deliberately does not go through the SourceIndex
 * class: that file has `import * as vscode from 'vscode'` at the top, which
 * fails to load outside the extension host no matter which method a test
 * calls (see sourceIndex.test.ts's own doc comment for the same point about
 * its unit tests). Everything SourceIndex.indexFile/scheduleReindexUri
 * actually do beyond vscode plumbing — read a path's bytes, parseSource()
 * them, feed the result to SourceLocationIndex, debounce with
 * PerKeyDebouncer — is reproduced here directly, with a real file path
 * string standing in for vscode.Uri.toString().
 *
 * Not reproducible this way: the one Integration case built entirely
 * around files.associations actually driving which on-disk files match
 * (collectGlobPatterns()/findCandidateFiles() in languageIndex.ts need
 * vscode.workspace.getConfiguration/findFiles). That case lives in
 * test/e2e instead, alongside the FileSystemWatcher coverage that also
 * cannot be reproduced without the extension host.
 */
describe('SourceIndex file-system behaviour (parseSource + SourceLocationIndex + PerKeyDebouncer against real files)', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utplsql-sourceindex-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function writeFile(name: string, content: string): string {
        const filePath = path.join(dir, name);
        fs.writeFileSync(filePath, content, 'utf8');
        return filePath;
    }

    /** What SourceIndex.indexFile does once vscode.workspace.fs.readFile is swapped for node:fs: read the path fresh and wholesale-replace whatever it previously contributed. */
    function indexFromDisk(index: SourceLocationIndex<string>, filePath: string): void {
        const content = fs.readFileSync(filePath, 'utf8');
        index.setOwnerEntries(filePath, filePath, parseSource(content));
    }

    function packageBody(pkgName: string, procNames: string[]): string {
        const decls = procNames.map((n) => `  procedure ${n};`).join('\n');
        return `create or replace package body ${pkgName} is\n${decls}\nend ${pkgName};\n/\n`;
    }

    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const DEBOUNCE_MS = 20;
    const SETTLE_MS = DEBOUNCE_MS * 5;

    it('reindexing two files within the debounce window reflects both files new content, not just the last one touched', async () => {
        const pathA = writeFile('a.pkb', packageBody('pkg_a', ['proc_old']));
        const pathB = writeFile('b.pkb', packageBody('pkg_b', ['proc_old']));
        const index = new SourceLocationIndex<string>();
        indexFromDisk(index, pathA);
        indexFromDisk(index, pathB);
        assert.ok(index.lookup('PKG_A.PROC_OLD'));
        assert.ok(index.lookup('PKG_B.PROC_OLD'));

        // Overwrite both within one debounce window — a find-and-replace
        // across files, or a formatter run on save over several open
        // editors, produce exactly this kind of burst (see #20's Impact
        // section).
        fs.writeFileSync(pathA, packageBody('pkg_a', ['proc_new']), 'utf8');
        fs.writeFileSync(pathB, packageBody('pkg_b', ['proc_new']), 'utf8');
        const debouncer = new PerKeyDebouncer(DEBOUNCE_MS);
        debouncer.schedule(pathA, () => indexFromDisk(index, pathA));
        debouncer.schedule(pathB, () => indexFromDisk(index, pathB));

        await sleep(SETTLE_MS);

        assert.equal(index.lookup('PKG_A.PROC_OLD'), undefined, "A's stale entry must be gone, not just B's");
        assert.ok(index.lookup('PKG_A.PROC_NEW'), "A's new content must be reflected");
        assert.equal(index.lookup('PKG_B.PROC_OLD'), undefined);
        assert.ok(index.lookup('PKG_B.PROC_NEW'), "B's new content must be reflected too — a single shared timer would have dropped A's reindex to make room for this one");
    });

    it("lookupProcedure-equivalent lookup still returns the body's location after an edit touches both the spec and the body within the debounce window", async () => {
        const specPath = writeFile('pkg.pks', 'create or replace package pkg is\n  procedure proc1;\nend pkg;\n/\n');
        const bodyPath = writeFile('pkg.pkb', packageBody('pkg', ['proc1']));
        const index = new SourceLocationIndex<string>();
        indexFromDisk(index, specPath);
        indexFromDisk(index, bodyPath);
        assert.equal(index.lookup('PKG.PROC1')?.owner ?? index.lookup('PKG')?.owner, bodyPath, 'precondition: body must already be preferred');

        // A formatter run across the whole package touches both files.
        fs.writeFileSync(specPath, '-- reformatted\ncreate or replace package pkg is\n  procedure proc1;\nend pkg;\n/\n', 'utf8');
        fs.writeFileSync(bodyPath, `-- reformatted\n${packageBody('pkg', ['proc1'])}`, 'utf8');
        const debouncer = new PerKeyDebouncer(DEBOUNCE_MS);
        debouncer.schedule(specPath, () => indexFromDisk(index, specPath));
        debouncer.schedule(bodyPath, () => indexFromDisk(index, bodyPath));

        await sleep(SETTLE_MS);

        const location = index.lookup('PKG.PROC1') ?? index.lookup('PKG');
        assert.equal(location?.owner, bodyPath, 'the body must still win the preference once both reindexes have settled');
        assert.equal(location?.isBody, true);
    });

    it('indexes a new file, tracks its procedure moving 50 lines down, then drops it once deleted', () => {
        const filePath = writeFile('pkg.pkb', packageBody('pkg', ['proc1']));
        const index = new SourceLocationIndex<string>();
        indexFromDisk(index, filePath);
        const before = index.lookup('PKG.PROC1');
        assert.ok(before, 'expected the freshly written file to be indexed');

        const padding = new Array(50).fill('  -- padding').join('\n');
        fs.writeFileSync(filePath, `create or replace package body pkg is\n${padding}\n  procedure proc1;\nend pkg;\n/\n`, 'utf8');
        indexFromDisk(index, filePath);
        const afterMove = index.lookup('PKG.PROC1');
        assert.ok(afterMove, 'expected the moved procedure to still be indexed');
        assert.equal(afterMove!.start.line, before!.start.line + 50);

        fs.unlinkSync(filePath);
        index.removeOwner(filePath);
        assert.equal(index.lookup('PKG.PROC1'), undefined);
    });

    it('a rename removes the old paths entries and leaves only the new paths entries', () => {
        const oldPath = writeFile('old_name.pkb', packageBody('pkg', ['proc1']));
        const index = new SourceLocationIndex<string>();
        indexFromDisk(index, oldPath);
        assert.equal(index.lookup('PKG.PROC1')?.owner, oldPath);

        const newPath = path.join(dir, 'new_name.pkb');
        fs.renameSync(oldPath, newPath);
        // What SourceIndex would see as onDidDelete(oldPath) followed by
        // onDidCreate(newPath) from the FileSystemWatcher — a rename is
        // both at once (#26's Impact section).
        index.removeOwner(oldPath);
        indexFromDisk(index, newPath);

        const location = index.lookup('PKG.PROC1');
        assert.equal(location?.owner, newPath);
        assert.notEqual(location?.owner, oldPath);
    });
});
