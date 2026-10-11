(() => {
// Webview-side controller: owns local state, renders cards, talks to the
// extension host via postMessage('save', ...) and listens for 'init'.
const vscode = acquireVsCodeApi();
let state = { machineName: '', commands: [], limits: null };
let onlyMine = false;

// Lucide icons (https://lucide.dev) inlined as raw SVG strings.
const SVG_ATTRS = 'xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
	chevron: `<svg ${SVG_ATTRS}><path d="m9 18 6-6-6-6"/></svg>`,
	up:      `<svg ${SVG_ATTRS}><path d="m18 15-6-6-6 6"/></svg>`,
	down:    `<svg ${SVG_ATTRS}><path d="m6 9 6 6 6-6"/></svg>`,
	copy:    `<svg ${SVG_ATTRS}><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`,
	trash:   `<svg ${SVG_ATTRS}><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`,
	x:       `<svg ${SVG_ATTRS}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
	help:    `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
	plus:    `<svg ${SVG_ATTRS}><path d="M5 12h14"/><path d="M12 5v14"/></svg>`,
	folder:  `<svg ${SVG_ATTRS}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`,
	file:    `<svg ${SVG_ATTRS}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>`,
	glove:   `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 280 280" fill="currentColor" fill-rule="evenodd"><path d="M167.41 63.52s2.52-4.09 17.95-2.39c23.06 2.53 37.89 16.76 49.1 32.41 9.91 13.85 10.51 17.72 16.12 34.18 2.2 6.45 3.54 12.45 4.27 19.49-4.4-.51-5.5-.8-12.24-1.61-.86-12.4-8.76-41.09-33.32-62.93-16.08-14.31-34.94-10.94-34.94-10.94z"/><path d="M37.43 126.69l56.26 19.52s7.55-10.43 15.16-13.1c11.71-4.11 17.72.63 17.72.63l54.98-54.01s29.73 31.04 35.83 50.22c4.02 12.61 15.19 14.55 15.19 14.55l-60.78 50.53 68.05 63.67-16.41 17.43-70.6-78.79-59.61-5.1-64.16-51.61z"/><path d="M187.71 203.54c-3.55-3.27-3.77-8.78-.5-12.33 3.27-3.55 8.79-3.77 12.33-.5 3.55 3.28 3.77 8.79.5 12.34-3.27 3.54-8.78 3.77-12.33.49zM208.32 222.33c-3.55-3.27-3.77-8.78-.5-12.33 3.28-3.55 8.79-3.77 12.34-.5 3.54 3.27 3.77 8.79.49 12.33-3.27 3.55-8.78 3.77-12.33.5zM230.82 244.03c-3.55-3.27-3.77-8.79-.5-12.33 3.27-3.55 8.79-3.77 12.33-.5 3.55 3.27 3.77 8.78.5 12.33-3.27 3.55-8.78 3.77-12.33.5zM205.16 186.09c-3.54-3.27-3.77-8.79-.49-12.33 3.27-3.55 8.78-3.77 12.33-.5 3.55 3.27 3.77 8.78.5 12.33-3.28 3.55-8.79 3.77-12.34.5zM225.78 204.88c-3.55-3.28-3.77-8.79-.5-12.34 3.27-3.54 8.78-3.77 12.33-.49 3.55 3.27 3.77 8.78.5 12.33-3.27 3.55-8.79 3.77-12.33.5zM248.27 226.57c-3.54-3.27-3.77-8.78-.49-12.33 3.27-3.55 8.78-3.77 12.33-.5 3.55 3.28 3.77 8.79.5 12.34-3.28 3.54-8.79 3.77-12.34.49z"/><path d="M104.32 3L90.92 11.66l42.75 51.33-4.65 4.19-58.34-60.83-15.37 11.36 57.9 66.2-6.97 4.65-70.15-67.11-12.61 10.86 67.88 70.2-72.06-48.35-9.3 13.02 70.67 64.16 79.03-73.93-10.69-12.08-4.18 1.39"/></svg>`,
};

function setIcon(el, name) { if (el && ICONS[name]) { el.innerHTML = ICONS[name]; } }
// Replace every [data-icon] placeholder under `scope` with its inline SVG.
function hydrateIcons(scope) {
	scope.querySelectorAll('[data-icon]').forEach((el) => setIcon(el, el.dataset.icon));
}

// Palette offered as one-click swatches; the hex field accepts any other
// #rgb / #rrggbb value.
const COLOR_PRESETS = ['#e5484d', '#f76b15', '#f5c542', '#46a758', '#12a594', '#3b82f6', '#8e4ec6', '#d6409f', '#8b8d98'];

// Return a lowercase hex color when the value is a valid #rgb/#rrggbb
// string, or '' for empty/invalid input (treated as "no color").
function normalizeHex(value) {
	const s = (value || '').trim().toLowerCase();
	return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(s) ? s : '';
}

// One dropdown builder shared by the project and machine-name fields: an
// anchored list under the field, pick on mousedown, close on outside click.
function openValueDropdown({ anchor, values, emptyText, onPick }) {
	document.querySelectorAll('.value-dropdown').forEach((el) => el.remove());
	const dropdown = document.createElement('div');
	dropdown.className = 'value-dropdown';
	if (values.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'vd-empty';
		empty.textContent = emptyText;
		dropdown.appendChild(empty);
	} else {
		for (const value of values) {
			const item = document.createElement('div');
			item.className = 'vd-item';
			item.textContent = value;
			item.addEventListener('mousedown', (e) => {
				e.preventDefault(); // keep focus on the input
				onPick(value);
				dropdown.remove();
			});
			dropdown.appendChild(item);
		}
	}
	anchor.appendChild(dropdown);
	// Close when clicking outside the anchor.
	const close = (e) => {
		if (!anchor.contains(e.target)) {
			dropdown.remove();
			document.removeEventListener('mousedown', close);
		}
	};
	setTimeout(() => document.addEventListener('mousedown', close), 0);
}

const root = document.getElementById('root');
const machineEl = document.getElementById('machine');
const onlyMineEl = document.getElementById('onlyMine');
const addBtn = document.getElementById('addBtn');
const jsonBtn = document.getElementById('jsonBtn');
const helpBtn = document.getElementById('helpBtn');
const helpEl = document.getElementById('help');
const helpCloseBtn = document.getElementById('helpClose');
setIcon(jsonBtn, 'file');
setIcon(helpBtn, 'help');
setIcon(helpCloseBtn, 'x');
setIcon(document.getElementById('brand'), 'glove');
helpBtn.addEventListener('click', () => {
	const opening = !helpEl.classList.contains('open');
	helpEl.classList.toggle('open');
	if (opening) { helpEl.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
});
helpCloseBtn.addEventListener('click', () => helpEl.classList.remove('open'));
jsonBtn.addEventListener('click', () => vscode.postMessage({ type: 'openJsonFile' }));

const cardTpl = document.getElementById('cardTpl');
const machineTpl = document.getElementById('machineTpl');
const overrideTpl = document.getElementById('overrideTpl');

// Inbound from the extension host: 'init' carries the machine name and
// the current commands array; we replace local state and re-render.
// 'directoryPicked' carries a path selected via the native folder dialog.
// A Map tracks pending pick callbacks keyed by a unique requestId.
const dirPickCallbacks = new Map();
window.addEventListener('message', (e) => {
	const m = e.data;
	if (m?.type === 'init') {
		state = { machineName: m.machineName || '', commands: m.commands || [], limits: m.limits || state.limits };
		machineEl.textContent = state.machineName || '(unknown)';
		// Show commands file path in a tooltip on the machine badge.
		if (m.commandsFilePath) {
			machineEl.title = 'Commands file: ' + m.commandsFilePath;
		}
		render();
	}
	if (m?.type === 'directoryPicked' && m.requestId && dirPickCallbacks.has(m.requestId)) {
		dirPickCallbacks.get(m.requestId)(m.path);
		dirPickCallbacks.delete(m.requestId);
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
		machineSettings: [],
	});
	save(); render(state.commands.length - 1);
});

// Persist the current commands array back to settings via the extension host.
function save() { vscode.postMessage({ type: 'save', commands: state.commands }); }
// Debounced save for text input events: coalesces rapid keystrokes into a
// single write so in-flight saves don't race against the suppress counter.
let saveTimer = 0;
function debouncedSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); }

