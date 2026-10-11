// This file implements the Power Glove Emoji Picker webview.
// - openEmojiPicker() opens (or reveals) a single WebviewPanel as a regular
//   editor tab with a searchable emoji picker: a search field, the recently
//   used emojis (5 columns, up to 4 rows) and the full emoji grid.
// - Clicking an emoji copies it to the native clipboard
//   (vscode.env.clipboard) and moves it to the front of the Recent grid.
// - Recent emojis persist in globalState, so the row survives restarts.
// - The page is plain HTML/CSS/JS, theme-aware via VS Code CSS variables;
//   the embedded dataset (emojiData.ts) is generated from github/gemoji.

import * as vscode from "vscode";
import { EMOJI_ENTRIES } from "./emojiData";

/** globalState key holding the recent emojis, newest first. */
const EMOJI_PICKER_RECENTS_KEY = "powerGlove.emojiPickerRecents";

/** How many recent emojis are kept and shown: 4 rows of 5 columns. */
const RECENTS_LIMIT = 20;

/** Longest accepted emoji payload; flag emojis use the longest sequences. */
const MAX_EMOJI_LENGTH = 24;

interface InboundMessage {
	type: "ready" | "copy";
	/** The emoji character a click asked to copy. */
	emoji?: string;
}

// Module-scoped singleton so a second invocation reveals the existing panel
// rather than creating a duplicate one.
let panel: vscode.WebviewPanel | undefined;

// Open or focus the Emoji Picker webview.
// - Singleton panel: a second call just reveals the existing one.
// - Stays a regular editor tab (the color picker pops out into its own
//   window instead) so it can be parked next to whatever is being written.
// - The webview asks for the initial recents with a 'ready' message once its
//   script has loaded, which avoids posting before the page can listen.
export function openEmojiPicker(context: vscode.ExtensionContext): void {
	if (panel) {
		panel.reveal();
		return;
	}

	panel = vscode.window.createWebviewPanel(
		"powerGlove.emojiPicker",
		"Power Glove: Emoji Picker",
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);

	panel.webview.html = renderHtml();
	panel.webview.onDidReceiveMessage(
		(message: InboundMessage) => handleMessage(context, message),
		undefined,
		context.subscriptions,
	);

	panel.onDidDispose(() => {
		panel = undefined;
	});
}

// Receive messages from the webview.
// - 'ready' answers with the stored recents so the row renders on load.
// - 'copy' writes the emoji to the native clipboard, remembers it and
//   answers with the refreshed recents list.
async function handleMessage(
	context: vscode.ExtensionContext,
	message: InboundMessage,
): Promise<void> {
	if (message?.type === "ready") {
		postRecents(context);
		return;
	}

	if (message?.type !== "copy") return;
	const emoji = typeof message.emoji === "string" ? message.emoji.trim() : "";
	// Length guard: real emojis are a few code points; anything huge is junk.
	if (!emoji || emoji.length > MAX_EMOJI_LENGTH) return;

	await vscode.env.clipboard.writeText(emoji);
	await addRecentEmoji(context, emoji);
	postRecents(context);
}

// Push the current recents list to the webview.
function postRecents(context: vscode.ExtensionContext): void {
	panel?.webview.postMessage({
		type: "recents",
		recents: getRecentEmojis(context),
	});
}

// The stored recents list; empty until the first click.
function getRecentEmojis(context: vscode.ExtensionContext): string[] {
	return context.globalState.get<string[]>(EMOJI_PICKER_RECENTS_KEY, []);
}

// Add one emoji to the Recent list: moved to the front when it is already
// present, newest first, capped at RECENTS_LIMIT entries.
async function addRecentEmoji(
	context: vscode.ExtensionContext,
	emoji: string,
): Promise<void> {
	const recents = getRecentEmojis(context).filter((entry) => entry !== emoji);
	recents.unshift(emoji);
	await context.globalState.update(
		EMOJI_PICKER_RECENTS_KEY,
		recents.slice(0, RECENTS_LIMIT),
	);
}

