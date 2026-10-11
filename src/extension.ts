// This file is the entry point of the Power Glove VS Code extension.
// - Activates on startup and wires up the extension's lifecycle.
// - Registers the user-facing commands: openUI, openManager (UI),
//   openManagerJson, runInCurrentTerminal, runInNewTerminal, runRecent,
//   plus the auto-run actions (runNow, runAll).
// - Reads config, detects the current machine, and resolves commands
//   through resolver.ts before delegating to the picker UI.
// - Owns the single sidebar tree, split into the manual commands section on
//   top and the Auto Run section at the bottom, plus the background
//   AutoRunEngine that feeds the auto-run rows.
// - Persists the last auto-run verdict per command (globalState) so window
//   reloads show the previous status instead of a blank row, and prunes
//   entries whose command has disappeared from the file.
// - Provides the enable/disable context actions and feeds the tree the
//   next-scheduled-run countdown rendered in its tooltips.
// - Watches the commands file so manager saves refresh both trees and
//   rebuild the auto-run schedule without an extension reload.
// - Owns the shared OutputChannel used for diagnostic logging.

import * as path from "path";
import * as vscode from "vscode";
import {
	createFile,
	fileExists,
	getCommandsFilePath,
	initializeCommandsStorage,
	readCommands,
	saveCommands,
} from "./config";
import { detectMachineName } from "./machine";
import { resolveCommands, ResolvedCommand } from "./resolver";
import {
	isWindowsPlatform,
	runInCurrentTerminal,
	runInNewTerminal,
} from "./terminal";
import { AutoRunEngine, AutoRunResult } from "./autorun";
import { showCommandPicker } from "./ui/picker";
import { openCommandsManager } from "./ui/manager";
import { openColorPicker } from "./ui/colorPicker";
import { openEmojiPicker } from "./ui/emojiPicker";
import { CommandsTreeDataProvider } from "./ui/tree";
import {
	getRecentNames,
	recordRecentName,
	resolveRecentCommands,
} from "./recent";

// Module-scoped output channel; created in activate(), used by log() and reportError().
let output: vscode.OutputChannel;

