// This file implements Power Glove's single sidebar tree view, split into
// two internal sections: the manual commands (grouped by project, on top)
// and the "Auto Run" section (auto commands with their latest background
// result, pinned to the bottom).
//
// - CommandsTreeDataProvider implements vscode.TreeDataProvider for both
//   sections: manual leaves under project group headers, plus one Auto Run
//   section header with a status row per auto command.
// - Every command row icon is a full-height color bar hugging the right edge
//   (transparent when the command has no color); auto rows add the
//   red/yellow/green status dot on the left.
// - CommandTreeItem is a thin TreeItem subclass that carries the minimum
//   identity fields (commandName, groupName) so inline command handlers can
//   look up the full ResolvedCommand from the provider's internal map.
// - The provider exposes getResolvedCommand(name) so the extension entry
//   point can wire up the default row-click action and the inline actions:
//     row click / Enter -> run in current terminal
//     ▣ run in new terminal (inline button)
//     ⓘ show command details (inline button)
// - Disabled commands ("enabled": false) stay visible but render dimmed:
//   no run action, a "disabled" description, and a "…disabled" context value
//   so the context menu offers Enable instead of Disable.
// - Auto row tooltips show a countdown to the next scheduled run via the
//   getNextRunAtMilliseconds callback supplied by the extension.
// - setRunning()/setResult() feed the Auto Run rows from the background
//   engine; refresh() replaces both sections' data in one go.

import * as vscode from 'vscode';
import { ResolvedCommand } from '../resolver';
import { AutoRunResult, AutoRunStatus } from '../autorun';

// Dot colors for auto-run rows, following the classic traffic-light mapping;
// "unknown" is drawn as a hollow ring for "never ran or unreadable verdict".
const STATUS_DOT_FILL: Record<Exclude<AutoRunStatus, 'unknown'>, string> = {
    green: '#3fb950',
    yellow: '#d29922',
    red: '#f85149',
};

// Lightweight TreeItem subclass. We intentionally avoid storing the full
// ResolvedCommand on the item because VS Code may serialise tree items
// when they cross the extension host / renderer boundary, which would
// strip custom class properties. Instead we keep a Map<string, ResolvedCommand>
// in the provider and use `commandName` (== ResolvedCommand.name) as the key.
export class CommandTreeItem extends vscode.TreeItem {
    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        /** Unique identifier of the resolved command (only set on leaf items). */
        public readonly commandName?: string,
        /** The project / group this item belongs to (only set on leaf items). */
        public readonly groupName?: string,
    ) {
        super(label, collapsibleState);
    }
}

// Hooks the provider uses to enrich auto rows; optional so tests can
// construct the provider without any extension wiring.
export interface CommandsTreeProviderOptions {
    /** Epoch ms of the next scheduled run for an auto command, or undefined
     *  when it is not scheduled; rendered as a countdown in the tooltip. */
    getNextRunAtMilliseconds?: (name: string) => number | undefined;
}

// TreeDataProvider that powers the "Power Glove Commands" view in the
// Explorer sidebar. Groups are derived from the `project` field of each
// resolved command; commands with no project land under "(general)".
export class CommandsTreeDataProvider implements vscode.TreeDataProvider<CommandTreeItem> {

