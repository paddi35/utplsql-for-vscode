import { ParsedIndexEntry } from './plsqlParser';

/** A parsed declaration plus which owner contributed it (see SourceLocationIndex below for what ownerKey/owner are for). */
export interface OwnedEntry<TOwner> extends ParsedIndexEntry {
    ownerKey: string;
    owner: TOwner;
}

/**
 * The PACKAGE[.PROCEDURE] -> declaration-location(s) map at the heart of
 * SourceIndex (src/workspace/sourceIndex.ts), split out so it is reachable
 * by plain mocha: SourceIndex has `import * as vscode from 'vscode'` at the
 * top of its file, which fails to load outside the extension host no
 * matter which of its methods a test actually exercises, so even its "pure"
 * add/remove/lookup behaviour needs a vscode-free home to be unit-testable
 * at all (the same reasoning virtualSourcePath.ts documents for the
 * URI-parsing half of the virtual-source feature, and perKeyDebouncer.ts
 * documents for the debounce half of this one — see #20/#26).
 *
 * TOwner is whatever a caller wants back out of lookup() — a real
 * vscode.Uri in production, a plain file path in tests. ownerKey is that
 * owner's stable string identity, used to find and remove everything one
 * owner contributed: TOwner itself is never assumed to be comparable with
 * `===`, since two vscode.Uri instances for the same file are not (only
 * their .toString() forms are).
 */
export class SourceLocationIndex<TOwner> {
    private readonly byKey = new Map<string, OwnedEntry<TOwner>[]>();

    /** Wipes every entry from every owner — the first step of a full rebuild. */
    clear(): void {
        this.byKey.clear();
    }

    /** Drops every entry `ownerKey` contributed. A no-op that leaves every other owner's entries untouched if it contributed none. */
    removeOwner(ownerKey: string): void {
        for (const [key, entries] of this.byKey) {
            const kept = entries.filter((e) => e.ownerKey !== ownerKey);
            if (kept.length === entries.length) {
                continue;
            }
            if (kept.length > 0) {
                this.byKey.set(key, kept);
            } else {
                this.byKey.delete(key);
            }
        }
    }

    /**
     * Replaces everything `ownerKey` previously contributed with `entries`
     * in one go (remove-then-add), so re-indexing a file whose package was
     * renamed drops the old key as well as adding the new one — adding the
     * new entries without first removing the old ones would leave a stale
     * key resolving to a location whose content no longer matches it.
     */
    setOwnerEntries(ownerKey: string, owner: TOwner, entries: readonly ParsedIndexEntry[]): void {
        this.removeOwner(ownerKey);
        for (const entry of entries) {
            const existing = this.byKey.get(entry.key) ?? [];
            existing.push({ ...entry, ownerKey, owner });
            this.byKey.set(entry.key, existing);
        }
    }

    /** Prefers a package body over a spec, since that's where TestMessages/gutter icons should point. Keys are matched case-insensitively. */
    lookup(key: string): OwnedEntry<TOwner> | undefined {
        const entries = this.byKey.get(key.toUpperCase());
        if (!entries || entries.length === 0) {
            return undefined;
        }
        return entries.find((e) => e.isBody) ?? entries[0];
    }
}
