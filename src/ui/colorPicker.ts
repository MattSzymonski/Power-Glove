// This file implements the Power Glove Color Picker webview.
// - openColorPicker() opens (or reveals) a single WebviewPanel with an
//   interactive color picker: saturation/value square, hue slider,
//   eyedropper, hex and RGB fields with copy buttons, and a Recent row.
// - Copy buttons and the eyedropper are handled by the extension host:
//   the page posts 'copy' / 'picked' messages, the host writes to the
//   native clipboard (vscode.env.clipboard) and updates the recents.
// - Recent colors persist in globalState, so the row survives restarts.
// - The page is plain HTML/CSS/JS, theme-aware via VS Code CSS variables.

import * as vscode from "vscode";

/** globalState key holding the Recent colors, newest first. */
const COLOR_PICKER_RECENTS_KEY = "powerGlove.colorPickerRecents";

/** Maximum number of colors kept in the Recent row. */
const RECENTS_LIMIT = 12;

/** Matches six digit hex colors such as "#3CAE89". */
const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/** Delay between the page reporting 'ready' and the move into the picker's
 *  own window; the webview's service worker registration must settle first
 *  (see moveToOwnWindowOnce for the full story). */
const OWN_WINDOW_MOVE_DELAY_MILLISECONDS = 500;

interface InboundMessage {
	type: "ready" | "copy" | "picked";
	/** The exact text a copy button wants on the clipboard. */
	text?: string;
	/** The current color, used for the Recent row. */
	hex?: string;
}

// Module-scoped singleton so a second invocation reveals the existing panel
// rather than creating a duplicate one; `movedToOwnWindow` remembers that
// the auxiliary-window move already ran for the current panel.
let panel: vscode.WebviewPanel | undefined;
let movedToOwnWindow = false;

// Open or focus the Color Picker webview.
// - Singleton panel: a second call just reveals the existing one (wherever
//   its window currently is).
// - A fresh panel is moved into its own auxiliary window once its page has
//   loaded, so the picker floats as the only tab of a small dedicated window
//   instead of sharing the editor area. The delay avoids tearing the webview
//   down while its service worker is still registering. Hosts without
//   auxiliary windows ignore the move command and the panel simply stays a
//   regular tab.
// - The webview asks for the initial recents with a 'ready' message once its
//   script has loaded, which avoids posting before the page can listen.
export function openColorPicker(context: vscode.ExtensionContext): void {
	if (panel) {
		panel.reveal();
		return;
	}

	panel = vscode.window.createWebviewPanel(
		"powerGlove.colorPicker",
		"Power Glove: Color Picker",
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
		movedToOwnWindow = false;
	});
}

// Move the picker into its own auxiliary window, but only after its page
// has reported that it finished loading. Moving an editor tears its webview
// document down and recreates it in the new window; doing that while the
// webview's service worker registration is still in flight makes Chromium
// reject the registration ("Failed to register a ServiceWorker: The document
// is in an invalid state") and the webview renders an error instead of the
// picker. The short delay past 'ready' gives the registration time to settle.
// Runs once per panel; rejections (for example on vscode.dev, where
// auxiliary windows do not exist) are swallowed on purpose - the panel stays
// a regular tab then and an error popup would only be noise.
function moveToOwnWindowOnce(): void {
	if (movedToOwnWindow || !panel) { return; }
	movedToOwnWindow = true;
	const targetPanel = panel;
	setTimeout(() => {
		// The panel may have been closed while the delay was pending.
		if (panel !== targetPanel) { return; }
		// Reveal first so the move command acts on the picker even when the
		// user clicked elsewhere during the delay.
		panel.reveal();
		void vscode.commands
			.executeCommand("workbench.action.moveEditorToNewWindow")
			.then(undefined, () => undefined);
	}, OWN_WINDOW_MOVE_DELAY_MILLISECONDS);
}