    private _onDidChangeTreeData = new vscode.EventEmitter<CommandTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly options: CommandsTreeProviderOptions = {}) {}

    // Current snapshot of resolved commands, kept up-to-date via refresh().
    private resolvedCommands: ResolvedCommand[] = [];

    // Sorted list of group keys: "(general)" first, then alphabetical.
    private groupOrder: string[] = [];

    // Quick lookup from command name → ResolvedCommand for inline action handlers.
    private commandMap = new Map<string, ResolvedCommand>();

    // Auto Run section: current commands, latest results, and the names of
    // commands whose background run is currently in flight.
    private autoCommands: ResolvedCommand[] = [];
    private readonly autoResults = new Map<string, AutoRunResult>();
    private readonly runningAutoNames = new Set<string>();

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /** Replace both sections' data and refresh the tree. Called on
     *  activation, config changes, workspace-folder changes, and after
     *  commands-file edits. */
    refresh(commands: ResolvedCommand[], autoCommands: ResolvedCommand[]): void {
        this.resolvedCommands = commands;
        this.autoCommands = autoCommands;
        this.commandMap = new Map(commands.map((c) => [c.name, c]));

        const groups = new Set<string>();
        for (const c of commands) {
            groups.add(c.project || '(general)');
        }

        // Stable sort: "(general)" always leads, then lexicographic.
        this.groupOrder = Array.from(groups).sort((a, b) => {
            if (a === '(general)') { return -1; }
            if (b === '(general)') { return 1; }
            return a.localeCompare(b);
        });

        // Drop results for auto commands that disappeared (renames, deletes).
        const autoNames = new Set(autoCommands.map((c) => c.name));
        for (const name of [...this.autoResults.keys()]) {
            if (!autoNames.has(name)) { this.autoResults.delete(name); }
        }

        this._onDidChangeTreeData.fire();
    }

    /** Look up a ResolvedCommand by its name. Returns undefined when the
     *  command is no longer in the current resolved set (stale click, etc.). */
    getResolvedCommand(name: string): ResolvedCommand | undefined {
        return this.commandMap.get(name);
    }

    /** Mark an auto command as currently running (or done running). */
    setRunning(name: string, running: boolean): void {
        if (running) {
            this.runningAutoNames.add(name);
        } else {
            this.runningAutoNames.delete(name);
        }
        this._onDidChangeTreeData.fire();
    }

    /** Record the parsed result of a finished auto run. */
    setResult(name: string, result: AutoRunResult): void {
        this.autoResults.set(name, result);
        this.runningAutoNames.delete(name);
        this._onDidChangeTreeData.fire();
    }

    /** Re-render the Auto Run rows; used by the periodic countdown ticker so
     *  the tooltip's "next run" line stays fresh. No-op without auto rows. */
    refreshAutoRows(): void {
        if (this.autoCommands.length === 0) { return; }
        this._onDidChangeTreeData.fire();
    }

    // ---------------------------------------------------------------------------
    // TreeDataProvider implementation
    // ---------------------------------------------------------------------------

    getTreeItem(element: CommandTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: CommandTreeItem): CommandTreeItem[] {
        // Root level → project groups for manual commands, then the Auto Run
        // section pinned to the bottom of the tree.
        if (!element) {
            const groups = this.groupOrder.map((group) => {
                const count = this.resolvedCommands.filter(
                    (c) => (c.project || '(general)') === group,
                ).length;
                const item = new CommandTreeItem(
                    group,
                    vscode.TreeItemCollapsibleState.Expanded,
                );
                item.iconPath = new vscode.ThemeIcon('folder');
                item.description = describeCommandCount(count);
                item.contextValue = 'group';
                return item;
            });
            const autoSection = this.buildAutoSection();
            return autoSection ? [...groups, autoSection] : groups;
        }

        // Auto Run section → one status row per auto command, or a hint row
        // (clickable, opens the manager) while there are none.
        if (element.contextValue === 'autoSection') {
            if (this.autoCommands.length === 0) {
                const hint = new CommandTreeItem(
                    'No auto-run commands',
                    vscode.TreeItemCollapsibleState.None,
                );
                hint.iconPath = new vscode.ThemeIcon('info');
                hint.description = 'set a command type to "Auto run command" in the manager';
                hint.contextValue = 'autoHint';
                hint.command = { command: 'powerGlove.openManager', title: 'Manage Commands' };
                return [hint];
            }
            return this.autoCommands.map((cmd) => this.buildAutoItem(cmd));
        }

        // Group level → one leaf item per command in that group.
        if (element.contextValue === 'group') {
            const group = (element.label as string) ?? '';
            const commands = this.resolvedCommands.filter(
                (c) => (c.project || '(general)') === group,
            );

            return commands.map((cmd) => {
                const disabled = cmd.enabled === false;
                const item = new CommandTreeItem(
                    cmd.name,
                    vscode.TreeItemCollapsibleState.None,
                    cmd.name,           // used by handlers for lookup
                    group,              // informational only
                );
                // Same icon grammar as the auto rows, without the status dot:
                // the color bar on the right is transparent when unset (and
                // always transparent while the command is disabled).
                item.iconPath = buildRowIcon(disabled ? undefined : cmd.color, undefined);
                item.description = disabled ? 'disabled' : (cmd.description || undefined);
                item.tooltip = buildTooltip(cmd);
                item.contextValue = disabled ? 'command.disabled' : 'command';
                // id is the stable key used by inline-action handlers to
                // recover the ResolvedCommand from the provider's map.
                item.id = cmd.name;

                // Default action: clicking anywhere on the command row (or
                // pressing Enter) runs it in the current terminal. Disabled
                // rows have no action; the context menu is the way back.
                item.command = disabled ? undefined : {
                    command: 'powerGlove.tree.runCurrent',
                    title: 'Run in Current Terminal',
                    arguments: [cmd.name],
                };

                return item;
            });
        }

        return [];
    }

    // Build the "Auto Run" root section. Hidden only while the whole view is
    // empty, in which case the view message explains how to add commands.
    private buildAutoSection(): CommandTreeItem | undefined {
        if (this.autoCommands.length === 0 && this.resolvedCommands.length === 0) {
            return undefined;
        }
        const item = new CommandTreeItem('Auto Run', vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('pulse');
        item.description = this.autoCommands.length > 0
            ? describeCommandCount(this.autoCommands.length)
            : 'none';
        item.contextValue = 'autoSection';
        return item;
    }

    // Build one Auto Run row: status dot, name, description + last message.
    private buildAutoItem(command: ResolvedCommand): CommandTreeItem {
        const disabled = command.enabled === false;
        const result = this.autoResults.get(command.name);
        const running = this.runningAutoNames.has(command.name);

        const item = new CommandTreeItem(
            command.name,
            vscode.TreeItemCollapsibleState.None,
            command.name,   // informational; the row runs via explicit args
        );
        item.id = command.name;
        item.contextValue = disabled ? 'autoCommand.disabled' : 'autoCommand';
        item.iconPath = buildRowIcon(
            disabled ? undefined : command.color,
            disabled ? undefined : (result?.status ?? 'unknown'),
        );
        item.description = disabled ? 'disabled' : buildAutoDescription(result, running);
        item.tooltip = buildAutoTooltip(
            command, result, running,
            this.options.getNextRunAtMilliseconds?.(command.name),
        );
        // Row click / Enter runs the command now instead of opening details.
        // Disabled rows have no action; the context menu is the way back.
        item.command = disabled ? undefined : {
            command: 'powerGlove.auto.runNow',
            title: 'Run Now',
            arguments: [command.name],
        };
        return item;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a rich Markdown tooltip showing description and the final shell
 *  command that will be sent to the terminal. */
function buildTooltip(cmd: ResolvedCommand): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    appendCommandTooltipHeader(md, cmd.name, cmd.description);
    if (cmd.enabled === false) {
        md.appendMarkdown('_DISABLED_ \u2014 use "Enable Command" in the context menu to activate it again.\n\n');
    }
    md.appendMarkdown(`---\n\`\`\`shell\n${cmd.finalShellCommand}\n\`\`\``);
    return md;
}

/** Escape basic Markdown special characters so command content doesn't
 *  accidentally break the tooltip formatting. */
function escapeMarkdown(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}

/** "1 command" / "N commands" - used by the group and Auto Run headers. */
function describeCommandCount(count: number): string {
    return `${count} command${count !== 1 ? 's' : ''}`;
}

/** Append the "**name**" + description header every command tooltip starts
 *  with, each part followed by the blank line that separates Markdown blocks. */
function appendCommandTooltipHeader(
    markdown: vscode.MarkdownString,
    name: string,
    description: string | undefined,
): void {
    markdown.appendMarkdown(`**${escapeMarkdown(name)}**\n\n`);
    if (description) {
        markdown.appendMarkdown(`${escapeMarkdown(description)}\n\n`);
    }
}

/** Build the icon shown at the start of every command row. The full-height
 *  bar hugging the right edge uses the command's color (transparent when none
 *  is set); auto rows put the result dot (red / yellow / green, or a hollow
 *  ring while unknown) on the left. A base64 data-URI SVG is used because
 *  ThemeIcon cannot render arbitrary user-picked colors; only pre-validated
 *  hex values reach this function (see normalizeColor in resolver.ts). The
 *  fixed grays are deliberate: SVG data URIs cannot read VS Code theme
 *  colors, and these read acceptably on light and dark themes. */
function buildRowIcon(color: string | undefined, status: AutoRunStatus | undefined): vscode.Uri {
    const square = color
        ? `fill="${color}" stroke="#808080" stroke-opacity="0.25"`
        : 'fill="#8b949e" fill-opacity="0.0"';
    // Every row icon lives in a fixed 16px slot (VS Code scales the image to
    // 16px wide): the status dot sits on the left, and the color bar hugs the
    // right edge as a full-height accent.
    let shapes: string;
    if (status === undefined) {
        shapes =
            `<rect x="12.0" y="1.0" width="4" height="14" rx="1.25" ${square}/>`;
    } else {
        const dot = status === 'unknown'
            ? '<circle cx="4.5" cy="8" r="4.5" fill="none" stroke="#8b949e" stroke-width="1.25"/>'
            : `<circle cx="4.5" cy="8" r="4.5" fill="${STATUS_DOT_FILL[status]}"/>`;
        shapes =
            dot + `<rect x="12.0" y="1.0" width="4" height="14" rx="1.25" ${square}/>`;
    }
    const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
        `${shapes}</svg>`;
    const base64 = Buffer.from(svg, 'utf8').toString('base64');
    return vscode.Uri.parse(`data:image/svg+xml;base64,${base64}`);
}

// Show only the last result message on an auto row; the command's own
// description lives in the tooltip so the row stays focused on status.
function buildAutoDescription(
    result: AutoRunResult | undefined,
    running: boolean,
): string | undefined {
    if (running) { return 'running…'; }
    return result?.message || undefined;
}

// Build the hover tooltip for an auto row: interval, next scheduled run,
// last verdict and its messages, plus the resolved shell command for
// troubleshooting.
function buildAutoTooltip(
    command: ResolvedCommand,
    result: AutoRunResult | undefined,
    running: boolean,
    nextRunAtMilliseconds?: number,
): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString();
    appendCommandTooltipHeader(markdown, command.name, command.description);
    if (command.enabled === false) {
        markdown.appendMarkdown('Disabled — enable it from the context menu to run it again.\n\n');
    }
    markdown.appendMarkdown(
        `Runs every ${formatIntervalLabel(command.autoRunIntervalMinutes, command.autoRunIntervalMaxMinutes)}.\n\n`,
    );
    if (!running && command.enabled !== false && nextRunAtMilliseconds !== undefined) {
        markdown.appendMarkdown(`Next run: ${formatNextRun(nextRunAtMilliseconds)}\n\n`);
    }
    if (running) {
        markdown.appendMarkdown('Status: running…\n\n');
    } else if (result) {
        const verdict = result.invalid ? 'unknown (invalid output)' : result.status;
        markdown.appendMarkdown(`Status: ${verdict}\n\n`);
        if (result.message) {
            markdown.appendMarkdown(`Result: ${escapeMarkdown(result.message)}\n\n`);
        }
        if (result.popupMessage) {
            markdown.appendMarkdown(`Popup: ${escapeMarkdown(result.popupMessage)}\n\n`);
        }
        markdown.appendMarkdown(`Last run: ${new Date(result.finishedAt).toLocaleString()}\n\n`);
    } else {
        markdown.appendMarkdown('Status: waiting for the first run…\n\n');
    }
    markdown.appendMarkdown(`---\n\`\`\`shell\n${command.finalShellCommand}\n\`\`\``);
    return markdown;
}

