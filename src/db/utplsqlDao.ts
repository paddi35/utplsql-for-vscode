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
    itemType: 'UT_SUITE' | 'UT_SUITE_CONTEXT' | 'UT_TEST';
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

let dbaViewAccessible: boolean | undefined;

export async function isDbaViewAccessible(conn: Connection): Promise<boolean> {
    if (dbaViewAccessible !== undefined) {
        return dbaViewAccessible;
    }
    try {
        await conn.execute(`SELECT 1 FROM dba_objects WHERE 1 = 2 UNION ALL SELECT 1 FROM dual WHERE 1 = 2`);
        dbaViewAccessible = true;
    } catch {
        dbaViewAccessible = false;
    }
    return dbaViewAccessible;
}

export async function getDbaView(conn: Connection): Promise<'dba_' | 'all_'> {
    return (await isDbaViewAccessible(conn)) ? 'dba_' : 'all_';
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

export async function getSuitesInfo(conn: Connection, owner?: string, pkg?: string): Promise<SuiteInfoRow[]> {
    const result = await conn.execute<Record<string, unknown>>(
        `SELECT object_owner, object_name, item_name, item_description, item_type,
                item_line_no, path, disabled_flag, disabled_reason, tags
           FROM TABLE(ut_runner.get_suites_info(upper(:owner), upper(:pkg)))`,
        { owner: owner ?? null, pkg: pkg ?? null }
    );
    return (result.rows ?? []).map((r) => ({
        objectOwner: String(r.OBJECT_OWNER),
        objectName: String(r.OBJECT_NAME),
        itemName: String(r.ITEM_NAME),
        itemDescription: r.ITEM_DESCRIPTION ? String(r.ITEM_DESCRIPTION) : undefined,
        itemType: String(r.ITEM_TYPE) as SuiteInfoRow['itemType'],
        itemLineNo: r.ITEM_LINE_NO !== null && r.ITEM_LINE_NO !== undefined ? Number(r.ITEM_LINE_NO) : undefined,
        path: String(r.PATH),
        disabledFlag: parseDisabledFlag(r.DISABLED_FLAG),
        disabledReason: r.DISABLED_REASON ? String(r.DISABLED_REASON) : undefined,
        tags: r.TAGS ? String(r.TAGS) : undefined
    }));
}

/** Objects reachable via {dba|all}_dependencies from the run's covered objects, for coverage scoping. */
export async function includes(conn: Connection, owner: string, name: string): Promise<Array<{ owner: string; name: string }>> {
    const view = await getDbaView(conn);
    const exclusionCsv = EXCLUDED_SCHEMA_PATTERNS.map((s) => `'${s}'`).join(', ');
    const result = await conn.execute<Record<string, unknown>>(
        `SELECT DISTINCT referenced_owner AS owner, referenced_name AS name
           FROM ${view}dependencies
          WHERE owner = upper(:owner)
            AND name = upper(:name)
            AND referenced_owner NOT IN (${exclusionCsv})
            AND referenced_owner NOT LIKE 'APEX\\_______' ESCAPE '\\'`,
        { owner, name }
    );
    return (result.rows ?? []).map((r) => ({ owner: String(r.OWNER), name: String(r.NAME) }));
}

/**
 * Which of PACKAGE BODY / PACKAGE actually exists for each of owner.names,
 * preferring BODY (that's where the executable, coverable statements are; a
 * spec-only package has none). A name absent from the result has neither —
 * it isn't a package/package body in this schema at all. Used to build a
 * coverage file mapping, or a Test Explorer navigation target, for objects
 * with no local workspace file — see workspace/virtualSource.ts.
 */
export async function getPackageObjectTypes(conn: Connection, owner: string, names: string[]): Promise<Map<string, 'PACKAGE BODY' | 'PACKAGE'>> {
    const result = new Map<string, 'PACKAGE BODY' | 'PACKAGE'>();
    if (names.length === 0) {
        return result;
    }
    const view = await getDbaView(conn);
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

export async function getPackageObjectType(conn: Connection, owner: string, name: string): Promise<'PACKAGE BODY' | 'PACKAGE' | undefined> {
    return (await getPackageObjectTypes(conn, owner, [name])).get(name.toUpperCase());
}

/** Full source text of a PACKAGE/PACKAGE BODY, reassembled from {dba|all}_source in line order. */
export async function getObjectSource(conn: Connection, owner: string, name: string, type: 'PACKAGE BODY' | 'PACKAGE'): Promise<string> {
    const view = await getDbaView(conn);
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