// Extension entry point invoked by VS Code on first command/event.
// - Creates the shared OutputChannel.
// - Initializes the commands storage (file path resolution).
// - Checks for the commands file; prompts the user to create it if missing.
// - Registers all user-facing commands and ties their disposables to the
//   extension context so they're cleaned up on deactivate.
export function activate(context: vscode.ExtensionContext): void {
	output = vscode.window.createOutputChannel("Power Glove");

	// ── Commands file initialisation ──────────────────────────────────
	initializeCommandsStorage(context);

	// Shared helper: show the "Create" / "Ignore" popup when the commands
	// file is missing on disk. Returns true when the file exists (either
	// already or just created by the user), false when the user declines.
	async function ensureCommandsFileExists(): Promise<boolean> {
		if (fileExists()) return true;

		const commandsPath = getCommandsFilePath();
		log(`commands file not found at ${commandsPath}`);
		const choice = await vscode.window.showWarningMessage(
			"Power Glove commands file not found. Do you want to create it?",
			"Create",
			"Ignore",
		);
		if (choice === "Create") {
			await createFile();
			log(`created commands file at ${commandsPath}`);
			vscode.window.showInformationMessage(
				`Power Glove: commands file created at ${commandsPath}`,
			);
			refreshTrees();
			return true;
		}
		log("user chose to ignore missing commands file");
		return false;
	}

	// Check whether the commands file exists on activation; if not, offer
	// to create it (fire-and-forget — the extension works either way).
	ensureCommandsFileExists();

	// ── Tree view (sidebar) ─────────────────────────────────────────
	// The engine is constructed a few lines below; the countdown callback
	// only runs once tooltips render, long after activation has finished.
	let autoEngine!: AutoRunEngine;
	const treeProvider = new CommandsTreeDataProvider({
		getNextRunAtMilliseconds: (name) =>
			autoEngine.getNextRunAtMilliseconds(name),
	});
	const treeView = vscode.window.createTreeView("powerGlove.commands", {
		treeDataProvider: treeProvider,
		showCollapseAll: true,
	});

	// Last auto-run verdicts, persisted per command so a window reload shows
	// the previous status instead of resetting every dot to "unknown".
	const AUTO_RUN_RESULTS_KEY = "powerGlove.autoRunResults";
	const storedAutoResults = context.globalState.get<
		Record<string, AutoRunResult>
	>(
		AUTO_RUN_RESULTS_KEY,
		{},
	);
	for (const [name, result] of Object.entries(storedAutoResults)) {
		treeProvider.setResult(name, result);
	}

	// Background runner for 'auto' commands; its callbacks refresh the
	// status rows inside the Auto Run section and persist each verdict.
	autoEngine = new AutoRunEngine({
		getCommands: () =>
			getResolvedCommands().resolved.filter((c) =>
				c.type === "auto" && c.enabled
			),
		logger: log,
		onRunStarted: (name) => treeProvider.setRunning(name, true),
		onRunFinished: (name, result) => {
			treeProvider.setResult(name, result);
			storedAutoResults[name] = result;
			void context.globalState.update(
				AUTO_RUN_RESULTS_KEY,
				storedAutoResults,
			);
		},
	});

	// Refresh the view and rebuild the auto-run schedule. Called on
	// activation, configuration changes, workspace-folder changes, and when
	// the commands file itself changes on disk (manager saves).
	const refreshTrees = () => {
		// Name the file in use, so "which commands file is this reading?" is
		// answerable from the output channel rather than by reading the code.
		log(`commands file: ${getCommandsFilePath()}`);
		const { resolved, machineName } = getResolvedCommands();
		const manualCommands = resolved.filter((c) => c.type === "manual");
		const autoCommands = resolved.filter((c) => c.type === "auto");
		treeProvider.refresh(manualCommands, autoCommands);

		// Drop persisted results whose command no longer exists in the file
		// (renames and deletions); the raw config is compared instead of the
		// machine/project-filtered view, so hiding a command on one workspace
		// never discards the status recorded on another.
		const configuredNames = new Set(readCommands().map((c) => c.name));
		let prunedStoredResults = false;
		for (const name of Object.keys(storedAutoResults)) {
			if (!configuredNames.has(name)) {
				delete storedAutoResults[name];
				prunedStoredResults = true;
			}
		}
		if (prunedStoredResults) {
			void context.globalState.update(
				AUTO_RUN_RESULTS_KEY,
				storedAutoResults,
			);
		}
		treeView.description = machineName;
		treeView.message =
			manualCommands.length === 0 && autoCommands.length === 0
				? 'No commands available for this machine. Use "Power Glove: Manage Commands (UI)" to add some.'
				: undefined;
		autoEngine.resync();
	};

	// Watch the commands file so edits made in the manager (or by hand) take
	// effect without a reload: both trees refresh and the schedule rebuilds.
	// The watcher is recreated whenever the configured file path changes.
	let commandsFileWatcher: vscode.FileSystemWatcher | undefined;
	let fileChangeDebounce: NodeJS.Timeout | undefined;
	const watchCommandsFile = () => {
		commandsFileWatcher?.dispose();
		const filePath = getCommandsFilePath();
		if (!filePath) return;
		commandsFileWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(
				vscode.Uri.file(path.dirname(filePath)),
				path.basename(filePath),
			),
		);
		const scheduleRefresh = () => {
			if (fileChangeDebounce) clearTimeout(fileChangeDebounce);
			fileChangeDebounce = setTimeout(() => refreshTrees(), 400);
		};
		commandsFileWatcher.onDidChange(scheduleRefresh);
		commandsFileWatcher.onDidCreate(scheduleRefresh);
		commandsFileWatcher.onDidDelete(scheduleRefresh);
	};

	// Countdown ticker: refresh the auto rows every 15 s while the view is
	// visible so the tooltip "next run" countdown stays roughly accurate.
	// Row re-renders are cheap, and nothing runs while the view is hidden.
	const countdownTicker = setInterval(() => {
		if (treeView.visible) treeProvider.refreshAutoRows();
	}, 15_000);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("powerGlove.commandsFilePath")) {
				// Re-resolve the path when the user changes it in settings.
				initializeCommandsStorage(context);
				watchCommandsFile();
				refreshTrees();
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => refreshTrees()),
		new vscode.Disposable(() => {
			if (fileChangeDebounce) clearTimeout(fileChangeDebounce);
			clearInterval(countdownTicker);
			commandsFileWatcher?.dispose();
			autoEngine.dispose();
		}),
	);

	// ── Enable / disable toggle ───────────────────────────────────────
	// Rewrites one entry in the commands file ("enabled": false disables it
	// everywhere without deleting it). The file watcher would pick the save
	// up on its own, but refreshTrees() makes the row flip immediately.
	const setCommandEnabled = async (
		arg: unknown,
		enabled: boolean,
	): Promise<void> => {
		const name = commandNameFromArg(arg);
		if (!name) return;
		const commands = readCommands();
		const entry = commands.find((c) => c.name === name);
		if (!entry) return;
		if (enabled) {
			delete entry.enabled;
		} else {
			entry.enabled = false;
		}
		await saveCommands(commands);
		log(`${enabled ? "enabled" : "disabled"} command: ${name}`);
		refreshTrees();
	};

	// ── Inline action commands for tree items ─────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"powerGlove.tree.disableCommand",
			(arg: unknown) => setCommandEnabled(arg, false),
		),
		vscode.commands.registerCommand(
			"powerGlove.tree.enableCommand",
			(arg: unknown) => setCommandEnabled(arg, true),
		),
		vscode.commands.registerCommand(
			"powerGlove.tree.runCurrent",
			(arg: unknown) => {
				const name = commandNameFromArg(arg);
				if (!name) return;
				const cmd = treeProvider.getResolvedCommand(name);
				if (cmd) {
					recordRecentName(context, cmd.name);
					runInCurrentTerminal(cmd);
				}
			},
		),
		vscode.commands.registerCommand(
			"powerGlove.tree.runNew",
			(arg: unknown) => {
				const name = commandNameFromArg(arg);
				if (!name) return;
				const cmd = treeProvider.getResolvedCommand(name);
				if (cmd) {
					recordRecentName(context, cmd.name);
					runInNewTerminal(cmd);
				}
			},
		),
		vscode.commands.registerCommand(
			"powerGlove.tree.showInfo",
			(arg: unknown) => {
				const name = commandNameFromArg(arg);
				if (!name) return;
				const cmd = treeProvider.getResolvedCommand(name);
				if (cmd) {
					showCommandDetails(cmd);
				}
			},
		),
	);

	// ── User-facing commands ──────────────────────────────────────────
	context.subscriptions.push(
		output,
		treeView,
		vscode.commands.registerCommand(
			"powerGlove.refreshTree",
			() => refreshTrees(),
		),
		vscode.commands.registerCommand(
			"powerGlove.openUI",
			() => openUI(context),
		),
		vscode.commands.registerCommand("powerGlove.openManager", async () => {
			await ensureCommandsFileExists();
			openCommandsManager(context);
		}),
		vscode.commands.registerCommand(
			"powerGlove.openManagerJson",
			async () => {
				if (await ensureCommandsFileExists()) {
					await openCommandsJsonFile();
				}
			},
		),
		vscode.commands.registerCommand(
			"powerGlove.openColorPicker",
			() => openColorPicker(context),
		),
		vscode.commands.registerCommand(
			"powerGlove.openEmojiPicker",
			() => openEmojiPicker(context),
		),
		vscode.commands.registerCommand(
			"powerGlove.runInCurrentTerminal",
			() => pickAndRun(context, runInCurrentTerminal),
		),
		vscode.commands.registerCommand(
			"powerGlove.runInNewTerminal",
			() => pickAndRun(context, runInNewTerminal),
		),
		vscode.commands.registerCommand(
			"powerGlove.runRecent",
			() => runRecent(context),
		),
		vscode.commands.registerCommand(
			"powerGlove.auto.runNow",
			(arg: unknown) => {
				const name = commandNameFromArg(arg);
				if (name) autoEngine.runCommand(name);
			},
		),
		vscode.commands.registerCommand(
			"powerGlove.auto.runAll",
			() => autoEngine.runAll(),
		),
	);

	// Initial population: build the view and start the auto-run schedule.
	watchCommandsFile();
	refreshTrees();

	log("activated");
}

