import * as vscode from 'vscode';
import { findCandidateFiles, matchesConfiguredLanguage } from './languageIndex';
import { findEntryAtOffset, parseSource } from './plsqlParser';

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
 */
export class SourceIndex implements vscode.Disposable {
    private readonly index = new Map<string, SourceLocation[]>();
    private readonly disposables: vscode.Disposable[] = [];
    private refreshTimer: NodeJS.Timeout | undefined;

    constructor() {
        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument((doc) => this.indexDocument(doc)),
            vscode.workspace.onDidChangeTextDocument((e) => this.scheduleReindex(e.document)),
            vscode.workspace.onDidCloseTextDocument(() => undefined)
        );
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
    }

    private scheduleReindex(doc: vscode.TextDocument): void {
        if (!matchesConfiguredLanguage(doc)) {
            return;
        }
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(() => this.indexDocument(doc), 400);
    }

    private removeUri(uri: vscode.Uri): void {
        const key = uri.toString();
        for (const [name, locations] of this.index) {
            const filtered = locations.filter((l) => l.uri.toString() !== key);
            if (filtered.length > 0) {
                this.index.set(name, filtered);
            } else {
                this.index.delete(name);
            }
        }
    }

    private addEntries(uri: vscode.Uri, text: string): void {
        this.removeUri(uri);
        for (const entry of parseSource(text)) {
            const range = new vscode.Range(
                new vscode.Position(entry.start.line, entry.start.character),
                new vscode.Position(entry.end.line, entry.end.character)
            );
            const locations = this.index.get(entry.key) ?? [];
            locations.push({ uri, range, isBody: entry.isBody });
            this.index.set(entry.key, locations);
        }
    }

    indexDocument(doc: vscode.TextDocument): void {
        if (!matchesConfiguredLanguage(doc)) {
            return;
        }
        this.addEntries(doc.uri, doc.getText());
    }

    async indexFile(uri: vscode.Uri): Promise<void> {
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            this.addEntries(uri, Buffer.from(bytes).toString('utf8'));
        } catch {
            // file may have been deleted between findFiles and readFile
        }
    }

    async buildFullIndex(): Promise<void> {
        this.index.clear();
        const files = await findCandidateFiles();
        await Promise.all(files.map((uri) => this.indexFile(uri)));
    }

    /** Prefer a package body over a spec, since that's where TestMessages should point. */
    lookup(key: string): SourceLocation | undefined {
        const locations = this.index.get(key.toUpperCase());
        if (!locations || locations.length === 0) {
            return undefined;
        }
        return locations.find((l) => l.isBody) ?? locations[0];
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
