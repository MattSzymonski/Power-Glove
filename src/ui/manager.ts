// This file implements the Power Glove Commands Manager webview.
// - openCommandsManager() opens (or reveals) a single WebviewPanel that
//   provides full CRUD over Power Glove commands: add/edit/duplicate/
//   delete/reorder, per-command colors and trigger types, plus per-machine
//   settings and <KEY> overrides.
// - Persists changes to the power-glove-commands.json file via config.ts.
// - Listens for configuration changes (commands file path) and live-refreshes.
// - The webview is plain HTML/CSS/JS with inline Lucide SVG icons.

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { CommandConfig } from '../types';
import { readCommands, saveCommands, getCommandsFilePath } from '../config';
import { detectMachineName } from '../machine';
import {
	DEFAULT_AUTO_RUN_INTERVAL_MINUTES,
	DEFAULT_TIMEOUT_SECONDS,
	MAXIMUM_TIMEOUT_SECONDS,
	MINIMUM_AUTO_RUN_INTERVAL_MINUTES,
	MINIMUM_TIMEOUT_SECONDS,
} from '../resolver';

interface InboundMessage {
	type: 'save' | 'pickDirectory' | 'openJsonFile';
	commands?: CommandConfig[];
	requestId?: string;
}

/** Validation limits the webview mirrors; sent with 'init' so the numbers
 *  live once, in the resolver, and cannot drift into a second copy. */
interface ManagerLimits {
	minimumIntervalMinutes: number;
	defaultIntervalMinutes: number;
	minimumTimeoutSeconds: number;
	defaultTimeoutSeconds: number;
	maximumTimeoutSeconds: number;
}

interface OutboundMessage {
	type: 'init' | 'directoryPicked';
	machineName?: string;
	commands?: CommandConfig[];
	commandsFilePath?: string;
	limits?: ManagerLimits;
	requestId?: string;
	path?: string;
}

// Module-scoped singletons so a second invocation reveals the existing
// panel rather than creating a duplicate one.
let panel: vscode.WebviewPanel | undefined;
let configWatcher: vscode.Disposable | undefined;

// Open or focus the Commands Manager webview.
// - Singleton panel: a second call just reveals the existing one.
// - Subscribes to settings changes so external edits to the commands file
//   path live-refresh the UI.
// - Sends the initial state to the webview once it's ready.
export function openCommandsManager(context: vscode.ExtensionContext): void {
	if (panel) {
		panel.reveal(vscode.ViewColumn.Active);
		return;
	}

	panel = vscode.window.createWebviewPanel(
		'powerGlove.manager',
		'Power Glove: Commands',
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);

	panel.webview.html = renderHtml(context, panel.webview);
	panel.webview.onDidReceiveMessage(handleMessage, undefined, context.subscriptions);

	// When the user changes the commands file path in settings, reload.
	configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
		if (!panel) { return; }
		if (!e.affectsConfiguration('powerGlove.commandsFilePath')) { return; }
		broadcastInit();
	});
	context.subscriptions.push(configWatcher);

	panel.onDidDispose(() => {
		panel = undefined;
		configWatcher?.dispose();
		configWatcher = undefined;
	});

	broadcastInit();
}

// Push the current command list, detected machine name, and commands file
// path to the webview. Called once on open and whenever the path changes.
function broadcastInit(): void {
	if (!panel) { return; }
	const commands = (readCommands() ?? []).map(normalize);
	const msg: OutboundMessage = {
		type: 'init',
		machineName: detectMachineName(),
		commands,
		commandsFilePath: getCommandsFilePath(),
		limits: buildLimits(),
	};
	panel.webview.postMessage(msg);
}

// The validation limits the webview enforces, sourced from the resolver so
// the two can never drift apart.
function buildLimits(): ManagerLimits {
	return {
		minimumIntervalMinutes: MINIMUM_AUTO_RUN_INTERVAL_MINUTES,
		defaultIntervalMinutes: DEFAULT_AUTO_RUN_INTERVAL_MINUTES,
		minimumTimeoutSeconds: MINIMUM_TIMEOUT_SECONDS,
		defaultTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
		maximumTimeoutSeconds: MAXIMUM_TIMEOUT_SECONDS,
	};
}

