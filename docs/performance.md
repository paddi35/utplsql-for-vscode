# Performance testing the Test Explorer tree view

This is the harness for measuring how the extension's Test Explorer tree
(discovery, run, tree-view rendering) behaves at a realistic large scale —
1000 test packages with 10-20 tests each (~15,000 tests total), a mix of
outcomes (pass/fail/error/disabled) and durations (most instant, 10% a short
fixed delay, 10% 2-10s), and enough tree depth (`--%suitepath`,
`--%context`) to exercise the parent-lookup logic the tree builder uses.

It does **not** fix any of the performance issues it finds — see
[Findings](#findings) below for what generating and running this fixture
against a live utPLSQL 3.2.3 instance actually turned up. Fixing those is
deliberately a separate piece of work.

## The fixture

`test/perf/support/perfFixture.sql` installs one small package,
`ut_perf_gen`, plus a one-row config table `ut_perf_config`. It does **not**
ship 1000 `.sql` files — it generates the packages directly in the database
via `EXECUTE IMMEDIATE`, from a deterministic hash of `(package, test
number, seed)`, so the same seed always reproduces the same tree.

Two independent axes per test:

- **Outcome** (`~75%` pass, `~10%` fail, `~5%` raise an unhandled exception,
  `~10%` `--%disabled`)
- **Duration** (`~80%` instant, `~10%` a short fixed delay, `~10%` sleep
  2-10s — the "slow" tier)

A slow test can also be a failing test; a disabled test can also have been
tagged "slow" (it just never runs its sleep, same as any other disabled
test never runs its body).

Tree shape: `~40%` of packages carry `--%suitepath(perf.gNN)` (20 groups,
so the tree has non-trivial branching above the package level), and `~20%`
additionally nest their last test under `--%context(nested)`.

### The three run modes

The "slow"/"medium" sleep durations are **not** baked into the compiled
test bodies. Each generated test reads a `sleep_scale` multiplier from
`ut_perf_config` at run time (`ut_perf_gen.scale()`), so the same
already-generated ~15,000 tests can run in three modes without
regenerating anything:

| Mode | `sleep_scale` | Approx. wall time | What it isolates |
|---|---|---|---|
| `tree` | `0` | a few minutes | Discovery, tree build, event-streaming overhead — test execution time is ~0, so this measures everything *around* running a test |
| `mixed` | `0.1` | tens of minutes | A realistic spread of test durations in the tree view |
| `full` | `1` | ~2.5 hours | The actual 2-10s tests, end to end — nightly/on-demand only |

## Running it

Needs the same local Oracle+utPLSQL instance as `test/integration` (see its
own docs — `docker compose up -d`, then wait for the container to report
healthy).

```bash
npm run perf:generate                 # 1000 packages, seed 42 (defaults)
npm run perf:generate -- 200 10 20 7  # fewer packages / a different seed, for a quick local check
npm run perf:scale -- 0.1             # switch the already-generated fixture to "mixed" mode
npm run perf:drop                     # remove all UT_PERF_TEST_* packages

npm run test:perf                     # generates its own fixture, runs the perf suite, drops it again
```

`test/perf/**/*.perf.test.ts` runs on demand / weekly via
`.github/workflows/performance.yml`, **not** on every push/PR — same
reasoning as `test/integration`: an infra-dependent, multi-minute suite does
not belong on the critical path of the normal dev/review loop. One
CPU-only exception: `test/unit/dedupPathList.perf.test.ts` needs no DB and
does run in the normal CI, as an early-warning regression guard for the
one hotspot with the clearest reproduction (see below).

Every measurement is appended as one JSON line to
`test-results/perf-report.jsonl` (git-ignored locally; uploaded as a CI
artifact) via `test/perf/support/timing.ts`'s `recordMeasurement()` — a
trend to look at, not something asserted against directly. **None of these
tests assert a tight wall-clock bound** — timings are machine-dependent.
They assert structural correctness (row counts, event counts, outcome
mix) plus a generous ceiling that today's *unoptimized* code still clears
comfortably, so they measure without being a tight regression gate.

## In-extension instrumentation

Two settings, both off by default:

- `utplsql.perf.enabled` — times `getSuitesInfo`, `getPackageObjectTypes`,
  `buildSchemaTree`, `groupRequest`/`dedupPathList`, and the realtime
  event-stream throughput (events/s), writing each to the `utPLSQL` output
  channel (see `src/perf.ts`). Set `utplsql.perf.reportFile` to also append
  each measurement as a JSON line to a file.
- `utplsql.trace` — the previously-unconditional per-event log lines
  (`pre-suite`, `pre-test`, `post-test`, one `received event` line per row)
  now sit behind this setting instead of always running, since at ~30,000+
  events for a full fixture run they were a measurable cost of their own.

## Manual checklist (real Extension Host, real tree view)

None of the automated levels above touch the actual VS Code Test Explorer
UI — `buildSchemaTree` (`src/testing/controller.ts`) is built directly
against `vscode.TestController`/`vscode.TestItem`, so measuring the real
tree view needs a real Extension Development Host, not headless mocha. This
project does not yet have an `@vscode/test-electron` harness to automate
that (a real gap — see [Open follow-ups](#open-follow-ups)); until then,
check manually:

1. `npm run perf:generate`, then F5 (Extension Development Host) against a
   connection profile pointed at the same schema.
2. Expand the connection root, then the schema node — note how long the
   tree takes to populate (1000 top-level items, most sitting under 20
   `perf.gNN` groups).
3. Use the Test Explorer's built-in filter box against a substring like
   `perf.g05` — check the tree stays responsive while filtering.
4. Run All. Watch the Test Results panel while ~15,000 results stream in;
   scroll the tree during the run.
5. Open "Developer: Show Running Extensions" and check this extension's
   activation/CPU time before and after.

## Findings

Generating and running this fixture against a live utPLSQL 3.2.3 / Oracle
23ai instance turned up a few concrete things, independent of the known
hotspots below:

- **`--%suite`/`--%suitepath` needs a blank line before the first
  `--%test`/`--%context`, or the whole package is silently invisible** to
  `get_suites_info`/`has_suites` — no error, just zero rows, on a package
  that compiles cleanly. Confirmed by isolating the exact annotation
  formatting on a live instance (see `perfFixture.sql`'s comments at the
  two spots this bites). Not previously documented anywhere in this
  codebase; worth knowing before writing `--%suite` blocks by hand too.
- **`--%context` has the same requirement** around its own block (a blank
  line after `--%context(...)` and before `--%endcontext`) — without it,
  the wrapped test still runs, but shows up flat under the suite instead of
  nested under a `UT_SUITE_CONTEXT`, with no error either.
- **`--%suitepath` groups report as `item_type = 'UT_LOGICAL_SUITE'`**,
  which `src/db/utplsqlDao.ts`'s `SuiteInfoRow['itemType']` type does not
  declare (only `'UT_SUITE' | 'UT_SUITE_CONTEXT' | 'UT_TEST'`). It does not
  crash — `buildSchemaTree`'s `itemType === 'UT_TEST' ? ... : ...` branch
  just treats it like a suite — but the type is incomplete, and any other
  itemType-specific handling added later should account for it.
- **`getPackageObjectTypes`'s `IN (...)` list does *not* hit Oracle's
  ORA-01795 (max 1000 expressions)** at 1000 names, or considerably beyond
  (verified up to 5000 in a single call) — because it uses one bind
  variable per name rather than inlining literals, and that 1000-element
  cap is specific to literal `IN`-lists. The original concern that this
  needed chunking for a 1000-package deployment does not hold; see
  `discovery.perf.test.ts`'s comment on that call.

## Known hotspots (not fixed here)

Reading `src/testing/*` and `src/db/*` while building this fixture surfaced
four concrete performance concerns, roughly in order of expected impact —
listed here as the punch list for the follow-up work this fixture exists to
measure, not fixed in this pass:

1. **`dedupPathList` (`src/testing/ids.ts`) is O(n²)** — `unique.filter(c
   => unique.some(isCoveredBy))`. "Run All" selects every path-bearing
   `TestItem` (suites, contexts *and* tests, not just leaves) into
   `groupRequest`'s candidate list before this runs. See
   `test/unit/dedupPathList.perf.test.ts` for a reproduction at a smaller
   (CI-fast) scale — its own recorded measurement already shows the
   quadratic cost.
2. **Realtime event streaming is one DB round-trip per event**
   (`fetchArraySize: 1` in `src/db/realtimeDao.ts`'s `openConsumer`) — this
   is *mandatory* for live progress, not a bug (see that function's own
   doc comment), but it means ~30,000+ round-trips for a full-fixture run,
   which is real latency on anything but a local/low-latency connection.
3. **Per-event output-channel logging** was unconditional before this
   change (now behind `utplsql.trace`, see above) — several `appendLine`
   calls per event add up across tens of thousands of events.
4. **`buildSchemaTree`'s sort comparator** (`src/testing/controller.ts`)
   recomputes `path.split('.').length` on every comparison rather than
   once per row up front — minor next to the other three, but free to fix
   alongside them.

## Open follow-ups

- An automated `@vscode/test-electron` level for the real tree view (see
  the manual checklist above) — not implemented in this pass.
- Fixing the hotspots above.