// Receive messages from the webview.
// - 'ready' answers with the stored recents so the row renders on load.
// - 'copy' writes the posted text to the native clipboard.
// - 'copy' and 'picked' both remember the current color, then answer with
//   the refreshed recents list.
async function handleMessage(
	context: vscode.ExtensionContext,
	message: InboundMessage,
): Promise<void> {
	if (message?.type === "ready") {
		postRecents(context);
		moveToOwnWindowOnce();
		return;
	}

	if (message?.type === "copy") {
		const text = typeof message.text === "string" ? message.text : "";
		await vscode.env.clipboard.writeText(text);
	}

	const hex = typeof message?.hex === "string" ? message.hex : "";
	if (
		(message?.type === "copy" || message?.type === "picked") &&
		HEX_COLOR_PATTERN.test(hex)
	) {
		await addRecentColor(context, hex);
		postRecents(context);
	}
}

// Push the current recents list to the webview.
function postRecents(context: vscode.ExtensionContext): void {
	panel?.webview.postMessage({
		type: "recents",
		recents: getRecentColors(context),
	});
}

// The stored recents list; empty until the first copy or pick.
function getRecentColors(context: vscode.ExtensionContext): string[] {
	return context.globalState.get<string[]>(COLOR_PICKER_RECENTS_KEY, []);
}

// Add one color to the Recent list: uppercased, moved to the front when it
// is already present, newest first, capped at RECENTS_LIMIT entries.
async function addRecentColor(
	context: vscode.ExtensionContext,
	hexColor: string,
): Promise<void> {
	const normalized = hexColor.toUpperCase();
	const recents = getRecentColors(context).filter((entry) =>
		entry !== normalized
	);
	recents.unshift(normalized);
	await context.globalState.update(
		COLOR_PICKER_RECENTS_KEY,
		recents.slice(0, RECENTS_LIMIT),
	);
}

