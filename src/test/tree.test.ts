// This file unit-tests the merged sidebar tree provider in src/ui/tree.ts.
// - Verifies the single view renders two sections: manual project groups on
//   top and the "Auto Run" section pinned to the bottom.
// - Covers the auto hint row (no auto commands), status-row content after a
//   result is recorded, row icon composition (color square, divider, status
//   dot / placeholder), result pruning on refresh, and the hidden-section
//   case when the whole view is empty.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { ResolvedCommand } from '../resolver';
import { CommandsTreeDataProvider } from '../ui/tree';

function manualCommand(name: string, project = ''): ResolvedCommand {
    return {
        name, description: `${name} description`, project,
        directory: '', command: 'echo hi', finalShellCommand: 'echo hi',
        type: 'manual',
    };
}

function autoCommand(name: string, intervalMinutes = 5): ResolvedCommand {
    return {
        name, description: `${name} description`, project: '',
        directory: '', command: 'echo auto', finalShellCommand: 'echo auto',
        type: 'auto', autoRunIntervalMinutes: intervalMinutes,
    };
}

// Decode a row's base64 SVG data-URI icon so tests can assert on its content.
// Uri.path is used because Uri.toString() percent-encodes the data-URI
// delimiters ("base64," would arrive as "base64%2C").
function decodeIcon(item: vscode.TreeItem): string {
    const uri = item.iconPath as vscode.Uri;
    return Buffer.from(uri.path.split('base64,')[1] ?? '', 'base64').toString('utf8');
}

suite('CommandsTreeDataProvider sections', () => {
    test('renders project groups on top and Auto Run at the bottom', () => {
        const provider = new CommandsTreeDataProvider();
        provider.refresh([manualCommand('Build')], [autoCommand('Peak')]);

        const roots = provider.getChildren();
        assert.strictEqual(roots.length, 2);
        assert.strictEqual(roots[0].label, '(general)');
        assert.strictEqual(roots[0].contextValue, 'group');
        assert.strictEqual(roots[1].label, 'Auto Run');
        assert.strictEqual(roots[1].contextValue, 'autoSection');
        assert.strictEqual(roots[1].description, '1 command');

        const autoRows = provider.getChildren(roots[1]);
        assert.strictEqual(autoRows.length, 1);
        assert.strictEqual(autoRows[0].label, 'Peak');
        assert.strictEqual(autoRows[0].contextValue, 'autoCommand');
        assert.strictEqual(autoRows[0].description, undefined, 'command description stays out of the row');
        assert.ok(autoRows[0].id, 'auto row has a stable id');
    });

    test('shows a hint row when there are no auto commands', () => {
        const provider = new CommandsTreeDataProvider();
        provider.refresh([manualCommand('Build')], []);

        const section = provider.getChildren().find((item) => item.contextValue === 'autoSection');
        assert.ok(section, 'expected the Auto Run section');
        assert.strictEqual(section.description, 'none');

        const rows = provider.getChildren(section);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].contextValue, 'autoHint');
        assert.strictEqual(rows[0].command?.command, 'powerGlove.openManager');
    });

    test('hides the whole view structure when nothing is configured', () => {
        const provider = new CommandsTreeDataProvider();
        provider.refresh([], []);
        assert.strictEqual(provider.getChildren().length, 0);
    });

    test('reflects results on the row and drops them when the command disappears', () => {
        const provider = new CommandsTreeDataProvider();
        provider.refresh([], [autoCommand('Peak')]);
        provider.setResult('Peak', {
            status: 'red',
            message: 'In peak, 1 h left',
            popupMessage: '',
            finishedAt: Date.now(),
        });

        const section = provider.getChildren()[0];
        const [row] = provider.getChildren(section);
        assert.ok(
            String(row.description).includes('In peak, 1 h left'),
            'row shows the result message',
        );
        assert.ok(
            !String(row.description).includes('Peak description'),
            'command description is not shown in the row',
        );

        // Refreshing without the command must drop its stored result and the
        // section itself once no manual commands remain either.
        provider.refresh([], []);
        assert.strictEqual(provider.getChildren().length, 0);
    });

    test('row icons combine the color square, divider, and status dot', () => {
        const provider = new CommandsTreeDataProvider();
        provider.refresh(
            [{ ...manualCommand('Build'), color: '#12a594' }],
            [{ ...autoCommand('Peak'), color: '#e5484d' }],
        );
        provider.setResult('Peak', {
            status: 'green', message: '', popupMessage: '', finishedAt: Date.now(),
        });

        const [group, autoSection] = provider.getChildren();
        const manualSvg = decodeIcon(provider.getChildren(group)[0]);
        assert.ok(manualSvg.includes('#12a594'), 'manual icon shows the command color');
        assert.ok(manualSvg.includes('#6e7681'), 'manual icon shows the divider');

        const autoSvg = decodeIcon(provider.getChildren(autoSection)[0]);
        assert.ok(autoSvg.includes('#e5484d'), 'auto icon shows the command color');
        assert.ok(autoSvg.includes('#6e7681'), 'auto icon shows the divider');
        assert.ok(autoSvg.includes('#3fb950'), 'auto icon shows the green status dot');
    });

    test('rows without a color use the gray placeholder square', () => {
        const provider = new CommandsTreeDataProvider();
        provider.refresh([manualCommand('Build')], []);

        const [group] = provider.getChildren();
        const svg = decodeIcon(provider.getChildren(group)[0]);
        assert.ok(svg.includes('#8b949e'), 'placeholder gray is drawn');
        assert.ok(svg.includes('#6e7681'), 'divider is drawn');
    });
});
