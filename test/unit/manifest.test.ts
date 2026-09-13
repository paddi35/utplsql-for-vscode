import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Consistency checks between package.json/README.md and the source they
 * describe -- cheap, drift-detecting guards rather than behavioural tests
 * (see test/unit/snippets.test.ts for the precedent of asserting against a
 * shipped non-code asset the same way). process.cwd()-relative, not
 * __dirname-relative, for the same reason snippets.test.ts's SNIPPETS_PATH
 * is: under tsx + mocha's ESM interop this file can be loaded
 * via dynamic import(), where __dirname is not defined; npm's test:unit
 * script always runs mocha from the project root.
 */
const ROOT = process.cwd();
const PACKAGE_JSON_PATH = path.resolve(ROOT, 'package.json');
const README_PATH = path.resolve(ROOT, 'README.md');
const COMMANDS_INDEX_PATH = path.resolve(ROOT, 'src', 'commands', 'index.ts');
const CONTROLLER_PATH = path.resolve(ROOT, 'src', 'testing', 'controller.ts');

interface PackageManifest {
    description: string;
    contributes: {
        commands: { command: string; title: string }[];
        configuration: { properties: Record<string, unknown> };
    };
}

function loadPackageJson(): PackageManifest {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as PackageManifest;
}

function loadReadme(): string {
    return fs.readFileSync(README_PATH, 'utf8');
}

/** The first non-empty block of lines after the H1 title -- README.md's opening pitch paragraph. */
function readmeOpeningParagraph(readme: string): string {
    const lines = readme.split(/\r?\n/);
    const titleIdx = lines.findIndex((l) => l.startsWith('# '));
    const paragraph: string[] = [];
    for (let i = titleIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '') {
            if (paragraph.length > 0) {
                break;
            }
            continue;
        }
        paragraph.push(line);
    }
    return paragraph.join(' ');
}

describe('marketplace/README claims vs. registered run profiles', () => {
    it('does not claim debug support in package.json unless a Debug run profile is actually registered', () => {
        const pkg = loadPackageJson();
        if (/debug/i.test(pkg.description)) {
            const controllerSrc = fs.readFileSync(CONTROLLER_PATH, 'utf8');
            assert.match(
                controllerSrc,
                /TestRunProfileKind\.Debug/,
                "package.json's description mentions debugging, but createUtplsqlContext (src/testing/controller.ts) " +
                    'registers no TestRunProfileKind.Debug run profile. Either add real debug support or drop the claim ' +
                    "from the description (see issue #30)."
            );
        }
    });

    it("README's opening paragraph and package.json's description agree on whether debugging is offered", () => {
        const pkg = loadPackageJson();
        const opening = readmeOpeningParagraph(loadReadme());
        assert.equal(
            /debug/i.test(opening),
            /debug/i.test(pkg.description),
            "README's opening paragraph and package.json's description must both mention debugging or both omit it -- " +
                'they describe the same feature set to two different audiences.'
        );
    });
});

