/**
 * Minimal fakes of the two vscode surfaces src/db/connections.ts (and, via
 * resolveTnsAdminDir(), src/db/tnsnames.ts) actually touch at runtime:
 * workspace.getConfiguration(section).get/update/inspect, and
 * ConfigurationTarget.Global. See support/moduleStub.ts for how this gets
 * substituted for the real 'vscode' module.
 */
export interface FakeConfigStore {
    [fullKey: string]: unknown;
}

export interface FakeVscodeModule {
    workspace: {
        getConfiguration(section: string): {
            get<T>(key: string, defaultValue?: T): T | undefined;
            update(key: string, value: unknown): Promise<void>;
            inspect<T>(key: string): { key: string; globalValue?: T };
        };
    };
    ConfigurationTarget: { Global: number; Workspace: number; WorkspaceFolder: number };
    window: {
        showInformationMessage(message: string): Thenable<undefined>;
        showErrorMessage(message: string): Thenable<undefined>;
        showWarningMessage(message: string): Thenable<undefined>;
    };
}

/**
 * `messages` records every show*Message call verbatim (in call order) — the
 * runAddConnection tests assert against it instead of against real vscode
 * notifications, which don't exist outside the extension host.
 */
export function createFakeVscode(
    initial: FakeConfigStore = {}
): { module: FakeVscodeModule; store: FakeConfigStore; messages: { kind: 'info' | 'error' | 'warning'; message: string }[] } {
    const store: FakeConfigStore = { ...initial };
    const messages: { kind: 'info' | 'error' | 'warning'; message: string }[] = [];
    const module: FakeVscodeModule = {
        workspace: {
            getConfiguration(section: string) {
                return {
                    get<T>(key: string, defaultValue?: T): T | undefined {
                        const full = `${section}.${key}`;
                        return full in store ? (store[full] as T) : defaultValue;
                    },
                    update(key: string, value: unknown): Promise<void> {
                        store[`${section}.${key}`] = value;
                        return Promise.resolve();
                    },
                    inspect<T>(key: string) {
                        const full = `${section}.${key}`;
                        return { key: full, globalValue: store[full] as T | undefined };
                    }
                };
            }
        },
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        window: {
            showInformationMessage: (message: string) => {
                messages.push({ kind: 'info', message });
                return Promise.resolve(undefined);
            },
            showErrorMessage: (message: string) => {
                messages.push({ kind: 'error', message });
                return Promise.resolve(undefined);
            },
            showWarningMessage: (message: string) => {
                messages.push({ kind: 'warning', message });
                return Promise.resolve(undefined);
            }
        }
    };
    return { module, store, messages };
}

/**
 * Stands in for vscode.SecretStorage — getPassword/setPassword/getPool all
 * take it as a plain parameter (a type reference, erased at compile time),
 * so a structurally-compatible fake works without touching the 'vscode'
 * module at all. keys()/onDidChange are part of the real interface but
 * unused by src/db/connections.ts; they're here only so this satisfies the
 * vscode.SecretStorage type at the call sites that expect it.
 */
export interface FakeSecretStorage {
    keys(): Promise<string[]>;
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    onDidChange: (listener: (e: { key: string }) => unknown) => { dispose(): void };
}

export function createFakeSecretStorage(initial: Record<string, string> = {}): FakeSecretStorage & { dump(): Record<string, string> } {
    const store = new Map(Object.entries(initial));
    return {
        keys: () => Promise.resolve([...store.keys()]),
        get: (key) => Promise.resolve(store.get(key)),
        store: (key, value) => {
            store.set(key, value);
            return Promise.resolve();
        },
        delete: (key) => {
            store.delete(key);
            return Promise.resolve();
        },
        onDidChange: () => ({ dispose: () => undefined }),
        dump: () => Object.fromEntries(store)
    };
}
