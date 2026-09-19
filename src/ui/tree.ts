// This file implements Power Glove's sidebar tree view, similar to the
// Timeline or Outline panels in VS Code. It displays resolved commands
// grouped by project with inline action buttons.
//
// - CommandsTreeDataProvider implements vscode.TreeDataProvider, grouping
//   commands by their `project` field under collapsible folder headers.
// - CommandTreeItem is a thin TreeItem subclass that carries the minimum
//   identity fields (commandName, groupName) so inline command handlers can
//   look up the full ResolvedCommand from the provider's internal map.
// - The provider exposes getResolvedCommand(name) so the extension entry
//   point can wire up the three inline actions:
//     ▶ Run in current terminal
//     ▣ Run in new terminal
//     ⓘ Show command details

import * as vscode from 'vscode';
import { ResolvedCommand } from '../resolver';

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

    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------

    /** Replace the entire dataset and refresh the tree. Called on activation,
     *  config changes, and workspace-folder changes. */
    refresh(commands: ResolvedCommand[]): void {
        this.resolvedCommands = commands;
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

        this._onDidChangeTreeData.fire();
    }

    /** Look up a ResolvedCommand by its name. Returns undefined when the
     *  command is no longer in the current resolved set (stale click, etc.). */
    getResolvedCommand(name: string): ResolvedCommand | undefined {
        return this.commandMap.get(name);
    }

    // ---------------------------------------------------------------------------
    // TreeDataProvider implementation
    // ---------------------------------------------------------------------------

    getTreeItem(element: CommandTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: CommandTreeItem): CommandTreeItem[] {
        // Root level → one folder item per project group.
        if (!element) {
            return this.groupOrder.map((group) => {
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
                item.iconPath = new vscode.ThemeIcon('terminal');
                item.description = cmd.description || undefined;
                item.tooltip = buildTooltip(cmd);
                item.contextValue = 'command';
                // id is the stable key used by inline-action handlers to
                // recover the ResolvedCommand from the provider's map.
                item.id = cmd.name;

                // Default click (Enter / single-click) → run in current terminal.
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