// Build the static HTML/CSS/JS document that renders inside the webview.
// The page embeds the emoji dataset inline, talks to the host via
// postMessage('ready' | 'copy') and listens for postMessage('recents').
function renderHtml(): string {
	// Plain HTML/CSS/JS, theme-aware via VS Code CSS variables. The page
	// script deliberately avoids template literals so it can live inside
	// this outer template literal without escaping; the dataset injection
	// below is the one host-side substitution of the document.
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
	content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<title>Power Glove · Emoji Picker</title>
<style>
	:root { color-scheme: light dark; }
	* { box-sizing: border-box; }
	body {
		min-height: 100vh;
		margin: 0;
		padding: 16px;
		display: flex;
		justify-content: center;
		background: radial-gradient(
			1100px 640px at 50% 34%,
			var(--vscode-editorWidget-background, #1b1b20),
			var(--vscode-editor-background, #0e0e10));
		color: var(--vscode-foreground);
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
	}
	.modal {
		display: flex;
		flex-direction: column;
		gap: 14px;
		width: min(680px, calc(100vw - 32px));
		height: calc(100vh - 32px);
		padding: 16px;
		background: var(--vscode-editorWidget-background, #1e1e22);
		border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border, #38383f));
		border-radius: 12px;
		box-shadow: 0 24px 60px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.55));
	}
	.search-input {
		flex: none;
		height: 32px;
		padding: 0 10px;
		color: var(--vscode-input-foreground);
		background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border, transparent);
		border-radius: 6px;
		font-family: var(--vscode-font-family);
		font-size: 13px;
	}
	.search-input:focus {
		outline: none;
		border-color: var(--vscode-focusBorder);
	}
	.section-title {
		flex: none;
		margin: 0 0 8px;
		color: var(--vscode-descriptionForeground);
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.recent-grid {
		display: grid;
		/* The Recent block is the specified 5 columns; 20 stored emojis
		   fill it as exactly 4 rows. */
		grid-template-columns: repeat(5, 48px);
		gap: 8px;
	}
	.all-grid {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(42px, 1fr));
		gap: 4px;
		align-content: start;
		padding-right: 4px;
	}
	.emoji-button {
		aspect-ratio: 1;
		display: grid;
		place-items: center;
		padding: 0;
		font-family: "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif;
		font-size: 22px;
		line-height: 1;
		color: var(--vscode-foreground);
		background: transparent;
		border: 1px solid transparent;
		border-radius: 6px;
		cursor: pointer;
	}
	.emoji-button:hover {
		background: var(--vscode-toolbar-hoverBackground);
		border-color: var(--vscode-focusBorder);
	}
	.recent-grid .emoji-button {
		border-color: var(--vscode-panel-border, rgba(0, 0, 0, 0.4));
	}
	.empty-message {
		margin: 0;
		color: var(--vscode-descriptionForeground);
		font-size: 12px;
	}
	.hidden { display: none; }
	.toast {
		position: fixed;
		left: 50%;
		bottom: 22px;
		transform: translateX(-50%) translateY(6px);
		padding: 6px 14px;
		border-radius: 999px;
		background: var(--vscode-editorWidget-background, #1e1e22);
		border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border, #38383f));
		box-shadow: 0 6px 20px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.4));
		font-size: 13px;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.15s, transform 0.15s;
	}
	.toast.visible {
		opacity: 1;
		transform: translateX(-50%) translateY(0);
	}
</style>
</head>
<body>
	<main class="modal">
		<input id="search-input" class="search-input" type="text" placeholder="Search emojis…" spellcheck="false" autocomplete="off" aria-label="Search emojis" />

		<h2 class="section-title">Recent</h2>
		<div id="recent-grid" class="recent-grid"></div>
		<p id="recents-empty" class="empty-message">Clicked emojis show up here.</p>

		<h2 class="section-title" id="all-title">All emojis</h2>
		<div id="all-grid" class="all-grid"></div>
		<p id="no-results" class="empty-message" hidden>No emojis match that search.</p>

		<div id="toast" class="toast" role="status"></div>
	</main>

<script>
(() => {
	"use strict";

	// Host-provided emoji dataset: [emoji, name, search keywords]; embedded
	// at build time by renderHtml() so the page works fully offline.
	const EMOJI_DATA = ${JSON.stringify(EMOJI_ENTRIES)};

	// Webview-side controller: builds the full emoji grid once, toggles
	// visibility while searching, and talks to the extension host via
	// postMessage('ready' | 'copy').
	const vscode = acquireVsCodeApi();

	// -- DOM references ------------------------------------------------
	const searchInput = document.getElementById("search-input");
	const recentGrid = document.getElementById("recent-grid");
	const recentsEmpty = document.getElementById("recents-empty");
	const allTitle = document.getElementById("all-title");
	const allGrid = document.getElementById("all-grid");
	const noResults = document.getElementById("no-results");
	const toast = document.getElementById("toast");

	// -- Toast feedback -------------------------------------------------

	let toastTimer;
	// Briefly show "Copied <emoji>" over the grid; repeating clicks restart
	// the timer so the pill never flickers between copies.
	function showToast(text) {
		toast.textContent = text;
		toast.classList.add("visible");
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => toast.classList.remove("visible"), 1100);
	}

	// -- Copying --------------------------------------------------------

	// Ask the host to copy the emoji; the host also stores it as recent and
	// answers with the refreshed list via the 'recents' message.
	function copyEmoji(emoji) {
		vscode.postMessage({ type: "copy", emoji: emoji });
		showToast("Copied " + emoji);
	}

	// One clickable emoji cell, shared by the Recent block and the full grid.
	function createEmojiButton(emoji, title) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "emoji-button";
		button.textContent = emoji;
		button.title = title;
		button.addEventListener("click", () => copyEmoji(emoji));
		return button;
	}

	// -- Full emoji grid ------------------------------------------------

	// Build every cell once; the search filter only toggles a class, which
	// keeps typing responsive despite the ~1900 buttons.
	const allButtons = [];
	function buildAllGrid() {
		const fragment = document.createDocumentFragment();
		for (const [emoji, name, keywords] of EMOJI_DATA) {
			const button = createEmojiButton(emoji, name);
			button.dataset.search = (name + " " + keywords).toLowerCase();
			allButtons.push(button);
			fragment.appendChild(button);
		}
		allGrid.appendChild(fragment);
	}

	// -- Search ---------------------------------------------------------

	// Filter by every whitespace-separated token matching somewhere in the
	// name/keywords; the heading doubles as the result counter.
	function applyFilter() {
		const query = searchInput.value.trim().toLowerCase();
		const tokens = query === "" ? [] : query.split(/\s+/);
		let visibleCount = 0;
		for (const button of allButtons) {
			const matches = tokens.every((token) => button.dataset.search.includes(token));
			button.classList.toggle("hidden", !matches);
			if (matches) visibleCount++;
		}
		noResults.hidden = visibleCount > 0;
		allTitle.textContent = query === "" ? "All emojis" : "Results (" + visibleCount + ")";
	}

	searchInput.addEventListener("input", applyFilter);

	// -- Recent emojis --------------------------------------------------

	// Render the Recent block (up to 20 cells, 5 columns wide); clicking a
	// recent cell copies it again and bumps it to the front.
	function renderRecents(emojiList) {
		recentGrid.replaceChildren.apply(recentGrid, emojiList.map((emoji) =>
			createEmojiButton(emoji, "Copy " + emoji)));
		recentsEmpty.hidden = emojiList.length > 0;
	}

	// Host messages: the recents list, pushed after 'ready' and after every
	// copy.
	window.addEventListener("message", (event) => {
		const message = event.data;
		if (message && message.type === "recents" && Array.isArray(message.recents)) {
			renderRecents(message.recents);
		}
	});

	// -- Initial paint --------------------------------------------------

	buildAllGrid();
	applyFilter();
	vscode.postMessage({ type: "ready" });
})();
</script>
</body>
</html>`;
}
