import oracledb, { Connection } from 'oracledb';

export const VERSION_REALTIME_REPORTER = 3001004; // 3.1.4
export const VERSION_HAS_SUITES = 3001008; // 3.1.8 (has_suites / is_suite / is_test)
export const VERSION_GET_SUITES_INFO = 3001003; // 3.1.3

/** Schemas excluded from the coverage object list, mirroring UtplsqlDao. */
const EXCLUDED_SCHEMA_PATTERNS = [
    // Dependencies resolved through a PUBLIC synonym (e.g. a bare
    // DBMS_SESSION.sleep() call) show up with referenced_owner = 'PUBLIC',
    // not the underlying SYS/built-in package's real owner — without this,
    // any test calling a public-synonym'd built-in pulls it into
    // a_include_objects, and it then has no local source file so it's
    // wasted round-trips at best (see coverage.ts's "no local source file
    // found" logging) or a huge report to render at worst.
    'PUBLIC',
    'SYS',
    'SYSTEM',
    'OUTLN',
    'DBSNMP',
    'APPQOSSYS',
    'CTXSYS',
    'XDB',
    'ORDSYS',
    'ORDDATA',
    'MDSYS',
    'OLAPSYS',
    'LBACSYS',
    'GSMADMIN_INTERNAL',
    'AUDSYS',
    'DVSYS',
    'WMSYS',
    'ORACLE_OCM'
];

export interface SuiteInfoRow {
    objectOwner: string;
    objectName: string;
    itemName: string;
    itemDescription?: string;
    /** UT_LOGICAL_SUITE is a --%suitepath(...) grouping node, not a real suite/context/test — see parseItemType's doc comment. */
    itemType: 'UT_SUITE' | 'UT_SUITE_CONTEXT' | 'UT_TEST' | 'UT_LOGICAL_SUITE';
    itemLineNo?: number;
    path: string;
    disabledFlag: boolean;
    disabledReason?: string;
    tags?: string;
}

export interface ReporterInfo {
    reporterObjectName: string;
    isOutputReporter: boolean;
}

export interface TestableUnit {
    objectOwner: string;
    objectName: string;
    objectType: 'PACKAGE' | 'TYPE' | 'FUNCTION' | 'PROCEDURE';
    subobjectName?: string;
}

/**
 * Parses `ut.version` into major*1e6 + minor*1e3 + bugfix. utPLSQL returns
 * this prefixed, e.g. "v3.2.3.4508" or "v.3.2.3.4508" — that prefix must be
 * stripped first, otherwise parseInt("v") is NaN, `NaN || 0` silently
 * becomes 0, and every field shifts by one (major ends up 0).
 */
export function normalizeVersion(version: string): number {
    const cleaned = version.replace(/^v\.?/i, '');
    const parts = cleaned.split('.').map((p) => parseInt(p, 10));
    const major = parts[0] || 0;
    const minor = parts[1] || 0;
    const bugfix = parts[2] || 0;
    return major * 1000000 + minor * 1000 + bugfix;
}

export async function getVersion(conn: Connection): Promise<{ raw: string; normalized: number }> {
    const result = await conn.execute<{ ver: string }>(
        `BEGIN :ver := ut.version; END;`,
        { ver: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 100 } }
    );
    const raw = result.outBinds!.ver;
    return { raw, normalized: normalizeVersion(raw) };
}

/**
 * dba_/all_ view-prefix probe result, keyed by connection profile — mirrors
 * versionCache.ts's identically-shaped cache for ut.version. A bare
 * module-level boolean here used to let whichever profile happened to probe
 * first decide the view prefix for every *other* profile for the rest of
 * the session: the Test Explorer builds one root per connection profile,
 * and probing is triggered by whichever's includes()/getPackageObjectTypes()/
 * getObjectSource() call happens to run first. An unprivileged profile
 * probed second inherited a cached `true` and failed every dba_*-view query
 * with ORA-00942; a privileged profile probed second inherited a cached
 * `false` and silently lost coverage scope with no error at all — the worse
 * of the two, since dependencies visible only via dba_dependencies just
 * dropped out (issue #15). Kept in this file rather than moved next to
 * versionCache's cache: versionCache.ts already imports this module for
 * dao.getVersion(), and includes()/getPackageObjectTypes()/getObjectSource()
 * below need this cache directly, so moving it there would make the two
 * modules import each other.
 */
const dbaViewAccessible = new Map<string, boolean>();

export async function isDbaViewAccessible(conn: Connection, profile: string): Promise<boolean> {
    const cached = dbaViewAccessible.get(profile);
    if (cached !== undefined) {
        return cached;
    }
    let accessible: boolean;
    try {
        await conn.execute(`SELECT 1 FROM dba_objects WHERE 1 = 2 UNION ALL SELECT 1 FROM dual WHERE 1 = 2`);
        accessible = true;
    } catch {
        accessible = false;
    }
    dbaViewAccessible.set(profile, accessible);
    return accessible;
}

