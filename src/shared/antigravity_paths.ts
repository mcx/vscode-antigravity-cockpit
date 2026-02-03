import * as os from 'os';
import * as path from 'path';

let overrideUserDataDir: string | null = null;

export function setAntigravityUserDataDir(dir: string | null): void {
    overrideUserDataDir = dir && dir.trim().length > 0 ? dir : null;
}

export function getAntigravityUserDataDir(): string | null {
    return overrideUserDataDir;
}

export function getAntigravityStateDbPath(): string {
    if (overrideUserDataDir) {
        return path.join(overrideUserDataDir, 'User', 'globalStorage', 'state.vscdb');
    }

    const homeDir = os.homedir();
    if (process.platform === 'darwin') {
        return path.join(
            homeDir,
            'Library',
            'Application Support',
            'Antigravity',
            'User',
            'globalStorage',
            'state.vscdb',
        );
    }
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
        return path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
    }
    return path.join(homeDir, '.config', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
}
