// This file implements the Power Glove Commands Manager webview.
// - openCommandsManager() opens (or reveals) a single WebviewPanel that
//   provides full CRUD over `powerGlove.commands`: add/edit/duplicate/
//   delete/reorder, plus per-machine settings and <KEY> overrides.
// - Persists changes back to settings.json under the same scope where
//   the setting currently lives (WorkspaceFolder → Workspace → Global).
// - Listens for external configuration changes and live-refreshes,
//   while suppressing its own write-back echoes.
// - The webview is plain HTML/CSS/JS with inline Lucide SVG icons.

import * as vscode from 'vscode';
import { CommandConfig } from '../config';
import { detectMachineName } from '../machine';

interface InboundMessage {
    type: 'save';
    commands: CommandConfig[];
}

interface OutboundMessage {
    type: 'init';
    machineName: string;
    commands: CommandConfig[];
}

// Module-scoped singletons so a second invocation reveals the existing
// panel rather than creating a duplicate one.
let panel: vscode.WebviewPanel | undefined;
let configWatcher: vscode.Disposable | undefined;
// Set to true right before we write back to settings so the resulting
// onDidChangeConfiguration event doesn't trigger a redundant re-render.
let suppressNextConfigBroadcast = false;

// Open or focus the Commands Manager webview.
// - Singleton panel: a second call just reveals the existing one.
// - Subscribes to settings changes so external edits to powerGlove.commands
//   live-refresh the UI (skipping our own write-back echoes).
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

    panel.webview.html = renderHtml();
    panel.webview.onDidReceiveMessage(handleMessage, undefined, context.subscriptions);

    // External changes to the commands setting should refresh the UI, except
    // when we triggered the change ourselves (avoid render loops).
    configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
        if (!panel) { return; }
        if (!e.affectsConfiguration('powerGlove.commands')) { return; }
        if (suppressNextConfigBroadcast) {
            suppressNextConfigBroadcast = false;
            return;
        }
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

// Push the current command list + detected machine name to the webview.
// Called once on open and again whenever settings change externally.
function broadcastInit(): void {
    if (!panel) { return; }
    const cfg = vscode.workspace.getConfiguration('powerGlove');
    const commands = (cfg.get<CommandConfig[]>('commands', []) ?? []).map(normalize);
    const msg: OutboundMessage = {
        type: 'init',
        machineName: detectMachineName(),
        commands,
    };
    panel.webview.postMessage(msg);
}

