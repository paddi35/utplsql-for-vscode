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

/**
 * node-oracledb's Thin-mode Easy-Connect parser only loads a configured
 * wallet for a resolved protocol of TCPS (see ezConnectResolver.js/
 * sessionAtts.js) -- everything else connects in the clear even with a
 * wallet configured (issue #83). This is a heuristic, not a hard gate: it
 * can't see inside a TNS alias's own tnsnames.ora entry, so it only
 * recognises TCPS spelled out directly in connectString -- an Easy-Connect
 * 'tcps://...' prefix, or a full descriptor's 'PROTOCOL=TCPS' pair. Matching
 * the bare substring 'tcps' anywhere (an earlier version of this check) also
 * false-positived: a hostname that merely contains 'tcps' (e.g.
 * 'tcpsprod-host...') is not a TCPS connection at all.
 */
export function connectStringDeclaresTcps(connectString: string): boolean {
    return /^\s*tcps:\/\//i.test(connectString) || /protocol\s*=\s*tcps\b/i.test(connectString);
}

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

async function getSecret(secrets: vscode.SecretStorage, prefix: string, name: string): Promise<string | undefined> {
    return secrets.get(prefix + name);
}

async function setSecret(secrets: vscode.SecretStorage, prefix: string, name: string, value: string): Promise<void> {
    await secrets.store(prefix + name, value);
}

async function deleteSecret(secrets: vscode.SecretStorage, prefix: string, name: string): Promise<void> {
    await secrets.delete(prefix + name);
}

export function getPassword(secrets: vscode.SecretStorage, name: string): Promise<string | undefined> {
    return getSecret(secrets, SECRET_PREFIX, name);
}

export function setPassword(secrets: vscode.SecretStorage, name: string, password: string): Promise<void> {
    return setSecret(secrets, SECRET_PREFIX, name, password);
}

export function getWalletPassword(secrets: vscode.SecretStorage, name: string): Promise<string | undefined> {
    return getSecret(secrets, WALLET_SECRET_PREFIX, name);
}

export function setWalletPassword(secrets: vscode.SecretStorage, name: string, password: string): Promise<void> {
    return setSecret(secrets, WALLET_SECRET_PREFIX, name, password);
}

export function deleteWalletPassword(secrets: vscode.SecretStorage, name: string): Promise<void> {
    return deleteSecret(secrets, WALLET_SECRET_PREFIX, name);
}
