import * as vscode from 'vscode';
import { SuiteInfoRow } from '../db/utplsqlDao';
import { SourceIndex } from '../workspace/sourceIndex';

/** Per-TestItem metadata that doesn't fit vscode.TestItem itself, keyed by TestItem.id. */
export interface ItemMeta {
    profile: string;
    owner: string;
    suitepath: string;
    row?: SuiteInfoRow;
}

export class MetaStore {
    private readonly byId = new Map<string, ItemMeta>();

    set(id: string, meta: ItemMeta): void {
        this.byId.set(id, meta);
    }

    get(id: string): ItemMeta | undefined {
        return this.byId.get(id);
    }

    deleteForProfile(profile: string): void {
        for (const [id, meta] of this.byId) {
            if (meta.profile === profile) {
                this.byId.delete(id);
            }
        }
    }

    valuesForProfile(profile: string): ItemMeta[] {
        return [...this.byId.values()].filter((m) => m.profile === profile);
    }
}

export interface UtplsqlContext {
    controller: vscode.TestController;
    meta: MetaStore;
    output: vscode.OutputChannel;
    secrets: vscode.SecretStorage;
    sourceIndex: SourceIndex;
}