export async function getDbaView(conn: Connection, profile: string): Promise<'dba_' | 'all_'> {
    return (await isDbaViewAccessible(conn, profile)) ? 'dba_' : 'all_';
}

/** Clears the dba_/all_ probe cache for one profile, or every profile when omitted — call alongside clearVersionCache on refresh/profile removal so a mid-session grant change or a stale probe doesn't survive it. */
export function clearDbaViewCache(profile?: string): void {
    if (profile) {
        dbaViewAccessible.delete(profile);
    } else {
        dbaViewAccessible.clear();
    }
}

export async function hasSuites(conn: Connection, owner: string): Promise<boolean> {
    const result = await conn.execute<{ result: number }>(
        `BEGIN :result := CASE WHEN ut_runner.has_suites(upper(:owner)) THEN 1 ELSE 0 END; END;`,
        { owner, result: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } }
    );
    return result.outBinds!.result === 1;
}

/**
 * ut_suite_item_info.disabled_flag comes back from node-oracledb as a JS
 * `number` (0/1), not the 'Y'/'N' string its column name suggests —
 * confirmed against a live utPLSQL 3.2.3 instance. A string-only comparison
 * against 'Y'/'true' silently evaluates to false for every row, which made
 * disabled tests indistinguishable from enabled ones.
 */
export function parseDisabledFlag(value: unknown): boolean {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return value !== 0;
    }
    const s = String(value);
    return s === 'Y' || s === 'true' || s === '1';
}

/** TestItem.description text for a --%disabled row, or undefined for an enabled one. */
export function describeDisabled(row: Pick<SuiteInfoRow, 'disabledFlag' | 'disabledReason'>): string | undefined {
    if (!row.disabledFlag) {
        return undefined;
    }
    return row.disabledReason ? `disabled: ${row.disabledReason}` : 'disabled';
}

/**
 * Error message for running tests against a utPLSQL version too old for the
 * real-time reporter, or undefined when the version is new enough. Kept
 * separate from the VERSION_GET_SUITES_INFO gate in fetchSuiteRows
 * (controller.ts) — discovery and running have different minimum versions,
 * and reaching this gate at all means discovery's own (older) gate already
 * passed, so this failure previously surfaced only as a raw ORA error deep
 * inside the produce/consume protocol instead of an actionable message.
 */
export function checkRealtimeReporterSupport(version: { raw: string; normalized: number }, profile: string): string | undefined {
    if (version.normalized >= VERSION_REALTIME_REPORTER) {
        return undefined;
    }
    return `utPLSQL ${version.raw} is too old to run tests (needs >= 3.1.4 for the real-time reporter). Upgrade utPLSQL in '${profile}' first.`;
}

/** Distinct --%tags(...) values across a set of suite rows, sorted for a stable QuickPick order. */
export function collectTags(rows: Array<Pick<SuiteInfoRow, 'tags'>>): string[] {
    const tags = new Set<string>();
    for (const row of rows) {
        (row.tags ?? '')
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t.length > 0)
            .forEach((t) => tags.add(t));
    }
    return [...tags].sort();
}

const KNOWN_ITEM_TYPES: ReadonlySet<string> = new Set(['UT_SUITE', 'UT_SUITE_CONTEXT', 'UT_TEST', 'UT_LOGICAL_SUITE']);

/**
 * Narrows a raw item_type value from ut_runner.get_suites_info to the
 * declared SuiteInfoRow union, or undefined for anything getSuitesInfo has
 * never seen it return. Replaces a blind `as SuiteInfoRow['itemType']` cast
 * that silently accepted whatever the database sent back — which is exactly
 * how UT_LOGICAL_SUITE (the --%suitepath grouping node's item_type, ~40% of
 * the perf fixture's packages per docs/performance.md's "Findings") went
 * undeclared for as long as it did: the cast asserted the union was
 * complete instead of ever letting the compiler, or a log line, catch that
 * it wasn't. getSuitesInfo treats an undefined result as a suite — the same
 * treatment every non-UT_TEST value already gets via isTestItem below — but
 * only after reporting the raw value through its onUnknownItemType
 * callback, so a fifth item_type a future utPLSQL version introduces is
 * visible instead of silently absorbed again.
 */
export function parseItemType(value: unknown): SuiteInfoRow['itemType'] | undefined {
    const s = String(value);
    return KNOWN_ITEM_TYPES.has(s) ? (s as SuiteInfoRow['itemType']) : undefined;
}

