import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Consistency checks between package.json/README.md and the source they
 * describe -- cheap, drift-detecting guards rather than behavioural tests
 * (see test/unit/snippets.test.ts for the precedent of asserting against a
 * shipped non-code asset the same way). process.cwd()-relative, not
 * __dirname-relative, for the same reason snippets.test.ts's SNIPPETS_PATH
 * is: under ts-node/register + mocha's ESM interop this file can be loaded
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
