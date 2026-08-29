import * as vscode from 'vscode';

export interface ConnectionProfile {
    name: string;
    user: string;
    connectString: string;
    defaultSchema?: string;
}

const SECRET_PREFIX = 'utplsql.password.';

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
}

export async function getPassword(secrets: vscode.SecretStorage, name: string): Promise<string | undefined> {
    return secrets.get(SECRET_PREFIX + name);
}

export async function setPassword(secrets: vscode.SecretStorage, name: string, password: string): Promise<void> {
    await secrets.store(SECRET_PREFIX + name, password);
}