/**
 * Issue #13 removed the coverage HTML report's extension-host webview
 * (c111cf6) and left package.json's and README's `utplsql.coverage.htmlReport`
 * descriptions -- plus a CHANGELOG entry -- still promising one; nothing in
 * this file caught it before a human happened to notice. Two content-drift
 * guards for that were considered here and deliberately not added, having
 * been checked against this repository's actual history rather than reasoned
 * about in the abstract -- both fail:
 *
 * 1. Fail if a description mentions "webview" while no file under `src`
 *    constructs `createWebviewPanel`. Sound in principle -- run against
 *    c111cf6 (webview already gone from src, descriptions not yet updated),
 *    it would have fired: both descriptions still said "in a webview"/"in
 *    einem Webview anzeigen", unnegated. But 7fa9894's actual fix necessarily
 *    still contains the word "webview", now to explain that the report is no
 *    longer one ("nicht mehr in einem Webview angezeigt", "instead of
 *    rendering it in a webview"). Added now, this guard fails immediately
 *    against that correct, already-merged text. Making it pass would mean
 *    detecting negation in prose -- "no longer a webview" vs. "shown in a
 *    webview" -- which is exactly the sentence-level heuristic that misfires
 *    on the next rewording and gets deleted, not a cheap grep-shaped
 *    invariant like this file's other checks.
 * 2. Assert package.json's and README's htmlReport descriptions agree on
 *    mechanism keywords ("webview"/"browser"/"notification"), the way the
 *    debug-mention check above compares two description fields. This is
 *    structurally unable to catch what actually happened: package.json and
 *    README were edited together both times (the original stale wording, and
 *    the fix) and always agreed with each other -- the drift was between the
 *    (agreeing) docs and the changed source, not between the two docs. It
 *    also would not survive this manifest's own bilingual split: most
 *    package.json configuration descriptions are German while README is
 *    English-only (compare e.g. utplsql.connections's description to
 *    utplsql.run.randomOrder's), and "webview"/"browser" only line up here as
 *    loanwords -- "notification" does not ("eine Benachrichtigung"), so even
 *    a hand-picked keyword subset would be reverse-engineered from today's
 *    exact wording rather than a real invariant.
 *
 * Nothing found here both catches this drift class and survives an accurate
 * future rewording. Left as a known gap rather than a guard that would need
 * constant re-tuning -- see this file's other describe blocks above for the
 * parts of manifest drift that *are* cheaply and reliably checkable (names
 * and boolean claims, not prose describing a mechanism).
 */

function extractRegisteredCommandIds(source: string): string[] {
    const ids: string[] = [];
    const re = /registerCommand\(\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
        ids.push(m[1]);
    }
    return ids;
}

describe('contributes.commands vs. registered commands', () => {
    it('every contributed command has a matching registerCommand call, and vice versa', () => {
        const pkg = loadPackageJson();
        const manifestCommands = pkg.contributes.commands.map((c) => c.command);
        const registered = extractRegisteredCommandIds(fs.readFileSync(COMMANDS_INDEX_PATH, 'utf8'));

        for (const id of manifestCommands) {
            assert.ok(
                registered.includes(id),
                `package.json contributes command '${id}' but no registerCommand('${id}', ...) call was found in src/commands/index.ts`
            );
        }
        for (const id of registered) {
            assert.ok(
                manifestCommands.includes(id),
                `src/commands/index.ts registers '${id}' but package.json's contributes.commands has no matching entry`
            );
        }
    });
});

