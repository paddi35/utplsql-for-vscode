# Changelog

All notable changes to the "utPLSQL for VS Code" extension are documented in this file.

## [0.1.0] - Unreleased

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
