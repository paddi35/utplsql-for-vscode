import * as vscode from 'vscode';
import { getProfile } from '../db/connections';
import { getPool } from '../db/pool';
import * as dao from '../db/utplsqlDao';
import { runWithReporter } from '../db/reporterDao';
import { UtplsqlContext } from './model';
import { groupRequest } from './runHandler';
import { readReporterOptions } from './reporterConfig';

function appendOutputCrlf(run: vscode.TestRun, text: string, item?: vscode.TestItem): void {
    run.appendOutput(text.replace(/\r?\n/g, '\r\n') + '\r\n', undefined, item);
}

/**
 * The reporter-export TestRunProfile: utplsql.runWithReporter (the command)
 * only ever exports the single package under the cursor. Registering this
 * as a profile instead reuses the exact same selection/grouping pipeline as
 * "Run" and "Run with Coverage" (groupRequest + dedupPathList), so an
 * arbitrary Test Explorer selection — one test, a whole suite, a
 * multi-select spanning schemas — can be exported, not just one package.
 * The cursor-based command stays as a quick one-object shortcut.
 */
export async function runReporterExport(ctx: UtplsqlContext, request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    const run = ctx.controller.createTestRun(request);
    try {
        const grouped = groupRequest(ctx, request);
        if (grouped.size === 0) {
            vscode.window.showErrorMessage('utPLSQL: select one or more tests/suites to export first.');
            return;
        }

        const [firstProfile] = grouped.keys();
        const firstCfg = getProfile(firstProfile);
        if (!firstCfg) {
            return;
        }
        const probePool = await getPool(firstCfg, ctx.secrets, 1);
        const probeConn = await probePool.getConnection();
        let reporters;
        try {
            reporters = await dao.getReportersList(probeConn);
        } finally {
            await probeConn.close();
        }
        if (reporters.length === 0) {
            vscode.window.showErrorMessage(`utPLSQL: no output reporters available on '${firstProfile}'.`);
            return;
        }
        const reporterName = await vscode.window.showQuickPick(
            reporters.map((r) => r.reporterObjectName),
            { title: 'Select reporter' }
        );
        if (!reporterName) {
            return;
        }
        const target = await vscode.window.showQuickPick(['Show in Output Channel', 'Save to File'], {
            title: grouped.size > 1 ? 'Where should each connection profile’s report go? (one file per profile)' : 'Where should the report go?'
        });
        if (!target) {
            return;
        }

        for (const [profile, group] of grouped) {
            if (token.isCancellationRequested) {
                group.items.forEach((i) => run.skipped(i));
                continue;
            }
            group.items.forEach((i) => run.enqueued(i));
            const cfg = getProfile(profile);
            if (!cfg) {
                group.items.forEach((i) => run.errored(i, new vscode.TestMessage(`Unknown connection profile '${profile}'`)));
                continue;
            }
            const pool = await getPool(cfg, ctx.secrets, 1);
            const producerConn = await pool.getConnection();
            const consumerConn = await pool.getConnection();
            const runPaths = group.paths.map((p) => `${p.owner}:${p.suitepath}`);
            try {
                const output = await runWithReporter(producerConn, consumerConn, reporterName, runPaths, readReporterOptions());
                if (target === 'Save to File') {
                    const uri = await vscode.window.showSaveDialog({ saveLabel: `Save '${profile}' report` });
                    if (uri) {
                        await vscode.workspace.fs.writeFile(uri, Buffer.from(output, 'utf8'));
                    }
                } else {
                    appendOutputCrlf(run, `--- ${profile} (${reporterName}) ---`);
                    appendOutputCrlf(run, output);
                    ctx.output.appendLine(output);
                }
                group.items.forEach((i) => run.skipped(i));
            } catch (err) {
                group.items.forEach((i) => run.errored(i, new vscode.TestMessage(String(err))));
            } finally {
                await producerConn.close();
                await consumerConn.close();
            }
        }
    } finally {
        run.end();
    }
}
