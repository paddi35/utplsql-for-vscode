import * as vscode from 'vscode';
import { findCandidateFiles, matchesConfiguredLanguage } from './languageIndex';
import { findEntryAtOffset, parseSource } from './plsqlParser';
import { PerKeyDebouncer } from './perKeyDebouncer';
import { SourceLocationIndex } from './sourceLocationIndex';

/** onDidChangeTextDocument fires once per keystroke; this is how long we wait for a burst to settle before re-parsing. */
const REINDEX_DEBOUNCE_MS = 400;

export interface SourceLocation {
    uri: vscode.Uri;
    range: vscode.Range;
    isBody: boolean;
}

/**
 * PACKAGE[.PROCEDURE] -> location, built from the workspace's PL/SQL files
 * (matched by language id, see languageIndex.ts). The owner is not part of
 * the key — it isn't reliably present in source files and comes from the
 * active connection profile instead.
 *
 * The map itself (add/remove/lookup, including the body-over-spec
 * preference) lives in SourceLocationIndex, and per-URI debouncing lives in
 * PerKeyDebouncer — both vscode-free so they are unit-testable outside the
 * extension host (see their own doc comments). This class is the
 * vscode-facing glue on top: turning TextDocument events into calls on
 * those two, and turning lookup() results back into
 * real vscode.Range/vscode.Position instances.
 */
export class SourceIndex implements vscode.Disposable {
    private readonly locationIndex = new SourceLocationIndex<vscode.Uri>();
    private readonly reindexDebouncer = new PerKeyDebouncer(REINDEX_DEBOUNCE_MS);
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument((doc) => this.indexDocument(doc)),
            vscode.workspace.onDidChangeTextDocument((e) => this.scheduleReindex(e.document)),
            vscode.workspace.onDidCloseTextDocument(() => undefined),
            vscode.workspace.onDidChangeConfiguration((e) => this.onConfigurationChanged(e))
        );
    }

    /**
     * files.associations changes which on-disk files even become candidates
     * (see collectGlobPatterns()), and utplsql.discovery.languageIds changes
     * which language ids count — either one can turn a file that used to be
     * invisible to lookupPackage() into a match (or vice versa), so a full
     * rescan is needed rather than just re-parsing already-known files.
     */
    private onConfigurationChanged(e: vscode.ConfigurationChangeEvent): void {
        if (e.affectsConfiguration('files.associations') || e.affectsConfiguration('utplsql.discovery.languageIds')) {
            void this.buildFullIndex();
        }
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.reindexDebouncer.dispose();
    }

    private scheduleReindex(doc: vscode.TextDocument): void {
        if (!matchesConfiguredLanguage(doc)) {
            return;
        }
        this.reindexDebouncer.schedule(doc.uri.toString(), () => this.indexDocument(doc));
    }

    private addEntries(uri: vscode.Uri, text: string): void {
        this.locationIndex.setOwnerEntries(uri.toString(), uri, parseSource(text));
    }

    indexDocument(doc: vscode.TextDocument): void {
        if (!matchesConfiguredLanguage(doc)) {
            return;
        }
        this.addEntries(doc.uri, doc.getText());
    }

    /** Reads uri fresh from disk and re-indexes it. Used for the initial scan. */
    async indexFile(uri: vscode.Uri): Promise<void> {
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            this.addEntries(uri, Buffer.from(bytes).toString('utf8'));
        } catch {
            // The file may have been deleted between findCandidateFiles's
            // scan and this readFile actually running — nothing to index.
        }
    }

    async buildFullIndex(): Promise<void> {
        this.locationIndex.clear();
        const files = await findCandidateFiles();
        await Promise.all(files.map((uri) => this.indexFile(uri)));
    }

    /** Prefer a package body over a spec, since that's where TestMessages should point. */
    lookup(key: string): SourceLocation | undefined {
        const found = this.locationIndex.lookup(key);
        if (!found) {
            return undefined;
        }
        return {
            uri: found.owner,
            isBody: found.isBody,
            range: new vscode.Range(
                new vscode.Position(found.start.line, found.start.character),
                new vscode.Position(found.end.line, found.end.character)
            )
        };
    }

    lookupPackage(pkg: string): SourceLocation | undefined {
        return this.lookup(pkg);
    }

    lookupProcedure(pkg: string, proc: string): SourceLocation | undefined {
        return this.lookup(`${pkg}.${proc}`) ?? this.lookup(pkg);
    }

    /** utplsql.runTestAtCursor: PACKAGE or PACKAGE.PROCEDURE declared at/above the cursor. */
    getPathAtCursor(doc: vscode.TextDocument, position: vscode.Position): string | undefined {
        const entries = parseSource(doc.getText());
        const offset = doc.offsetAt(position);
        return findEntryAtOffset(entries, offset)?.key;
    }
}
