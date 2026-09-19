// This file manages the recently-run command history for Power Glove.
// - Stores an ordered list of command names in extension globalState so it
//   persists across VS Code sessions.
// - getRecentNames() returns the list (most-recent first).
// - recordRecentName() prepends a name and caps the list at MAX_RECENT.

import * as vscode from 'vscode';

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
