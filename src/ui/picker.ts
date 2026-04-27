// This file renders Power Glove's status-bar QuickPick command picker.
// - Builds a vscode.QuickPick from ResolvedCommand entries grouped by
//   project (with a leading "(general)" group) using separator items.
// - Exposes per-item buttons to run in the current or a new terminal,
//   plus a title-bar gear button that opens the Commands Manager.
// - Default activation (Enter) runs the selected command in the current
//   terminal; matching is enabled across description and detail.

import * as vscode from 'vscode';
import { ResolvedCommand } from '../resolver';
import { runInCurrentTerminal, runInNewTerminal } from '../terminal';

const RUN_CURRENT: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('play'),
    tooltip: 'Run in current terminal',
};

const RUN_NEW: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('terminal-new'),
    tooltip: 'Run in new terminal',
};

const MANAGE: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('gear'),
    tooltip: 'Manage commands…',
};

interface CommandItem extends vscode.QuickPickItem {
    cmd?: ResolvedCommand;
}

// Open the Quick Pick command picker.
// - Builds a grouped item list (by project) from the resolved commands.
// - Wires per-item buttons (run-current / run-new) and the title-bar gear
//   button (manage commands), defaulting Enter to "run in current terminal".
// - When the resolved list is empty, shows a notification with a shortcut to
//   open the Commands Manager instead of an empty picker.
export function showCommandPicker(
    commands: ResolvedCommand[],
    machineName: string,
    onManage?: () => void,
): void {
    // Empty-state branch: nothing to pick from on this machine.
    if (commands.length === 0) {
        const action = 'Manage commands…';
        vscode.window
            .showInformationMessage(
                `Power Glove: no commands available for machine "${machineName}".`,
                action,
            )
            .then((sel) => { if (sel === action) { onManage?.(); } });
        return;
    }

    const qp = vscode.window.createQuickPick<CommandItem>();
    qp.title = `Power Glove  ·  ${machineName}`;
    qp.placeholder = 'Pick a command (Enter = run in current terminal)';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.items = buildItems(commands);
    if (onManage) { qp.buttons = [MANAGE]; }

    // Title-bar gear button: jump to the Commands Manager.
    qp.onDidTriggerButton((btn) => {
        if (btn === MANAGE) { qp.hide(); onManage?.(); }
    });

    // Per-item buttons: dispatch to the matching terminal strategy.
    qp.onDidTriggerItemButton(({ item, button }) => {
        if (!item.cmd) { return; }
        qp.hide();
        (button === RUN_NEW ? runInNewTerminal : runInCurrentTerminal)(item.cmd);
    });

    // Default activation (Enter): run in the current terminal.
    qp.onDidAccept(() => {
        const sel = qp.selectedItems[0];
        if (sel?.cmd) {
            qp.hide();
            runInCurrentTerminal(sel.cmd);
        }
    });

    qp.onDidHide(() => qp.dispose());
    qp.show();
}

// Group resolved commands by their `project` field and emit a flat
// QuickPickItem list with separator headers between groups. Commands without
// a project are placed under a leading "(general)" header.
function buildItems(commands: ResolvedCommand[]): CommandItem[] {
    // Bucket commands by group key.
    const groups = new Map<string, ResolvedCommand[]>();
    for (const c of commands) {
        const key = c.project || '(general)';
        const list = groups.get(key) ?? [];
        list.push(c);
        groups.set(key, list);
    }

    // Always show the "(general)" group first; sort the rest alphabetically.
    const sortedKeys = [...groups.keys()].sort((a, b) => {
        if (a === '(general)') { return -1; }
        if (b === '(general)') { return 1; }
        return a.localeCompare(b);
    });

    // Emit a separator + the bucket's items for each group.
    const items: CommandItem[] = [];
    for (const key of sortedKeys) {
        items.push({ label: key, kind: vscode.QuickPickItemKind.Separator });
        for (const c of groups.get(key)!) {
            items.push({
                label: `$(zap) ${c.name}`,
                description: c.description || undefined,
                detail: truncate(c.finalShellCommand, 240),
                cmd: c,
                buttons: [RUN_CURRENT, RUN_NEW],
            });
        }
    }
    return items;
}

// Trim a string to `max` characters, appending a single-character ellipsis
// when truncated. Used to keep the QuickPick item `detail` line readable.
function truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
