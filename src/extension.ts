// This file is the entry point of the Power Glove VS Code extension.
// - Activates on startup and wires up the extension's lifecycle.
// - Registers the six user-facing commands: openUI, openManager (UI),
//   openManagerJson, runInCurrentTerminal, runInNewTerminal, runRecent.
// - Reads config, detects the current machine, and resolves commands
//   through resolver.ts before delegating to the picker UI.
// - Owns the shared OutputChannel used for diagnostic logging.

import * as vscode from 'vscode';
import {
	initializeCommandsStorage,
	readCommands,
	fileExists,
	createFile,
	getCommandsFilePath,
} from './config';
import { detectMachineName } from './machine';
import { resolveCommands, ResolvedCommand } from './resolver';
import { isWindowsPlatform, runInCurrentTerminal, runInNewTerminal } from './terminal';
import { showCommandPicker } from './ui/picker';
import { openCommandsManager } from './ui/manager';
import { CommandsTreeDataProvider } from './ui/tree';
import { getRecentNames, recordRecentName } from './recent';

// Module-scoped output channel; created in activate(), used by log() and reportError().
let output: vscode.OutputChannel;

// Extension entry point invoked by VS Code on first command/event.
// - Creates the shared OutputChannel.
// - Initializes the commands storage (file path resolution).
// - Checks for the commands file; prompts the user to create it if missing.
// - Registers all user-facing commands and ties their disposables to the
//   extension context so they're cleaned up on deactivate.
export function activate(context: vscode.ExtensionContext): void {
	output = vscode.window.createOutputChannel('Power Glove');

	// ── Commands file initialisation ──────────────────────────────────
	initializeCommandsStorage(context);

	// Shared helper: show the "Create" / "Ignore" popup when the commands
	// file is missing on disk. Returns true when the file exists (either
	// already or just created by the user), false when the user declines.
	async function ensureCommandsFileExists(): Promise<boolean> {
		if (fileExists()) { return true; }

		const commandsPath = getCommandsFilePath();
		log(`commands file not found at ${commandsPath}`);
		const choice = await vscode.window.showWarningMessage(
			'Power Glove commands file not found. Do you want to create it?',
			'Create',
			'Ignore',
		);
		if (choice === 'Create') {
			await createFile();
			log(`created commands file at ${commandsPath}`);
			vscode.window.showInformationMessage(
				`Power Glove: commands file created at ${commandsPath}`,
			);
			refreshTree();
			return true;
		}
		log('user chose to ignore missing commands file');
		return false;
	}

	// Check whether the commands file exists on activation; if not, offer
	// to create it (fire-and-forget — the extension works either way).
	ensureCommandsFileExists();

	// ── Tree view (sidebar) ───────────────────────────────────────────
	const treeProvider = new CommandsTreeDataProvider();
	const treeView = vscode.window.createTreeView('powerGlove.commands', {
		treeDataProvider: treeProvider,
		showCollapseAll: true,
	});

	// Refresh the tree whenever the commands-file-path configuration
	// changes or workspace folders are added/removed.
	const refreshTree = () => {
		const { resolved, machineName } = getResolvedCommands();
		treeProvider.refresh(resolved);
		treeView.description = machineName;
		treeView.message = resolved.length === 0
			? 'No commands available for this machine. Use "Power Glove: Manage Commands (UI)" to add some.'
			: undefined;
	};
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('powerGlove.commandsFilePath')) {
				// Re-resolve the path when the user changes it in settings.
				initializeCommandsStorage(context);
				refreshTree();
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => refreshTree()),
	);

	// ── Inline action commands for tree items ─────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('powerGlove.tree.runCurrent', (arg: string) => {
			const name = typeof arg === 'string' ? arg : (arg as Record<string, unknown>)?.id as string | undefined;
			if (!name) { return; }
			const cmd = treeProvider.getResolvedCommand(name);
			if (cmd) {
				recordRecentName(context, cmd.name);
				runInCurrentTerminal(cmd);
			}
		}),
		vscode.commands.registerCommand('powerGlove.tree.runNew', (arg: string) => {
			const name = typeof arg === 'string' ? arg : (arg as Record<string, unknown>)?.id as string | undefined;
			if (!name) { return; }
			const cmd = treeProvider.getResolvedCommand(name);
			if (cmd) {
				recordRecentName(context, cmd.name);
				runInNewTerminal(cmd);
			}
		}),
		vscode.commands.registerCommand('powerGlove.tree.showInfo', (arg: string) => {
			const name = typeof arg === 'string' ? arg : (arg as Record<string, unknown>)?.id as string | undefined;
			if (!name) { return; }
			const cmd = treeProvider.getResolvedCommand(name);
			if (cmd) {
				showCommandDetails(cmd);
			}
		}),
	);

	// ── User-facing commands ──────────────────────────────────────────
	context.subscriptions.push(
		output,
		treeView,
		vscode.commands.registerCommand('powerGlove.refreshTree', () => refreshTree()),
		vscode.commands.registerCommand('powerGlove.openUI', () => openUI(context)),
		vscode.commands.registerCommand('powerGlove.openManager', async () => {
			await ensureCommandsFileExists();
			openCommandsManager(context);
		}),
		vscode.commands.registerCommand('powerGlove.openManagerJson', async () => {
			if (await ensureCommandsFileExists()) {
				await openCommandsJsonFile();
			}
		}),
		vscode.commands.registerCommand('powerGlove.runInCurrentTerminal', () =>
			pickAndRun(context, runInCurrentTerminal),
		),
		vscode.commands.registerCommand('powerGlove.runInNewTerminal', () =>
			pickAndRun(context, runInNewTerminal),
		),
		vscode.commands.registerCommand('powerGlove.runRecent', () => runRecent(context)),
	);

	// Initial tree population.
	refreshTree();

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
		const recentNames = getRecentNames(context);
		showCommandPicker(
			resolved,
			machineName,
			recentNames,
			(name) => recordRecentName(context, name),
			() => openCommandsManager(context),
		);
	} catch (err) {
		reportError(err);
	}
}

