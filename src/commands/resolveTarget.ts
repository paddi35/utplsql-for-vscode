/**
 * Vscode-free target-resolution logic factored out of resolveAtCursor
 * (index.ts) so it is directly testable with plain mocha instead of the
 * extension host — see testing/singleFlight.ts and testing/objectTypeCache.ts
 * for the same split elsewhere in this codebase (issue #29).
 *
 * A "candidate" here is a database object a cursor-driven command
 * (runTestAtCursor, runWithReporter, generateTest) can act on: a PACKAGE,
 * optionally narrowed to one PROCEDURE/FUNCTION test inside it. `owner` is
 * always the schema that actually owns the object — never a profile's
 * default-schema guess, see editorTargetFromVirtualSource below for why
 * that distinction is the point of this module.
 */
export interface Candidate {
    owner: string;
    packageName: string;
    procedureName?: string;
}

/**
 * The target a Test Explorer item stands for, or undefined when it stands
 * for no single database object.
 *
 * This is what lets the Test Explorer context menu act on the item that was
 * right-clicked instead of falling back to a QuickPick that asks the user to
 * name again what they just clicked (issue #29).
 *
 * Two kinds of row have no object to act on. A UT_LOGICAL_SUITE is a
 * --%suitepath(...) grouping node that exists only as a path segment -- no
 * package is named by it. A profile root has no row at all. Both return
 * undefined, and the caller then prompts as before rather than guessing at
 * one of the packages underneath.
 *
 * A UT_SUITE_CONTEXT names its package but not a single test, so it
 * resolves to the package: running or exporting the whole package is a
 * superset of the context, which is the safe direction to be wrong in.
 */
export function targetFromDiscoveryRow(row: {
    objectOwner: string;
    objectName: string;
    itemName: string;
    itemType: 'UT_SUITE' | 'UT_SUITE_CONTEXT' | 'UT_TEST' | 'UT_LOGICAL_SUITE';
}): Candidate | undefined {
    if (row.itemType === 'UT_LOGICAL_SUITE' || !row.objectName) {
        return undefined;
    }
    return {
        owner: row.objectOwner.toUpperCase(),
        packageName: row.objectName,
        procedureName: row.itemType === 'UT_TEST' ? row.itemName : undefined
    };
}

/** `OWNER.PACKAGE` or `OWNER.PACKAGE.PROCEDURE` — the QuickPick label chooseTarget offers for a candidate, and the key it dedupes candidates by. */
export function candidateLabel(candidate: Candidate): string {
    return candidate.procedureName ? `${candidate.owner}.${candidate.packageName}.${candidate.procedureName}` : `${candidate.owner}.${candidate.packageName}`;
}

export interface ChooseTargetInput {
    /**
     * A target already known from the active editor's cursor — a real
     * workspace file matched by SourceIndex, or a utplsql-source:// document
     * (see editorTargetFromVirtualSource). Wins over any candidate list with
     * no prompting: an explicit cursor position is always more specific than
     * "somewhere in this schema", and is exactly what resolveAtCursor used
     * to require before issue #29 — this only adds a fallback, it never
     * takes away the fast path.
     */
    editorTarget?: Candidate;
    /**
     * Offered only when editorTarget is absent — e.g. dao.testables() rows
     * for generateTest, or the discovered suite rows for
     * runTestAtCursor/runWithReporter (issue #29's "database is the sole
     * source of truth" workspaces have no editor target at all, ever).
     * Already fetched by the caller before chooseTarget is invoked, so a
     * cancelled pick does not trigger — or need to trigger — any further
     * database work.
     */
    candidates: Candidate[];
    /**
     * Presents `labels` (the distinct candidate labels, sorted) and resolves
     * to the one the user picked, or undefined if they cancelled. Never
     * called when editorTarget is set, or when there is exactly one distinct
     * candidate — both of those resolve without prompting at all.
     */
    pickOne: (labels: string[]) => Promise<string | undefined>;
}

/**
 * Resolves a single target from either an editor-derived one or a candidate
 * list, prompting only when neither editorTarget nor a lone candidate
 * settles it on its own. Returns undefined when there is nothing to act on
 * (no editorTarget and no candidates), or when the user cancels the prompt.
 */
export async function chooseTarget(input: ChooseTargetInput): Promise<Candidate | undefined> {
    if (input.editorTarget) {
        return input.editorTarget;
    }
    const byLabel = new Map<string, Candidate>();
    for (const candidate of input.candidates) {
        byLabel.set(candidateLabel(candidate), candidate);
    }
    const labels = [...byLabel.keys()].sort();
    if (labels.length === 0) {
        return undefined;
    }
    if (labels.length === 1) {
        return byLabel.get(labels[0]);
    }
    const picked = await input.pickOne(labels);
    return picked !== undefined ? byLabel.get(picked) : undefined;
}

/**
 * A utplsql-source:// document names its own owner and package in its URI
 * path (see workspace/virtualSourcePath.ts) — unlike a real workspace file,
 * which carries no schema information at all and has always relied on the
 * connection profile's default schema as a guess (resolveAtCursor,
 * index.ts). Before issue #29, the cursor-resolution path ignored that and
 * used the profile default for a virtual document too, which only
 * "worked" by accident when the document's owner happened to match that
 * default — silently wrong for any other schema, and there was never an
 * error to reveal it since owner only affects *which* schema a query runs
 * against, not whether it returns rows at all.
 *
 * `cursorPath` is the PACKAGE[.PROCEDURE] the normal content-based cursor
 * lookup (SourceIndex.getPathAtCursor) found within the document, used only
 * for its procedure part: the package part is always the URI's own name,
 * which is authoritative for a document that *is* that one package, rather
 * than however the parser happened to read the CREATE OR REPLACE header.
 */
export function editorTargetFromVirtualSource(uri: { owner: string; name: string }, cursorPath: string | undefined): Candidate {
    const dotIndex = cursorPath !== undefined ? cursorPath.indexOf('.') : -1;
    const procedureName = dotIndex >= 0 ? cursorPath!.slice(dotIndex + 1) : undefined;
    return { owner: uri.owner, packageName: uri.name, procedureName };
}