/** One README settings-table row's "Setting" column, e.g. "`utplsql.coverage.schemes` / `utplsql.coverage.includeObjects`" or the wildcard "`utplsql.generate.*`". */
function settingTokensInRow(row: string): string[] {
    const firstColumn = row.split('|')[1] ?? '';
    return [...firstColumn.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

function readmeSettingsTableRows(readme: string): string[] {
    const lines = readme.split(/\r?\n/);
    const headingIdx = lines.findIndex((l) => l.trim() === '## Settings');
    assert.ok(headingIdx !== -1, 'README is missing the "## Settings" section');
    const rows: string[] = [];
    for (let i = headingIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^##\s/.test(line)) {
            break;
        }
        if (line.startsWith('|')) {
            rows.push(line);
        }
    }
    return rows;
}

/**
 * A row documenting several same-prefix settings abbreviates every sibling
 * after the first, e.g. "`utplsql.coverage.includeSchemaExpr` /
 * `includeObjectExpr` / `excludeSchemaExpr` / `excludeObjectExpr`" documents
 * four properties, not one literally named 'includeObjectExpr' -- readers
 * infer the shared `utplsql.coverage.` prefix from the row's first, fully
 * qualified entry, so this does the same rather than requiring the table to
 * spell every sibling out in full.
 */
function expandRowTokens(tokens: string[]): string[] {
    if (tokens.length === 0) {
        return tokens;
    }
    const [first, ...rest] = tokens;
    const prefix = first.slice(0, first.lastIndexOf('.') + 1);
    return [first, ...rest.map((t) => (t.startsWith('utplsql.') ? t : prefix + t))];
}

interface DocumentedSettings {
    exact: Set<string>;
    wildcardPrefixes: string[];
}

/**
 * Reads the README's settings table into the two shapes a row can document:
 * an exact setting name, or a "foo.*" wildcard row (currently only
 * `utplsql.generate.*`, standing in for its nine individual properties --
 * see package.json). Header/separator rows contribute nothing (no backtick
 * tokens in their first column), so they don't need special-casing.
 */
function documentedSettings(readme: string): DocumentedSettings {
    const exact = new Set<string>();
    const wildcardPrefixes: string[] = [];
    for (const row of readmeSettingsTableRows(readme)) {
        for (const token of expandRowTokens(settingTokensInRow(row))) {
            if (token.endsWith('.*')) {
                wildcardPrefixes.push(token.slice(0, -1));
            } else {
                exact.add(token);
            }
        }
    }
    return { exact, wildcardPrefixes };
}

function isDocumented(name: string, documented: DocumentedSettings): boolean {
    return documented.exact.has(name) || documented.wildcardPrefixes.some((prefix) => name.startsWith(prefix));
}

describe('README settings table vs. contributes.configuration.properties', () => {
    it('every settings-table entry matches a contributed configuration property, and vice versa', () => {
        const pkg = loadPackageJson();
        const documented = documentedSettings(loadReadme());
        const manifestSettings = Object.keys(pkg.contributes.configuration.properties);

        for (const name of manifestSettings) {
            assert.ok(
                isDocumented(name, documented),
                `'${name}' is declared in package.json's contributes.configuration.properties but is not documented ` +
                    "in README.md's settings table"
            );
        }
        for (const name of documented.exact) {
            assert.ok(
                manifestSettings.includes(name),
                `README.md's settings table documents '${name}', which does not exist in package.json's ` +
                    'contributes.configuration.properties'
            );
        }
        // A wildcard row is a deliberate umbrella (see documentedSettings's
        // doc comment), but it must still match at least one real property
        // -- otherwise a stale "foo.*" row (e.g. after a setting group was
        // renamed) would silently document nothing and this check would
        // never catch it.
        for (const prefix of documented.wildcardPrefixes) {
            assert.ok(
                manifestSettings.some((name) => name.startsWith(prefix)),
                `README.md documents a '${prefix}*' settings group that matches no property in package.json`
            );
        }
    });
});

/**
 * vsce refuses to package when @types/vscode declares a newer editor than
 * engines.vscode ("@types/vscode ^1.137.0 greater than engines.vscode
 * ^1.85.0"), and that failure only ever showed up in the Package .vsix CI
 * step -- long after the dependency update that caused it looked green
 * locally. These two guards move that check to the unit suite, and pin the
 * README's stated minimum to the manifest so the requirement users read
 * cannot drift away from the one the editor enforces.
 */
describe('engines.vscode vs. @types/vscode and the README requirement', () => {
    /** "^1.137.0" -> [1, 137]. Only major/minor matter -- VS Code's type definitions are published per minor. */
    function majorMinor(range: string): [number, number] {
        const match = /(\d+)\.(\d+)/.exec(range);
        assert.ok(match, `expected a x.y version in '${range}'`);
        return [Number(match![1]), Number(match![2])];
    }

    it('does not ask for type definitions newer than the engine it declares', () => {
        const manifest = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
            engines: { vscode: string };
            devDependencies: Record<string, string>;
        };
        const [engineMajor, engineMinor] = majorMinor(manifest.engines.vscode);
        const [typesMajor, typesMinor] = majorMinor(manifest.devDependencies['@types/vscode']);

        assert.ok(
            typesMajor < engineMajor || (typesMajor === engineMajor && typesMinor <= engineMinor),
            `@types/vscode ${typesMajor}.${typesMinor} is newer than engines.vscode ${engineMajor}.${engineMinor}; ` +
                'vsce will refuse to package. Raise engines.vscode (and the README requirement) or pin @types/vscode back.'
        );
    });

    it("README's stated minimum VS Code version matches engines.vscode", () => {
        const manifest = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as { engines: { vscode: string } };
        const [major, minor] = majorMinor(manifest.engines.vscode);
        const stated = /- VS Code \*\*(\d+)\.(\d+)\*\* or newer\./.exec(loadReadme());

        assert.ok(stated, "README.md's Requirements section no longer states a '- VS Code **x.y** or newer.' line");
        assert.deepEqual(
            [Number(stated![1]), Number(stated![2])],
            [major, minor],
            `README.md promises VS Code ${stated![1]}.${stated![2]} but package.json's engines.vscode is ${major}.${minor}`
        );
    });
});


