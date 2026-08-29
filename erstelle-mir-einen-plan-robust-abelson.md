# utPLSQL für Visual Studio Code — Implementierungsplan

## Kontext

utPLSQL wird heute in SQL Developer (dieses Repo, Java/Swing/Maven), PL/SQL Developer, per
`utPLSQL-cli` und per Maven-Plugin unterstützt. Für Visual Studio Code gibt es keine dedizierte
Integration — lediglich dbFlux ruft SQLcl auf und schreibt das Ergebnis in einen Output-Channel,
ohne Anbindung an die VS Code Testing API.

Ziel ist eine eigenständige VS-Code-Extension, die utPLSQL-Tests über die **native VS Code Testing
API** (Test Explorer, Gutter-Icons, Coverage-Ansicht) verfügbar macht. Fachliche Referenz ist die
SQL-Developer-Extension in diesem Repo: deren DB-Protokoll (`UtplsqlDao`, `RealtimeReporterDao`,
`model/runner/*`, `parser/UtplsqlParser`) ist IDE-unabhängig und wird nach TypeScript portiert.
Alles, was an Swing/JDeveloper hängt (`ui/`, `menu/`, `oddgen/`, `snippet/SnippetMerger`), wird
durch VS-Code-Bordmittel ersetzt.

### Getroffene Entscheidungen

| Thema | Entscheidung |
|---|---|
| DB-Zugriff | `node-oracledb` **Thin Mode** für alles (Discovery *und* Ausführung) |
| Discovery | DB-Dictionary (`ut_runner.get_suites_info`) als Quelle der Wahrheit, plus Workspace-Index zum Mappen auf Datei/Zeile |
| Dateierkennung | über **Language-ID** `sql` / `oracle-sql`, **nicht** über Dateiendung |
| Umfang v1 | Testausführung, Code Coverage, Test-Generierung & Snippets, Reporter-Export |
| Ablageort | offen — Plan ist ortsunabhängig formuliert |

### Warum node-oracledb und nicht utPLSQL-cli

Drei belegte Blocker gegen den CLI-Ansatz:

1. **`utPLSQL-cli` kann keine Tests auflisten.** Es kennt nur `run`, `info`, `reporters`
   (`org/utplsql/cli/*Command.java`). Die gewählte Discovery über `ut_runner.get_suites_info`
   braucht zwingend eine eigene SQL-Verbindung.
2. **Credentials stehen in der Prozessliste** — `ConnectionConfig` parst `user/passwort@connect`
   aus einem positionalen Argument.
3. **ojdbc liegt der CLI nicht bei** (`OracleLibraryChecker.checkOjdbcExists()`); wir müssten es
   selbst redistribuieren, zusätzlich zu einer JRE pro Plattform-Target.

`node-oracledb` im Thin Mode ist dagegen reines JavaScript — die mitgelieferten Thick-Mode-Binaries
entfernt `npm run prune all`, damit entfällt jedes Electron-/ABI-Risiko. `REF CURSOR` als OUT-Bind,
`CLOB` und `fetchArraySize` sind unterstützt, was den `ut_realtime_reporter` exakt abdeckt.

---

## Architektur

```
src/
  extension.ts                Aktivierung, Registrierung von Controller/Commands
  db/
    pool.ts                   oracledb-Bootstrap (Thin), Pool pro Verbindungsprofil
    connections.ts            Profile aus Settings + Passwörter aus SecretStorage
    utplsqlDao.ts             Port von UtplsqlDao
    realtimeDao.ts            Port von RealtimeReporterDao (produce / consume / coverage)
    reporterDao.ts            generischer Reporter-Lauf (Export-Command)
  model/
    events.ts                 PreRunEvent … PostTestEvent, Counter, Expectation
    tree.ts                   Suite / Test / Run (Aggregat, Zähler, Status-Eskalation)
    eventParser.ts            XML → Event (fast-xml-parser)
  testing/
    controller.ts             TestController, resolveHandler, refreshHandler
    ids.ts                    TestItem-ID ⇄ utPLSQL-Pfad, Dedup nicht-überlappender Mengen
    runHandler.ts             Run-Profil: produce/consume, Events → TestRun
    coverage.ts               Coverage-Profil, loadDetailedCoverage, HTML-Webview
  workspace/
    languageIndex.ts          Kandidatendateien über Language-IDs ermitteln
    plsqlParser.ts            Port von UtplsqlParser (Regex-Scanner)
    sourceIndex.ts            PACKAGE[.PROC] → Uri + Range, ut_file_mappings
  generate/
    testTemplate.ts           Port von oddgen/TestTemplate + TestGenerator
  commands/                   runAtCursor, runWithReporter, generateTest, Verbindungspflege
snippets/utplsql.code-snippets
```

