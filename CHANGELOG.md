# Changelog

All notable changes to the "utPLSQL for VS Code" extension are documented in this file.

## [0.2.0] - 2026-09-15 

### Added

- **"Run with Reporter (Export)" can now export a coverage report**
  (`ut_coverage_html_reporter`, `ut_coverage_sonar_reporter`, `ut_coverage_cobertura_reporter`),
  both from the cursor-based command and the "Export with Reporter" run profile. Picking one of
  these reporters now computes the same dependency-derived coverage scope and
  local-file/`utplsql-source://` file mapping "Run with Coverage" uses, so the export produces a
  real report scoped to the exported package's dependencies instead of always timing out with
  `ORA-20215`. The QuickPick marks these three as "coverage" so it is clear the scope differs from
  a plain text/XML export; picking one for a target with no resolvable dependencies fails fast with
  a clear error instead of attempting a doomed run.
- **Connection profiles can now configure a wallet** (`walletLocation`, optional `walletPassword`
  stored in `SecretStorage`) for mutual TLS or an Autonomous Database connection. "Add Connection"
  asks for both after the default schema; "Set Wallet Password for Connection" updates or clears
  the password later. The connect-string prompt now also mentions `tcps://` for a plain
  TLS-encrypted connection that needs no wallet.
- **"Run with Reporter (Export)" and "Generate Test Package" are now on the Test Explorer's own
  right-click menu**, on any item that stands for a database object. They act on the item that was
  clicked rather than asking again which object was meant, which is what made them awkward to reach
  from a workspace with no local PL/SQL files. Grouping nodes (a `--%suitepath` level) and
  connection roots do not offer them, since they name no single object.
- CodeQL analysis runs on every push, every pull request and weekly, as a committed workflow so the
  query selection is reviewable rather than configured out of sight.
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
- **Export with Reporter** (the run profile) and `utplsql.runWithReporter` (the cursor command) can
  now be cancelled while the export itself is running, not just between connection profiles or not
  at all; `utplsql.runWithReporter` also gets its own cancellable progress notification, reporting
  coarse phases (opening consumer / running tests / collecting `<n>` lines). Previously a wedged
  export could hold two pool connections for up to an hour with no stop button that did anything;
  cancelling now closes both connections and recycles the pool so a following export on the same
  profile still succeeds.

### Changed

- New extension icon, and a rewritten README: a walkthrough from adding a connection to a first
  coverage run, four diagrams of the Testing view, the data flow, the four setup steps and the
  coverage view, and a troubleshooting table. The reference sections (commands, settings, known
  limitations, security) are unchanged in substance. The icon ships at 256×256 with the
  full-resolution original kept in `docs/images/`, which takes the packaged `.vsix` from 1.04 MB
  down to 234 KB — the old icon alone was 87% of it.
- **Minimum VS Code raised from 1.85 to 1.137.** `@types/vscode` has to stay at or below
  `engines.vscode` (vsce refuses to package otherwise), so the type definitions could not be
  updated while the engine floor stayed at 1.85. No API newer than 1.85 is used yet; this only
  moves the floor so the definitions can track the editor. Users on an older VS Code keep the
  previously published version.
- The packaged `.vsix` no longer carries `test-results/`, `.vscode-test/` or `.claude/`. All three
  are gitignored, but vsce does not read `.gitignore`, so a local perf report could be shipped to
  the Marketplace (and an agent worktree made `vsce package` fail outright).
- The Test Explorer tree is now materialized one level at a time: expanding a schema, suite, or
  package builds only its direct children instead of eagerly turning every row the schema's suites
  return into a `TestItem` up front, which made expanding a schema with many packages noticeably
  slow. Running a suite/package that was never individually expanded now resolves its subtree first,
  so every test it contains still gets a visible pass/fail result; re-resolving an already-expanded
  node (which a run now does, and which the editor itself may do after a reload) updates its
  existing `TestItem`s in place instead of discarding and rebuilding them, so a just-finished run's
  results stay attached instead of disappearing from the sidebar the next time that node is opened.

### Fixed

- A coverage run failed outright — losing coverage for the whole schema — when any object it
  depended on had a name that is not a plain identifier. Oracle allows quoted identifiers, and such
  a name cannot be written into the generated PL/SQL, so the run died at SQL-build time with
  "invalid include object". That object is now dropped from the derived scope and named in the
  output channel instead. A name given explicitly in `utplsql.coverage.includeObjects` still fails
  loudly: the user typed it and can correct it.
- A command that could not reach the database reported VS Code's generic "Running the contributed
  command failed" instead of the reason. Every one of them opens a pooled connection somewhere, and
  none of those calls had a catch above it, so the messages that matter most — a stored password
  that no longer works, a TNS alias that stopped resolving, every pooled connection being busy —
  were the ones the user never saw.
- Listing reporters across several connection profiles aborted entirely as soon as one profile could
  not be reached, which also made the "none of the selected connection profiles could be reached"
  message unreachable. Each profile is now probed independently and a failing one is logged and
  skipped.