// True when this command has at least one machineSetting matching the
// detected host with show !== false. Used for the dim/'only mine' filter.
function visibleForCurrentMachine(c) {
	if (!Array.isArray(c.machineSettings)) { return false; }
	return c.machineSettings.some(
		(m) => m && m.machineName === state.machineName && m.show !== false,
	);
}

// Group key for a command: its `project` field, or '__common__' for none.
function groupKey(c) {
	const p = (c.project || '').trim();
	return p || '__common__';
}

// Rebuild the entire card list from `state.commands`.
// - Optionally restricts to commands visible on this machine.
// - Buckets by project, renders an empty-state hint when nothing matches,
//   and pins the 'Common' (no-project) section to the end.
// - `openIdx` lets a caller specify which card should start expanded
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

	// Wire a single text/textarea input to a property on `c`. Saves on every
	// keystroke and updates the head preview; project edits force a full
	// re-render because they can change which group the card belongs to.
	const bind = (prop) => {
		const el = node.querySelector(`[data-bind="${prop}"]`);
		el.value = c[prop] ?? '';
		el.addEventListener('input', () => {
			c[prop] = el.value;
			if (prop === 'name') { node.querySelector('.name').textContent = el.value || '(unnamed)'; }
			if (prop === 'command') { node.querySelector('.preview').textContent = el.value; }
			debouncedSave();
		});
		if (prop === 'project') {
			el.addEventListener('blur', () => { render(idx); });
		}
	};
	bind('name');
	bind('description');
	bind('project');
	bind('directory');
	bind('command');

	// Color chip: preset swatches plus a free-form hex field. The chosen
	// color appears on the card head and as a square in front of the row in
	// the sidebar tree. Clearing the color deletes the key entirely so the
	// stored JSON stays free of empty placeholders.
	const dot = node.querySelector('.color-dot');
	const swatchesEl = node.querySelector('.color-row .swatches');
	const hexInput = node.querySelector('.color-hex');

	// Sync the dot, the swatch highlight, and (when not being typed in) the
	// hex field with c.color.
	const renderColor = () => {
		const color = normalizeHex(c.color);
		dot.classList.toggle('hidden', !color);
		dot.style.background = color || '';
		swatchesEl.querySelectorAll('.swatch').forEach((sw) => {
			sw.classList.toggle('selected', (sw.dataset.color || '') === color);
		});
		if (document.activeElement !== hexInput) { hexInput.value = color; }
	};

	const noneSwatch = document.createElement('button');
	noneSwatch.className = 'swatch none';
	noneSwatch.dataset.color = '';
	noneSwatch.title = 'No color';
	swatchesEl.appendChild(noneSwatch);
	for (const preset of COLOR_PRESETS) {
		const sw = document.createElement('button');
		sw.className = 'swatch';
		sw.dataset.color = preset;
		sw.title = preset;
		sw.style.background = preset;
		swatchesEl.appendChild(sw);
	}
	swatchesEl.addEventListener('click', (ev) => {
		const sw = ev.target.closest('.swatch');
		if (!sw) { return; }
		const color = sw.dataset.color || '';
		if (color) { c.color = color; } else { delete c.color; }
		renderColor();
		save();
	});
	// Free typing: valid values apply immediately; invalid partial input
	// stays visible while typing and reverts to the stored value on blur.
	hexInput.addEventListener('input', () => {
		const raw = hexInput.value.trim().toLowerCase();
		const color = normalizeHex(raw);
		if (raw === '') {
			delete c.color;
		} else if (color) {
			c.color = color;
		} else {
			return;
		}
		renderColor();
		debouncedSave();
	});
	hexInput.addEventListener('blur', () => { hexInput.value = normalizeHex(c.color); });
	renderColor();

	// Command type + auto-run settings: the dropdown switches between the
	// manual (default) and auto modes. The interval, popup, timeout and
	// retry fields and the "auto" chip are only shown for auto commands.
	const typeSelect = node.querySelector('[data-bind="type"]');
	const typeChip = node.querySelector('.type-chip');
	const intervalField = node.querySelector('.auto-interval-field');
	const intervalInput = node.querySelector('[data-bind="autoRunIntervalMinutes"]');
	// Parse the interval field: "5" is a fixed interval, "0.5" is 30
	// seconds, and "1-3" is a random range. Values below the configured
	// minimum are rejected; invalid or half-typed input returns null so it
	// is not saved and blur falls back to the default.
	const parseInterval = () => {
		const text = intervalInput.value.trim();
		const single = /^(\d+(?:\.\d+)?)$/.exec(text);
		if (single) {
			const minutes = Number(single[1]);
			return minutes >= state.limits.minimumIntervalMinutes ? minutes : null;
		}
		const range = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(text);
		if (range) {
			const first = Number(range[1]);
			const second = Number(range[2]);
			if (first >= state.limits.minimumIntervalMinutes && second >= state.limits.minimumIntervalMinutes) {
				return [Math.min(first, second), Math.max(first, second)];
			}
		}
		return null;
	};
	// Render an interval value back into the field: "5" or "1-3".
	const formatInterval = (value) => {
		if (Array.isArray(value) && value.length === 2) { return value[0] + '-' + value[1]; }
		return typeof value === 'number' ? String(value) : String(state.limits.defaultIntervalMinutes);
	};
	const applyTypeUi = () => {
		const isAuto = typeSelect.value === 'auto';
		// Toggle the class (not style.display) so the initial hiding in the
		// markup is a class too - the strict CSP has no 'unsafe-inline'.
		typeChip.classList.toggle('hidden', !isAuto);
		intervalField.classList.toggle('hidden', !isAuto);
		popupField.classList.toggle('hidden', !isAuto);
		timeoutField.classList.toggle('hidden', !isAuto);
		retryField.classList.toggle('hidden', !isAuto);
	};
	// Entries without a type are manual; showing that explicitly in the
	// dropdown keeps older commands files working without rewriting them.
	typeSelect.value = c.type === 'auto' ? 'auto' : 'manual';
	intervalInput.value = formatInterval(c.autoRunIntervalMinutes);
	typeSelect.addEventListener('change', () => {
		if (typeSelect.value === 'auto') {
			c.type = 'auto';
			if (typeof c.autoRunIntervalMinutes !== 'number' && !Array.isArray(c.autoRunIntervalMinutes)) {
				c.autoRunIntervalMinutes = 5;
				intervalInput.value = '5';
			}
		} else {
			// Keep the interval value around so toggling back is lossless;
			// the resolver ignores it for manual entries.
			delete c.type;
		}
		applyTypeUi();
		save();
	});
	// Interval edits apply live; an empty or invalid value falls back to
	// the default on blur so the stored interval is always sane.
	intervalInput.addEventListener('input', () => {
		const parsed = parseInterval();
		if (parsed !== null) {
			c.autoRunIntervalMinutes = parsed;
			debouncedSave();
		}
	});
	intervalInput.addEventListener('blur', () => {
		const parsed = parseInterval();
			c.autoRunIntervalMinutes = parsed !== null ? parsed : state.limits.defaultIntervalMinutes;
		intervalInput.value = formatInterval(c.autoRunIntervalMinutes);
		save();
	});

	// Popup policy: only meaningful for auto commands; 'onChange' is the
	// default, so picking it deletes the key instead of storing it.
	const popupField = node.querySelector('.auto-popup-field');
	const popupSelect = node.querySelector('[data-bind="popup"]');
	popupSelect.value = c.popup === 'always' || c.popup === 'never' ? c.popup : 'onChange';
	popupSelect.addEventListener('change', () => {
		if (popupSelect.value === 'always' || popupSelect.value === 'never') {
			c.popup = popupSelect.value;
		} else {
			delete c.popup;
		}
		save();
	});

	// Timeout overrides the default 120 s kill timer; empty or invalid
	// input removes the key on blur so the default applies again.
	const timeoutField = node.querySelector('.auto-timeout-field');
	const timeoutInput = node.querySelector('[data-bind="timeoutSeconds"]');
	const parseTimeout = () => {
		const seconds = Math.round(Number(timeoutInput.value.trim()));
		return Number.isFinite(seconds) && seconds >= state.limits.minimumTimeoutSeconds && seconds <= state.limits.maximumTimeoutSeconds ? seconds : null;
	};
	const formatTimeout = () => typeof c.timeoutSeconds === 'number' ? String(c.timeoutSeconds) : '';
	timeoutInput.value = formatTimeout();
	timeoutInput.addEventListener('input', () => {
		const parsed = parseTimeout();
		if (parsed !== null) { c.timeoutSeconds = parsed; debouncedSave(); }
	});
	timeoutInput.addEventListener('blur', () => {
		const parsed = parseTimeout();
		if (parsed !== null) { c.timeoutSeconds = parsed; } else { delete c.timeoutSeconds; }
		timeoutInput.value = formatTimeout();
		save();
	});

	// Retry-on-failure toggle.
	const retryField = node.querySelector('.auto-retry-field');
	const retryInput = node.querySelector('[data-bind="retryOnFailure"]');
	retryInput.checked = c.retryOnFailure === true;
	retryInput.addEventListener('change', () => {
		if (retryInput.checked) { c.retryOnFailure = true; } else { delete c.retryOnFailure; }
		save();
	});

	// Enabled toggle: unchecking stores "enabled": false, checking removes
	// the key again (missing means enabled) so the file stays clean. The
	// card dims like a machine-hidden entry to signal the inactive state.
	const enabledInput = node.querySelector('[data-bind="enabled"]');
	enabledInput.checked = c.enabled !== false;
	enabledInput.addEventListener('change', () => {
		if (enabledInput.checked) {
			delete c.enabled;
			node.classList.remove('dim');
		} else {
			c.enabled = false;
			node.classList.add('dim');
		}
		save();
	});

	applyTypeUi();

	// Project value dropdown: lists all distinct project values in state.
	const projectInput = node.querySelector('[data-bind="project"]');
	const projectWrap = node.querySelector('.project-wrap');
	const projectDropBtn = node.querySelector('.project-drop-btn');
	setIcon(projectDropBtn, 'down');

	projectDropBtn.addEventListener('click', (ev) => {
		ev.stopPropagation();
		openValueDropdown({
			anchor: projectWrap,
			values: [...new Set(
				state.commands.map((cmd) => (cmd.project || '').trim()).filter(Boolean)
			)].sort(),
			emptyText: 'No projects defined yet',
			onPick: (value) => {
				c.project = value;
				projectInput.value = value;
				save();
				render(idx);
			},
		});
	});

	// Directory browse button: opens native folder picker via extension host.
	const dirInput = node.querySelector('[data-bind="directory"]');
	const dirPickBtn = node.querySelector('.dir-pick-btn');
	setIcon(dirPickBtn, 'folder');
	dirPickBtn.addEventListener('click', (ev) => {
		ev.stopPropagation();
		const requestId = Math.random().toString(36).slice(2);
		dirPickCallbacks.set(requestId, (path) => {
			if (!path) { return; }
			c.directory = path;
			dirInput.value = path;
			save();
		});
		vscode.postMessage({ type: 'pickDirectory', requestId });
	});

	// Render any existing per-machine setting blocks under this card.
	const machinesEl = node.querySelector('.machines');
	(c.machineSettings || []).forEach((m, mi) => {
		machinesEl.appendChild(buildMachine(c, m, mi, idx));
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
	function buildMachine(cmd, m, mi, idx) {
	const node = machineTpl.content.firstElementChild.cloneNode(true);
	hydrateIcons(node);
	const nameEl = node.querySelector('[data-bind="machineName"]');
	const showEl = node.querySelector('[data-bind="show"]');
	nameEl.value = m.machineName || '';
	showEl.checked = m.show !== false;
	nameEl.addEventListener('input', () => { m.machineName = nameEl.value; debouncedSave(); });
	showEl.addEventListener('change', () => { m.show = showEl.checked; save(); });

	// Machine name dropdown: lists all distinct machineName values across all commands.
	const machineWrap = node.querySelector('.machine-name-wrap');
	const machineDropBtn = node.querySelector('.machine-drop-btn');
	setIcon(machineDropBtn, 'down');
	machineDropBtn.addEventListener('click', (ev) => {
		ev.stopPropagation();
		openValueDropdown({
			anchor: machineWrap,
			values: [...new Set(
				state.commands.flatMap((c) =>
					(c.machineSettings || []).map((s) => (s.machineName || '').trim()).filter(Boolean)
				)
			)].sort(),
			emptyText: 'No machine names defined yet',
			onPick: (value) => {
				m.machineName = value;
				nameEl.value = value;
				save();
			},
		});
	});

	const ovsEl = node.querySelector('.overrides');
	if ((m.overrides || []).length > 0) {
		const header = document.createElement('div');
		header.className = 'ov-header';
		header.innerHTML = '<span>Key</span><span>Value</span><span></span>';
		ovsEl.appendChild(header);
	}
	(m.overrides || []).forEach((o, oi) => ovsEl.appendChild(buildOverride(m, o, oi)));

	node.querySelector('[data-act="delMachine"]').addEventListener('click', () => {
		cmd.machineSettings.splice(mi, 1);
		save(); render(idx);
	});
	node.querySelector('[data-act="addOverride"]').addEventListener('click', () => {
		m.overrides = m.overrides || [];
		m.overrides.push({ key: '', value: '' });
		save(); render(idx);
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
	k.addEventListener('input', () => { o.key = k.value; debouncedSave(); });
	v.addEventListener('input', () => { o.value = v.value; debouncedSave(); });
	node.querySelector('[data-act="delOverride"]').addEventListener('click', () => {
		m.overrides.splice(oi, 1);
		save();
		// Re-render only the parent card by triggering full render of state.
		render();
	});
	return node;
}

// Swap a command with its neighbour in `state.commands`. No-op at the edges.
function moveCommand(idx, delta) {
	const j = idx + delta;
	if (j < 0 || j >= state.commands.length) { return; }
	const [item] = state.commands.splice(idx, 1);
	state.commands.splice(j, 0, item);
	save(); render(j);
}
})();
