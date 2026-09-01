import * as vscode from 'vscode';
import { RunWithReporterOptions } from '../db/reporterDao';

/** Shared by the cursor-based utplsql.runWithReporter command and the Export-with-Reporter TestRunProfile. */
export function readReporterOptions(): RunWithReporterOptions {
    const cfg = vscode.workspace.getConfiguration('utplsql.reporter');
    const clientCharacterSet = cfg.get<string>('clientCharacterSet', '');
    return {
        clientCharacterSet: clientCharacterSet || undefined,
        colorConsole: cfg.get<boolean>('colorConsole', false)
    };
}
