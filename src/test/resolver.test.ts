// This file unit-tests the pure resolver in src/resolver.ts.
// - Exercises machine show/hide filtering, project-substring matching,
//   <KEY> override substitution (incl. repeated and missing placeholders),
//   Windows vs POSIX shell building, description handling, color
//   validation, command type and auto-run interval resolution,
//   invalid-input skipping, and ordering guarantees.
// - Has no vscode interaction; runs as plain Mocha inside the extension
//   host alongside the activation tests.

import * as assert from 'assert';
import { CommandConfig } from '../types';
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

    test('normalizes valid hex colors for resolved commands', () => {
        const out = resolveCommands(
            [
                makeCmd({ name: 'upper', color: '  #E5484D ' }),
                makeCmd({ name: 'short', color: '#AbC' }),
            ],
            opts(),
        );
        assert.strictEqual(out[0].color, '#e5484d');
        assert.strictEqual(out[1].color, '#abc');
    });

    test('drops malformed colors instead of failing resolution', () => {
        const out = resolveCommands(
            [
                makeCmd({ name: 'named', color: 'red' }),
                makeCmd({ name: 'noHash', color: 'ff0000' }),
                makeCmd({ name: 'tooLong', color: '#ff0000aa' }),
            ],
            opts(),
        );
        assert.strictEqual(out.length, 3);
        assert.ok(out.every((r) => r.color === undefined), 'expected invalid colors to be dropped');
    });

    test('defaults the command type to manual and drops the interval', () => {
        const [r] = resolveCommands([makeCmd({ autoRunIntervalMinutes: 10 })], opts());
        assert.strictEqual(r.type, 'manual');
        assert.strictEqual(r.autoRunIntervalMinutes, undefined);
        assert.strictEqual(r.autoRunIntervalMaxMinutes, undefined);
    });

    test('resolves auto commands with a validated interval', () => {
        const out = resolveCommands(
            [
                makeCmd({ name: 'default', type: 'auto' }),
                makeCmd({ name: 'custom', type: 'auto', autoRunIntervalMinutes: 15.7 }),
                makeCmd({ name: 'bad', type: 'auto', autoRunIntervalMinutes: 0 }),
            ],
            opts(),
        );
        assert.strictEqual(out[0].type, 'auto');
        assert.strictEqual(out[0].autoRunIntervalMinutes, 5);
        assert.strictEqual(out[0].autoRunIntervalMaxMinutes, 5);
        assert.strictEqual(out[1].autoRunIntervalMinutes, 15.7);
        assert.strictEqual(out[1].autoRunIntervalMaxMinutes, 15.7);
        assert.strictEqual(out[2].autoRunIntervalMinutes, 5);
        assert.strictEqual(out[2].autoRunIntervalMaxMinutes, 5);
    });

    test('supports random auto-run intervals given as [min, max]', () => {
        const out = resolveCommands(
            [
                makeCmd({ name: 'range', type: 'auto', autoRunIntervalMinutes: [1, 3] }),
                makeCmd({ name: 'swapped', type: 'auto', autoRunIntervalMinutes: [3, 1] }),
                makeCmd({ name: 'badRange', type: 'auto', autoRunIntervalMinutes: [0, 3] }),
            ],
            opts(),
        );
        assert.strictEqual(out[0].autoRunIntervalMinutes, 1);
        assert.strictEqual(out[0].autoRunIntervalMaxMinutes, 3);
        assert.strictEqual(out[1].autoRunIntervalMinutes, 1);
        assert.strictEqual(out[1].autoRunIntervalMaxMinutes, 3);
        assert.strictEqual(out[2].autoRunIntervalMinutes, 5);
        assert.strictEqual(out[2].autoRunIntervalMaxMinutes, 5);
    });

    test('supports fractional (sub-minute) intervals', () => {
        const out = resolveCommands(
            [
                makeCmd({ name: 'half', type: 'auto', autoRunIntervalMinutes: 0.5 }),
                makeCmd({ name: 'tiny', type: 'auto', autoRunIntervalMinutes: 0.05 }),
                makeCmd({ name: 'fractionRange', type: 'auto', autoRunIntervalMinutes: [0.5, 1.5] }),
            ],
            opts(),
        );
        assert.strictEqual(out[0].autoRunIntervalMinutes, 0.5);
        assert.strictEqual(out[0].autoRunIntervalMaxMinutes, 0.5);
        assert.strictEqual(out[1].autoRunIntervalMinutes, 5, 'below the 0.1 minimum falls back to the default');
        assert.strictEqual(out[2].autoRunIntervalMinutes, 0.5);
        assert.strictEqual(out[2].autoRunIntervalMaxMinutes, 1.5);
    });
});
