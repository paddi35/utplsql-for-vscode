import * as vscode from 'vscode';
import { SourceIndex } from './workspace/sourceIndex';
import { createUtplsqlContext } from './testing/controller';
import { registerConnectionCommands, registerTestCommands } from './commands/index';
import { closeAllPools } from './db/pool';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const sourceIndex = new SourceIndex();
    context.subscriptions.push(sourceIndex);

    const ctx = createUtplsqlContext(context, sourceIndex);

    registerConnectionCommands(context);
    registerTestCommands(context, ctx);

    // Build the initial workspace index in the background so the first
    // Test Explorer resolve already has file/line locations available.
    void sourceIndex.buildFullIndex();
}

export async function deactivate(): Promise<void> {
    await closeAllPools();
}