Abhängigkeiten: `oracledb` (≥ 6.x, Thin), `fast-xml-parser`, `esbuild`, `@vscode/test-cli`.

---

## Arbeitspakete

### AP1 — Gerüst und Verbindungen

`contributes.configuration`-Setting `utplsql.connections`: Array aus
`{ name, user, connectString, defaultSchema? }`. Passwörter ausschließlich in
`context.secrets` (`SecretStorage`), Schlüssel = Profilname. Commands
`utplsql.addConnection`, `utplsql.setPassword`, `utplsql.removeConnection`.

`db/pool.ts` legt pro Profil einen Pool an (`poolMin: 0`, `poolMax: 2 + Anzahl Reporter`,
`poolIncrement: 1`). Zwei Sessions pro Testlauf sind zwingend — eine produziert, eine konsumiert.

### AP2 — DAO-Portierung

`utplsqlDao.ts` — 1:1 aus `sqldev/src/main/java/org/utplsql/sqldev/dal/UtplsqlDao.java`:

* Versionserkennung `BEGIN :ver := ut.version; END;`, Normalisierung auf
  `major*1000000 + minor*1000 + bugfix`. Schwellwerte übernehmen:
  `3001004` Realtime-Reporter, `3001008` `has_suites`/`is_suite`/`is_test`,
  `3001003` `get_suites_info`. Unterhalb 3.1.4 wird die Extension nicht aktiv (kein
  Worksheet-Fallback wie in SQL Developer — VS Code hat kein Äquivalent).
* `isDbaViewAccessible()` (Probe `SELECT 1 FROM dba_objects WHERE 1=2 UNION ALL …`) und
  `getDbaView()` → Präfix `dba_` bzw. `all_`.
* Discovery:
  ```sql
  SELECT object_owner, object_name, item_name, item_description, item_type,
         item_line_no, path, disabled_flag, disabled_reason, tags
    FROM TABLE(ut_runner.get_suites_info(upper(:owner), upper(:pkg)))
  ```
  `item_type` ∈ `UT_SUITE` / `UT_SUITE_CONTEXT` / `UT_TEST` (aus
  `source/api/ut_suite_item_info.tps`). `item_line_no` und `disabled_flag`/`tags` gibt es in
  SQL Developer nicht — sie werden hier für Gutter-Position, `TestItem.tags` und
  Skip-Status genutzt.
* `includes(owner, name)` über `{dba|all}_dependencies` für die Coverage-Objektliste,
  inkl. der Ausschlussliste Oracle-eigener Schemas und `APEX\_______`.
* **Hinweis:** Der Fehler in `UtplsqlDao.htmlCodeCoverage` (Zeile 926,
  `excludeObjectList.isEmpty()` statt `!…isEmpty()`) wird nicht mitportiert.

### AP3 — Realtime-Reporter

`realtimeDao.ts` — Port von `RealtimeReporterDao`.

Producer (aus `getProduceReportPlsql`, um die Optionen aus `ut_runner.pks` erweitert):