/**
 * vsce does not read .gitignore, so anything gitignored has to be listed in
 * .vscodeignore separately or it ends up inside the published .vsix. This
 * already happened twice: test/perf's test-results/ was being shipped to the
 * Marketplace, and .claude/'s agent worktrees (which contain node_modules
 * junctions) made `vsce package` fail outright.
 */
describe('.gitignore vs. .vscodeignore', () => {
    const GITIGNORE_PATH = path.resolve(ROOT, '.gitignore');
    const VSCODEIGNORE_PATH = path.resolve(ROOT, '.vscodeignore');

    /**
     * dist/ is the one directory that is gitignored on purpose and shipped on
     * purpose -- it holds the esbuild bundle that *is* the extension.
     */
    const SHIPPED_ANYWAY = new Set(['dist']);

    function trimmedLines(file: string): string[] {
        return fs
            .readFileSync(file, 'utf8')
            .split(/\r?\n/)
            .map((l) => l.trim());
    }

    /** Gitignore entries that name a directory, i.e. the ones ending in a slash, with that slash dropped. */
    function ignoredDirectories(file: string): string[] {
        return trimmedLines(file)
            .filter((l) => l.length > 0 && !l.startsWith('#') && l.endsWith('/'))
            .map((l) => l.slice(0, -1));
    }

    it('excludes every gitignored directory from the package, except the built bundle', () => {
        const excluded = new Set(trimmedLines(VSCODEIGNORE_PATH));
        for (const dir of ignoredDirectories(GITIGNORE_PATH)) {
            if (SHIPPED_ANYWAY.has(dir)) {
                continue;
            }
            assert.ok(
                excluded.has(`${dir}/**`),
                `.gitignore hides ${dir}/ but .vscodeignore does not list '${dir}/**', so it would be published in the .vsix`
            );
        }
    });
});

/**
 * capabilities.untrustedWorkspaces.supported: false is what makes it safe for
 * virtualSourcePath.ts's provideTextDocumentContent() to be registered
 * unconditionally at activation for the utplsql-source:// scheme: that
 * handler opens a pooled DB connection using the stored password for
 * *any* URI of that scheme the editor is handed -- one from a workspace
 * file, a .vscode configuration entry, or another extension. Without this
 * flag, that handler would also run in a workspace the user has not decided
 * to trust. Nothing else in the extension enforces this, so a future
 * package.json edit could drop it silently (issue #79).
 */
describe('untrusted workspace support', () => {
    it('capabilities.untrustedWorkspaces.supported stays false', () => {
        const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
            capabilities?: { untrustedWorkspaces?: { supported?: boolean } };
        };
        assert.equal(
            pkg.capabilities?.untrustedWorkspaces?.supported,
            false,
            "package.json's capabilities.untrustedWorkspaces.supported must stay false -- it is what keeps " +
                "utplsql-source://'s provideTextDocumentContent() (which opens a DB connection with the stored " +
                'password for any URI of that scheme) from running in an untrusted workspace.'
        );
    });
});