- Coverage resolved PACKAGE/PACKAGE BODY types through its own database round trip while the Test
  Explorer already had the answer cached. Both now share one cache, which is also what keeps it
  correct: "Refresh Tests" and a changed connection profile clear that cache, and a second instance
  would have gone on answering PACKAGE for something recompiled as PACKAGE BODY until the window was
  reloaded.
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
- Discovery and coverage picked their `dba_`/`all_` data-dictionary view prefix from a single cache
  shared by every connection profile: whichever profile probed it first decided the answer for every
  other profile for the rest of the session. A second, less-privileged profile inheriting a cached
  `dba_` answer failed with `ORA-00942`; a second, more-privileged profile inheriting a cached `all_`
  answer silently lost part of its coverage scope with no error at all. The cache is now keyed per
  connection profile and cleared by **Refresh**, so a mid-session grant or revoke no longer needs a
  window reload to take effect either.
- Expanding two Test Explorer nodes at once (or starting a run, which re-resolves its subtree first)
  could send the same connection profile's full suite-discovery query to the database more than once
  in parallel instead of sharing a single result — a query that measures 27-59 seconds against the
  documented 1000-package fixture, so this read as the Test Explorer hanging for the better part of a
  minute just from expanding two things quickly. Concurrent resolves for the same profile now share
  one in-flight query.
- Resolving a tree level whose rows have no matching local workspace source file — the workspace
  shape this extension is meant to support, with the database as the sole source of truth and no
  local `.pkb`/`.pks` files at all — opened a fresh pooled connection and queried object types on
  every single level, even though every level for the same schema asks the same question. Expanding
  or running a large such tree (e.g. "Run All" on the documented 1000-package fixture) could rack up
  well over a thousand sequential connection checkouts against a pool sized for as few as two
  connections before the first test even started. Object types are now cached and primed once per
  connection profile and schema instead of once per tree level.
- Building **Run with Coverage**'s scope queried `*_dependencies` once per selected `TestItem`
  instead of once per package — since a coverage run selects every path-bearing suite/context/test
  row, not just leaves, the same package's dependencies were queried once per row belonging to it.
  On the documented 1000-package fixture that was on the order of 16,000 sequential round trips
  before a single test started running. Dependency lookups are now batched into one query per
  schema instead of per package.
- `utplsql.runWithTags` built its tag list only from Test Explorer nodes that had already been
  materialized, so a suite the user never individually expanded contributed no tags even though its
  `--%tags(...)` annotations exist — the common path (expand the connection root, immediately run
  "Run Tests with Tag") usually produced an empty list and a "no annotations found" error that was
  simply wrong. Tags are now read from the full discovery row set instead, complete regardless of
  what has been expanded; the tag QuickPick also now shows each tag's carrying-test count.
- `utplsql.runTestAtCursor`, `utplsql.runWithReporter` and `utplsql.generateTest` required an open
  editor holding a local PL/SQL file, making all three dead commands in a workspace with no local
  source at all — the database-as-sole-source-of-truth setup this extension is built to support.
  They now also resolve a `utplsql-source://` virtual document at the cursor, and, failing that,
  fall back to a QuickPick listing the database objects available for the chosen connection
  profile.
- `utplsql.setPassword` stored the new secret but left the profile's connection pool cached with
  the old password, so every subsequent query kept failing with `ORA-01017` until the window was
  reloaded even though the stored password was already correct; `utplsql.removeConnection` rewrote
  settings and deleted the secret but never closed the pool, leaving the removed profile's Oracle
  sessions open for the rest of the window. Both commands now close the pool and clear every
  per-profile cache. The Test Explorer also now reconciles its root nodes live off
  `utplsql.connections`, so adding or removing a profile — via either command, or by hand-editing
  `settings.json` — updates the tree immediately instead of needing "Refresh Tests" or a window
  reload.
- `utplsql.addConnection` wrote the new profile to settings before prompting for its password, so
  cancelling the password prompt left a persisted, unusable profile behind; a duplicate profile
  name surfaced as VS Code's generic "command failed" notification instead of a clear error. The
  profile name and default schema are now validated as you type — an empty name, one containing `/`
  or `:` (both break `TestItem` id parsing), or a name that already exists are all rejected before
  the password prompt is ever shown — every answer is gathered before anything is persisted, and a
  duplicate name now shows an actual error message instead of a generic failure.
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
- The coverage HTML report (`utplsql.coverage.htmlReport`) is no longer rendered in an
  extension-host webview. `ut_coverage_html_reporter`'s output is assembled by the database from
  database-derived text (schema/object names, verbatim source lines) that utPLSQL does not escape,
  so on a shared schema it is not necessarily content the viewer wrote themselves. It is now
  written to a temporary file with a hardened CSP and offered via a notification (**Open in
  Browser** / **Save As…**) instead — a browser tab has no `acquireVsCodeApi()` to reach and no
  extension UI to impersonate. The report no longer opens automatically beside the editor, and now
  opens in the OS browser instead of inside VS Code.

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