/**
 * Whether a SuiteInfoRow is a leaf test rather than a suite/context/
 * --%suitepath grouping node — the one condition resolveLocation
 * (controller.ts) branches on. A --%suitepath group has no object_name of
 * its own to look up (get_suites_info reuses the group's path segment
 * there, not a real package), so routing it through the same
 * lookupPackage(row.objectName) call every other non-test row uses is
 * deliberate: SourceIndex.lookup() returns undefined for a name that never
 * matched a real package, which is exactly "no location for this row" —
 * the correct outcome for a node that isn't backed by one object, not a
 * false match.
 */
export function isTestItem(itemType: SuiteInfoRow['itemType']): boolean {
    return itemType === 'UT_TEST';
}

export async function getSuitesInfo(
    conn: Connection,
    owner?: string,
    pkg?: string,
    onUnknownItemType?: (raw: unknown) => void
): Promise<SuiteInfoRow[]> {
    const result = await conn.execute<Record<string, unknown>>(
        `SELECT object_owner, object_name, item_name, item_description, item_type,
                item_line_no, path, disabled_flag, disabled_reason, tags
           FROM TABLE(ut_runner.get_suites_info(upper(:owner), upper(:pkg)))`,
        { owner: owner ?? null, pkg: pkg ?? null }
    );
    return (result.rows ?? []).map((r) => {
        const itemType = parseItemType(r.ITEM_TYPE);
        if (itemType === undefined) {
            onUnknownItemType?.(r.ITEM_TYPE);
        }
        return {
            objectOwner: String(r.OBJECT_OWNER),
            objectName: String(r.OBJECT_NAME),
            itemName: String(r.ITEM_NAME),
            itemDescription: r.ITEM_DESCRIPTION ? String(r.ITEM_DESCRIPTION) : undefined,
            itemType: itemType ?? 'UT_SUITE',
            itemLineNo: r.ITEM_LINE_NO !== null && r.ITEM_LINE_NO !== undefined ? Number(r.ITEM_LINE_NO) : undefined,
            path: String(r.PATH),
            disabledFlag: parseDisabledFlag(r.DISABLED_FLAG),
            disabledReason: r.DISABLED_REASON ? String(r.DISABLED_REASON) : undefined,
            tags: r.TAGS ? String(r.TAGS) : undefined
        };
    });
}

/**
 * Objects reachable via {dba|all}_dependencies from `names` under `owner`,
 * for coverage scoping — one query per *owner*, not per object: `names` is
 * batched into a `name IN (:n0, :n1, ...)` list with one bind variable per
 * name, the same shape getPackageObjectTypes below already uses for its
 * `object_name IN (...)` list (see that function's doc comment — verified
 * against a live Oracle 23ai instance up to 5000 bind variables in one call,
 * well past ORA-01795's 1000-*literal*-expression limit, which a bind list
 * is not subject to). `profile` selects the dba_/all_ probe cache entry (see
 * getDbaView) — it does not otherwise affect the query.
 *
 * Issue #21: buildCoverageOptions (coverage.ts) used to call this once per
 * selected TestItem, with the same (owner, name) pair repeated for every
 * test/context/suite row belonging to the same package — coverageScope.ts's
 * computeCoverageScope is what now collapses that down to one call per
 * owner, with that owner's full distinct name list, before this ever runs.
 */
export async function includes(conn: Connection, owner: string, names: string[], profile: string): Promise<Array<{ owner: string; name: string }>> {
    if (names.length === 0) {
        return [];
    }
    const view = await getDbaView(conn, profile);
    const exclusionCsv = EXCLUDED_SCHEMA_PATTERNS.map((s) => `'${s}'`).join(', ');
    const binds: Record<string, string> = { owner };
    const bindNames = names.map((n, i) => {
        const key = `n${i}`;
        binds[key] = n.toUpperCase();
        return `:${key}`;
    });
    const result = await conn.execute<Record<string, unknown>>(
        `SELECT DISTINCT referenced_owner AS owner, referenced_name AS name
           FROM ${view}dependencies
          WHERE owner = upper(:owner)
            AND name IN (${bindNames.join(', ')})
            AND referenced_owner NOT IN (${exclusionCsv})
            AND referenced_owner NOT LIKE 'APEX\\_______' ESCAPE '\\'`,
        binds
    );
    return (result.rows ?? []).map((r) => ({ owner: String(r.OWNER), name: String(r.NAME) }));
}

/**
 * Which of PACKAGE BODY / PACKAGE actually exists for each of owner.names,
 * preferring BODY (that's where the executable, coverable statements are; a
 * spec-only package has none). A name absent from the result has neither —
 * it isn't a package/package body in this schema at all. Used to build a
 * coverage file mapping, or a Test Explorer navigation target, for objects
 * with no local workspace file — see workspace/virtualSource.ts. `profile`
 * selects the dba_/all_ probe cache entry (see getDbaView) — it does not
 * otherwise affect the query.
 */