```sql
DECLARE
   l_reporter ut_realtime_reporter := ut_realtime_reporter();
BEGIN
   l_reporter.set_reporter_id(:id);
   l_reporter.output_buffer.init();
   sys.dbms_output.enable(NULL);
   ut_runner.run(
      a_paths     => ut_varchar2_list(<literale Pfade>),
      a_reporters => ut_reporters(l_reporter),
      a_tags      => :tags,
      a_random_test_order => :randomOrder,
      a_random_test_order_seed => :seed
   );
   sys.dbms_output.disable;
END;
```

Consumer:

```sql
DECLARE
   l_reporter ut_realtime_reporter := ut_realtime_reporter();
BEGIN
   l_reporter.set_reporter_id(:id);
   :cur := l_reporter.get_lines_cursor(a_initial_timeout => :timeout);
END;
```

Kritische Details, die über die UX entscheiden:

* **Streaming:** `fetchArraySize: 1` **und** `prefetchRows: 0` in den `execute`-Optionen, sonst
  kommen die Events gebündelt und der Live-Fortschritt verschwindet. Entspricht
  `jdbcTemplate.setFetchSize(1)` in `RealtimeReporterDao.consumeReport`.
  `RealtimeReporterFetchSizeTest.delayFreeStreamingConsumtion()` in diesem Repo ist die Vorlage
  für den entsprechenden Integrationstest.
