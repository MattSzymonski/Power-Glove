// This file manages the recently-run command history for Power Glove.
// - Stores an ordered list of command names in extension globalState so it
//   persists across VS Code sessions.
// - getRecentNames() returns the list (most-recent first).
// - recordRecentName() prepends a name and caps the list at MAX_RECENT.
// - resolveRecentCommands() maps stored names onto the given resolved commands.

import * as vscode from 'vscode';
import { ResolvedCommand } from './resolver';

const STATE_KEY = 'powerGlove.recentCommands';
const MAX_RECENT = 10;

// Returns the stored list of recently run command names, most-recent first.
export function getRecentNames(context: vscode.ExtensionContext): string[] {
    return context.globalState.get<string[]>(STATE_KEY, []);
}

// Prepends `name` to the recents list, removes any previous occurrence of the
// same name, and trims the list to MAX_RECENT entries.
export function recordRecentName(context: vscode.ExtensionContext, name: string): void {
    const list = context.globalState.get<string[]>(STATE_KEY, []).filter((n) => n !== name);
    list.unshift(name);
    context.globalState.update(STATE_KEY, list.slice(0, MAX_RECENT));
}

// Maps stored recent names onto `commands` (typically the current machine's
// resolved, enabled manual commands), preserving most-recent-first order and
// skipping names that no longer resolve on this machine.
export function resolveRecentCommands(
    commands: ResolvedCommand[],
    recentNames: string[],
): ResolvedCommand[] {
    const byName = new Map(commands.map((c) => [c.name, c]));
    return recentNames
        .map((name) => byName.get(name))
        .filter((cmd): cmd is ResolvedCommand => cmd !== undefined);
}
