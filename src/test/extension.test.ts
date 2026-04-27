// This file is the activation smoke test for the Power Glove extension.
// - Verifies the extension is discovered by VS Code, activates without
//   error, and registers all expected commands in the command registry.
// - Runs inside the @vscode/test-cli extension host (vscode-test).

import * as assert from 'assert';
import * as vscode from 'vscode';

const EXT_ID = 'undefined_publisher.power-glove';

const EXPECTED_COMMANDS = [
	'powerGlove.openUI',
	'powerGlove.openManager',
	'powerGlove.runInCurrentTerminal',
	'powerGlove.runInNewTerminal',
];

suite('Power Glove · activation', () => {
	test('extension is present', () => {
		const ext = vscode.extensions.getExtension(EXT_ID);
		assert.ok(ext, `extension ${EXT_ID} not found`);
	});

	test('extension activates without error', async () => {
		const ext = vscode.extensions.getExtension(EXT_ID);
		assert.ok(ext);
		await ext!.activate();
		assert.strictEqual(ext!.isActive, true);
	});

	test('all expected commands are registered', async () => {
		await vscode.extensions.getExtension(EXT_ID)?.activate();
		const all = await vscode.commands.getCommands(true);
		for (const c of EXPECTED_COMMANDS) {
			assert.ok(all.includes(c), `command not registered: ${c}`);
		}
	});
});
