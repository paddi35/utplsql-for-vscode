// esbuild inlines test/integration/support/fixture.ts's code into the
// bundled testExplorer.e2e.test.js, but its fs.readFileSync(path.join(
// __dirname, 'fixture.sql')) resolves __dirname at *runtime* against the
// bundle's own location (test/e2e/out/), not fixture.ts's original
// directory. Copying the .sql files it reads there is simpler and less
// fragile than changing fixture.ts's file-reading approach just for this
// one (bundled) consumer, when test/integration's own (unbundled, tsx)
// use of the same file needs it to keep reading relative to itself.
const fs = require('node:fs');
const path = require('node:path');

const sourceDir = path.join(__dirname, '..', '..', 'integration', 'support');
const targetDir = path.join(__dirname, '..', 'out');
fs.mkdirSync(targetDir, { recursive: true });

// Every .sql in that directory, not a list of the ones currently needed.
//
// fixture.ts reads each of them at *module load* time (top-level
// fs.readFileSync, unconditional), so importing it at all -- which
// testExplorer.e2e.test.ts does for installFixture -- fails with ENOENT the
// moment a real extension host requires the bundle, whether or not any case
// calls the matching install function. A hardcoded list therefore turns
// "someone added a fixture" into "the whole e2e suite dies before the first
// test", with a stack trace pointing at the bundle rather than at the list.
//
// That has now happened twice: once for xssFixture.sql, and again for
// deepTagsFixture.sql, which issue #18's tag tests added afterwards. Reading
// the directory removes the failure mode rather than fixing this instance of
// it; test/unit/copyFixtures.test.ts pins that it stays that way.
for (const file of fs.readdirSync(sourceDir)) {
    if (file.endsWith('.sql')) {
        fs.copyFileSync(path.join(sourceDir, file), path.join(targetDir, file));
    }
}

/**
 * A body-only copy of fixture.sql's coverage_local_pkg body, written directly
 * into the e2e workspace *before* the extension host starts (unlike
 * sourceIndexCases.ts's test_calc_pkg.pkb, which a case writes at runtime to
 * exercise a live transition) -- see coverageCases.ts's own doc comment for
 * why coverage's "local workspace file" e2e case needs the mapping to already
 * exist at activation, not appear mid-run. Trimmed the same way
 * sourceIndexCases.ts's TEST_CALC_PKG_BODY is: never compiled or run from
 * here, it only needs to parse as the same PACKAGE BODY/FUNCTION declarations
 * so SourceIndex can map COVERAGE_LOCAL_PKG's DB-discovered dependency onto
 * it.
 */
const COVERAGE_LOCAL_PKG_BODY = `create or replace package body coverage_local_pkg is

  function add_numbers(a number, b number) return number is
  begin
    return a + b;
  end add_numbers;

  function never_called return number is
  begin
    return -1;
  end never_called;

end coverage_local_pkg;
/
`;

const workspaceDir = path.join(targetDir, 'workspace');
fs.mkdirSync(workspaceDir, { recursive: true });
fs.writeFileSync(path.join(workspaceDir, 'coverage_local_pkg.pkb'), COVERAGE_LOCAL_PKG_BODY, 'utf8');
