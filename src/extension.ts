// This file is the entry point of the Power Glove VS Code extension.
// - Activates on startup and wires up the extension's lifecycle.
// - Registers the four user-facing commands: openUI, openManager,
//   runInCurrentTerminal, runInNewTerminal.
// - Reads config, detects the current machine, and resolves commands
//   through resolver.ts before delegating to the picker UI.
// - Owns the shared OutputChannel used for diagnostic logging.

import * as vscode from 'vscode';
import { readConfig } from './config';
import { detectMachineName } from './machine';
import { resolveCommands, ResolvedCommand } from './resolver';
import { isWindowsPlatform, runInCurrentTerminal, runInNewTerminal } from './terminal';
import { showCommandPicker } from './ui/picker';
import { openCommandsManager } from './ui/manager';

// Module-scoped output channel; created in activate(), used by log() and reportError().
let output: vscode.OutputChannel;

// Extension entry point invoked by VS Code on first command/event.
// - Creates the shared OutputChannel.
// - Registers all four user-facing commands and ties their disposables to the
//   extension context so they're cleaned up on deactivate.
export function activate(context: vscode.ExtensionContext): void {
	output = vscode.window.createOutputChannel('Power Glove');

	context.subscriptions.push(
		output,
		vscode.commands.registerCommand('powerGlove.openUI', () => openUI(context)),
		vscode.commands.registerCommand('powerGlove.openManager', () => openCommandsManager(context)),
		vscode.commands.registerCommand('powerGlove.runInCurrentTerminal', () =>
			pickAndRun(runInCurrentTerminal),
		),
		vscode.commands.registerCommand('powerGlove.runInNewTerminal', () =>
			pickAndRun(runInNewTerminal),
		),
	);

	log('activated');
}

// VS Code lifecycle hook. No explicit cleanup needed; everything is registered
// through context.subscriptions and disposed automatically.
export function deactivate(): void {
	// Disposed via context.subscriptions.
}

// Handler for `powerGlove.openUI`. Resolves the current command list for this
// machine/workspace and hands it to the QuickPick picker; any error is surfaced
// through the OutputChannel and a notification.
function openUI(context: vscode.ExtensionContext): void {
	try {
		const { resolved, machineName } = getResolvedCommands();
		showCommandPicker(resolved, machineName, () => openCommandsManager(context));
	} catch (err) {
		reportError(err);
	}
}

// Shared handler for the `runInCurrentTerminal` / `runInNewTerminal` commands.
// - Resolves commands for this machine, shows a minimal QuickPick, and forwards
//   the chosen entry to the supplied `run` strategy.
// - Shows an error if no commands match the current machine.
async function pickAndRun(run: (cmd: ResolvedCommand) => void): Promise<void> {
	try {
		const { resolved, machineName } = getResolvedCommands();
		// Edge case: nothing matches this machine — tell the user explicitly
		// instead of opening an empty picker.
		if (resolved.length === 0) {
			vscode.window.showErrorMessage(
				`Power Glove: no commands available for machine "${machineName}".`,
			);
			return;
		}
		const pick = await vscode.window.showQuickPick(
			resolved.map((c) => ({ label: c.name, description: c.finalShellCommand, cmd: c })),
			{ placeHolder: 'Select command' },
		);
		if (pick) { run(pick.cmd); }
	} catch (err) {
		reportError(err);
	}
}

// Gathers the inputs the resolver needs (settings, machine, workspace folders,
// platform, logger) and returns the filtered/substituted ResolvedCommand list
// alongside the detected machine name (used for status text in the UI).
function getResolvedCommands() {
	const cfg = readConfig();
	const machineName = detectMachineName();
	const workspacePaths = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
	const resolved = resolveCommands(cfg.commands, {
		machineName,
		isWindows: isWindowsPlatform(),
		workspacePaths,
		logger: log,
	});
	return { machineName, resolved };
}

// Append a timestamped diagnostic line to the "Power Glove" output channel.
function log(msg: string): void {
	output.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

// Funnel for unexpected errors: log to the output channel and notify the user.
function reportError(err: unknown): void {
	const msg = err instanceof Error ? err.message : String(err);
	log(`ERROR: ${msg}`);
	vscode.window.showErrorMessage(`Power Glove: ${msg}`);
}