// Receive messages from the webview. Currently only `save` is supported,
// which writes the new commands array back to the appropriate settings scope.
// Errors are surfaced as a notification rather than swallowed.
async function handleMessage(msg: InboundMessage): Promise<void> {
    if (msg?.type !== 'save') { return; }
    try {
        const cfg = vscode.workspace.getConfiguration('powerGlove');
        const inspect = cfg.inspect<CommandConfig[]>('commands');
        const target = pickWriteTarget(inspect);
        // We're about to trigger a config-change event; make sure broadcastInit
        // doesn't echo back to the webview.
        suppressNextConfigBroadcast = true;
        await cfg.update('commands', msg.commands, target);
    } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Power Glove: failed to save commands: ${text}`);
    }
}

// Choose the settings scope to write into: prefer the most specific scope
// where the value already exists (folder → workspace), defaulting to global
// (user) settings when the value isn't set anywhere yet.
function pickWriteTarget(
    inspect: ReturnType<vscode.WorkspaceConfiguration['inspect']> | undefined,
): vscode.ConfigurationTarget {
    if (inspect?.workspaceFolderValue !== undefined) {
        return vscode.ConfigurationTarget.WorkspaceFolder;
    }
    if (inspect?.workspaceValue !== undefined) {
        return vscode.ConfigurationTarget.Workspace;
    }
    return vscode.ConfigurationTarget.Global;
}

// Coerce a CommandConfig into a fully-populated shape (no missing fields,
// arrays guaranteed) so the webview can bind to it without null checks.
function normalize(c: CommandConfig): CommandConfig {
    return {
        name: c?.name ?? '',
        project: c?.project ?? '',
        directory: c?.directory ?? '',
        command: c?.command ?? '',
        machineSettings: Array.isArray(c?.machineSettings)
            ? c.machineSettings.map((m) => ({
                machineName: m?.machineName ?? '',
                show: m?.show !== false,
                overrides: Array.isArray(m?.overrides)
                    ? m.overrides.map((o) => ({ key: o?.key ?? '', value: o?.value ?? '' }))
                    : [],
            }))
            : [],
    };
}

// Build the static HTML/CSS/JS document that renders inside the webview.
// The script section is self-contained: it talks to the host via
// postMessage('save', ...) and listens for postMessage('init', ...).
function renderHtml(): string {
    // Plain HTML/CSS/JS, theme-aware via VS Code CSS variables.
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
	content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<title>Power Glove · Commands</title>
<style>
	:root { color-scheme: light dark; }
	body {
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
		margin: 0; padding: 0 0 40px;
	}
	header {
		position: sticky; top: 0;
		background: var(--vscode-editor-background);
		padding: 14px 24px 12px;
		border-bottom: 1px solid var(--vscode-panel-border);
		z-index: 5;
	}
	header .row { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
	.brand {
		display: inline-flex; align-items: center; justify-content: center;
		width: 26px; height: 26px; line-height: 0;
		color: var(--vscode-foreground); opacity: 0.9;
	}
	.brand svg { width: 100%; height: 100%; display: block; }
	h1 { font-size: 1.15em; margin: 0; font-weight: 600; }
	.machine { opacity: 0.85; }
	.machine code {
		background: var(--vscode-textBlockQuote-background);
		padding: 2px 7px; border-radius: 3px;
		font-family: var(--vscode-editor-font-family);
	}
	label.toggle {
		display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
		user-select: none;
	}
	main { padding: 0 24px; }
	button {
		font: inherit;
		color: var(--vscode-button-foreground);
		background: var(--vscode-button-background);
		border: 1px solid transparent;
		padding: 5px 12px; border-radius: 2px; cursor: pointer;
	}
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary {
		color: var(--vscode-button-secondaryForeground);
		background: var(--vscode-button-secondaryBackground);
	}
	button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
	button.icon {
		background: transparent; color: var(--vscode-foreground);
		padding: 4px; border-radius: 3px; opacity: 0.7;
		line-height: 0;
		display: inline-flex; align-items: center; justify-content: center;
	}
	button.icon svg { width: 16px; height: 16px; display: block; }
	button.icon:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
	button.icon:disabled { opacity: 0.25; cursor: default; background: transparent; }
	button.danger:hover { color: var(--vscode-errorForeground); }
	button.confirming {
		color: var(--vscode-inputValidation-errorForeground, #fff);
		background: var(--vscode-inputValidation-errorBackground, #b91c1c);
		opacity: 1;
		padding: 0 10px;
		align-self: stretch;
		font-weight: 600;
	}
	button.confirming svg { display: none; }
	.section { margin-top: 28px; }
	.section h2 {
		font-size: 1em; text-transform: none; letter-spacing: 0.02em;
		opacity: 0.85; margin: 0 0 10px; font-weight: 600;
		padding-bottom: 6px;
		border-bottom: 1px solid var(--vscode-panel-border);
	}
	.card {
		border: 1px solid var(--vscode-panel-border);
		border-radius: 4px; margin-bottom: 6px;
		background: var(--vscode-editorWidget-background);
		transition: border-color 0.1s;
	}
	.card:hover { border-color: var(--vscode-focusBorder); }
	.card.dim { opacity: 0.5; }
	.card.dim:hover { opacity: 0.8; }
	.card-head {
		display: flex; align-items: center; gap: 10px;
		padding: 8px 10px; cursor: pointer;
		user-select: none;
	}
	.card-head .chev {
		width: 18px; height: 18px; opacity: 0.7; transition: transform 0.15s;
		display: inline-flex; align-items: center; justify-content: center;
		flex: 0 0 auto;
	}
	.card-head .chev svg { width: 18px; height: 18px; display: block; }
	.card.open .card-head .chev { transform: rotate(90deg); }
	.card-head .name {
		font-weight: 600; flex: 0 0 auto; min-width: 0;
		max-width: 35%;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.card-head .preview {
		opacity: 0.55; font-family: var(--vscode-editor-font-family);
		font-size: 0.88em; flex: 1 1 auto; min-width: 0;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.card-head .toolbar {
		display: flex; gap: 2px; align-items: stretch;
		flex: 0 0 auto;
		align-self: stretch;
	}
	.card-head .toolbar .sep {
		width: 1px; background: var(--vscode-panel-border);
		margin: 4px 4px;
	}
	.card-body {
		display: none; padding: 12px 14px 16px;
		border-top: 1px solid var(--vscode-panel-border);
	}
	.card.open .card-body { display: block; }
	.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
	.field label {
		font-size: 0.82em; opacity: 0.75; font-weight: 500;
	}
	input[type="text"], textarea {
		font: inherit;
		font-family: var(--vscode-editor-font-family);
		color: var(--vscode-input-foreground);
		background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border, transparent);
		padding: 5px 7px; border-radius: 2px; width: 100%; box-sizing: border-box;
	}
	textarea { resize: vertical; min-height: 56px; }
	input:focus, textarea:focus {
		outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px;
	}
	.machine-block {
		border: 1px solid var(--vscode-panel-border);
		border-radius: 3px; padding: 10px; margin-bottom: 8px;
		background: var(--vscode-editor-background);
	}
	.machine-block .head {
		display: flex; align-items: center; gap: 10px; margin-bottom: 8px;
	}
	.machine-block .head input { flex: 1; }
	.overrides .ov-row {
		display: grid; grid-template-columns: 1fr 2fr auto;
		gap: 6px; margin-bottom: 4px;
	}
	.subhead {
		font-size: 0.78em; opacity: 0.65; margin: 12px 0 6px;
		text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;
	}
	.empty { opacity: 0.55; font-style: italic; padding: 32px 0; text-align: center; }
	#help {
		display: none; margin: 28px 0 0;
		border: 1px solid var(--vscode-panel-border);
		border-radius: 4px; padding: 14px 18px 18px;
		background: var(--vscode-editorWidget-background);
		position: relative;
	}
	#help.open { display: block; }
	#help h3 { margin: 0 0 8px; font-size: 1em; }
	#help p, #help li { margin: 4px 0; line-height: 1.5; opacity: 0.9; }
	#help code, #help kbd {
		background: var(--vscode-textBlockQuote-background);
		padding: 1px 5px; border-radius: 3px;
		font-family: var(--vscode-editor-font-family); font-size: 0.92em;
	}
	#helpClose {
		position: absolute; top: 6px; right: 8px;
	}
</style>
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
		<span style="flex:1"></span>
		<button id="addBtn">+ New command</button>
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
		<li>Changes are saved automatically to your <code>settings.json</code> under <code>powerGlove.commands</code>.</li>
	</ul>
	<h3>Fields</h3>
	<ul>
		<li><b>Project</b> — if non-empty, the command appears only when an open workspace folder path <i>contains</i> this substring. Empty = always shown.</li>
		<li><b>Directory</b> — if non-empty, the command is prefixed with <code>cd /d "&lt;dir&gt;" &amp;&amp;</code> on Windows or <code>cd "&lt;dir&gt;" &amp;&amp;</code> elsewhere.</li>
		<li><b>Command</b> — the shell command. May contain <code>&lt;KEY&gt;</code> placeholders that get replaced via per-machine overrides.</li>
		<li><b>Machine settings</b> — the command is shown only on machines listed here with <i>Show</i> enabled. Per-machine <i>overrides</i> substitute <code>&lt;KEY&gt;</code> tokens in <i>Command</i> and <i>Directory</i>.</li>
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
			<span class="name"></span>
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
			<div class="field"><label>Name</label><input type="text" data-bind="name" /></div>
			<div class="field"><label>Description (optional, shown in the picker)</label><input type="text" data-bind="description" /></div>
			<div class="field"><label>Project (substring of workspace path; empty = always show)</label><input type="text" data-bind="project" /></div>
			<div class="field"><label>Directory (empty = no cd)</label><input type="text" data-bind="directory" /></div>
			<div class="field"><label>Command</label><textarea data-bind="command"></textarea></div>
			<div class="subhead">Machine settings</div>
			<div class="machines"></div>
			<button class="secondary" data-act="addMachine">+ Add machine setting</button>
		</div>
	</div>
</template>

<template id="machineTpl">
	<div class="machine-block">
		<div class="head">
			<input type="text" data-bind="machineName" placeholder="machineName" />
			<label class="toggle"><input type="checkbox" data-bind="show" /> Show</label>
			<button class="icon danger" data-act="delMachine" title="Remove" data-icon="x"></button>
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

<script>
(() => {
	// Webview-side controller: owns local state, renders cards, talks to the
	// extension host via postMessage('save', ...) and listens for 'init'.
	const vscode = acquireVsCodeApi();
	let state = { machineName: '', commands: [] };
	let onlyMine = false;

	// Lucide icons (https://lucide.dev) inlined as raw SVG strings.
	const SVG_ATTRS = 'xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
	const ICONS = {
		chevron: \`<svg \${SVG_ATTRS}><path d="m9 18 6-6-6-6"/></svg>\`,
		up:      \`<svg \${SVG_ATTRS}><path d="m18 15-6-6-6 6"/></svg>\`,
		down:    \`<svg \${SVG_ATTRS}><path d="m6 9 6 6 6-6"/></svg>\`,
		copy:    \`<svg \${SVG_ATTRS}><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>\`,
		trash:   \`<svg \${SVG_ATTRS}><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>\`,
		x:       \`<svg \${SVG_ATTRS}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>\`,
		help:    \`<svg \${SVG_ATTRS}><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>\`,
		plus:    \`<svg \${SVG_ATTRS}><path d="M5 12h14"/><path d="M12 5v14"/></svg>\`,
		glove:   '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 280 280" fill="currentColor" fill-rule="evenodd"><path d="M167.41 63.52s2.52-4.09 17.95-2.39c23.06 2.53 37.89 16.76 49.1 32.41 9.91 13.85 10.51 17.72 16.12 34.18 2.2 6.45 3.54 12.45 4.27 19.49-4.4-.51-5.5-.8-12.24-1.61-.86-12.4-8.76-41.09-33.32-62.93-16.08-14.31-34.94-10.94-34.94-10.94z"/><path d="M37.43 126.69l56.26 19.52s7.55-10.43 15.16-13.1c11.71-4.11 17.72.63 17.72.63l54.98-54.01s29.73 31.04 35.83 50.22c4.02 12.61 15.19 14.55 15.19 14.55l-60.78 50.53 68.05 63.67-16.41 17.43-70.6-78.79-59.61-5.1-64.16-51.61z"/><path d="M187.71 203.54c-3.55-3.27-3.77-8.78-.5-12.33 3.27-3.55 8.79-3.77 12.33-.5 3.55 3.28 3.77 8.79.5 12.34-3.27 3.54-8.78 3.77-12.33.49zM208.32 222.33c-3.55-3.27-3.77-8.78-.5-12.33 3.28-3.55 8.79-3.77 12.34-.5 3.54 3.27 3.77 8.79.49 12.33-3.27 3.55-8.78 3.77-12.33.5zM230.82 244.03c-3.55-3.27-3.77-8.79-.5-12.33 3.27-3.55 8.79-3.77 12.33-.5 3.55 3.27 3.77 8.78.5 12.33-3.27 3.55-8.78 3.77-12.33.5zM205.16 186.09c-3.54-3.27-3.77-8.79-.49-12.33 3.27-3.55 8.78-3.77 12.33-.5 3.55 3.27 3.77 8.78.5 12.33-3.28 3.55-8.79 3.77-12.34.5zM225.78 204.88c-3.55-3.28-3.77-8.79-.5-12.34 3.27-3.54 8.78-3.77 12.33-.49 3.55 3.27 3.77 8.78.5 12.33-3.27 3.55-8.79 3.77-12.33.5zM248.27 226.57c-3.54-3.27-3.77-8.78-.49-12.33 3.27-3.55 8.78-3.77 12.33-.5 3.55 3.28 3.77 8.79.5 12.34-3.28 3.54-8.79 3.77-12.34.49z"/><path d="M104.32 3L90.92 11.66l42.75 51.33-4.65 4.19-58.34-60.83-15.37 11.36 57.9 66.2-6.97 4.65-70.15-67.11-12.61 10.86 67.88 70.2-72.06-48.35-9.3 13.02 70.67 64.16 79.03-73.93-10.69-12.08-4.18 1.39"/></svg>',
	};

	function setIcon(el, name) { if (el && ICONS[name]) { el.innerHTML = ICONS[name]; } }
	// Replace every [data-icon] placeholder under \`scope\` with its inline SVG.
	function hydrateIcons(scope) {
		scope.querySelectorAll('[data-icon]').forEach((el) => setIcon(el, el.dataset.icon));
	}

	const root = document.getElementById('root');
	const machineEl = document.getElementById('machine');
	const onlyMineEl = document.getElementById('onlyMine');
	const addBtn = document.getElementById('addBtn');
	const helpBtn = document.getElementById('helpBtn');
	const helpEl = document.getElementById('help');
	const helpCloseBtn = document.getElementById('helpClose');
	setIcon(helpBtn, 'help');
	setIcon(helpCloseBtn, 'x');
	setIcon(document.getElementById('brand'), 'glove');
	helpBtn.addEventListener('click', () => {
		const opening = !helpEl.classList.contains('open');
		helpEl.classList.toggle('open');
		if (opening) { helpEl.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
	});
	helpCloseBtn.addEventListener('click', () => helpEl.classList.remove('open'));

	const cardTpl = document.getElementById('cardTpl');
	const machineTpl = document.getElementById('machineTpl');
	const overrideTpl = document.getElementById('overrideTpl');

	// Inbound from the extension host: 'init' carries the machine name and
	// the current commands array; we replace local state and re-render.
	window.addEventListener('message', (e) => {
		const m = e.data;
		if (m?.type === 'init') {
			state = { machineName: m.machineName || '', commands: m.commands || [] };
			machineEl.textContent = state.machineName || '(unknown)';
			render();
		}
	});

	onlyMineEl.addEventListener('change', () => { onlyMine = onlyMineEl.checked; render(); });
	// '+ New command': append a default entry visible on this machine, save,
	// and re-render with the new card opened for editing.
	addBtn.addEventListener('click', () => {
		state.commands.push({
			name: 'New command',
			description: '',
			project: '',
			directory: '',
			command: '',
			machineSettings: [{ machineName: state.machineName, show: true, overrides: [] }],
		});
		save(); render(state.commands.length - 1);
	});

	// Persist the current commands array back to settings via the extension host.
	function save() { vscode.postMessage({ type: 'save', commands: state.commands }); }

	// True when this command has at least one machineSetting matching the
	// detected host with show !== false. Used for the dim/'only mine' filter.
	function visibleForCurrentMachine(c) {
		if (!Array.isArray(c.machineSettings)) { return false; }
		return c.machineSettings.some(
			(m) => m && m.machineName === state.machineName && m.show !== false,
		);
	}

	// Group key for a command: its \`project\` field, or '__common__' for none.
	function groupKey(c) {
		const p = (c.project || '').trim();
		return p || '__common__';
	}

	// Rebuild the entire card list from \`state.commands\`.
	// - Optionally restricts to commands visible on this machine.
	// - Buckets by project, renders an empty-state hint when nothing matches,
	//   and pins the 'Common' (no-project) section to the end.
	// - \`openIdx\` lets a caller specify which card should start expanded
	//   (used after add/duplicate/move so the user lands on the new row).
	function render(openIdx) {
		root.innerHTML = '';
		let list = state.commands.map((c, i) => ({ c, i }));
		if (onlyMine) {
			list = list.filter((x) => visibleForCurrentMachine(x.c));
		}
		// Empty-state: differentiate 'truly empty' from 'filtered out'.
		if (list.length === 0) {
			const e = document.createElement('div');
			e.className = 'empty';
			e.textContent = state.commands.length === 0
				? 'No commands yet. Click "+ New command" to add one.'
				: 'No commands match the current machine.';
			root.appendChild(e);
			return;
		}
		// Bucket commands by project group.
		const groups = new Map();
		for (const x of list) {
			const k = groupKey(x.c);
			if (!groups.has(k)) { groups.set(k, []); }
			groups.get(k).push(x);
		}
		// Sort group keys alphabetically, but pin the 'common' bucket to the end.
		const keys = [...groups.keys()].sort((a, b) => {
			if (a === '__common__') { return 1; }
			if (b === '__common__') { return -1; }
			return a.localeCompare(b);
		});
		for (const key of keys) {
			const sec = document.createElement('div');
			sec.className = 'section';
			const h = document.createElement('h2');
			h.textContent = key === '__common__' ? 'Common' : key;
			sec.appendChild(h);
			for (const { c, i } of groups.get(key)) {
				sec.appendChild(buildCard(c, i, openIdx === i));
			}
			root.appendChild(sec);
		}
	}

	// Build a single command card DOM node from <template id="cardTpl">.
	// Wires up: text input two-way binding (with live preview/save), per-card
	// toolbar (up / down / duplicate / two-step delete), nested machine blocks,
	// and click-to-toggle on the card head.
	function buildCard(c, idx, open) {
		const node = cardTpl.content.firstElementChild.cloneNode(true);
		node.dataset.idx = String(idx);
		if (open) { node.classList.add('open'); }
		if (!visibleForCurrentMachine(c)) { node.classList.add('dim'); }

		setIcon(node.querySelector('.chev'), 'chevron');
		hydrateIcons(node);

		node.querySelector('.name').textContent = c.name || '(unnamed)';
		node.querySelector('.preview').textContent = c.command || '';

		// Disable up/down at the list edges.
		const upBtn = node.querySelector('[data-act="up"]');
		const downBtn = node.querySelector('[data-act="down"]');
		if (idx === 0) { upBtn.disabled = true; }
		if (idx === state.commands.length - 1) { downBtn.disabled = true; }

		// Wire a single text/textarea input to a property on \`c\`. Saves on every
		// keystroke and updates the head preview; project edits force a full
		// re-render because they can change which group the card belongs to.
		const bind = (prop) => {
			const el = node.querySelector(\`[data-bind="\${prop}"]\`);
			el.value = c[prop] ?? '';
			el.addEventListener('input', () => {
				c[prop] = el.value;
				if (prop === 'name') { node.querySelector('.name').textContent = el.value || '(unnamed)'; }
				if (prop === 'command') { node.querySelector('.preview').textContent = el.value; }
				save();
				if (prop === 'project') { render(idx); }
			});
		};
		bind('name');
		bind('description');
		bind('project');
		bind('directory');
		bind('command');

		// Render any existing per-machine setting blocks under this card.
		const machinesEl = node.querySelector('.machines');
		(c.machineSettings || []).forEach((m, mi) => {
			machinesEl.appendChild(buildMachine(c, m, mi));
		});

		// Click anywhere on the head (except inside the toolbar / any button) toggles open.
		const head = node.querySelector('.card-head');
		head.addEventListener('click', (ev) => {
			if (ev.target.closest('button, .toolbar')) { return; }
			node.classList.toggle('open');
		});

		// Two-step delete: first click arms the button; a second click within
		// ~2.5s confirms; otherwise the button auto-disarms back to the icon.
		const delBtn = node.querySelector('[data-act="del"]');
		let delArmed = false;
		let delTimer = 0;

		// Single delegated handler for every toolbar / footer button on this card.
		node.querySelectorAll('[data-act]').forEach((btn) => {
			btn.addEventListener('click', (ev) => {
				ev.stopPropagation();
				const act = btn.dataset.act;
				if (act === 'up') { moveCommand(idx, -1); return; }
				if (act === 'down') { moveCommand(idx, +1); return; }
				if (act === 'dup') {
					// Deep clone via JSON so the duplicate doesn't share array refs.
					const copy = JSON.parse(JSON.stringify(c));
					copy.name = (copy.name || '') + ' (copy)';
					state.commands.splice(idx + 1, 0, copy);
					save(); render(idx + 1); return;
				}
				if (act === 'del') {
					// First click: arm the button and start the disarm timer.
					if (!delArmed) {
						delArmed = true;
						delBtn.classList.add('confirming');
						delBtn.title = 'Click again to confirm';
						delBtn.textContent = 'Confirm?';
						clearTimeout(delTimer);
						delTimer = setTimeout(() => {
							delArmed = false;
							delBtn.classList.remove('confirming');
							delBtn.title = 'Delete (click twice)';
							setIcon(delBtn, 'trash');
						}, 2500);
						return;
					}
					// Second click within the window: actually remove the entry.
					clearTimeout(delTimer);
					state.commands.splice(idx, 1);
					save(); render(); return;
				}
				if (act === 'addMachine') {
					c.machineSettings = c.machineSettings || [];
					c.machineSettings.push({ machineName: state.machineName, show: true, overrides: [] });
					save(); render(idx); return;
				}
			});
		});

		return node;
	}

	// Build one machine-setting block (machineName, show toggle, overrides list,
	// add/remove buttons) inside a command card. Mutations save immediately;
	// structural changes (add/remove) trigger a full re-render of the card.
	function buildMachine(cmd, m, mi) {
		const node = machineTpl.content.firstElementChild.cloneNode(true);
		hydrateIcons(node);
		const nameEl = node.querySelector('[data-bind="machineName"]');
		const showEl = node.querySelector('[data-bind="show"]');
		nameEl.value = m.machineName || '';
		showEl.checked = m.show !== false;
		nameEl.addEventListener('input', () => { m.machineName = nameEl.value; save(); });
		showEl.addEventListener('change', () => { m.show = showEl.checked; save(); });

		const ovsEl = node.querySelector('.overrides');
		(m.overrides || []).forEach((o, oi) => ovsEl.appendChild(buildOverride(m, o, oi)));

		node.querySelector('[data-act="delMachine"]').addEventListener('click', () => {
			cmd.machineSettings.splice(mi, 1);
			save(); render(state.commands.indexOf(cmd));
		});
		node.querySelector('[data-act="addOverride"]').addEventListener('click', () => {
			m.overrides = m.overrides || [];
			m.overrides.push({ key: '', value: '' });
			save(); render(state.commands.indexOf(cmd));
		});
		return node;
	}

	// Build a single key/value override row inside a machine block. Edits save
	// in place; deleting an override triggers a full re-render.
	function buildOverride(m, o, oi) {
		const node = overrideTpl.content.firstElementChild.cloneNode(true);
		hydrateIcons(node);
		const k = node.querySelector('[data-bind="key"]');
		const v = node.querySelector('[data-bind="value"]');
		k.value = o.key || '';
		v.value = o.value || '';
		k.addEventListener('input', () => { o.key = k.value; save(); });
		v.addEventListener('input', () => { o.value = v.value; save(); });
		node.querySelector('[data-act="delOverride"]').addEventListener('click', () => {
			m.overrides.splice(oi, 1);
			save();
			// Re-render only the parent card by triggering full render of state.
			render();
		});
		return node;
	}

	// Swap a command with its neighbour in \`state.commands\`. No-op at the edges.
	function moveCommand(idx, delta) {
		const j = idx + delta;
		if (j < 0 || j >= state.commands.length) { return; }
		const [item] = state.commands.splice(idx, 1);
		state.commands.splice(j, 0, item);
		save(); render(j);
	}
})();
</script>
</body>
</html>`;
}