// Receive messages from the webview. Handles `save`, `pickDirectory`,
// and `openJsonFile` (delegates to the registered VS Code command).
async function handleMessage(msg: InboundMessage): Promise<void> {
	if (msg?.type === 'openJsonFile') {
		await vscode.commands.executeCommand('powerGlove.openManagerJson');
		return;
	}
	if (msg?.type === 'pickDirectory') {
		const uris = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			title: 'Select directory',
		});
		if (panel && uris && uris.length > 0) {
			panel.webview.postMessage({
				type: 'directoryPicked',
				requestId: msg.requestId,
				path: uris[0].fsPath,
			} satisfies OutboundMessage);
		}
		return;
	}
	if (msg?.type !== 'save') { return; }
	try {
		await saveCommands(msg.commands ?? []);
	} catch (err) {
		const text = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Power Glove: failed to save commands: ${text}`);
	}
}

// Coerce a CommandConfig into a fully-populated shape (no missing fields,
// arrays guaranteed) so the webview can bind to it without null checks.
//
// Fields the manager's form does not edit are carried through verbatim. The
// webview round-trips whatever it is handed on save, so anything omitted here
// is silently deleted from the commands file the next time the user saves from
// the UI. Only populated optional fields are emitted, which keeps the stored
// JSON free of empty placeholders.
function normalize(c: CommandConfig): CommandConfig {
	const normalized: CommandConfig = { name: c?.name ?? '' };
	if (c?.description) { normalized.description = c.description; }
	if (c?.color) { normalized.color = c.color; }
	if (c?.type === 'auto') { normalized.type = 'auto'; }
	const interval = c?.autoRunIntervalMinutes;
	if (typeof interval === 'number' || Array.isArray(interval)) {
		normalized.autoRunIntervalMinutes = interval;
	}
	if (c?.popup === 'always' || c?.popup === 'never') { normalized.popup = c.popup; }
	if (typeof c?.timeoutSeconds === 'number') { normalized.timeoutSeconds = c.timeoutSeconds; }
	if (c?.retryOnFailure === true) { normalized.retryOnFailure = true; }
	if (c?.enabled === false) { normalized.enabled = false; }
	normalized.project = c?.project ?? '';
	normalized.directory = c?.directory ?? '';
	normalized.command = c?.command ?? '';
	if (c?.vscodeCommand) { normalized.vscodeCommand = c.vscodeCommand; }
	if (c?.vscodeCommandArgs?.length) { normalized.vscodeCommandArgs = c.vscodeCommandArgs; }
	normalized.machineSettings = Array.isArray(c?.machineSettings)
		? c.machineSettings.map((m) => ({
			machineName: m?.machineName ?? '',
			show: m?.show !== false,
			overrides: Array.isArray(m?.overrides)
				? m.overrides.map((o) => ({ key: o?.key ?? '', value: o?.value ?? '' }))
				: [],
		}))
		: [];
	return normalized;
}

// Build the webview's HTML shell. The stylesheet and the controller live as
// real files under media/ (addressed through webview URIs with a per-open
// nonce), so they get editor tooling and the CSP can drop 'unsafe-inline' for
// both scripts and styles. The inline templates stay here because the script
// clones them.
function renderHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
	const styleUri = webview.asWebviewUri(
		vscode.Uri.joinPath(context.extensionUri, 'media', 'manager.css'),
	);
	const scriptUri = webview.asWebviewUri(
		vscode.Uri.joinPath(context.extensionUri, 'media', 'manager.js'),
	);
	const nonce = crypto.randomBytes(16).toString('base64');
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
	content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<title>Power Glove · Commands</title>
<link href="${styleUri}" rel="stylesheet" />
</head>
<body>
<header>
	<div class="row">
		<span class="brand" id="brand" aria-label="Power Glove"></span>
		<span class="machine">Machine: <code id="machine">…</code></span>
		<label class="toggle">
			<input type="checkbox" id="onlyMine" />
			Only show commands for this machine
		</label>
		<span class="grow"></span>
		<button id="addBtn">+ New command</button>
		<button id="jsonBtn" class="icon" title="Open json file"></button>
		<button id="helpBtn" class="icon" title="Show instructions"></button>
	</div>
</header>

<main id="root"></main>

<section id="help">
	<button id="helpClose" class="icon danger" title="Close"></button>
	<h3>How it works</h3>
	<ul>
		<li>Click anywhere on a command bar to expand or collapse it.</li>
		<li>Use <code>▲</code> / <code>▼</code> on the right to reorder.</li>
		<li>The <code>✕</code> button requires two clicks to delete (resets after a couple of seconds).</li>
		<li>Changes are saved automatically to your <code>power-glove-commands.json</code> file. Use <strong>Power Glove: Commands File Path</strong> in settings to change its location.</li>
	</ul>
	<h3>Fields</h3>
	<ul>
		<li><b>Name</b> — a short, human-readable label for the command (shown in the picker and tree view).</li>
		<li><b>Type</b> — <i>Manual run command</i> appears in the picker and the top sidebar section. <i>Auto run command</i> runs itself in the background and reports in the bottom "Auto Run" section.</li>
		<li><b>Auto run interval</b> — minutes between background runs of an auto command (minimum 0.1; default 5). Decimals are allowed (<code>0.5</code> runs every 30 seconds), and a range like <code>1-3</code> schedules each run after a random delay in that range.</li>
		<li><b>Popup notifications</b> — when an auto command's <code>POPUP_MESSAGE</code> raises a notification: only when the status or message changed (default), on every run, or never.</li>
		<li><b>Auto run timeout</b> — seconds before a background run is killed (default 120, maximum 3600).</li>
		<li><b>Retry once</b> — re-runs the command once (after 3 s) when a background run produces no valid status line.</li>
		<li><b>Enabled</b> — uncheck to disable a command without deleting it: it disappears from the picker and stops auto running, but stays visible (dimmed) in the sidebar tree and can be re-enabled from its context menu.</li>
		<li><b>Description</b> — optional extra detail displayed alongside the command name in the picker.</li>
		<li><b>Color</b> — optional square shown before the command in the sidebar tree. Pick a preset or type any <code>#rgb</code> / <code>#rrggbb</code> value.</li>
		<li><b>Project filter</b> — restricts the command to workspaces whose folder path contains this text. Leave empty to make the command available in all projects.</li>
		<li><b>Working directory</b> — when set, the shell first <code>cd</code>s into this folder before running the command. Uses <code>cd /d</code> on Windows, <code>cd</code> elsewhere.</li>
		<li><b>Shell command</b> — the command passed to the shell. Use <code>&lt;KEY&gt;</code> placeholders that get replaced by per-machine overrides.</li>
		<li><b>Machine settings</b> — control which machines see this command. Enable <i>Show</i> for each machine where it should appear. Per-machine <i>overrides</i> fill in <code>&lt;KEY&gt;</code> tokens in the command and working directory.</li>
	</ul>
	<h3>Auto run output format</h3>
	<p>Auto commands must print one line in the format <code>&lt;COLOR&gt;|&lt;RESULT_MESSAGE&gt;|&lt;POPUP_MESSAGE&gt;</code>:</p>
	<ul>
		<li><code>COLOR</code> is required: <code>red</code>, <code>yellow</code>, or <code>green</code> — it colors the dot in the Auto Run tree.</li>
		<li><code>RESULT_MESSAGE</code> is shown next to the command in the Auto Run tree (empty = nothing shown).</li>
		<li><code>POPUP_MESSAGE</code>, when non-empty and allowed by the <i>Popup notifications</i> policy, raises a notification (green: info, yellow: warning, red: error); with the default policy it only fires when it changes between runs.</li>
	</ul>
	<h3>Tips</h3>
	<ul>
		<li>Toggle <i>Only show commands for this machine</i> to hide entries that don't apply here.</li>
		<li>Cards that aren't visible on this machine are dimmed but still editable.</li>
	</ul>
</section>

<template id="cardTpl">
	<div class="card" data-idx="">
		<div class="card-head">
			<span class="chev"></span>
			<span class="color-dot hidden"></span>
			<span class="name"></span>
			<span class="type-chip hidden">auto</span>
			<span class="preview"></span>
			<div class="toolbar">
				<button class="icon" data-act="up" title="Move up" data-icon="up"></button>
				<button class="icon" data-act="down" title="Move down" data-icon="down"></button>
				<span class="sep"></span>
				<button class="icon" data-act="dup" title="Duplicate" data-icon="copy"></button>
				<button class="icon danger" data-act="del" title="Delete (click twice)" data-icon="trash"></button>
			</div>
		</div>
		<div class="card-body">
			<div class="field"><label class="toggle"><input type="checkbox" data-bind="enabled" /> Enabled — uncheck to disable without deleting (hidden from the picker, dimmed in the tree)</label></div>
			<div class="field"><label>Type</label><select data-bind="type"><option value="manual">Manual run command</option><option value="auto">Auto run command</option></select></div>
			<div class="field auto-interval-field hidden"><label>Auto run interval (minutes — 0.5 = 30 s — or a random range like 1-3)</label><input type="text" data-bind="autoRunIntervalMinutes" placeholder="e.g. 5, 0.5 or 1-3" spellcheck="false" /></div>
			<div class="field auto-popup-field hidden"><label>Popup notifications</label><select data-bind="popup"><option value="onChange">Only when status or message changed (default)</option><option value="always">On every run with a popup message</option><option value="never">Never notify</option></select></div>
			<div class="field auto-timeout-field hidden"><label>Auto run timeout — seconds before a background run is killed (default 120)</label><input type="text" data-bind="timeoutSeconds" placeholder="e.g. 120" spellcheck="false" /></div>
			<div class="field auto-retry-field hidden"><label class="toggle"><input type="checkbox" data-bind="retryOnFailure" /> Retry once if a run fails or prints no status line</label></div>
			<div class="field"><label>Name</label><input type="text" data-bind="name" /></div>
			<div class="field"><label>Description — optional help text shown in the command picker</label><input type="text" data-bind="description" /></div>
			<div class="field"><label>Color — square shown before the command in the sidebar tree</label><div class="color-row"><span class="swatches"></span><input type="text" class="color-hex" maxlength="7" placeholder="#RRGGBB" spellcheck="false" /></div></div>
			<div class="field"><label>Project filter — command only appears in workspaces whose folder path contains this text; leave empty to show everywhere</label><div class="project-wrap"><input type="text" data-bind="project" /><button class="icon project-drop-btn" title="Pick existing project" data-icon="down"></button></div></div>
			<div class="field"><label>Working directory — the command runs from this folder; empty uses the terminal's current directory</label><div class="project-wrap"><input type="text" data-bind="directory" /><button class="icon dir-pick-btn" title="Browse for directory" data-icon="folder"></button></div></div>
			<div class="field"><label>Shell command — the command to run. Use &lt;KEY&gt; placeholders for per-machine values</label><textarea data-bind="command"></textarea></div>
			<div class="subhead">Machine settings</div>
			<div class="machines"></div>
			<button class="secondary" data-act="addMachine">+ Add machine setting</button>
		</div>
	</div>
</template>

<template id="machineTpl">
	<div class="machine-block">
		<div class="field field-tight">
			<label>Machine name</label>
			<div class="machine-name-wrap">
				<input type="text" data-bind="machineName" placeholder="machineName" />
				<button class="icon machine-drop-btn" title="Pick existing machine name" data-icon="down"></button>
				<label class="toggle"><input type="checkbox" data-bind="show" /> Show</label>
				<button class="icon danger" data-act="delMachine" title="Remove" data-icon="x"></button>
			</div>
		</div>
		<div class="overrides"></div>
		<button class="secondary" data-act="addOverride">+ Add override</button>
	</div>
</template>

<template id="overrideTpl">
	<div class="ov-row">
		<input type="text" data-bind="key" placeholder="KEY" />
		<input type="text" data-bind="value" placeholder="value" />
		<button class="icon danger" data-act="delOverride" title="Remove" data-icon="x"></button>
	</div>
</template>

<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
