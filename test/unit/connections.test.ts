import assert from 'node:assert/strict';
import { validateProfileName } from '../../src/db/profileName';
import { installModuleStub, uncacheAllSrcModules } from './support/moduleStub';
import { createFakeVscode, createFakeSecretStorage } from './support/fakeVscode';

type ConnectionsModule = typeof import('../../src/db/connections');

/**
 * src/db/connections.ts imports 'vscode' for real
 * (workspace.getConfiguration/update), so it can only be require()'d after
 * a fake 'vscode' module is installed — see support/moduleStub.ts. The
 * require() happens here, inside a helper called from within each test
 * body, rather than as a top-level `import`: a top-level import would be
 * hoisted to a plain require() at module-load time by tsx's commonjs
 * output, which runs before any test (or its stub) does.
 */
function loadConnections(initialConnections: unknown[] = []): { connections: ConnectionsModule; store: Record<string, unknown>; uninstall(): void } {
    const { module: fakeVscode, store } = createFakeVscode({ 'utplsql.connections': initialConnections });
    const stub = installModuleStub('vscode', fakeVscode);
    uncacheAllSrcModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const connections = require('../../src/db/connections') as ConnectionsModule;
    return {
        connections,
        store,
        uninstall() {
            stub.uninstall();
            uncacheAllSrcModules();
        }
    };
}

describe('validateProfileName', () => {
    it("rejects an empty name with an error message, accepts 'dev'", () => {
        assert.equal(typeof validateProfileName(''), 'string');
        assert.equal(validateProfileName('dev'), undefined);
    });

    it("rejects a name containing '/', naming the offending character", () => {
        const message = validateProfileName('a/b');
        assert.equal(typeof message, 'string');
        assert.ok(message!.includes('/'), `expected the message to name '/': ${message}`);
    });

    it("rejects a name containing ':', naming the offending character", () => {
        const message = validateProfileName('a:b');
        assert.equal(typeof message, 'string');
        assert.ok(message!.includes(':'), `expected the message to name ':': ${message}`);
    });

    it("rejects 'dev' as a duplicate when 'dev' already exists", () => {
        const message = validateProfileName('dev', ['dev', 'prod']);
        assert.equal(typeof message, 'string');
        assert.ok(message!.includes('dev'));
    });

    it('accepts a name not present in the existing list', () => {
        assert.equal(validateProfileName('dev', ['prod']), undefined);
    });
});

describe('connections (against a fake vscode module)', () => {
    it('addProfile on a duplicate rejects with a message containing the profile name', async () => {
        const { connections, uninstall } = loadConnections([{ name: 'dev', user: 'hr', connectString: 'x' }]);
        try {
            await assert.rejects(
                () => connections.addProfile({ name: 'dev', user: 'hr2', connectString: 'y' }),
                (err: unknown) => err instanceof Error && err.message.includes('dev')
            );
        } finally {
            uninstall();
        }
    });

    it('addProfile persists a new profile alongside existing ones', async () => {
        const { connections, store, uninstall } = loadConnections([{ name: 'dev', user: 'hr', connectString: 'x' }]);
        try {
            await connections.addProfile({ name: 'prod', user: 'hr', connectString: 'y' });
            assert.deepEqual(store['utplsql.connections'], [
                { name: 'dev', user: 'hr', connectString: 'x' },
                { name: 'prod', user: 'hr', connectString: 'y' }
            ]);
        } finally {
            uninstall();
        }
    });

    it('removeProfile deletes both the settings entry and the secret under the utplsql.password. prefix', async () => {
        const { connections, store, uninstall } = loadConnections([
            { name: 'dev', user: 'hr', connectString: 'x' },
            { name: 'prod', user: 'hr', connectString: 'y' }
        ]);
        try {
            const secrets = createFakeSecretStorage({ 'utplsql.password.dev': 'secret', 'utplsql.password.prod': 'other' });
            await connections.removeProfile('dev', secrets);
            assert.deepEqual(store['utplsql.connections'], [{ name: 'prod', user: 'hr', connectString: 'y' }]);
            assert.equal(await secrets.get('utplsql.password.dev'), undefined);
            assert.equal(await secrets.get('utplsql.password.prod'), 'other');
        } finally {
            uninstall();
        }
    });

    it('setPassword/getPassword round-trip through the utplsql.password. prefix', async () => {
        const { connections, uninstall } = loadConnections();
        try {
            const secrets = createFakeSecretStorage();
            await connections.setPassword(secrets, 'dev', 'hunter2');
            assert.equal(await connections.getPassword(secrets, 'dev'), 'hunter2');
            assert.deepEqual(secrets.dump(), { 'utplsql.password.dev': 'hunter2' });
        } finally {
            uninstall();
        }
    });
});
