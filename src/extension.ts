import * as vscode from 'vscode';
import { SourceIndex } from './workspace/sourceIndex';
import { VIRTUAL_SOURCE_SCHEME, VirtualSourceProvider } from './workspace/virtualSource';
import { createUtplsqlContext } from './testing/controller';
import { UtplsqlContext } from './testing/model';
import { registerConnectionCommands, registerTestCommands } from './commands/index';
import { closeAllPools } from './db/pool';

/**
 * Not a stable public API — `UtplsqlContext` is an internal type that can
 * change shape freely. This exists solely so `test/e2e` (a real
 * @vscode/test-electron run against a real Oracle instance) can drive
 * discovery/resolveHandler/runTests directly, the same way the Test
 * Explorer UI does, without re-implementing activation.
 */
export interface ExtensionApi {
    ctx: UtplsqlContext;
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
    const sourceIndex = new SourceIndex();
    context.subscriptions.push(sourceIndex);

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(VIRTUAL_SOURCE_SCHEME, new VirtualSourceProvider(context.secrets))
    );

    const ctx = createUtplsqlContext(context, sourceIndex);

    registerConnectionCommands(context);
    registerTestCommands(context, ctx);

    // Build the initial workspace index in the background so the first
    // Test Explorer resolve already has file/line locations available.
    void sourceIndex.buildFullIndex();

    return { ctx };
}

export async function deactivate(): Promise<void> {
    await closeAllPools();
}
