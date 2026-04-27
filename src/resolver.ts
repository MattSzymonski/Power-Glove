// This file is the pure resolution layer for Power Glove commands.
// - Exports resolveCommands() which transforms raw CommandConfig entries
//   into ResolvedCommand entries ready to run.
// - Filters by machine visibility (machineSettings + show flag) and by
//   project substring against the open workspace folders.
// - Substitutes <KEY> placeholders using per-machine overrides and logs
//   any placeholder left unresolved.
// - Builds the final shell string with a platform-correct cd prefix.
// - Has no `vscode` dependency, which makes it directly unit-testable.

import { CommandConfig, MachineSetting, Override } from './config';

export interface ResolvedCommand {
    name: string;
    description: string;
    project: string;
    directory: string;
    command: string;
    finalShellCommand: string;
}

export interface ResolverOptions {
    machineName: string;
    isWindows: boolean;
    workspacePaths: string[];
    logger?: (msg: string) => void;
}

// Pure transformation from raw user-config CommandConfig entries to runnable
// ResolvedCommand entries. For each input command:
//  - Drop entries that fail basic shape validation.
//  - Drop entries that have no machineSettings match for the current host, or
//    whose matching entry has show:false.
//  - Drop entries whose `project` substring isn't found in any open workspace
//    folder path (empty `project` means "always show").
//  - Substitute <KEY> placeholders in `command` and `directory` using the
//    matched machine's `overrides`, logging any unresolved placeholders.
//  - Build the final shell string with a platform-correct `cd` prefix.
// Order of input commands is preserved in the output.
export function resolveCommands(
    commands: CommandConfig[],
    opts: ResolverOptions,
): ResolvedCommand[] {
    const out: ResolvedCommand[] = [];

    for (const cmd of commands) {
        // Defensive: skip malformed entries (e.g. missing name/command) and log them.
        if (!isValid(cmd)) {
            opts.logger?.(`Skipping invalid command entry: ${JSON.stringify(cmd)}`);
            continue;
        }

        // Machine visibility gate: must be listed for this host and not hidden.
        const setting = findMachineSetting(cmd.machineSettings, opts.machineName);
        if (!setting || setting.show === false) {
            continue;
        }

        // Project filter: when set, at least one open folder path must contain it.
        const project = (cmd.project ?? '').trim();
        if (project && !opts.workspacePaths.some((p) => p.includes(project))) {
            continue;
        }

        // Apply this machine's overrides to both the command and the cd directory.
        const overrides = setting.overrides ?? [];
        const command = applyOverrides(cmd.command, overrides, cmd.name, opts.logger);
        const directory = applyOverrides(cmd.directory ?? '', overrides, cmd.name, opts.logger);

        out.push({
            name: cmd.name,
            description: (cmd.description ?? '').trim(),
            project,
            directory,
            command,
            finalShellCommand: buildShellCommand(command, directory, opts.isWindows),
        });
    }

    return out;
}

// Minimal shape check used to filter out garbage from user settings.
function isValid(cmd: CommandConfig): boolean {
    return !!cmd && typeof cmd.name === 'string' && typeof cmd.command === 'string';
}

// Look up the MachineSetting whose machineName matches the current host.
// Returns undefined if `settings` is missing/not-an-array or no entry matches.
function findMachineSetting(
    settings: MachineSetting[] | undefined,
    machineName: string,
): MachineSetting | undefined {
    if (!Array.isArray(settings)) { return undefined; }
    return settings.find((s) => s?.machineName === machineName);
}

// Replace every `<KEY>` token in `input` with the matching override value.
// Any `<KEY>` token left without a matching override is logged via the
// supplied logger and left in the output unchanged.
function applyOverrides(
    input: string,
    overrides: Override[],
    cmdName: string,
    logger?: (msg: string) => void,
): string {
    if (!input) { return ''; }

    // Snapshot every placeholder up front so we can detect which ones never
    // get resolved by the override list.
    const placeholders = new Set(input.match(/<[A-Z0-9_]+>/g) ?? []);
    let out = input;

    // Apply each override; split/join replaces all occurrences of a token.
    for (const o of overrides) {
        if (!o || typeof o.key !== 'string') { continue; }
        const token = `<${o.key}>`;
        placeholders.delete(token);
        out = out.split(token).join(o.value ?? '');
    }

    // Whatever remains in `placeholders` was never substituted — warn so the
    // user can spot typos / missing config in the Power Glove output channel.
    for (const ph of placeholders) {
        logger?.(`[${cmdName}] missing override for placeholder ${ph}; left unchanged`);
    }

    return out;
}

// Compose the final shell line: when a directory is set, prefix with the
// platform-correct `cd` so the command runs in that folder. With no directory
// the command is returned unchanged.
function buildShellCommand(command: string, directory: string, isWindows: boolean): string {
    const dir = directory.trim();
    if (!dir) { return command; }
    const cd = isWindows ? `cd /d "${dir}"` : `cd "${dir}"`;
    return `${cd} && ${command}`;
}