// Build the static HTML/CSS/JS document that renders inside the webview.
// The page talks to the host via postMessage('ready' | 'copy' | 'picked')
// and listens for postMessage('recents'). All colors are six digit hex
// strings; the 0-255 and 0.0-1.0 representations are derived in the page.
function renderHtml(): string {
	// Plain HTML/CSS/JS, theme-aware via VS Code CSS variables. The page
	// script deliberately avoids template literals so it can live inside
	// this outer template literal without escaping.
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
	content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<title>Power Glove · Color Picker</title>
<style>
	:root { color-scheme: light dark; }
	* { box-sizing: border-box; }
	body {
		min-height: 100vh;
		margin: 0;
		padding: 16px;
		display: flex;
		align-items: center;
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
		/* Sized from the window on both axes so the card fills the space
		   instead of floating in it: the height term leaves room for the
		   controls, fields and recents below the square, and the floor
		   keeps short windows usable (they scroll slightly instead). */
		width: min(620px, calc(100vw - 32px), calc(100vh - 455px));
		min-width: min(340px, calc(100vw - 32px));
		padding: 16px;
		background: var(--vscode-editorWidget-background, #1e1e22);
		border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border, #38383f));
		border-radius: 12px;
		box-shadow: 0 24px 60px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.55));
	}
	.header-hex {
		display: block;
		margin: 0 0 12px;
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 21px;
		font-weight: 600;
		letter-spacing: 0.02em;
	}
	.sv-square {
		position: relative;
		/* Keep the square square at any card width. */
		aspect-ratio: 1 / 1;
		border-radius: 8px;
		cursor: crosshair;
		touch-action: none;
		background:
			linear-gradient(to bottom, rgba(0, 0, 0, 0), #000),
			linear-gradient(to right, #fff, rgba(255, 255, 255, 0)),
			hsl(var(--hue, 0), 100%, 50%);
	}
	.sv-cursor {
		position: absolute;
		width: 16px;
		height: 16px;
		border: 2px solid #fff;
		border-radius: 50%;
		box-shadow: 0 0 3px rgba(0, 0, 0, 0.9), inset 0 0 2px rgba(0, 0, 0, 0.6);
		transform: translate(-50%, -50%);
		pointer-events: none;
	}
	.controls-row {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 12px 0 14px;
	}
	.icon-button {
		display: grid;
		place-items: center;
		flex: none;
		width: 32px;
		height: 32px;
		color: var(--vscode-button-secondaryForeground);
		background: var(--vscode-button-secondaryBackground);
		border: 1px solid transparent;
		border-radius: 8px;
		cursor: pointer;
	}
	.icon-button:hover { background: var(--vscode-button-secondaryHoverBackground); }
	.current-swatch {
		flex: none;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		border: 2px solid var(--vscode-panel-border, #48484f);
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
	}
	.hue-slider {
		position: relative;
		flex: 1;
		height: 14px;
		border-radius: 999px;
		cursor: pointer;
		touch-action: none;
		background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
	}
	.hue-cursor {
		position: absolute;
		top: 50%;
		width: 18px;
		height: 18px;
		border: 2px solid #fff;
		border-radius: 50%;
		box-shadow: 0 0 3px rgba(0, 0, 0, 0.9);
		transform: translate(-50%, -50%);
		pointer-events: none;
	}
	.field-row {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 8px;
	}
	.field-label {
		flex: none;
		width: 86px;
		color: var(--vscode-descriptionForeground);
		font-size: 10.5px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.text-input,
	.number-input {
		height: 30px;
		padding: 0 8px;
		color: var(--vscode-input-foreground);
		background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border, transparent);
		border-radius: 6px;
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 13px;
	}
	.text-input:focus,
	.number-input:focus {
		outline: none;
		border-color: var(--vscode-focusBorder);
	}
	.text-input {
		flex: 1;
		min-width: 0;
	}
	.channel-inputs {
		display: flex;
		flex: 1;
		gap: 8px;
		min-width: 0;
	}
	.number-input {
		flex: 1;
		min-width: 0;
		appearance: textfield;
	}
	.number-input::-webkit-inner-spin-button,
	.number-input::-webkit-outer-spin-button {
		appearance: none;
		margin: 0;
	}
	.copy-button {
		flex: none;
		min-width: 64px;
		height: 30px;
		color: var(--vscode-button-secondaryForeground);
		background: var(--vscode-button-secondaryBackground);
		border: 1px solid transparent;
		border-radius: 6px;
		font-family: var(--vscode-font-family);
		font-size: 12px;
		cursor: pointer;
	}
	.copy-button:hover { background: var(--vscode-button-secondaryHoverBackground); }
	.recents { margin-top: 16px; }
	.recents-title {
		margin: 0 0 8px;
		color: var(--vscode-descriptionForeground);
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.recents-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(56px, 1fr));
		gap: 8px;
	}
	.recent-swatch {
		width: 100%;
		aspect-ratio: 1;
		padding: 0;
		border: 1px solid var(--vscode-panel-border, rgba(0, 0, 0, 0.55));
		border-radius: 7px;
		box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.04);
		cursor: pointer;
	}
	.recent-swatch:hover { box-shadow: 0 0 0 2px var(--vscode-focusBorder); }
	.recents-empty {
		margin: 0;
		color: var(--vscode-descriptionForeground);
		font-size: 12px;
	}
</style>
</head>
<body>
	<main class="modal">
		<span id="header-hex" class="header-hex">#3CAE89</span>

		<div id="sv-square" class="sv-square" aria-label="Saturation and brightness">
			<div id="sv-cursor" class="sv-cursor"></div>
		</div>

		<div class="controls-row">
			<button id="eyedropper-button" class="icon-button" type="button" title="Pick a color from anywhere on screen" hidden>
				<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="m2 22 1-1h3l9-9"></path>
					<path d="M3 21v-3l9-9"></path>
					<path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.5 1.5-1.5 1.5-4-4Z"></path>
				</svg>
			</button>
			<span id="current-swatch" class="current-swatch" aria-hidden="true"></span>
			<div id="hue-slider" class="hue-slider" aria-label="Hue">
				<div id="hue-cursor" class="hue-cursor"></div>
			</div>
		</div>

		<div class="field-row">
			<label class="field-label" for="hex-input">Hex</label>
			<input id="hex-input" class="text-input" spellcheck="false" autocomplete="off" aria-label="Hex color">
			<button class="copy-button" type="button" data-copy="hex">Copy</button>
		</div>

		<div class="field-row">
			<span class="field-label">RGB 0-255</span>
			<div class="channel-inputs">
				<input id="rgb255-red" class="number-input" type="number" min="0" max="255" step="1" aria-label="Red 0-255">
				<input id="rgb255-green" class="number-input" type="number" min="0" max="255" step="1" aria-label="Green 0-255">
				<input id="rgb255-blue" class="number-input" type="number" min="0" max="255" step="1" aria-label="Blue 0-255">
			</div>
			<button class="copy-button" type="button" data-copy="rgb255">Copy</button>
		</div>

		<div class="field-row">
			<span class="field-label">RGB 0.0-1.0</span>
			<div class="channel-inputs">
				<input id="rgb01-red" class="number-input" type="number" min="0" max="1" step="0.01" aria-label="Red 0.0-1.0">
				<input id="rgb01-green" class="number-input" type="number" min="0" max="1" step="0.01" aria-label="Green 0.0-1.0">
				<input id="rgb01-blue" class="number-input" type="number" min="0" max="1" step="0.01" aria-label="Blue 0.0-1.0">
			</div>
			<button class="copy-button" type="button" data-copy="rgb01">Copy</button>
		</div>

		<section class="recents">
			<h2 class="recents-title">Recent</h2>
			<div id="recents-grid" class="recents-grid"></div>
			<p id="recents-empty" class="recents-empty">Copied colors show up here.</p>
		</section>
	</main>

<script>
(() => {
	"use strict";

	// Webview-side controller: keeps the color as HSV, renders cursors,
	// swatches and fields, and talks to the extension host via
	// postMessage('ready' | 'copy' | 'picked').
	const vscode = acquireVsCodeApi();

	// -- DOM references ------------------------------------------------
	const headerHex = document.getElementById("header-hex");
	const svSquare = document.getElementById("sv-square");
	const svCursor = document.getElementById("sv-cursor");
	const hueSlider = document.getElementById("hue-slider");
	const hueCursor = document.getElementById("hue-cursor");
	const currentSwatch = document.getElementById("current-swatch");
	const hexInput = document.getElementById("hex-input");
	const red255Input = document.getElementById("rgb255-red");
	const green255Input = document.getElementById("rgb255-green");
	const blue255Input = document.getElementById("rgb255-blue");
	const red01Input = document.getElementById("rgb01-red");
	const green01Input = document.getElementById("rgb01-green");
	const blue01Input = document.getElementById("rgb01-blue");
	const eyedropperButton = document.getElementById("eyedropper-button");
	const recentsGrid = document.getElementById("recents-grid");
	const recentsEmpty = document.getElementById("recents-empty");

	// -- State ----------------------------------------------------------
	// HSV keeps the hue stable while the square is dragged through the
	// edges; RGB and hex are derived on every change.
	const initialRgb = parseHexText("#3CAE89");
	const initialHsv = initialRgb
		? rgbToHsv(initialRgb.red, initialRgb.green, initialRgb.blue)
		: { hue: 0, saturation: 0, value: 0 };
	let hue = initialHsv.hue;
	let saturation = initialHsv.saturation;
	let value = initialHsv.value;

	// -- Color math ------------------------------------------------------

	// Clamp to the 0..1 range.
	function clamp01(number) {
		return Math.min(1, Math.max(0, number));
	}

	// Clamp to an explicit range.
	function clamp(number, minimum, maximum) {
		return Math.min(maximum, Math.max(minimum, number));
	}

	// Convert HSV (hue 0..360, saturation/value 0..1) to RGB 0..255 floats.
	function hsvToRgb(hueValue, saturationValue, valueValue) {
		const chroma = valueValue * saturationValue;
		const hueSection = (hueValue % 360) / 60;
		const second = chroma * (1 - Math.abs((hueSection % 2) - 1));
		let red = 0;
		let green = 0;
		let blue = 0;
		if (hueSection < 1) { red = chroma; green = second; }
		else if (hueSection < 2) { red = second; green = chroma; }
		else if (hueSection < 3) { green = chroma; blue = second; }
		else if (hueSection < 4) { green = second; blue = chroma; }
		else if (hueSection < 5) { red = second; blue = chroma; }
		else { red = chroma; blue = second; }
		const match = valueValue - chroma;
		return {
			red: (red + match) * 255,
			green: (green + match) * 255,
			blue: (blue + match) * 255,
		};
	}

	// Convert RGB 0..255 to hue 0..360, saturation 0..1, value 0..1.
	function rgbToHsv(red, green, blue) {
		const normalizedRed = red / 255;
		const normalizedGreen = green / 255;
		const normalizedBlue = blue / 255;
		const maximum = Math.max(normalizedRed, normalizedGreen, normalizedBlue);
		const minimum = Math.min(normalizedRed, normalizedGreen, normalizedBlue);
		const delta = maximum - minimum;
		let hueValue = 0;
		if (delta > 0) {
			if (maximum === normalizedRed) {
				hueValue = 60 * (((normalizedGreen - normalizedBlue) / delta) % 6);
			} else if (maximum === normalizedGreen) {
				hueValue = 60 * (((normalizedBlue - normalizedRed) / delta) + 2);
			} else {
				hueValue = 60 * (((normalizedRed - normalizedGreen) / delta) + 4);
			}
		}
		if (hueValue < 0) hueValue += 360;
		return {
			hue: hueValue,
			saturation: maximum === 0 ? 0 : delta / maximum,
			value: maximum,
		};
	}

	// Parse "#abc", "#aabbcc" (with or without the hash) into RGB 0..255.
	// Returns null for anything else so callers can leave the color alone.
	function parseHexText(text) {
		const cleaned = text.trim().replace(/^#/, "");
		if (!/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(cleaned)) return null;
		const full = cleaned.length === 3
			? cleaned.split("").map((digit) => digit + digit).join("")
			: cleaned;
		return {
			red: parseInt(full.slice(0, 2), 16),
			green: parseInt(full.slice(2, 4), 16),
			blue: parseInt(full.slice(4, 6), 16),
		};
	}

	// Format RGB 0..255 as an uppercase six digit hex string like "#3CAE89".
	function rgbToHexText(red, green, blue) {
		const parts = [red, green, blue].map((channel) =>
			Math.round(channel).toString(16).padStart(2, "0"));
		return ("#" + parts.join("")).toUpperCase();
	}

	// -- Rendering -------------------------------------------------------

	// The current color as RGB 0..255, derived from the HSV state.
	function currentRgb() {
		return hsvToRgb(hue, saturation, value);
	}

	// The current color as an uppercase hex string.
	function currentHex() {
		const rgb = currentRgb();
		return rgbToHexText(rgb.red, rgb.green, rgb.blue);
	}

	// Adopt an RGB color: recompute HSV (keeping the old hue for achromatic
	// colors so grays do not reset the hue slider) and repaint everything.
	// skipInputId protects the input the user is currently typing into.
	function applyRgb(red, green, blue, skipInputId) {
		const hsv = rgbToHsv(red, green, blue);
		if (hsv.saturation > 0.0001) hue = hsv.hue;
		saturation = hsv.saturation;
		value = hsv.value;
		render(skipInputId);
	}

	// Repaint cursors, swatches, the header and all value fields from the
	// current HSV state. skipInputId is the id of an input that must not be
	// overwritten (the one being edited), or undefined to refresh all.
	function render(skipInputId) {
		const rgb = currentRgb();
		const hexText = rgbToHexText(rgb.red, rgb.green, rgb.blue);

		headerHex.textContent = hexText;
		currentSwatch.style.backgroundColor = hexText;
		svSquare.style.setProperty("--hue", String(hue));
		svCursor.style.left = (saturation * 100) + "%";
		svCursor.style.top = ((1 - value) * 100) + "%";
		hueCursor.style.left = ((hue / 360) * 100) + "%";

		if (skipInputId !== "hex-input") hexInput.value = hexText;
		if (skipInputId !== "rgb255-red") red255Input.value = String(Math.round(rgb.red));
		if (skipInputId !== "rgb255-green") green255Input.value = String(Math.round(rgb.green));
		if (skipInputId !== "rgb255-blue") blue255Input.value = String(Math.round(rgb.blue));
		if (skipInputId !== "rgb01-red") red01Input.value = (rgb.red / 255).toFixed(3);
		if (skipInputId !== "rgb01-green") green01Input.value = (rgb.green / 255).toFixed(3);
		if (skipInputId !== "rgb01-blue") blue01Input.value = (rgb.blue / 255).toFixed(3);
	}

	// -- Pointer dragging ------------------------------------------------

	// Wire pointer dragging on an element: pointerdown starts the gesture
	// and captures the pointer so pointermove keeps arriving during the drag.
	function enableDrag(element, onDragPosition) {
		element.addEventListener("pointerdown", (event) => {
			element.setPointerCapture(event.pointerId);
			onDragPosition(event);
		});
		element.addEventListener("pointermove", (event) => {
			if (element.hasPointerCapture(event.pointerId)) onDragPosition(event);
		});
	}

	// The square: x is saturation (left 0, right 1), y is value (top 1,
	// bottom 0), so the second axis is inverted.
	enableDrag(svSquare, (event) => {
		const bounds = svSquare.getBoundingClientRect();
		saturation = clamp01((event.clientX - bounds.left) / bounds.width);
		value = 1 - clamp01((event.clientY - bounds.top) / bounds.height);
		render();
	});

	// The hue slider maps x directly onto 0..360 degrees.
	enableDrag(hueSlider, (event) => {
		const bounds = hueSlider.getBoundingClientRect();
		hue = clamp01((event.clientX - bounds.left) / bounds.width) * 360;
		render();
	});

	// -- Editable fields -------------------------------------------------

	// Read a numeric input; returns null while it is empty or not a number.
	function readNumber(input) {
		if (input.value.trim() === "") return null;
		const number = Number(input.value);
		return Number.isFinite(number) ? number : null;
	}

	// Apply the three 0-255 fields when they all parse.
	function applyRgb255Inputs(skipInputId) {
		const red = readNumber(red255Input);
		const green = readNumber(green255Input);
		const blue = readNumber(blue255Input);
		if (red === null || green === null || blue === null) return;
		applyRgb(clamp(red, 0, 255), clamp(green, 0, 255), clamp(blue, 0, 255), skipInputId);
	}

	// Apply the three 0.0-1.0 fields when they all parse.
	function applyRgb01Inputs(skipInputId) {
		const red = readNumber(red01Input);
		const green = readNumber(green01Input);
		const blue = readNumber(blue01Input);
		if (red === null || green === null || blue === null) return;
		applyRgb(
			clamp(red, 0, 1) * 255,
			clamp(green, 0, 1) * 255,
			clamp(blue, 0, 1) * 255,
			skipInputId,
		);
	}

	// Hex field: apply as the user types, normalize the text on change/blur.
	hexInput.addEventListener("input", () => {
		const rgb = parseHexText(hexInput.value);
		if (rgb) applyRgb(rgb.red, rgb.green, rgb.blue, "hex-input");
	});
	hexInput.addEventListener("change", () => render());

	// RGB 0-255 fields: while typing only the edited field is left alone;
	// on change the edit is clamped and renormalized.
	red255Input.addEventListener("input", () => applyRgb255Inputs("rgb255-red"));
	green255Input.addEventListener("input", () => applyRgb255Inputs("rgb255-green"));
	blue255Input.addEventListener("input", () => applyRgb255Inputs("rgb255-blue"));
	red255Input.addEventListener("change", () => applyRgb255Inputs());
	green255Input.addEventListener("change", () => applyRgb255Inputs());
	blue255Input.addEventListener("change", () => applyRgb255Inputs());

	// RGB 0.0-1.0 fields behave the same way.
	red01Input.addEventListener("input", () => applyRgb01Inputs("rgb01-red"));
	green01Input.addEventListener("input", () => applyRgb01Inputs("rgb01-green"));
	blue01Input.addEventListener("input", () => applyRgb01Inputs("rgb01-blue"));
	red01Input.addEventListener("change", () => applyRgb01Inputs());
	green01Input.addEventListener("change", () => applyRgb01Inputs());
	blue01Input.addEventListener("change", () => applyRgb01Inputs());

	// -- Copy buttons ----------------------------------------------------

	// The text copied for each field kind: the hex color, the 0-255 triple
	// or the 0.0-1.0 triple, exactly as shown in the fields.
	function copyTextFor(kind) {
		const rgb = currentRgb();
		if (kind === "hex") return currentHex();
		if (kind === "rgb255") {
			return [Math.round(rgb.red), Math.round(rgb.green), Math.round(rgb.blue)].join(", ");
		}
		return [
			(rgb.red / 255).toFixed(3),
			(rgb.green / 255).toFixed(3),
			(rgb.blue / 255).toFixed(3),
		].join(", ");
	}

	// Flash "Copied!" feedback on a button and restore its label.
	const copyFeedbackTimers = new WeakMap();
	function showCopyFeedback(button) {
		const previousTimer = copyFeedbackTimers.get(button);
		if (previousTimer) clearTimeout(previousTimer);
		button.textContent = "Copied!";
		const timer = setTimeout(() => { button.textContent = "Copy"; }, 900);
		copyFeedbackTimers.set(button, timer);
	}

	// Wire one copy button: the host writes the clipboard (vscode.env
	// .clipboard) and remembers the color, so no browser permissions are
	// involved. The refreshed recents arrive via the message listener.
	function wireCopyButton(button) {
		button.addEventListener("click", () => {
			vscode.postMessage({
				type: "copy",
				text: copyTextFor(button.dataset.copy),
				hex: currentHex(),
			});
			showCopyFeedback(button);
		});
	}

	document.querySelectorAll("button[data-copy]").forEach(wireCopyButton);

	// -- Recent colors ---------------------------------------------------

	// Render the Recent row; clicking a swatch adopts that color.
	function renderRecents(hexColors) {
		recentsGrid.replaceChildren.apply(recentsGrid, hexColors.map((hexColor) => {
			const swatch = document.createElement("button");
			swatch.type = "button";
			swatch.className = "recent-swatch";
			swatch.style.backgroundColor = hexColor;
			swatch.title = hexColor;
			swatch.addEventListener("click", () => {
				const rgb = parseHexText(hexColor);
				if (rgb) applyRgb(rgb.red, rgb.green, rgb.blue);
			});
			return swatch;
		}));
		recentsEmpty.hidden = hexColors.length > 0;
	}

	// Host messages: the recents list, pushed after 'ready', every copy and
	// every eyedropper pick.
	window.addEventListener("message", (event) => {
		const message = event.data;
		if (message && message.type === "recents" && Array.isArray(message.recents)) {
			renderRecents(message.recents);
		}
	});

	// -- Eyedropper ------------------------------------------------------

	// The native EyeDropper API exists only in Chromium-based hosts; in
	// other webview engines the button stays hidden.
	if ("EyeDropper" in window) {
		eyedropperButton.hidden = false;
		eyedropperButton.addEventListener("click", async () => {
			try {
				const result = await new EyeDropper().open();
				const rgb = parseHexText(result.sRGBHex);
				if (!rgb) return;
				applyRgb(rgb.red, rgb.green, rgb.blue);
				vscode.postMessage({ type: "picked", hex: result.sRGBHex.toUpperCase() });
			} catch (error) {
				// The user cancelled the eyedropper; nothing to do.
			}
		});
	}

	// -- Initial paint ---------------------------------------------------

	render();
	vscode.postMessage({ type: "ready" });
})();
</script>
</body>
</html>`;
}
