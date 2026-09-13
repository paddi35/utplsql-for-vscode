import assert from 'node:assert/strict';
import { installModuleStub, uncacheAllSrcModules } from '../unit/support/moduleStub';
import { createFakeVscode, createFakeSecretStorage } from '../unit/support/fakeVscode';

/**
 * Issue #25's three "no DB needed" integration cases — unlike the rest of
 * test/integration (which drives a real Oracle instance via oracledb
 * directly, see support/db.ts's own doc comment), these only touch settings
 * and SecretStorage, so the same fake-vscode-module technique
 * test/unit/addConnection.test.ts and connections.test.ts use is enough to
 * run them for real, no docker-compose fixture required. Kept here rather
 * than folded into the unit suite because they exercise the full,
 * multi-command scenario (two commands in sequence; add-then-abort) rather
 * than one call in isolation.
 */
type CommandsModule = typeof import('../../src/commands/index');
type ConnectionsModule = typeof import('../../src/db/connections');

function loadExtensionModules(): {
    commands: CommandsModule;
    connections: ConnectionsModule;
    store: Record<string, unknown>;
    messages: { kind: 'info' | 'error' | 'warning'; message: string }[];
    uninstall(): void;
} {
    const { module: fakeVscode, store, messages } = createFakeVscode({ 'utplsql.connections': [] });
    const stub = installModuleStub('vscode', fakeVscode);
    uncacheAllSrcModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const commands = require('../../src/commands/index') as CommandsModule;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const connections = require('../../src/db/connections') as ConnectionsModule;
    return {
        commands,
        connections,
        store,
        messages,
        uninstall() {
            stub.uninstall();
            uncacheAllSrcModules();
        }
    };
}

function fakeExtCtx(secrets: ReturnType<typeof createFakeSecretStorage>): import('vscode').ExtensionContext {
    return { secrets } as unknown as import('vscode').ExtensionContext;
}

describe('addConnection wizard against settings + SecretStorage only [integration, no DB needed]', () => {
    it('adding a profile then adding a second with the same name leaves exactly one entry and does not clobber the first secret', async () => {
        const { commands, store, uninstall } = loadExtensionModules();
        try {
            const secrets = createFakeSecretStorage();
            await commands.runAddConnection(fakeExtCtx(secrets), {
                name: async () => 'dev',
                user: async () => 'hr',
                connectString: async () => 'localhost:1521/FREEPDB1',
                defaultSchema: async () => undefined,
                walletLocation: async () => undefined,
                walletPassword: async () => undefined,
                password: async () => 'first-secret'
            });
            await commands.runAddConnection(fakeExtCtx(secrets), {
                name: async () => 'dev', // same name — no live UI validateInput to stop it, mirroring a settings.json race
                user: async () => 'hr2',
                connectString: async () => 'localhost:1521/OTHERPDB',
                defaultSchema: async () => undefined,
                walletLocation: async () => undefined,
                walletPassword: async () => undefined,
                password: async () => 'second-secret'
            });

            const persisted = store['utplsql.connections'] as unknown[];
            assert.equal(persisted.length, 1, `expected exactly one entry, got ${JSON.stringify(persisted)}`);
            assert.equal(await secrets.get('utplsql.password.dev'), 'first-secret', "expected the first profile's secret to survive the rejected duplicate add");
        } finally {
            uninstall();
        }
    });

    it('aborting before the password is supplied leaves no entry in utplsql.connections', async () => {
        const { commands, store, uninstall } = loadExtensionModules();
        try {
            const secrets = createFakeSecretStorage();
            await commands.runAddConnection(fakeExtCtx(secrets), {
                name: async () => 'dev',
                user: async () => 'hr',
                connectString: async () => 'localhost:1521/FREEPDB1',
                defaultSchema: async () => undefined,
                walletLocation: async () => undefined,
                walletPassword: async () => undefined,
                password: async () => undefined // Esc
            });
            assert.deepEqual((store['utplsql.connections'] as unknown[]) ?? [], []);
        } finally {
            uninstall();
        }
    });

    it('a defaultSchema rejected by SCHEMA_NAME_RE is refused at entry, not persisted, and produces no partial profile', async () => {
        const { commands, store, messages, uninstall } = loadExtensionModules();
        try {
            const secrets = createFakeSecretStorage();
            await commands.runAddConnection(fakeExtCtx(secrets), {
                name: async () => 'dev',
                user: async () => 'hr',
                connectString: async () => 'localhost:1521/FREEPDB1',
                defaultSchema: async () => '1_bad_start', // SCHEMA_NAME_RE requires a leading letter
                walletLocation: async () => undefined,
                walletPassword: async () => undefined,
                password: async () => 'pw'
            });
            assert.deepEqual((store['utplsql.connections'] as unknown[]) ?? [], []);
            assert.ok(messages.some((m) => m.kind === 'error' && m.message.toLowerCase().includes('defaultschema')));
        } finally {
            uninstall();
        }
    });
});