// Handler for `powerGlove.openManagerJson`. Opens the commands JSON file
// as a text document in a new editor tab.
async function openCommandsJsonFile(): Promise<void> {
	try {
		const filePath = getCommandsFilePath();
		const uri = vscode.Uri.file(filePath);
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document);
	} catch (err) {
		reportError(err);
	}
}

// Shared handler for the `runInCurrentTerminal` / `runInNewTerminal` commands.
// - Resolves commands for this machine, shows a minimal QuickPick, and forwards
//   the chosen entry to the supplied `run` strategy.
// - Shows an error if no commands match the current machine.
async function pickAndRun(context: vscode.ExtensionContext, run: (cmd: ResolvedCommand) => void): Promise<void> {
	try {
		const { resolved, machineName } = getResolvedCommands();
		if (resolved.length === 0) {
			vscode.window.showErrorMessage(
				`Power Glove: no commands available for machine "${machineName}".`,
			);
			return;
		}
		const pick = await vscode.window.showQuickPick(
			resolved.map((c) => ({ label: c.name, description: c.command, cmd: c })),
			{ placeHolder: 'Select command' },
		);
		if (pick) {
			recordRecentName(context, pick.cmd.name);
			run(pick.cmd);
		}
	} catch (err) {
		reportError(err);
	}
}

// Handler for `powerGlove.runRecent`.
// - Shows a quick pick of the most-recently-run commands (matched against the
//   current machine's resolved list so stale entries are skipped).
// - If there are no recents yet, shows an informational message.
async function runRecent(context: vscode.ExtensionContext): Promise<void> {
	try {
		const recentNames = getRecentNames(context);
		if (recentNames.length === 0) {
			vscode.window.showInformationMessage('Power Glove: no recently run commands yet.');
			return;
		}
		const { resolved } = getResolvedCommands();
		const byName = new Map(resolved.map((c) => [c.name, c]));
		const recentResolved = recentNames
			.map((n) => byName.get(n))
			.filter((c): c is ResolvedCommand => c !== undefined);
		if (recentResolved.length === 0) {
			vscode.window.showInformationMessage('Power Glove: no recent commands available on this machine.');
			return;
		}
		const pick = await vscode.window.showQuickPick(
			recentResolved.map((c) => ({ label: c.name, description: c.command, cmd: c })),
			{ placeHolder: 'Select recent command' },
		);
		if (pick) {
			recordRecentName(context, pick.cmd.name);
			runInCurrentTerminal(pick.cmd);
		}
	} catch (err) {
		reportError(err);
	}
}

// Gathers the inputs the resolver needs (commands from the JSON file,
// machine, workspace folders, platform, logger) and returns the filtered/
// substituted ResolvedCommand list alongside the detected machine name
// (used for status text in the UI).
function getResolvedCommands() {
	const commands = readCommands();
	const machineName = detectMachineName();
	const workspacePaths = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
	const resolved = resolveCommands(commands, {
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

// Show a details popup for a command (triggered by the ⓘ inline button in the
// tree view). Uses a single-item QuickPick so the user can read the description,
// inspect the resolved shell command, and optionally copy or run it.
function showCommandDetails(cmd: ResolvedCommand): void {
	const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
	qp.title = `Command: ${cmd.name}`;
	qp.placeholder = 'Esc to close  ·  Enter to run in current terminal';
	qp.items = [
		{ label: '$(info) Description', description: cmd.description || '(none)' },
		{ label: '$(folder) Project', description: cmd.project || '(general)' },
		{ label: '$(root-folder) Directory', description: cmd.directory || '(none — runs in terminal CWD)' },
		{ label: '$(terminal) Shell command', description: cmd.finalShellCommand },
	];
	qp.buttons = [
		{ iconPath: new vscode.ThemeIcon('copy'), tooltip: 'Copy shell command' },
		{ iconPath: new vscode.ThemeIcon('play'), tooltip: 'Run in current terminal' },
	];
	qp.onDidTriggerButton((btn) => {
		if (btn.tooltip === 'Copy shell command') {
			vscode.env.clipboard.writeText(cmd.finalShellCommand);
			vscode.window.showInformationMessage('Copied shell command to clipboard.');
			qp.hide();
		} else {
			qp.hide();
			runInCurrentTerminal(cmd);
		}
	});
	qp.onDidAccept(() => {
		qp.hide();
		runInCurrentTerminal(cmd);
	});
	qp.onDidHide(() => qp.dispose());
	qp.show();
}