// VS Code lifecycle hook. No explicit cleanup needed; everything is registered
// through context.subscriptions and disposed automatically.
export function deactivate(): void {
	// Disposed via context.subscriptions.
}

// Resolve the command name carried by a tree-action argument: inline button
// handlers and row clicks pass the name string; context-menu invocations pass
// the TreeItem itself (whose id is the command name). Undefined when neither.
function commandNameFromArg(arg: unknown): string | undefined {
	if (typeof arg === "string") return arg;
	const id = (arg as Record<string, unknown> | undefined)?.id;
	return typeof id === "string" ? id : undefined;
}

// Build the QuickPick rows for `commands` and show the picker; resolves to
// the chosen command, or undefined when the person cancels or closes it.
async function pickFromCommands(
	commands: ResolvedCommand[],
	placeHolder: string,
): Promise<ResolvedCommand | undefined> {
	const pick = await vscode.window.showQuickPick(
		commands.map((c) => ({
			label: c.name,
			description: c.command,
			cmd: c,
		})),
		{ placeHolder },
	);
	return pick?.cmd;
}

// Handler for `powerGlove.openUI`. Resolves the current command list for this
// machine/workspace and hands it to the QuickPick picker; any error is surfaced
// through the OutputChannel and a notification.
function openUI(context: vscode.ExtensionContext): void {
	try {
		const { resolved, machineName } = getResolvedCommands();
		// The picker only offers enabled manual commands; auto commands live in
		// their own sidebar section and run on their schedule instead.
		const manualCommands = resolved.filter((c) =>
			c.type === "manual" && c.enabled
		);
		const recentNames = getRecentNames(context);
		showCommandPicker(
			manualCommands,
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
async function pickAndRun(
	context: vscode.ExtensionContext,
	run: (cmd: ResolvedCommand) => void,
): Promise<void> {
	try {
		const { resolved, machineName } = getResolvedCommands();
		const manualCommands = resolved.filter((c) =>
			c.type === "manual" && c.enabled
		);
		if (manualCommands.length === 0) {
			vscode.window.showErrorMessage(
				`Power Glove: no commands available for machine "${machineName}".`,
			);
			return;
		}
		const cmd = await pickFromCommands(manualCommands, "Select command");
		if (cmd) {
			recordRecentName(context, cmd.name);
			run(cmd);
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
			vscode.window.showInformationMessage(
				"Power Glove: no recently run commands yet.",
			);
			return;
		}
		const { resolved } = getResolvedCommands();
		const manualCommands = resolved.filter((c) =>
			c.type === "manual" && c.enabled
		);
		const recentResolved = resolveRecentCommands(
			manualCommands,
			recentNames,
		);
		if (recentResolved.length === 0) {
			vscode.window.showInformationMessage(
				"Power Glove: no recent commands available on this machine.",
			);
			return;
		}
		const cmd = await pickFromCommands(
			recentResolved,
			"Select recent command",
		);
		if (cmd) {
			recordRecentName(context, cmd.name);
			runInCurrentTerminal(cmd);
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
	const workspacePaths =
		vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
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
	qp.placeholder = "Esc to close  ·  Enter to run in current terminal";
	qp.items = [
		{
			label: "$(info) Description",
			description: cmd.description || "(none)",
		},
		{ label: "$(folder) Project", description: cmd.project || "(general)" },
		{
			label: "$(root-folder) Directory",
			description: cmd.directory || "(none — runs in terminal CWD)",
		},
		{
			label: "$(terminal) Shell command",
			description: cmd.finalShellCommand,
		},
	];
	qp.buttons = [
		{
			iconPath: new vscode.ThemeIcon("copy"),
			tooltip: "Copy shell command",
		},
		{
			iconPath: new vscode.ThemeIcon("play"),
			tooltip: "Run in current terminal",
		},
	];
	qp.onDidTriggerButton((btn) => {
		if (btn.tooltip === "Copy shell command") {
			vscode.env.clipboard.writeText(cmd.finalShellCommand);
			vscode.window.showInformationMessage(
				"Copied shell command to clipboard.",
			);
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
