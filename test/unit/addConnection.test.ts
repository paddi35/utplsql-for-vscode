import assert from 'node:assert/strict';
import { installModuleStub, uncacheAllSrcModules } from './support/moduleStub';
import { createFakeVscode, createFakeSecretStorage } from './support/fakeVscode';

type CommandsModule = typeof import('../../src/commands/index');

/**
 * src/commands/index.ts (via src/testing/controller.ts's forgetProfile
 * import) pulls in most of this extension's module graph, all of which
 * needs 'vscode' to be resolvable to load at all — see connections.test.ts
 * for why this has to be a dynamic require() gated behind the module stub,
 * rather than a top-level import.
 */
function loadCommands(initialConnections: unknown[] = []): {
    commands: CommandsModule;
    store: Record<string, unknown>;
    messages: { kind: 'info' | 'error' | 'warning'; message: string }[];
    uninstall(): void;
} {
    const { module: fakeVscode, store, messages } = createFakeVscode({ 'utplsql.connections': initialConnections });
    const stub = installModuleStub('vscode', fakeVscode);
    uncacheAllSrcModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const commands = require('../../src/commands/index') as CommandsModule;
    return {
        commands,
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

describe('runAddConnection (issue #25: order prompts, persist last, catch duplicate-name)', () => {
    it('persists the profile and stores the password only after every prompt has an answer', async () => {
        const { commands, store, messages, uninstall } = loadCommands();
        try {
            const secrets = createFakeSecretStorage();
            await commands.runAddConnection(fakeExtCtx(secrets), {
                name: async () => 'dev',
                user: async () => 'hr',
                connectString: async () => 'localhost:1521/FREEPDB1',
                defaultSchema: async () => undefined,
                walletLocation: async () => undefined,
                walletPassword: async () => undefined,
                password: async () => 'hunter2'
            });

            assert.deepEqual(store['utplsql.connections'], [{ name: 'dev', user: 'hr', connectString: 'localhost:1521/FREEPDB1', defaultSchema: undefined }]);
            assert.equal(await secrets.get('utplsql.password.dev'), 'hunter2');
            assert.ok(messages.some((m) => m.kind === 'info' && m.message.includes("'dev' added")));
        } finally {
            uninstall();
        }
    });

    it('leaves no entry in utplsql.connections when the password prompt is cancelled (Esc)', async () => {
        const { commands, store, uninstall } = loadCommands();
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

            assert.deepEqual(store['utplsql.connections'] ?? [], []);
        } finally {
            uninstall();
        }
    });

    it('persists the profile without a password, and says so, when the password is explicitly left empty', async () => {
        const { commands, store, messages, uninstall } = loadCommands();
        try {
            const secrets = createFakeSecretStorage();
            await commands.runAddConnection(fakeExtCtx(secrets), {
                name: async () => 'dev',
                user: async () => 'hr',
                connectString: async () => 'localhost:1521/FREEPDB1',
                defaultSchema: async () => undefined,
                walletLocation: async () => undefined,
                walletPassword: async () => undefined,
                password: async () => '' // pressed Enter on an empty box, not Esc
            });

            assert.equal((store['utplsql.connections'] as unknown[]).length, 1);
            assert.equal(await secrets.get('utplsql.password.dev'), undefined);
            assert.ok(messages.some((m) => m.kind === 'info' && m.message.includes('without a password')));
        } finally {
            uninstall();
        }
    });

    it('leaves no entry when any earlier prompt (name/user/connectString) is cancelled', async () => {
        const { commands, store, uninstall } = loadCommands();
        try {
            const secrets = createFakeSecretStorage();
            await commands.runAddConnection(fakeExtCtx(secrets), {
                name: async () => 'dev',
                user: async () => 'hr',
                connectString: async () => undefined, // cancelled
                defaultSchema: async () => undefined,
                walletLocation: async () => undefined,
                walletPassword: async () => undefined,
                password: async () => 'hunter2'
            });
            assert.deepEqual(store['utplsql.connections'] ?? [], []);
        } finally {
            uninstall();
        }
    });

    it('shows an error message instead of throwing when the name duplicates an existing profile', async () => {
        const { commands, store, messages, uninstall } = loadCommands([{ name: 'dev', user: 'hr', connectString: 'x' }]);
        try {
            const secrets = createFakeSecretStorage();
            await commands.runAddConnection(fakeExtCtx(secrets), {
                // A fake prompt bypasses the real validateInput gate, standing
                // in for a race with a settings.json edit made while the
                // wizard was open — addProfile's own duplicate check is the
                // backstop for that.
                name: async () => 'dev',
                user: async () => 'hr2',
                connectString: async () => 'y',
                defaultSchema: async () => undefined,
                walletLocation: async () => undefined,
                walletPassword: async () => undefined,
                password: async () => 'pw'
            });

            assert.equal((store['utplsql.connections'] as unknown[]).length, 1, 'expected the duplicate add to leave the original single entry untouched');
            assert.ok(
                messages.some((m) => m.kind === 'error' && m.message.includes('dev')),
                `expected an error notification naming 'dev', got: ${JSON.stringify(messages)}`
            );
        } finally {
            uninstall();
        }
    });

    it('refuses a defaultSchema rejected by SCHEMA_NAME_RE at entry, before persisting anything', async () => {
        const { commands, store, messages, uninstall } = loadCommands();
        try {
            const secrets = createFakeSecretStorage();
            await commands.runAddConnection(fakeExtCtx(secrets), {
                name: async () => 'dev',
                user: async () => 'hr',
                connectString: async () => 'x',
                defaultSchema: async () => 'not a valid identifier!',
                walletLocation: async () => undefined,
                walletPassword: async () => undefined,
                password: async () => 'pw'
            });

            assert.deepEqual(store['utplsql.connections'] ?? [], []);
            assert.ok(messages.some((m) => m.kind === 'error' && m.message.includes('defaultSchema')));
        } finally {
            uninstall();
        }
    });

    it('persists walletLocation and stores the wallet password when a wallet is configured (issue #83)', async () => {
        const { commands, store, uninstall } = loadCommands();
        try {
            const secrets = createFakeSecretStorage();
            await commands.runAddConnection(fakeExtCtx(secrets), {
                name: async () => 'dev',
                user: async () => 'hr',
                connectString: async () => 'tcps://localhost:1522/FREEPDB1',
                defaultSchema: async () => undefined,
                walletLocation: async () => '/opt/wallet',
                walletPassword: async () => 'walletsecret',
                password: async () => 'hunter2'
            });

            assert.deepEqual(store['utplsql.connections'], [
                { name: 'dev', user: 'hr', connectString: 'tcps://localhost:1522/FREEPDB1', defaultSchema: undefined, walletLocation: '/opt/wallet' }
            ]);
            assert.equal(await secrets.get('utplsql.walletPassword.dev'), 'walletsecret');
        } finally {
            uninstall();
        }
    });

    it('leaves no walletLocation and stores no wallet password when the wallet prompt is left empty (issue #83)', async () => {
        const { commands, store, uninstall } = loadCommands();
        try {
            const secrets = createFakeSecretStorage();
            await commands.runAddConnection(fakeExtCtx(secrets), {
                name: async () => 'dev',
                user: async () => 'hr',
                connectString: async () => 'localhost:1521/FREEPDB1',
                defaultSchema: async () => undefined,
                walletLocation: async () => undefined,
                walletPassword: async () => 'should never be prompted for, let alone stored',
                password: async () => 'hunter2'
            });

            assert.deepEqual(store['utplsql.connections'], [{ name: 'dev', user: 'hr', connectString: 'localhost:1521/FREEPDB1', defaultSchema: undefined }]);
            assert.equal(await secrets.get('utplsql.walletPassword.dev'), undefined);
        } finally {
            uninstall();
        }
    });
});
