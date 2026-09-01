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

### Fixed

- `a_tags` was bound as a `ut_varchar2_list` instead of the plain, comma-joined `varchar2` value
  `ut_runner.run` actually expects — every tagged run failed to compile, which surfaced only as
  the consumer connection silently hanging until its 60-second timeout rather than a clear error.
- The `ut-expect-raise` snippet called a `to_raise_exception` matcher that does not exist on
  `ut_expectation` in utPLSQL 3.x; replaced by the `--%throws(...)` annotation, which is the
  actual mechanism for asserting a test raises an exception.

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
