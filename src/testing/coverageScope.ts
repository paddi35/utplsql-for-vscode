import { isPlainIdentifier } from '../db/realtimeDao';

/**
 * Pure scope-building half of coverage.ts's buildCoverageOptions — see that
 * module for the vscode/Connection-dependent glue around this. Kept
 * vscode-free (see objectTypeCache.ts, singleFlight.ts for the same split
 * elsewhere in this codebase) so it is directly testable with plain mocha,
 * via an injected `includesFn` rather than a real oracledb Connection.
 *
 * Issue #21: buildCoverageOptions's `items` is exactly groupRequest's
 * (runHandler.ts) selected-TestItem list, which — per that function's own
 * doc comment, and the same property that made dedupPathList an O(n²)
 * hotspot (docs/performance.md, "Known hotspots") — is every path-bearing
 * descendant: suites, contexts *and* tests, not just leaves. The old code
 * called dao.includes() once per item in that list as a sequential await,
 * with the same (owner, objectName) pair repeated for every test/context/
 * suite row belonging to the same package — ~17 identical queries for a
 * package with 15 tests plus its suite/context rows, on the order of 16,000
 * sequential round trips on the documented 1000-package/~15,000-test
 * fixture before a single test starts running.
 *
 * computeCoverageScope fixes that past the issue's minimum suggestion (dedup
 * to one call per distinct (owner, objectName) pair): every item is first
 * reduced to its owner's distinct object names, then `includesFn` is awaited
 * once per distinct *owner* with that owner's full name list in one call —
 * the same bind-list batching dao.getPackageObjectTypes already uses for its
 * `object_name IN (...)` list (confirmed against a live Oracle 23ai instance
 * up to 5000 bind variables in one call, see that function's doc comment and
 * docs/performance.md's "Known hotspots"). dao.includes's shape changed to
 * match: it now takes `names: string[]` instead of a single `name`, for
 * exactly this call site.
 *
 * Owners are resolved strictly one after another — a plain for-of loop, not
 * Promise.all — because a single oracledb Connection does not support
 * concurrent execute() calls, the same constraint coverage.ts's
 * resolveFileMappings documents for dao.getPackageObjectTypes.
 */

export interface CoverageScopeItem {
    owner: string;
    objectName: string;
}

export interface ObjectRef {
    owner: string;
    name: string;
}

/** dao.includes(scopeConn, owner, names, profile), with the Connection/profile already bound by the caller — keeps this module free of oracledb/vscode. */
export type IncludesFn = (owner: string, names: string[]) => Promise<ObjectRef[]>;

export interface CoverageScopeOptions {
    /** utplsql.coverage.excludeObjects — removed from the derived include set case-insensitively. */
    excludeObjects: readonly string[];
    /** utplsql.coverage.schemes — non-empty replaces the owner set derived from `items`. */
    schemesOverride: readonly string[];
    /** utplsql.coverage.includeObjects — non-empty replaces the *_dependencies-derived include set entirely, expanded across every scheme. */
    includeObjectsOverride: readonly string[];
}

export interface CoverageScope {
    schemes: string[];
    /** The test packages themselves, deduplicated by owner.objectName — reported via a_test_file_mappings, not a_include_objects. */
    testObjects: Map<string, ObjectRef>;
    /** *_dependencies-derived (or overridden) coverage scope, deduplicated by owner.name. */
    includeObjects: Map<string, ObjectRef>;
    /**
     * Derived dependencies dropped because their name cannot be expressed
     * as a plain identifier — reported by the caller rather than silently
     * swallowed, since their coverage really is missing from the result.
     * Never populated from the includeObjects override: a name the user
     * typed is refused loudly instead.
     */
    unusableNames: ObjectRef[];
}

function refKey(owner: string, name: string): string {
    return `${owner}.${name}`;
}

export async function computeCoverageScope(
    items: Iterable<CoverageScopeItem>,
    includesFn: IncludesFn,
    options: CoverageScopeOptions
): Promise<CoverageScope> {
    const testObjects = new Map<string, ObjectRef>();
    const namesByOwner = new Map<string, Set<string>>();

    for (const { owner, objectName } of items) {
        testObjects.set(refKey(owner, objectName), { owner, name: objectName });
        const names = namesByOwner.get(owner) ?? new Set<string>();
        names.add(objectName);
        namesByOwner.set(owner, names);
    }

    const includeObjects = new Map<string, ObjectRef>();
    const unusableNames: ObjectRef[] = [];
    for (const [owner, names] of namesByOwner) {
        const deps = await includesFn(owner, [...names]);
        deps.forEach((d) => {
            // A dependency whose name is not a plain identifier (a quoted
            // identifier, which Oracle allows) cannot go into the generated
            // PL/SQL: realtimeDao's validateIdentifier refuses it. Before
            // this filter it refused it at *SQL-build* time, by which point
            // the whole coverage run failed -- so a single oddly-named object
            // anywhere in the schema cost coverage for everything else in it.
            // Dropping it here costs coverage for that one object and is
            // reported by the caller.
            if (!isPlainIdentifier(d.name) || !isPlainIdentifier(d.owner)) {
                unusableNames.push(d);
                return;
            }
            includeObjects.set(refKey(d.owner, d.name), d);
        });
    }

    // Dependency discovery can't tell the utPLSQL framework's own packages
    // (e.g. UT, UT_EXPECTATION) apart from real code under test when the
    // framework is installed into the same schema as the tests — every test
    // necessarily calls ut.expect(...), so they always show up as a direct
    // dependency. There is no reliable signal in *_dependencies to filter
    // those out automatically, so this is a user-maintained denylist instead
    // of a guessed one.
    const userExcluded = new Set(options.excludeObjects.map((n) => n.toUpperCase()));
    for (const [k, { name }] of includeObjects) {
        if (userExcluded.has(name)) {
            includeObjects.delete(k);
        }
    }

    // utplsql.coverage.schemes/includeObjects: an explicit override replaces
    // the automatically derived scope entirely — dynamically invoked objects
    // (execute immediate, triggers) never show up in *_dependencies, so
    // there is no way to include them other than naming them here.
    const schemes = options.schemesOverride.length > 0 ? options.schemesOverride.map((s) => s.toUpperCase()) : [...namesByOwner.keys()];
    if (options.includeObjectsOverride.length > 0) {
        includeObjects.clear();
        for (const owner of schemes) {
            for (const name of options.includeObjectsOverride) {
                includeObjects.set(refKey(owner, name.toUpperCase()), { owner, name: name.toUpperCase() });
            }
        }
    }

    return { schemes, testObjects, includeObjects, unusableNames };
}
