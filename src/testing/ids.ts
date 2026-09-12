/**
 * TestItem.id encoding used by the controller:
 *   conn:<profile>                              root per connection profile
 *   conn:<profile>/schema:<OWNER>                schema node
 *   conn:<profile>/path:<OWNER>:<suitepath>       suite, context or test
 *
 * The run path utPLSQL expects is "OWNER:suitepath" (ut_runner.pks suitepath
 * syntax, dot-separated).
 */

export type ParsedId =
    | { kind: 'root'; profile: string }
    | { kind: 'schema'; profile: string; owner: string }
    | { kind: 'path'; profile: string; owner: string; suitepath: string };

export function rootId(profile: string): string {
    return `conn:${profile}`;
}

export function schemaId(profile: string, owner: string): string {
    return `conn:${profile}/schema:${owner.toUpperCase()}`;
}

export function pathId(profile: string, owner: string, suitepath: string): string {
    return `conn:${profile}/path:${owner.toUpperCase()}:${suitepath}`;
}

export function childPathId(profile: string, owner: string, parentPath: string | undefined, segment: string): string {
    const suitepath = parentPath ? `${parentPath}.${segment}` : segment;
    return pathId(profile, owner, suitepath);
}

export function parseId(id: string): ParsedId {
    const [connPart, rest] = splitOnce(id, '/');
    const profile = connPart.slice('conn:'.length);
    if (!rest) {
        return { kind: 'root', profile };
    }
    if (rest.startsWith('schema:')) {
        return { kind: 'schema', profile, owner: rest.slice('schema:'.length) };
    }
    if (rest.startsWith('path:')) {
        const [owner, suitepath] = splitOnce(rest.slice('path:'.length), ':');
        return { kind: 'path', profile, owner, suitepath: suitepath ?? '' };
    }
    throw new Error(`utPLSQL: cannot parse TestItem id '${id}'`);
}

function splitOnce(value: string, sep: string): [string, string | undefined] {
    const idx = value.indexOf(sep);
    if (idx === -1) {
        return [value, undefined];
    }
    return [value.slice(0, idx), value.slice(idx + sep.length)];
}

/** The utPLSQL run path ("OWNER:suitepath") for a `path:` TestItem id. */
export function toRunPath(id: string): string {
    const parsed = parseId(id);
    if (parsed.kind !== 'path') {
        throw new Error(`utPLSQL: TestItem id '${id}' has no run path`);
    }
    return `${parsed.owner}:${parsed.suitepath}`;
}

export interface OwnedPath {
    owner: string;
    suitepath: string;
}

/**
 * Whether some proper dot-separated prefix of `suitepath` (i.e. an ancestor
 * suite/context path, not just any string sharing a prefix — "suite1x" is
 * not covered by "suite1") is itself a selected path for the same owner.
 * Walking up by trimming one path segment at a time is O(depth) per
 * candidate instead of comparing against every other selected path, so the
 * whole dedup is O(n * depth) rather than O(n^2) — depth (suite/context
 * nesting) stays small and roughly constant as the selection grows, unlike
 * the old unique.some(isCoveredBy) scan over the full set for every entry.
 */
function hasSelectedAncestor(suitepath: string, selectedForOwner: ReadonlySet<string>): boolean {
    let path = suitepath;
    let dotIdx = path.lastIndexOf('.');
    while (dotIdx !== -1) {
        path = path.slice(0, dotIdx);
        if (selectedForOwner.has(path)) {
            return true;
        }
        dotIdx = path.lastIndexOf('.');
    }
    return false;
}

/**
 * Port of UtplsqlController.dedupPathList / ItemNode.createNonOverlappingSet:
 * drops any selected path that is already implied by another selected path
 * of the same owner (e.g. a suite and one of its own tests both selected).
 */
export function dedupPathList(paths: OwnedPath[]): OwnedPath[] {
    const unique = dedupeExact(paths);
    const selectedByOwner = new Map<string, Set<string>>();
    for (const p of unique) {
        const set = selectedByOwner.get(p.owner);
        if (set) {
            set.add(p.suitepath);
        } else {
            selectedByOwner.set(p.owner, new Set([p.suitepath]));
        }
    }
    return unique.filter((candidate) => !hasSelectedAncestor(candidate.suitepath, selectedByOwner.get(candidate.owner)!));
}

function dedupeExact(paths: OwnedPath[]): OwnedPath[] {
    const seen = new Map<string, OwnedPath>();
    for (const p of paths) {
        seen.set(`${p.owner}:${p.suitepath}`, p);
    }
    return [...seen.values()];
}
