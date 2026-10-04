// This file implements Power Glove's single sidebar tree view, split into
// two internal sections: the manual commands (grouped by project, on top)
// and the "Auto Run" section (auto commands with their latest background
// result, pinned to the bottom).
//
// - CommandsTreeDataProvider implements vscode.TreeDataProvider for both
//   sections: manual leaves under project group headers, plus one Auto Run
//   section header with a status row per auto command.
// - Every command row icon is a color square (muted placeholder when unset)
//   plus a dark gray divider; auto rows append the red/yellow/green dot.
// - CommandTreeItem is a thin TreeItem subclass that carries the minimum
//   identity fields (commandName, groupName) so inline command handlers can
//   look up the full ResolvedCommand from the provider's internal map.
// - The provider exposes getResolvedCommand(name) so the extension entry
//   point can wire up the default row-click action and the inline actions:
//     row click / Enter -> run in current terminal
//     ▣ run in new terminal (inline button)
//     ⓘ show command details (inline button)
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

// TreeDataProvider that powers the "Power Glove Commands" view in the
// Explorer sidebar. Groups are derived from the `project` field of each
// resolved command; commands with no project land under "(general)".
export class CommandsTreeDataProvider implements vscode.TreeDataProvider<CommandTreeItem> {

    private _onDidChangeTreeData = new vscode.EventEmitter<CommandTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

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
                item.description = `${count} command${count !== 1 ? 's' : ''}`;
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
                const item = new CommandTreeItem(
                    cmd.name,
                    vscode.TreeItemCollapsibleState.None,
                    cmd.name,           // used by handlers for lookup
                    group,              // informational only
                );
                // Same icon grammar as the auto rows, without the status dot:
                // color square (muted placeholder when unset) + divider line.
                item.iconPath = buildRowIcon(cmd.color, undefined);
                item.description = cmd.description || undefined;
                item.tooltip = buildTooltip(cmd);
                item.contextValue = 'command';
                // id is the stable key used by inline-action handlers to
                // recover the ResolvedCommand from the provider's map.
                item.id = cmd.name;

                // Default action: clicking anywhere on the command row (or
                // pressing Enter) runs it in the current terminal. This is why
                // there is no dedicated run-current inline button anymore.
                item.command = {
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
            ? `${this.autoCommands.length} command${this.autoCommands.length !== 1 ? 's' : ''}`
            : 'none';
        item.contextValue = 'autoSection';
        return item;
    }

    // Build one Auto Run row: status dot, name, description + last message.
    private buildAutoItem(command: ResolvedCommand): CommandTreeItem {
        const result = this.autoResults.get(command.name);
        const running = this.runningAutoNames.has(command.name);

        const item = new CommandTreeItem(
            command.name,
            vscode.TreeItemCollapsibleState.None,
            command.name,   // informational; the row runs via explicit args
        );
        item.id = command.name;
        item.contextValue = 'autoCommand';
        item.iconPath = buildRowIcon(command.color, result?.status ?? 'unknown');
        item.description = buildAutoDescription(result, running);
        item.tooltip = buildAutoTooltip(command, result, running);
        // Row click / Enter runs the command now instead of opening details.
        item.command = {
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
    md.appendMarkdown(`**${escapeMarkdown(cmd.name)}**`);
    if (cmd.description) {
        md.appendMarkdown(`\n\n${escapeMarkdown(cmd.description)}`);
    }
    md.appendMarkdown(`\n\n---\n\`\`\`shell\n${cmd.finalShellCommand}\n\`\`\``);
    return md;
}

/** Escape basic Markdown special characters so command content doesn't
 *  accidentally break the tooltip formatting. */
function escapeMarkdown(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}

/** Build the icon shown at the start of every command row. The bar uses
 *  the command's color (a muted placeholder when none is set) and is followed
 *  by a dark gray divider line; auto rows append the result dot (red /
 *  yellow / green, or a hollow ring while unknown). A base64 data-URI SVG is
 *  used because ThemeIcon cannot render arbitrary user-picked colors; only
 *  pre-validated hex values reach this function (see normalizeColor in
 *  resolver.ts). The fixed grays are deliberate: SVG data URIs cannot read
 *  VS Code theme colors, and these read acceptably on light and dark themes. */
function buildRowIcon(color: string | undefined, status: AutoRunStatus | undefined): vscode.Uri {
    const square = color
        ? `fill="${color}" stroke="#808080" stroke-opacity="0.25"`
        : 'fill="#8b949e" fill-opacity="0.0"';
    // Every row icon lives in a fixed 16px slot (VS Code scales the image to
    // 16px wide). The color chip is a slim vertical bar, then the divider,
    // then (auto rows only) the status dot. The bar keeps the divider in the
    // same spot in both sections, so the rows align visually.
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

// Build the hover tooltip for an auto row: interval, last verdict and its
// messages, plus the resolved shell command for troubleshooting.
function buildAutoTooltip(
    command: ResolvedCommand,
    result: AutoRunResult | undefined,
    running: boolean,
): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**${escapeMarkdown(command.name)}**\n\n`);
    if (command.description) {
        markdown.appendMarkdown(`${escapeMarkdown(command.description)}\n\n`);
    }
    const intervalLabel = command.autoRunIntervalMaxMinutes !== undefined &&
            command.autoRunIntervalMaxMinutes !== command.autoRunIntervalMinutes
        ? `${command.autoRunIntervalMinutes}-${command.autoRunIntervalMaxMinutes} min (random)`
        : `${command.autoRunIntervalMinutes} min`;
    markdown.appendMarkdown(`Runs every ${intervalLabel}.\n\n`);
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