* **Reihenfolge:** Consumer zuerst starten, 100 ms warten, dann Producer (SQL Developer
  Issue #80 — Konkurrenz auf der Output-Header-Tabelle).
* **Reporter-ID:** UUID ohne Bindestriche.
* `ITEM_TYPE` (VARCHAR2) und `TEXT` (CLOB) sind die Cursor-Spalten; `TEXT` per
  `fetchTypeHandler` bzw. `oracledb.fetchAsString = [oracledb.CLOB]` als String holen.
* **Abbruch:** `token.onCancellationRequested` → `connection.break()`, danach
  `close({ drop: true })` auf der Consumer-Verbindung. Die DB-Session läuft weiter — dieselbe
  bewusste Einschränkung wie in `RunnerPanel` („database session is not cancelled. This is not a
  bug."). Noch offene Tests werden als `skipped` mit erklärender `TestMessage` markiert.

### AP4 — Event-Parsing

`eventParser.ts` bekommt `(itemType, xml)`. Der Event-Typ steht **doppelt** zur Verfügung: in der
Spalte `ITEM_TYPE` und als Attribut `type` auf `<event>` (siehe
`ut_realtime_reporter.tpb`, `print_start_node('event', 'type', 'pre-run')`). Wir nutzen die Spalte
und validieren gegen das Attribut.

Sechs Event-Typen: `pre-run`, `post-run`, `pre-suite`, `post-suite`, `pre-test`, `post-test`.

| Element | Felder |
|---|---|
| `<suite id="…">` | `name`, `description`, `items/*` (rekursiv) |
| `<test id="…">` | `executableType`, `ownerName`, `objectName`, `procedureName`, `disabled`, `disabledReason`, `name`, `description`, `testNumber` |
| `post-*` | `startTime`, `endTime`, `executionTime`, `counter/{disabled,success,failure,error,warning}`, `errorStack`, `serverOutput`, `warnings` |
| `post-test` zusätzlich | `failedExpectations/expectation/{description,message,caller}` |

`pre-run` liefert zusätzlich `totalNumberOfTests` und den kompletten Item-Baum.

Parse-Fehler werden **geloggt und übersprungen, nicht geworfen** — Übernahme der bewussten
Entscheidung aus SQL Developer Issue #107.

### AP5 — Test Explorer

`vscode.tests.createTestController('utplsql', 'utPLSQL')`.

ID-Schema (`testing/ids.ts`):

```
conn:<profil>                                Wurzel je Verbindungsprofil
conn:<profil>/schema:<OWNER>
conn:<profil>/path:<OWNER>:<suitepath>       Suite, Context und Test
```

Der Lauf-Pfad an utPLSQL ist `OWNER:suitepath` — die Suitepath-Syntax aus `ut_runner.pks`.
Vor dem Start werden überlappende Auswahlen reduziert (Port von
`UtplsqlController.dedupPathList` bzw. `ItemNode.createNonOverlappingSet`).

* `resolveHandler`: Wurzel → Schemata über `ut_runner.has_suites`; Schema → Suite-Baum aus
  `get_suites_info`.
* `refreshHandler`: erneutes Laden; optional vorher `ut_runner.purge_cache`.
* `TestItem.tags` aus der Spalte `tags`; `TestItem.range`/`uri` aus dem Workspace-Index (AP6),
  Fallback auf `item_line_no`, sobald die Datei gefunden ist.

Event → `TestRun`-Mapping im `runHandler`:

| Event | Aktion |
|---|---|
| vor Start | `run.enqueued()` auf allen einbezogenen Items |
| `pre-run` | Baum abgleichen, fehlende Items nachlegen |
| `pre-suite` / `pre-test` | `run.started(item)` |
| `post-test` | Zähler auswerten → `passed` / `failed` / `errored` / `skipped`, Dauer `executionTime * 1000` |
| `post-suite` | Zähler aggregieren; Suite-Warnungen dem laufenden Test zuschlagen (wie `doProcess(PostSuiteEvent)`) |
| `post-run` | `run.end()` |

Status-Eskalation aus `Item.getStatusIcon()` übernehmen:
`error > 0` → errored, sonst `failure > 0` → failed, sonst `success > 0` → passed, sonst
`disabled > 0` → skipped.

`failedExpectations` werden zu `vscode.TestMessage`. Die Zeilennummer kommt aus `caller` über die
Regex aus `Expectation.getCallerLine()`: `(?i)"[^\"]+",\s+line\s*([0-9]+)` — damit zeigt VS Code
den Fehler direkt am Package-**Body**. `expectedOutput`/`actualOutput` werden best-effort aus dem
`message`-Text extrahiert (utPLSQL formuliert „Actual: … was expected to …"); gelingt das nicht,
bleibt nur `message`.

`serverOutput` und `errorStack` gehen per `run.appendOutput()` in das Terminal des Laufs —
**Zeilenenden zwingend als CRLF**, sonst rendert VS Code die Ausgabe falsch.

### AP6 — Workspace-Index über Language-IDs

Es gibt keine öffentliche API, die einem Pfad ohne Öffnen eine Language-ID zuordnet. Deshalb wird
die Menge relevanter Datei-Muster aufgebaut aus:

1. `vscode.extensions.all[].packageJSON.contributes.languages`, gefiltert auf
   `id ∈ utplsql.discovery.languageIds` (Default `["sql", "oracle-sql"]`) → deren `extensions`
   und `filenames`;
2. den Einträgen aus `files.associations`, die auf eine dieser IDs zeigen;
3. bereits offenen Dokumenten aus `vscode.workspace.textDocuments` mit passender `languageId`.

Daraus ein Glob für `vscode.workspace.findFiles`. Aktuell gehalten über
`onDidOpenTextDocument`, `onDidChangeTextDocument` (debounced) und einen `FileSystemWatcher`.

`plsqlParser.ts` portiert die beiden Regexe aus `UtplsqlParser`:

```
(?i)(\s*)(create(\s+or\s+replace)?\s+(package|type|function|procedure)\s+(body\s+)?)([^\s]+)(\s+)
(?i)(\s*)(procedure)(\s+)([^\s\(;]+)
```

Vorher werden Kommentare und String-Literale entfernt. Ergebnis: Index
`PACKAGE[.PROCEDURE]` → `{ uri, range, isBody }`, case-insensitiv. Der Owner steht in der Datei
meist nicht und kommt aus dem Verbindungsprofil.

Zwei Verwendungen: Sprung von Fehler zu Quellzeile, und `utplsql.runTestAtCursor` — Pfad aus der
Cursorposition wie `UtplsqlParser.getPathAt`.

### AP7 — Code Coverage

Coverage-Profil via `createRunProfile(…, TestRunProfileKind.Coverage, …)`.

Der Lauf hängt einen zweiten Reporter an denselben `ut_runner.run`-Aufruf — Vorbild
`RealtimeReporterDao.produceReportWithCoverage`, das `ut_reporters(l_rt_rep, l_cov_rep)` verwendet.
Für die native Coverage-Ansicht brauchen wir zeilengenaue Daten pro **Workspace-Datei**, also
`ut_coverage_sonar_reporter` (Default) oder `ut_coverage_cobertura_reporter`, kombiniert mit
`a_source_file_mappings`:

```sql
a_source_file_mappings => ut_file_mappings(
   ut_file_mapping('db/sources/pkg_x.pkb', 'HR', 'PKG_X', 'PACKAGE BODY'),
   …
),
a_coverage_schemes => ut_varchar2_list(…),
a_include_objects  => ut_varchar2_list(…),
a_exclude_objects  => ut_varchar2_list(…)
```

Die Mappings werden aus dem Workspace-Index (AP6) erzeugt und **als Literale in den anonymen Block
geschrieben**, nicht als DbObject gebunden — analog zu `ut_varchar2_list` in SQL Developer. Das
vermeidet Objekttyp-Bindings komplett. Objektnamen werden gegen `[A-Za-z0-9_$#.]` validiert und
einfache Anführungszeichen verdoppelt (`StringTools.getCSV` in diesem Repo escaped **nicht** —
das wird hier nachgeholt).

Ergebnis → `run.addCoverage(new vscode.FileCoverage(uri, statementCoverage))`;
`profile.loadDetailedCoverage` liefert `StatementCoverage(executed, new Position(line, 0))` je
gemessener Zeile.

Zusätzlich optional (`utplsql.coverage.htmlReport`) `ut_coverage_html_reporter` als dritter
Reporter, dessen Ausgabe in einem Webview landet. **Korrektur gegenüber der ursprünglichen
Planung:** `ut_coverage_html_reporter` liefert ein vollständig eigenständiges HTML-Dokument
(CSS/JS inline via `<style>`/`<script>`), das keine externen Asset-Dateien referenziert — anders
als angenommen gibt es kein Pendant zu `sqldev/src/main/resources/coverage/assets/`, das über
`webview.asWebviewUri` eingebunden werden müsste (dieser Ordner existiert in diesem Repo auch gar
nicht). `showHtmlReport()` setzt den Reporter-Output daher direkt als `webview.html`, mit
`enableScripts: false` (der Report braucht keine Interaktivität). Das entspricht weiterhin nicht
`CodeCoverageReporter.openInBrowser`: kein Temp-Verzeichnis, kein externer Browser.

### AP8 — Reporter-Export

Command `utplsql.runWithReporter`: Quick-Pick aus

```sql
SELECT reporter_object_name, is_output_reporter FROM TABLE(ut_runner.get_reporters_list())
```

gefiltert auf `is_output_reporter = 'Y'`. Der gewählte Typname wird gegen genau diese Liste
validiert und dann in den anonymen Block eingesetzt:

```sql
DECLARE
   l_reporter <REPORTER_TYPE> := <REPORTER_TYPE>();
BEGIN
   l_reporter.set_reporter_id(:id);
   l_reporter.output_buffer.init();
   ut_runner.run(a_paths => …, a_reporters => ut_reporters(l_reporter));
END;
```

Konsumiert wird analog über `get_lines_cursor()` ohne Timeout. Ziel: Datei (Quick-Pick) oder
Output-Channel. Deckt `ut_documentation_reporter`, `ut_junit_reporter`, `ut_tap_reporter`,
`ut_teamcity_reporter`, `ut_sonar_test_reporter`, `ut_tfs_junit_reporter`, `ut_debug_reporter` ab —
also den Funktionsumfang von `utplsql-cli run -f=… -o=…`.

### AP9 — Generierung und Snippets

Port von `oddgen/TestTemplate.java` und `oddgen/TestGenerator.java`: Command
`utplsql.generateTest` auf einem Package/Type/Function/Procedure erzeugt ein Testpackage-Skelett in
einem neuen Untitled-Dokument. Kandidaten kommen aus der `user_procedures`-Abfrage in
`UtplsqlDao.testables`. Settings übernehmen: `testPackagePrefix` (`test_`), `testPackageSuffix`,
`testUnitPrefix`/`-Suffix`, `numberOfTestsPerUnit` (1), `generateComments` (true),
`disableTests` (false), `suitePath` (`alltests`), `indentSpaces` (3).

Snippets aus `sqldev/src/main/resources/…/UtplsqlSnippets.xml` nach
`snippets/utplsql.code-snippets` konvertieren und per `contributes.snippets` für die
Language-IDs `sql` und `oracle-sql` registrieren — der `SnippetMerger`-Mechanismus entfällt
ersatzlos.

**Nicht in v1:** Debugging. VS Code hat keinen PL/SQL-Debugger, den wir wie
`DBStarterFactory.PlSqlStarter` ansteuern könnten.

---

## Offene Punkte / Spikes vor dem Ausbau

1. **Streaming-Spike (zuerst, blockierend für AP3):** Verhalten von `fetchArraySize` /
   `prefetchRows` auf einem als OUT-Bind gelieferten `REF CURSOR` in node-oracledb Thin
   verifizieren. Messkriterium wie im vorhandenen Java-Test: ein Test mit 2 s Laufzeit muss ~2 s
   nach dem vorigen Event ankommen, nicht am Ende gebündelt.
2. **Suitepath-Kollision:** Event-IDs (`a_suite.path`) enthalten den Owner nicht. Bei einem Lauf
   über mehrere Schemata sind Pfade mehrdeutig. Auflösung über `Test.ownerName` plus eine
   Zuordnungstabelle, die aus dem `pre-run`-Baum gegen die angeforderten Items aufgebaut wird.
   SQL Developer hat dieselbe Schwäche und löst sie nicht.
3. **Coverage-Dateipfade:** Ob der Sonar-Reporter die Pfade exakt so zurückgibt, wie sie in
   `ut_file_mapping.file_name` übergeben wurden, ist gegen eine echte DB zu prüfen (relativ vs.
   absolut, Trennzeichen unter Windows).

---

## Verifikation

**Unit-Ebene (ohne DB):** `eventParser` gegen aufgezeichnete XML-Fixtures aller sechs Event-Typen;
`plsqlParser` gegen die Testfälle aus `sqldev/src/test/java/.../parser/`; `ids.ts`-Dedup gegen die
Fälle aus `UtplsqlControllerTest`.

**Integration (mit DB):** Docker-Container `gvenzl/oracle-free` plus utPLSQL-Installation
(`source/install_headless.sql`) und den Beispielsuiten. Abgedeckt:

* Discovery liefert den erwarteten Baum inkl. Contexts, disabled-Flags und Tags.
* Ein Lauf über eine Suite mit Erfolg, Failure, Error und disabled-Test setzt alle vier
  `TestRun`-Zustände korrekt.
* Streaming-Test aus Spike 1 als Dauertest.
* Abbruch während eines langlaufenden Tests beendet den `TestRun` und lässt keine Verbindung
  im Pool zurück.
* Coverage-Lauf erzeugt `FileCoverage` für eine Workspace-Datei mit plausiblen Zeilentreffern.
* Reporter-Export mit `ut_documentation_reporter` erzeugt dieselbe Ausgabe wie
  `utplsql run … -f=ut_documentation_reporter`.

**Manuell (`F5`, Extension Development Host):** Verbindung anlegen, Test Explorer öffnen, Einzeltest
per Gutter-Icon starten, Failure anklicken und im Package-Body auf der richtigen Zeile landen,
Coverage-Lauf starten und die Einfärbung im Editor prüfen.
