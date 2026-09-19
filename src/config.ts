// This file defines Power Glove's configuration schema and reader.
// - Declares the TypeScript interfaces (CommandConfig, MachineSetting,
//   Override) used throughout the extension.
// - Exposes initializeCommandsStorage() which resolves the commands file
//   path (from settings or the default globalStorage location) and stores
//   it for subsequent read/write operations.
// - Exposes readCommands() / saveCommands() that delegate to storage.ts
//   using the resolved path, so consumers never need to track the path.
// - Exposes getCommandsFilePath() for diagnostics and the manager UI.

import * as vscode from 'vscode';
import { CommandConfig } from './types';
import {
    getCommandsFilePath as resolvePath,
    readCommandsFromFile,
    writeCommandsToFile,
    commandsFileExists,
    createDefaultCommandsFile,
} from './storage';

// Re-export interfaces for backward compatibility with existing imports.
export type { Override, MachineSetting, CommandConfig } from './types';

// ── Module-level state ────────────────────────────────────────────────

let resolvedFilePath = '';

// ── Initialization ────────────────────────────────────────────────────

/**
 * Resolve the commands file path (configured or default) and store it.
 * Must be called once during extension activation before any read/write.
 * Returns the resolved path so callers can use it for existence checks.
 */
export function initializeCommandsStorage(context: vscode.ExtensionContext): string {
    resolvedFilePath = resolvePath(context);
    return resolvedFilePath;
}

/** Return the currently resolved commands file path. */
export function getCommandsFilePath(): string {
    return resolvedFilePath;
}

// ── Read / Write ──────────────────────────────────────────────────────

/** Synchronously read commands from the resolved JSON file.
 *  Returns an empty array when the file doesn't exist or is malformed. */
export function readCommands(): CommandConfig[] {
    if (!resolvedFilePath) { return []; }
    return readCommandsFromFile(resolvedFilePath);
}

/** Asynchronously write commands to the resolved JSON file. */
export async function saveCommands(commands: CommandConfig[]): Promise<void> {
    if (!resolvedFilePath) { return; }
    await writeCommandsToFile(resolvedFilePath, commands);
}

// ── File existence ────────────────────────────────────────────────────

/** Check whether the resolved commands file exists on disk. */
export function fileExists(): boolean {
    if (!resolvedFilePath) { return false; }
    return commandsFileExists(resolvedFilePath);
}

/** Create the commands file at the resolved path with an empty array. */
export async function createFile(): Promise<void> {
    if (!resolvedFilePath) { return; }
    await createDefaultCommandsFile(resolvedFilePath);
}
