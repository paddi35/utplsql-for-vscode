# utPLSQL for VS Code

Run and debug [utPLSQL](https://github.com/utPLSQL/utPLSQL) unit tests directly from Visual
Studio Code's native Testing API — Test Explorer, gutter run icons, inline failure locations,
code coverage and reporter export, without needing SQL Developer, PL/SQL Developer or the
`utPLSQL-cli`.

## Features

- **Test Explorer integration** — suites, contexts and tests are discovered straight from the
  database (`ut_runner.get_suites_info`) and mapped onto your workspace source files.
- **Gutter icons & run-at-cursor** — run the suite/test under the cursor with
  `utPLSQL: Run Test at Cursor`, or from the Test Explorer / editor gutter.
- **Live progress** — tests stream results one at a time via the real-time reporter protocol
  instead of waiting for the whole suite to finish.
- **Failure locations** — failed expectations jump straight to the failing line inside the
  package **body**, not just the test procedure.
- **Code coverage** — per-line coverage in the native VS Code Coverage view
  (`ut_coverage_sonar_reporter`), with an optional rendered HTML report on the side.
- **Reporter export** — run any output reporter your utPLSQL install offers (documentation,
  JUnit, TAP, TeamCity, Sonar, …) to the Output channel or a file.
- **Test generation** — scaffold a test package for the package/procedure/function under the
  cursor.
- **Snippets** for common utPLSQL annotations (`sql` / `oracle-sql` language IDs).

## Requirements

- Oracle Database with **utPLSQL >= 3.1.3** installed (>= 3.1.4 for the real-time reporter used
  for running tests; discovery and reporter export need >= 3.1.3 for `get_suites_info`).
- VS Code **1.85** or newer.
- Network access from the machine running VS Code to the database (this extension connects
  directly via [`node-oracledb`](https://github.com/oracle/node-oracledb) in Thin mode — no
  Oracle Client install required).

## Getting started

1. Run **utPLSQL: Add Connection** and provide a profile name, DB user, and an Easy-Connect
   string or TNS alias (pick "Enter manually" if no `tnsnames.ora` is configured, see
   `utplsql.connections.tnsAdminPath` below). You'll be prompted for the password, which is
   stored in VS Code's `SecretStorage` — never in settings.
2. Open the **Testing** view. The new connection profile appears as a root node; expanding it
   discovers schemas with utPLSQL suites, then the suite/context/test tree per schema.
3. Run tests from the Testing view, from gutter icons next to `--%suite`/`--%test` annotations
   in your source files, or via **utPLSQL: Run Test at Cursor**.
4. Use the **Run with Coverage** profile to get per-line coverage in the editor.

Your source files need a language ID this extension recognizes (`sql` or `oracle-sql` by
default — see `utplsql.discovery.languageIds`) so it can map database objects to files. This
extension contributes an `oracle-sql` language for common PL/SQL file extensions
(`.pkb`, `.pks`, `.pls`, `.plb`, `.tps`, `.tpb`, `.prc`, `.fnc`, `.trg`, `.vw`); add matching
entries to `files.associations` yourself for any extensions it doesn't already cover.

## Commands

| Command | Description |
|---|---|
| `utplsql.addConnection` | Add a new connection profile. |
| `utplsql.setPassword` | (Re-)store a connection's password in `SecretStorage`. |
| `utplsql.removeConnection` | Remove a connection profile and its stored password. |
| `utplsql.runTestAtCursor` | Run the suite/test/package at the cursor position. |
| `utplsql.runWithReporter` | Run the package at the cursor with a chosen output reporter, to the Output channel or a file. |
| `utplsql.generateTest` | Generate a test package skeleton for the unit at the cursor. |

## Settings

| Setting | Default | Description |
|---|---|---|
| `utplsql.connections` | `[]` | Connection profiles (`name`, `user`, `connectString`, optional `defaultSchema`). Managed via the commands above; edit directly only if you know what you're doing. |
| `utplsql.connections.tnsAdminPath` | `""` | Folder containing `tnsnames.ora`. Falls back to the Oracle SQL Developer extension's `sqldeveloper.connections.tnsConfiguration.path`, then `TNS_ADMIN`. If empty and you enter a TNS alias directly as the connect string, `node-oracledb` still resolves it itself at connect time. |
| `utplsql.discovery.languageIds` | `["sql", "oracle-sql"]` | Language IDs treated as PL/SQL source for discovery and parsing. |
| `utplsql.coverage.htmlReport` | `false` | Also render an `ut_coverage_html_reporter` report in a webview alongside the native coverage view. |
| `utplsql.generate.*` | see `package.json` | Test generation options: package/unit prefix/suffix, tests-per-unit, comments, disabled-by-default, suite path, indent. Mirrors utPLSQL's SQL Developer test generator settings. |

## Known limitations

- **No PL/SQL debugger.** VS Code has no built-in PL/SQL debug adapter for this extension to
  drive, so stepping through PL/SQL is out of scope for now.
- **Suite path collisions across schemas.** utPLSQL suite paths don't carry the owning schema.
  Running suites that share the same path in two different schemas in a single run can
  misattribute a live event to the wrong schema's test item — the same known limitation Oracle
  SQL Developer's utPLSQL integration has.

## Development

```sh
npm install
npm run test          # typecheck + unit tests (no database needed)
npm run watch          # esbuild --watch, for iterating in the Extension Development Host (F5)
npm run package        # build a .vsix with vsce
```

Integration tests need a real utPLSQL-equipped Oracle instance. A ready-made one is available via
Docker. The credentials it uses (`ut3` / `oracle`, overridable via `ORACLE_PASSWORD`) are
throwaway defaults for a local, disposable container — never point this compose file at anything
reachable from outside your machine:

```sh
docker compose up -d --build   # starts gvenzl/oracle-free with utPLSQL installed into schema UT3
npm run test:integration
```

Point the integration tests at a different instance/schema with the `UTPLSQL_IT_USER`,
`UTPLSQL_IT_PASSWORD` and `UTPLSQL_IT_CONNECT_STRING` environment variables (defaults match the
`docker-compose.yml` setup above).

## Credits

This extension's database protocol layer is a TypeScript port of
[utPLSQL for SQL Developer](https://github.com/utPLSQL/utPLSQL-SQLDeveloper) (Apache-2.0) — its
`UtplsqlDao`/`RealtimeReporterDao`, event model, PL/SQL parser and test generator are
IDE-independent and were reused rather than reinvented. See [NOTICE](./NOTICE) for the full
attribution.

## Security

- Passwords are stored only in VS Code's `SecretStorage`, never in settings and never written to
  the output channel.
- `utplsql.connections` and `utplsql.connections.tnsAdminPath` are **machine-scoped**: a
  workspace cannot contribute or override them, so opening someone else's repository can't
  redirect a connection profile (and its stored password) at another host.
- The extension is disabled in [untrusted workspaces](https://code.visualstudio.com/docs/editor/workspace-trust).

Found a security issue? Please report it via
[GitHub Security Advisories](https://github.com/paddi35/utplsql-for-vscode/security/advisories/new)
rather than a public issue.

## License

[Apache-2.0](./LICENSE) — see also [NOTICE](./NOTICE).
