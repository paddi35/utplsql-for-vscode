# Changelog

All notable changes to the "utPLSQL for VS Code" extension are documented in this file.

## [Unreleased]

### Added

- `--%disabled` tests are now marked in the Test Explorer (a `disabled` tag and description) instead
  of being indistinguishable from enabled tests until run.
- `utplsql.runWithTags` runs all tests carrying one or more chosen `--%tags(...)` values.
- `utplsql.run.randomOrder`/`utplsql.run.randomOrderSeed` run tests in a random (optionally
  reproducible) order via `a_random_test_order`/`a_random_test_order_seed`.
- `utplsql.rebuildAnnotations` rebuilds utPLSQL's own annotation cache
  (`ut_runner.rebuild_annotation_cache`) and refreshes the Test Explorer.
- Running tests is now gated on utPLSQL >= 3.1.4 (the real-time reporter's minimum) with an
  actionable error instead of a raw `ORA-*` failure; the detected version is shown on each
  connection's root Test Explorer item.
- Coverage scoping can now be overridden/extended via `utplsql.coverage.schemes`,
  `utplsql.coverage.includeObjects`, and the four `a_*_expr` regex settings
  (`includeSchemaExpr`/`includeObjectExpr`/`excludeSchemaExpr`/`excludeObjectExpr`).
- Coverage now reports test packages via `a_test_file_mappings` instead of approximating them
  with `a_exclude_objects`.
- `utplsql.coverage.reporter = "cobertura"` additionally runs `ut_coverage_cobertura_reporter`
  alongside the Sonar reporter the native Coverage view needs, offered as a file after each run.
- **Export with Reporter** run profile exports an arbitrary Test Explorer selection (not just the
  package at the cursor) with a chosen output reporter, one file per connection profile involved.
- `utplsql.reporter.clientCharacterSet`/`utplsql.reporter.colorConsole` control
  `a_client_character_set`/`a_color_console` for reporter export.
- Snippets for the remaining documented `--%` annotations (`%beforetest`, `%aftertest`, `%tags`,
  `%rollback`, `%throws`, `%displayname`, `%name`) and `ut.expect` matchers (`to_be_not_null`,
  `to_be_true`/`to_be_false`, `to_be_between`, the `to_be_greater/less_than[_or_equal]` family,
  `to_match`, `to_be_like`, `to_contain`, `to_have_count`, a cursor `to_equal` with the
  include/exclude/unordered modifiers, JSON `to_equal`, `ut.fail`, and a verified
  `ut.set_nls`/`ut.reset_nls` pattern).
- `utplsql.trace` and `utplsql.perf.enabled`/`utplsql.perf.reportFile` add opt-in, verbose
  per-event logging and timing instrumentation for discovery/run, off by default (see
  `docs/performance.md`).

### Changed

- The Test Explorer tree is now materialized one level at a time: expanding a schema, suite, or
  package builds only its direct children instead of eagerly turning every row the schema's suites
  return into a `TestItem` up front, which made expanding a schema with many packages noticeably
  slow. Running a suite/package that was never individually expanded now resolves its subtree first,
  so every test it contains still gets a visible pass/fail result; re-resolving an already-expanded
  node (which a run now does, and which the editor itself may do after a reload) updates its
  existing `TestItem`s in place instead of discarding and rebuilding them, so a just-finished run's
  results stay attached instead of disappearing from the sidebar the next time that node is opened.

### Fixed

- `a_tags` was bound as a `ut_varchar2_list` instead of the plain, comma-joined `varchar2` value
  `ut_runner.run` actually expects — every tagged run failed to compile, which surfaced only as
  the consumer connection silently hanging until its 60-second timeout rather than a clear error.
- The `ut-expect-raise` snippet called a `to_raise_exception` matcher that does not exist on
  `ut_expectation` in utPLSQL 3.x; replaced by the `--%throws(...)` annotation, which is the
  actual mechanism for asserting a test raises an exception.
- `package.json`'s marketplace `description` and this README's opening paragraph claimed the
  extension can "run **and debug**" utPLSQL tests. No `TestRunProfileKind.Debug` run profile has
  ever been registered — `createUtplsqlContext` (`src/testing/controller.ts`) only creates `Run`,
  `Run with Coverage` and `Export with Reporter` — and the "Known limitations" section a few
  paragraphs down already said as much. Both now read "Run utPLSQL unit tests…"; debugging stays
  out of scope until VS Code has a PL/SQL debug adapter for this extension to drive.
- `SourceIndex` re-indexed documents through a single shared debounce timer: editing one file and
  then a different file within the 400 ms debounce window cancelled the first file's pending
  re-index via `clearTimeout`, so only the most recently edited document was ever re-parsed. The
  index silently went stale for every file but the last one touched — gutter icons, "go to test",
  and a failed expectation's location could all point at the wrong line — until that file was
  reopened or the window reloaded. Re-indexing is now debounced per document URI, so edits across
  several files inside the same window are each still re-indexed.
- The pre-run `run paths for '<profile>' = …` log line (embedding every selected `TestItem` id)
  and the `produce SQL: …` log line (embedding the entire generated PL/SQL block) were written to
  the `utPLSQL` output channel unconditionally on every run, instead of being gated behind
  `utplsql.trace` like the rest of this file's per-event logging already is. On the documented
  1000-package/~15,000-test fixture, a plain "Run All" wrote on the order of a megabyte in a single
  call right as the run started, burying every other line already in the output channel. Both are
  now gated behind `utplsql.trace`; a short, count-bounded summary line is still always logged, and
  the full produce SQL is still logged unconditionally when a run fails.
- PL/SQL source files changed outside the editor — a `git checkout`/`pull`, a branch switch, or a
  file created/deleted by another tool — were never re-indexed; only opening or editing a document
  in VS Code itself fed the workspace index, so `lookupPackage()`/`lookupProcedure()` kept handing
  out stale locations (or, for a deleted file, a location that no longer exists) for the rest of
  the session, with a window reload the only fix. A filesystem watcher now indexes created/changed
  files and removes deleted ones as they happen; closing an untitled/unsaved document now also
  drops its entries instead of leaving them behind, and closing a saved one re-reads it from disk.

### Security

- `utplsql.perf.reportFile`/`utplsql.perf.enabled` are now `"scope": "machine"`, like
  `utplsql.connections`, so a workspace's own `.vscode/settings.json` can no longer set either.
  Previously a repository could ship both settings and have the extension append a JSON line to an
  attacker-chosen path outside the workspace on the very first Test Explorer expand (any
  `measure()` span — discovery and run are both instrumented). `src/perf.ts` now also resolves
  `perf.reportFile` and refuses to write anywhere that isn't inside an open workspace folder,
  logging the rejection once instead of silently swallowing it in a bare `catch {}`, and appends
  the report line with `fs.appendFile` (async) instead of `appendFileSync` so a slow/contended disk
  can no longer block the extension host.
- The `TNS_ADMIN` directory fallback no longer trusts a workspace-scoped value of
  `sqldeveloper.connections.tnsConfiguration.path` — a setting owned by the Oracle SQL Developer
  for VSCode extension, not this one, and outside this extension's control. It was previously read
  with a plain `get()`, which does not distinguish a workspace-set value from a global one, and the
  resulting directory was passed straight to `oracledb.createPool()`'s `configDir` — so a
  workspace's own `.vscode/settings.json` could redefine the TNS alias a stored-password connection
  profile names and redirect that connection, credentials included, to a host the workspace chose.
  The fallback now reads that setting via `inspect()` and only honours its global/default value;
  `utplsql.connections.tnsAdminPath` (already machine-scoped) still takes priority, and a
  workspace-scoped SQL Developer value is ignored in favour of `TNS_ADMIN`.

## [0.1.0] - 2026-08-31

Initial version.

### Added

- Native VS Code Testing API integration: Test Explorer, gutter icons, run/debug-style results.
- Discovery of utPLSQL suites/contexts/tests via `ut_runner.get_suites_info`, mapped to workspace
  source files through a language-ID-based workspace index (no dependency on file extensions).
- Test execution against the real-time reporter protocol (`ut_realtime_reporter`), with live
  per-test progress, `serverOutput`/`errorStack` capture and cancellation support.
- Code coverage (`TestRunProfileKind.Coverage`) via `ut_coverage_sonar_reporter`, with an optional
  additional HTML report (`ut_coverage_html_reporter`) shown in a webview
  (`utplsql.coverage.htmlReport`).
- Reporter export command (`utplsql.runWithReporter`) covering any output reporter returned by
  `ut_runner.get_reporters_list()` (documentation, JUnit, TAP, TeamCity, Sonar, etc.).
- Test package generation (`utplsql.generateTest`) from a package/procedure/function at the cursor.
- Connection management commands (`utplsql.addConnection`, `utplsql.setPassword`,
  `utplsql.removeConnection`) with passwords stored in VS Code `SecretStorage`, and TNS alias
  discovery via `utplsql.connections.tnsAdminPath`.
- Snippets for common utPLSQL annotations, registered for the `sql` and `oracle-sql` language IDs.

### Known limitations

- No PL/SQL debugger integration — VS Code has no built-in PL/SQL debug adapter to drive.
- Suite paths returned by utPLSQL don't carry the owning schema, so a run spanning suites with the
  same path in two different schemas can misattribute events to the wrong schema (the same
  limitation Oracle SQL Developer's utPLSQL integration has).
