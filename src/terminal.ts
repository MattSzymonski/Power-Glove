// This file runs ResolvedCommand entries inside VS Code terminals.
// - runInCurrentTerminal() reuses the active terminal or creates one,
//   shows it, and sends the resolved shell command.
// - runInNewTerminal() always opens a fresh terminal named after the
//   command ("Power Glove: <name>").
// - isWindowsPlatform() is a tiny helper used by the resolver to pick
//   the right cd syntax.

import * as vscode from 'vscode';
import { ResolvedCommand } from './resolver';

// Send the resolved shell command to the active terminal, creating one if
// none is open. The terminal is brought into focus before sending.
export function runInCurrentTerminal(cmd: ResolvedCommand): void {
    const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal();
    terminal.show();
    terminal.sendText(cmd.finalShellCommand, true);
}

// Always spawn a fresh terminal, named after the command, and run there.
// Useful for long-running processes that shouldn't share a terminal.
export function runInNewTerminal(cmd: ResolvedCommand): void {
    const terminal = vscode.window.createTerminal({ name: `Power Glove: ${cmd.name}` });
    terminal.show();
    terminal.sendText(cmd.finalShellCommand, true);
}

// Tiny platform helper consumed by resolver.ts to pick the right `cd` syntax.
export function isWindowsPlatform(): boolean {
    return process.platform === 'win32';
}