export async function getPackageObjectTypes(conn: Connection, owner: string, names: string[], profile: string): Promise<Map<string, 'PACKAGE BODY' | 'PACKAGE'>> {
    const result = new Map<string, 'PACKAGE BODY' | 'PACKAGE'>();
    if (names.length === 0) {
        return result;
    }
    const view = await getDbaView(conn, profile);
    const binds: Record<string, string> = { owner };
    const bindNames = names.map((n, i) => {
        const key = `n${i}`;
        binds[key] = n.toUpperCase();
        return `:${key}`;
    });
    const query = await conn.execute<Record<string, unknown>>(
        `SELECT object_name, object_type
           FROM ${view}objects
          WHERE owner = upper(:owner)
            AND object_name IN (${bindNames.join(', ')})
            AND object_type IN ('PACKAGE BODY', 'PACKAGE')`,
        binds
    );
    for (const r of query.rows ?? []) {
        const name = String(r.OBJECT_NAME);
        const type = String(r.OBJECT_TYPE) as 'PACKAGE BODY' | 'PACKAGE';
        if (result.get(name) !== 'PACKAGE BODY') {
            result.set(name, type);
        }
    }
    return result;
}

export async function getPackageObjectType(conn: Connection, owner: string, name: string, profile: string): Promise<'PACKAGE BODY' | 'PACKAGE' | undefined> {
    return (await getPackageObjectTypes(conn, owner, [name], profile)).get(name.toUpperCase());
}

/** Full source text of a PACKAGE/PACKAGE BODY, reassembled from {dba|all}_source in line order. `profile` selects the dba_/all_ probe cache entry (see getDbaView) — it does not otherwise affect the query. */
export async function getObjectSource(conn: Connection, owner: string, name: string, type: 'PACKAGE BODY' | 'PACKAGE', profile: string): Promise<string> {
    const view = await getDbaView(conn, profile);
    const result = await conn.execute<Record<string, unknown>>(
        `SELECT text
           FROM ${view}source
          WHERE owner = upper(:owner)
            AND name = upper(:name)
            AND type = :type
          ORDER BY line`,
        { owner, name, type }
    );
    return (result.rows ?? []).map((r) => String(r.TEXT ?? '')).join('');
}

/**
 * ut_runner.rebuild_annotation_cache(owner, type) — forces a re-parse of
 * --%annotations for the given schema. Needed after a recompile: utPLSQL's
 * own annotation cache can otherwise still reflect the previous version of
 * a package, so a newly added --%test never shows up no matter how many
 * times the extension's own suitesCache is cleared (see controller.ts's
 * refreshHandler, which only clears *this extension's* cache).
 */
export async function rebuildAnnotationCache(conn: Connection, owner: string): Promise<void> {
    await conn.execute(`BEGIN ut_runner.rebuild_annotation_cache(upper(:owner)); END;`, { owner });
}

export async function getReportersList(conn: Connection): Promise<ReporterInfo[]> {
    const result = await conn.execute<Record<string, unknown>>(
        `SELECT reporter_object_name, is_output_reporter FROM TABLE(ut_runner.get_reporters_list())`
    );
    return (result.rows ?? [])
        .map((r) => ({
            reporterObjectName: String(r.REPORTER_OBJECT_NAME),
            isOutputReporter: String(r.IS_OUTPUT_REPORTER) === 'Y'
        }))
        .filter((r) => r.isOutputReporter);
}

/**
 * Candidates for test generation (AP9), mirrors UtplsqlDao.testables.
 *
 * USER_PROCEDURES has no OWNER column — unlike ALL_/DBA_PROCEDURES, it is
 * implicitly scoped to the session's current schema already (confirmed
 * against a live instance: filtering on `owner = upper(:owner)` fails every
 * call with ORA-00904 "invalid identifier"). That scoping is exactly what
 * this needs anyway, since db/pool.ts's getConnection() already runs
 * `ALTER SESSION SET CURRENT_SCHEMA` for a profile's defaultSchema — the
 * `owner` parameter is only used below to label the results, not to filter.
 */
export async function testables(conn: Connection, owner: string): Promise<TestableUnit[]> {
    const result = await conn.execute<Record<string, unknown>>(
        `SELECT object_name, object_type, procedure_name
           FROM user_procedures
          WHERE object_type IN ('PACKAGE', 'TYPE', 'FUNCTION', 'PROCEDURE')
          ORDER BY object_name, subprogram_id`
    );
    return (result.rows ?? []).map((r) => ({
        objectOwner: owner.toUpperCase(),
        objectName: String(r.OBJECT_NAME),
        objectType: String(r.OBJECT_TYPE) as TestableUnit['objectType'],
        subobjectName: r.PROCEDURE_NAME ? String(r.PROCEDURE_NAME) : undefined
    }));
}
