// This file handles reading and writing Power Glove commands to a
// dedicated JSON file (power-glove-commands.json) stored in the user's
// VS Code globalStorage directory (or a user-configured custom path).
//
// - getDefaultCommandsFilePath()   → default path inside globalStorageUri
// - getCommandsFilePath()          → resolves the configured or default path
// - readCommandsFromFile()         → synchronous parse of the JSON file
// - writeCommandsToFile()          → async JSON write with directory creation
// - commandsFileExists()           → quick existence check
// - createDefaultCommandsFile()    → bootstrap an empty commands file

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CommandConfig } from './types';

const SETTING_KEY = 'powerGlove.commandsFilePath';
const DEFAULT_FILENAME = 'power-glove-commands.json';

// ── Path resolution ───────────────────────────────────────────────────

/** Build the default path: <globalStorageUri>/power-glove-commands.json */
export function getDefaultCommandsFilePath(context: vscode.ExtensionContext): string {
    return vscode.Uri.joinPath(context.globalStorageUri, DEFAULT_FILENAME).fsPath;
}

/**
 * Read the user-configured path from VS Code settings, falling back to the
 * default location inside globalStorage when the setting is empty or unset.
 */
export function getCommandsFilePath(context: vscode.ExtensionContext): string {
    const cfg = vscode.workspace.getConfiguration('powerGlove');
    const configured = cfg.get<string>('commandsFilePath', '');
    if (configured && configured.trim().length > 0) {
        return configured.trim();
    }
    return getDefaultCommandsFilePath(context);
}

// ── File I/O ───────────────────────────────────────────────────────────

/** Synchronously read and parse the commands JSON file.
 *  Returns an empty array when the file doesn't exist or is malformed. */
export function readCommandsFromFile(filePath: string): CommandConfig[] {
    try {
        if (!fs.existsSync(filePath)) {
            return [];
        }
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed as CommandConfig[];
    } catch {
        return [];
    }
}

/** Asynchronously write the commands array to the JSON file.
 *  Creates the parent directory tree when it doesn't exist yet. */
export async function writeCommandsToFile(filePath: string, commands: CommandConfig[]): Promise<void> {
    const directory = path.dirname(filePath);
    if (!fs.existsSync(directory)) {
        await fs.promises.mkdir(directory, { recursive: true });
    }
    const content = JSON.stringify(commands, null, 2);
    await fs.promises.writeFile(filePath, content, 'utf-8');
}

/** Quick synchronous check whether the commands file exists on disk. */
export function commandsFileExists(filePath: string): boolean {
    try {
        return fs.existsSync(filePath);
    } catch {
        return false;
    }
}

/** Create (or overwrite) the commands file with an empty array. */
export async function createDefaultCommandsFile(filePath: string): Promise<void> {
    await writeCommandsToFile(filePath, []);
}
