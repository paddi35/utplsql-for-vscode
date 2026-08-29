import * as vscode from 'vscode';

function configuredLanguageIds(): string[] {
    return vscode.workspace
        .getConfiguration('utplsql')
        .get<string[]>('discovery.languageIds', ['sql', 'oracle-sql']);
}

interface LanguageContribution {
    id?: string;
    extensions?: string[];
    filenames?: string[];
}

/**
 * There is no public API mapping an on-disk path to a language id without
 * opening it. Instead we build the set of relevant glob patterns from every
 * extension that contributes one of the configured language ids, from
 * files.associations pointing at those ids, and from already-open documents.
 */
export function collectGlobPatterns(): string[] {
    const ids = new Set(configuredLanguageIds());
    const extensionsSet = new Set<string>();
    const filenamesSet = new Set<string>();

    for (const ext of vscode.extensions.all) {
        const contributed = ext.packageJSON?.contributes?.languages as LanguageContribution[] | undefined;
        if (!contributed) {
            continue;
        }
        for (const lang of contributed) {
            if (lang.id && ids.has(lang.id)) {
                (lang.extensions ?? []).forEach((e) => extensionsSet.add(e.startsWith('.') ? e.slice(1) : e));
                (lang.filenames ?? []).forEach((f) => filenamesSet.add(f));
            }
        }
    }

    const associations = vscode.workspace.getConfiguration('files').get<Record<string, string>>('associations', {});
    for (const [pattern, langId] of Object.entries(associations)) {
        if (ids.has(langId)) {
            extensionsSet.add(pattern);
        }
    }

    const globs: string[] = [];
    for (const ext of extensionsSet) {
        globs.push(ext.includes('*') || ext.includes('/') ? ext : `**/*.${ext}`);
    }
    for (const name of filenamesSet) {
        globs.push(`**/${name}`);
    }
    return globs;
}

export function openDocumentsForLanguages(): vscode.TextDocument[] {
    const ids = new Set(configuredLanguageIds());
    return vscode.workspace.textDocuments.filter((doc) => ids.has(doc.languageId));
}

export function matchesConfiguredLanguage(document: vscode.TextDocument): boolean {
    return configuredLanguageIds().includes(document.languageId);
}

export async function findCandidateFiles(): Promise<vscode.Uri[]> {
    const patterns = collectGlobPatterns();
    if (patterns.length === 0) {
        return [];
    }
    const uris = new Map<string, vscode.Uri>();
    for (const pattern of patterns) {
        const found = await vscode.workspace.findFiles(`{${pattern}}`, '**/node_modules/**');
        for (const uri of found) {
            uris.set(uri.toString(), uri);
        }
    }
    for (const doc of openDocumentsForLanguages()) {
        uris.set(doc.uri.toString(), doc.uri);
    }
    return [...uris.values()];
}
