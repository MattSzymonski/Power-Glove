// This file runs ResolvedCommand entries - either inside a VS Code terminal
// (shell entries) or through the VS Code command API (vscodeCommand entries).
// - runInCurrentTerminal() reuses the active terminal or creates one, shows
//   it, and sends the resolved shell command.
// - runInNewTerminal() always opens a fresh terminal named after the command
//   ("Power Glove: <name>").
// - isWindowsPlatform() is a tiny helper used by the resolver to pick the
//   right cd syntax.

import * as vscode from 'vscode';
import { ResolvedCommand } from './resolver';

// Send the resolved shell command to the active terminal, creating one if
// none is open. The terminal is brought into focus before sending.
// Entries that target a VS Code command never touch a terminal.
export function runInCurrentTerminal(cmd: ResolvedCommand): void {
    if (dispatchVscodeCommand(cmd)) { return; }
    const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal();
    terminal.show();
    terminal.sendText(cmd.finalShellCommand, true);
}

// Always spawn a fresh terminal, named after the command, and run there.
// Useful for long-running processes that shouldn't share a terminal.
export function runInNewTerminal(cmd: ResolvedCommand): void {
    if (dispatchVscodeCommand(cmd)) { return; }
    const terminal = vscode.window.createTerminal({ name: `Power Glove: ${cmd.name}` });
    terminal.show();
    terminal.sendText(cmd.finalShellCommand, true);
}

// Run an entry's VS Code command, if it has one. Returns true when the entry
// was handled here, so both terminal strategies can continue untouched for
// shell entries. A rejection is surfaced rather than swallowed: an unknown
// command id would otherwise fail completely silently, since executeCommand
// reports through the returned promise.
function dispatchVscodeCommand(cmd: ResolvedCommand): boolean {
    if (!cmd.vscodeCommand) { return false; }
    vscode.commands
        .executeCommand(cmd.vscodeCommand, ...(cmd.vscodeCommandArgs ?? []))
        .then(undefined, (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Power Glove: "${cmd.vscodeCommand}" failed: ${msg}`);
        });
    return true;
}

// Tiny platform helper consumed by resolver.ts to pick the right `cd` syntax.
export function isWindowsPlatform(): boolean {
    return process.platform === 'win32';
}