// Render an interval as "5 min", "30 s", or "1-3 min (random)". Sub-minute
// values are shown in seconds so "0.5" reads as "30 s" instead.
function formatIntervalLabel(
    minimumMinutes: number | undefined,
    maximumMinutes: number | undefined,
): string {
    if (minimumMinutes === undefined) { return '?'; }
    const asText = (minutes: number): string =>
        minutes < 1 ? `${Math.round(minutes * 60)} s` : `${minutes} min`;
    if (maximumMinutes !== undefined && maximumMinutes !== minimumMinutes) {
        return `${asText(minimumMinutes)}-${asText(maximumMinutes)} (random)`;
    }
    return asText(minimumMinutes);
}

// Render the next scheduled run for the tooltip: local time plus a coarse
// countdown. The seconds part is rounded to 5 s and the extension only
// re-renders rows every ~15 s, so treat the "~" as an order of magnitude.
function formatNextRun(nextRunAtMilliseconds: number): string {
    const remainingSeconds = Math.max(0, Math.round((nextRunAtMilliseconds - Date.now()) / 1000));
    const time = new Date(nextRunAtMilliseconds).toLocaleTimeString();
    if (remainingSeconds >= 90) {
        return `${time} (~${Math.round(remainingSeconds / 60)} min)`;
    }
    return `${time} (~${Math.max(5, Math.round(remainingSeconds / 5) * 5)} s)`;
}
