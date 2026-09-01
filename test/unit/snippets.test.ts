import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface Snippet {
    prefix: string;
    body: string | string[];
    description?: string;
}

// process.cwd()-relative, not __dirname-relative: this file is matched
// directly by mocha's test glob, and under ts-node/register + mocha's ESM
// interop it can be loaded via dynamic import() (see the "reparsing as ES
// module" warning mocha prints), where __dirname is not defined at all.
// npm's test:unit script always runs mocha from the project root.
const SNIPPETS_PATH = path.resolve(process.cwd(), 'snippets', 'utplsql.code-snippets');

function loadSnippets(): Record<string, Snippet> {
    return JSON.parse(fs.readFileSync(SNIPPETS_PATH, 'utf8')) as Record<string, Snippet>;
}

function bodyText(snippet: Snippet): string {
    return Array.isArray(snippet.body) ? snippet.body.join('\n') : snippet.body;
}

describe('utplsql.code-snippets', () => {
    it('parses as valid JSON', () => {
        assert.doesNotThrow(() => loadSnippets());
    });

    it('every entry has a non-empty prefix, body and description', () => {
        const snippets = loadSnippets();
        for (const [name, snippet] of Object.entries(snippets)) {
            assert.ok(snippet.prefix && snippet.prefix.length > 0, `${name}: missing prefix`);
            assert.ok(bodyText(snippet).length > 0, `${name}: empty body`);
            assert.ok(snippet.description && snippet.description.length > 0, `${name}: missing description`);
        }
    });

    it('prefixes are unique', () => {
        const snippets = loadSnippets();
        const prefixes = Object.values(snippets).map((s) => s.prefix);
        const seen = new Set<string>();
        const duplicates = prefixes.filter((p) => (seen.has(p) ? true : (seen.add(p), false)));
        assert.deepEqual(duplicates, []);
    });

    it('covers the annotations documented for utPLSQL 3.2.x (verified against the installed userguide)', () => {
        const snippets = loadSnippets();
        const prefixes = new Set(Object.values(snippets).map((s) => s.prefix));
        const expectedAnnotations = [
            'ut-%suite',
            'ut-%suitepath',
            'ut-%test',
            'ut-%context',
            'ut-%name',
            'ut-%beforeall',
            'ut-%afterall',
            'ut-%beforeeach',
            'ut-%aftereach',
            'ut-%beforetest',
            'ut-%aftertest',
            'ut-%disabled',
            'ut-%tags',
            'ut-%rollback',
            'ut-%throws',
            'ut-%displayname'
        ];
        for (const prefix of expectedAnnotations) {
            assert.ok(prefixes.has(prefix), `expected a snippet with prefix '${prefix}'`);
        }
    });

    it('does not offer the fictitious to_raise_exception matcher, which does not exist on ut_expectation', () => {
        // Confirmed against the installed utPLSQL 3.2.3 source
        // (source/expectations/ut_expectation.tps): no to_raise/
        // to_raise_exception member exists on ut_expectation or
        // ut_expectation_compound. Exception assertions are done via the
        // --%throws(...) annotation instead (see ut-%throws above) — a
        // package containing a snippet-generated ut.expect(...)
        // .to_raise_exception(...) call would fail to compile.
        const snippets = loadSnippets();
        for (const [name, snippet] of Object.entries(snippets)) {
            assert.doesNotMatch(bodyText(snippet), /to_raise/, `${name} should not reference to_raise/to_raise_exception`);
        }
    });

    it('every ut.expect(...) snippet body is a single balanced-parens statement ending in a semicolon', () => {
        const snippets = loadSnippets();
        for (const [name, snippet] of Object.entries(snippets)) {
            const text = bodyText(snippet);
            if (!text.includes('ut.expect(') && !text.includes('ut.fail(')) {
                continue;
            }
            const opens = (text.match(/\(/g) ?? []).length;
            const closes = (text.match(/\)/g) ?? []).length;
            assert.equal(opens, closes, `${name}: unbalanced parentheses in "${text}"`);
            assert.match(text.trimEnd(), /;$/, `${name}: expected the statement to end with ';'`);
        }
    });
});
