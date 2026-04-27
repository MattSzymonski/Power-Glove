// This file unit-tests the pure resolver in src/resolver.ts.
// - Exercises machine show/hide filtering, project-substring matching,
//   <KEY> override substitution (incl. repeated and missing placeholders),
//   Windows vs POSIX shell building, description handling, invalid-input
//   skipping, and ordering guarantees.
// - Has no vscode interaction; runs as plain Mocha inside the extension
//   host alongside the activation tests.

import * as assert from 'assert';
import { CommandConfig } from '../config';
import { resolveCommands, ResolverOptions } from '../resolver';

function opts(overrides: Partial<ResolverOptions> = {}): ResolverOptions {
    return {
        machineName: 'HOST-A',
        isWindows: false,
        workspacePaths: [],
        ...overrides,
    };
}

function makeCmd(partial: Partial<CommandConfig>): CommandConfig {
    return {
        name: 'cmd',
        command: 'echo hi',
        machineSettings: [{ machineName: 'HOST-A', show: true }],
        ...partial,
    };
}

suite('resolveCommands', () => {
    test('skips commands with no matching machine setting', () => {
        const out = resolveCommands(
            [makeCmd({ machineSettings: [{ machineName: 'OTHER', show: true }] })],
            opts(),
        );
        assert.strictEqual(out.length, 0);
    });

    test('skips commands when machine setting has show: false', () => {
        const out = resolveCommands(
            [makeCmd({ machineSettings: [{ machineName: 'HOST-A', show: false }] })],
            opts(),
        );
        assert.strictEqual(out.length, 0);
    });

    test('treats omitted "show" as visible', () => {
        const out = resolveCommands(
            [makeCmd({ machineSettings: [{ machineName: 'HOST-A' }] })],
            opts(),
        );
        assert.strictEqual(out.length, 1);
    });

    test('keeps commands with empty project regardless of workspace', () => {
        const out = resolveCommands([makeCmd({ project: '' })], opts({ workspacePaths: [] }));
        assert.strictEqual(out.length, 1);
    });

    test('filters commands by project substring against workspace paths', () => {
        const cmd = makeCmd({ project: 'pill-engine' });
        assert.strictEqual(
            resolveCommands([cmd], opts({ workspacePaths: ['/work/pill-engine'] })).length,
            1,
        );
        assert.strictEqual(
            resolveCommands([cmd], opts({ workspacePaths: ['/work/other'] })).length,
            0,
        );
        assert.strictEqual(
            resolveCommands([cmd], opts({ workspacePaths: [] })).length,
            0,
        );
    });

    test('applies overrides to command and directory', () => {
        const cmd = makeCmd({
            command: 'run --env <ENV> --port <PORT>',
            directory: '/srv/<ENV>',
            machineSettings: [{
                machineName: 'HOST-A',
                show: true,
                overrides: [
                    { key: 'ENV', value: 'staging' },
                    { key: 'PORT', value: '8080' },
                ],
            }],
        });
        const [r] = resolveCommands([cmd], opts());
        assert.strictEqual(r.command, 'run --env staging --port 8080');
        assert.strictEqual(r.directory, '/srv/staging');
    });

    test('replaces all occurrences of a placeholder', () => {
        const cmd = makeCmd({
            command: '<X>-<X>-<X>',
            machineSettings: [{
                machineName: 'HOST-A', show: true,
                overrides: [{ key: 'X', value: 'a' }],
            }],
        });
        const [r] = resolveCommands([cmd], opts());
        assert.strictEqual(r.command, 'a-a-a');
    });

    test('leaves unknown placeholders untouched and logs them', () => {
        const logged: string[] = [];
        const cmd = makeCmd({ command: 'echo <MISSING>' });
        const [r] = resolveCommands([cmd], opts({ logger: (m) => logged.push(m) }));
        assert.strictEqual(r.command, 'echo <MISSING>');
        assert.ok(logged.some((m) => m.includes('<MISSING>')), 'expected missing placeholder log');
    });

    test('builds Windows shell command with cd /d when directory is set', () => {
        const cmd = makeCmd({ directory: 'C:\\work', command: 'npm test' });
        const [r] = resolveCommands([cmd], opts({ isWindows: true }));
        assert.strictEqual(r.finalShellCommand, 'cd /d "C:\\work" && npm test');
    });

    test('builds POSIX shell command with cd when directory is set', () => {
        const cmd = makeCmd({ directory: '/home/u', command: 'make' });
        const [r] = resolveCommands([cmd], opts({ isWindows: false }));
        assert.strictEqual(r.finalShellCommand, 'cd "/home/u" && make');
    });

    test('omits cd prefix when directory is empty/whitespace', () => {
        const cmd1 = makeCmd({ directory: '', command: 'ls' });
        const cmd2 = makeCmd({ directory: '   ', command: 'ls' });
        assert.strictEqual(resolveCommands([cmd1], opts())[0].finalShellCommand, 'ls');
        assert.strictEqual(resolveCommands([cmd2], opts())[0].finalShellCommand, 'ls');
    });

    test('propagates description (trimmed) to resolved command', () => {
        const [r] = resolveCommands(
            [makeCmd({ description: '  builds the thing  ' })],
            opts(),
        );
        assert.strictEqual(r.description, 'builds the thing');
    });

    test('defaults description to empty string when missing', () => {
        const [r] = resolveCommands([makeCmd({})], opts());
        assert.strictEqual(r.description, '');
    });

    test('skips invalid entries (missing name or command)', () => {
        const logged: string[] = [];
        const bad: any[] = [
            null,
            { command: 'echo' },
            { name: 'no-cmd' },
            { name: 'ok', command: 'echo', machineSettings: [{ machineName: 'HOST-A', show: true }] },
        ];
        const out = resolveCommands(bad as CommandConfig[], opts({ logger: (m) => logged.push(m) }));
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].name, 'ok');
        assert.ok(logged.length >= 2, 'expected logs for skipped invalid entries');
    });

    test('handles commands with no machineSettings array', () => {
        const out = resolveCommands(
            [{ name: 'x', command: 'echo' } as CommandConfig],
            opts(),
        );
        assert.strictEqual(out.length, 0);
    });

    test('preserves order of input commands in output', () => {
        const cmds = ['a', 'b', 'c', 'd'].map((n) => makeCmd({ name: n }));
        const out = resolveCommands(cmds, opts());
        assert.deepStrictEqual(out.map((r) => r.name), ['a', 'b', 'c', 'd']);
    });

    test('project filter matches against any of multiple workspace folders', () => {
        const cmd = makeCmd({ project: 'svc' });
        const out = resolveCommands(
            [cmd],
            opts({ workspacePaths: ['/work/web', '/work/payments-svc'] }),
        );
        assert.strictEqual(out.length, 1);
    });
});
