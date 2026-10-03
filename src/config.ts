// This file defines Power Glove's configuration schema and reader.
// - Declares the TypeScript interfaces (CommandConfig, MachineSetting,
//   Override) used throughout the extension.
// - Exposes initializeCommandsStorage() which records the activation context
//   so the commands file path (from settings or the default globalStorage
//   location) can be resolved on demand.
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

// The activation context, kept only so the commands file path can be
// re-resolved on demand. The path itself is deliberately not cached here;
// see getCommandsFilePath() for why.
let storageContext: vscode.ExtensionContext | undefined;

// ── Initialization ────────────────────────────────────────────────────

/**
 * Record the activation context so the commands file path can be resolved.
 * Must be called during activation before any read/write.
 * Returns the resolved path so callers can use it for existence checks.
 */
export function initializeCommandsStorage(context: vscode.ExtensionContext): string {
    storageContext = context;
    return getCommandsFilePath();
}

/**
 * Return the resolved commands file path.
 *
 * Resolved on every call instead of memoised at activation, because an empty
 * `powerGlove.commandsFilePath` is legitimate at activation time and can be
 * set later, and a settings.json edited on disk does not reliably raise the
 * configuration-change event this extension listens for. A memoised path would
 * then keep pointing at the default globalStorage location for the rest of the
 * session, silently ignoring the setting and reporting the wrong path in the
 * manager UI. Every read, write, existence check and UI surface funnels
 * through here, so resolving here keeps all of them consistent with the
 * setting that is actually in effect.
 */
export function getCommandsFilePath(): string {
    if (!storageContext) { return ''; }
    return resolvePath(storageContext);
}

// ── Read / Write ──────────────────────────────────────────────────────

/** Synchronously read commands from the resolved JSON file.
 *  Returns an empty array when the file doesn't exist or is malformed. */
export function readCommands(): CommandConfig[] {
    const filePath = getCommandsFilePath();
    if (!filePath) { return []; }
    return readCommandsFromFile(filePath);
}

/** Asynchronously write commands to the resolved JSON file. */
export async function saveCommands(commands: CommandConfig[]): Promise<void> {
    const filePath = getCommandsFilePath();
    if (!filePath) { return; }
    await writeCommandsToFile(filePath, commands);
}

// ── File existence ────────────────────────────────────────────────────

/** Check whether the resolved commands file exists on disk. */
export function fileExists(): boolean {
    const filePath = getCommandsFilePath();
    if (!filePath) { return false; }
    return commandsFileExists(filePath);
}

/** Create the commands file at the resolved path with an empty array. */
export async function createFile(): Promise<void> {
    const filePath = getCommandsFilePath();
    if (!filePath) { return; }
    await createDefaultCommandsFile(filePath);
}
