import * as vscode from 'vscode';

export { validateProfileName } from './profileName';

export interface ConnectionProfile {
    name: string;
    user: string;
    connectString: string;
    defaultSchema?: string;
    /** Wallet directory for mutual TLS or an Autonomous Database wallet. The wallet's own password (if any) lives in SecretStorage, same as the connection password — see getWalletPassword/setWalletPassword. */
    walletLocation?: string;
}

const SECRET_PREFIX = 'utplsql.password.';
const WALLET_SECRET_PREFIX = 'utplsql.walletPassword.';

export function readProfiles(): ConnectionProfile[] {
    const raw = vscode.workspace.getConfiguration('utplsql').get<ConnectionProfile[]>('connections', []);
    return raw ?? [];
}

export function getProfile(name: string): ConnectionProfile | undefined {
    return readProfiles().find((p) => p.name === name);
}

async function writeProfiles(profiles: ConnectionProfile[]): Promise<void> {
    await vscode.workspace
        .getConfiguration('utplsql')
        .update('connections', profiles, vscode.ConfigurationTarget.Global);
}

export async function addProfile(profile: ConnectionProfile): Promise<void> {
    const profiles = readProfiles();
    if (profiles.some((p) => p.name === profile.name)) {
        throw new Error(`Connection profile '${profile.name}' already exists.`);
    }
    await writeProfiles([...profiles, profile]);
}

export async function removeProfile(name: string, secrets: vscode.SecretStorage): Promise<void> {
    const profiles = readProfiles().filter((p) => p.name !== name);
    await writeProfiles(profiles);
    await secrets.delete(SECRET_PREFIX + name);
    await secrets.delete(WALLET_SECRET_PREFIX + name);
}

export async function getPassword(secrets: vscode.SecretStorage, name: string): Promise<string | undefined> {
    return secrets.get(SECRET_PREFIX + name);
}

export async function setPassword(secrets: vscode.SecretStorage, name: string, password: string): Promise<void> {
    await secrets.store(SECRET_PREFIX + name, password);
}

export async function getWalletPassword(secrets: vscode.SecretStorage, name: string): Promise<string | undefined> {
    return secrets.get(WALLET_SECRET_PREFIX + name);
}

export async function setWalletPassword(secrets: vscode.SecretStorage, name: string, password: string): Promise<void> {
    await secrets.store(WALLET_SECRET_PREFIX + name, password);
}

export async function deleteWalletPassword(secrets: vscode.SecretStorage, name: string): Promise<void> {
    await secrets.delete(WALLET_SECRET_PREFIX + name);
}
