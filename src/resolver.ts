// This file is the pure resolution layer for Power Glove commands.
// - Exports resolveCommands() which transforms raw CommandConfig entries
//   into ResolvedCommand entries ready to run.
// - Filters by machine visibility (machineSettings + show flag) and by
//   project substring against the open workspace folders.
// - Substitutes <KEY> placeholders using per-machine overrides and logs
//   any placeholder left unresolved.
// - Builds the final shell string with a platform-correct cd prefix.
// - Has no `vscode` dependency, which makes it directly unit-testable.

import { CommandConfig, CommandType, MachineSetting, Override } from './types';

export interface ResolvedCommand {
    name: string;
    description: string;
    /** Validated hex color ("#rgb" or "#rrggbb") for the tree row chip;
     *  undefined when the entry has no (valid) color. */
    color?: string;
    /** Trigger mode; 'auto' commands are run by the background engine. */
    type: CommandType;
    /** Lower bound of the background run interval; only set for 'auto'.
     *  Equals autoRunIntervalMaxMinutes when the interval is fixed. */
    autoRunIntervalMinutes?: number;
    /** Upper bound of the background run interval. A value above the minimum
     *  means the next run is scheduled after a random delay in the range. */
    autoRunIntervalMaxMinutes?: number;
    project: string;
    directory: string;
    command: string;
    finalShellCommand: string;
    /** Set when this entry runs a VS Code command instead of a shell command. */
    vscodeCommand?: string;
    /** Arguments passed to `vscodeCommand`, in order. */
    vscodeCommandArgs?: unknown[];
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
//    whose matching entry has show:false; each drop is logged.
//  - Drop entries whose `project` substring isn't found in any open workspace
//    folder path (empty `project` means "always show"); each drop is logged.
//  - Log how many entries survived, so an empty result is traceable.
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
            opts.logger?.(`Skipping ${cmd.name}: not enabled for machine "${opts.machineName}"`);
            continue;
        }

        // Project filter: when set, at least one open folder path must contain it.
        const project = (cmd.project ?? '').trim();
        if (project && !opts.workspacePaths.some((p) => p.includes(project))) {
            opts.logger?.(`Skipping ${cmd.name}: project "${project}" matches no open workspace folder`);
            continue;
        }

        // Apply this machine's overrides to both the command and the cd directory.
        const overrides = setting.overrides ?? [];

        // Validate the optional color chip once. Only hex values survive, so
        // the tree can embed the value into an SVG icon without escaping.
        const color = normalizeColor(cmd.color);

        // Trigger mode and auto-run schedule. Anything that is not explicitly
        // 'auto' stays manual; the interval is only meaningful for auto runs.
        const type: CommandType = cmd.type === 'auto' ? 'auto' : 'manual';
        const autoInterval = type === 'auto'
            ? normalizeAutoRunInterval(cmd.autoRunIntervalMinutes)
            : undefined;

        // A VS Code-command entry never reaches a terminal, so it has neither a
        // cd prefix nor a shell line. Overrides still apply, to its string
        // arguments only, so a per-machine value (an address, a path) is
        // substituted exactly as it is inside a shell command.
        const vscodeCommand = (cmd.vscodeCommand ?? '').trim();
        if (vscodeCommand) {
            const args = (cmd.vscodeCommandArgs ?? []).map((arg) =>
                substituteOverrides(arg, overrides, cmd.name, opts.logger),
            );
            out.push({
                name: cmd.name,
                description: (cmd.description ?? '').trim(),
                color,
                type,
                autoRunIntervalMinutes: autoInterval?.minMinutes,
                autoRunIntervalMaxMinutes: autoInterval?.maxMinutes,
                project,
                directory: '',
                command: '',
                finalShellCommand: describeVscodeCommand(vscodeCommand, args),
                vscodeCommand,
                vscodeCommandArgs: args,
            });
            continue;
        }

        const command = applyOverrides(cmd.command ?? '', overrides, cmd.name, opts.logger);
        const directory = applyOverrides(cmd.directory ?? '', overrides, cmd.name, opts.logger);

        out.push({
            name: cmd.name,
            description: (cmd.description ?? '').trim(),
            color,
            type,
            autoRunIntervalMinutes: autoInterval?.minMinutes,
            autoRunIntervalMaxMinutes: autoInterval?.maxMinutes,
            project,
            directory,
            command,
            finalShellCommand: buildShellCommand(command, directory, opts.isWindows),
        });
    }

    // Report the outcome, so a partial or empty list is self-explanatory in the
    // Power Glove output channel instead of looking like an unreadable file.
    opts.logger?.(`loaded ${out.length} of ${commands.length} commands for machine "${opts.machineName}"`);

    return out;
}

// Minimal shape check used to filter out garbage from user settings. An entry
// needs a name and something to do: either a shell command or a VS Code
// command id.
function isValid(cmd: CommandConfig): boolean {
    if (!cmd || typeof cmd.name !== 'string') { return false; }
    const hasShellCommand = typeof cmd.command === 'string';
    const hasVscodeCommand = typeof cmd.vscodeCommand === 'string' && cmd.vscodeCommand.trim().length > 0;
    return hasShellCommand || hasVscodeCommand;
}

// Validate an optional user-provided color. Only 3- or 6-digit hex values are
// accepted, normalized to lowercase; anything else resolves to undefined so a
// malformed entry degrades to "no chip" instead of leaking into an SVG icon.
export function normalizeColor(value: string | undefined): string | undefined {
    const color = (value ?? '').trim().toLowerCase();
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(color) ? color : undefined;
}

/** Default number of minutes between auto runs when none is configured. */
export const DEFAULT_AUTO_RUN_INTERVAL_MINUTES = 5;

/** Validated auto-run schedule: a fixed interval when both values match,
 *  otherwise a random delay picked between them on every run. */
export interface AutoRunInterval {
    minMinutes: number;
    maxMinutes: number;
}

// Validate the configured auto-run interval: a single number is a fixed
// interval, a [min, max] pair is a random range (whole minutes, at least one,
// order-insensitive). Anything unusable falls back to the default fixed
// interval, so a bad setting can never spin the scheduler into a hot loop.
export function normalizeAutoRunInterval(value: unknown): AutoRunInterval {
    const defaultInterval: AutoRunInterval = {
        minMinutes: DEFAULT_AUTO_RUN_INTERVAL_MINUTES,
        maxMinutes: DEFAULT_AUTO_RUN_INTERVAL_MINUTES,
    };
    if (typeof value === 'number') {
        const minutes = Math.floor(value);
        return minutes >= 1 ? { minMinutes: minutes, maxMinutes: minutes } : defaultInterval;
    }
    if (Array.isArray(value) && value.length === 2) {
        const first = Math.floor(Number(value[0]));
        const second = Math.floor(Number(value[1]));
        if (Number.isFinite(first) && Number.isFinite(second) && first >= 1 && second >= 1) {
            return { minMinutes: Math.min(first, second), maxMinutes: Math.max(first, second) };
        }
    }
    return defaultInterval;
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

// Apply overrides to an argument of any shape: a bare string is substituted
// directly, and strings nested inside plain arrays/objects are substituted in
// place. Structured arguments are the normal case for a VS Code command — the
// VNC connect command takes { label: "host:port" } — so without this a
// per-machine address could not be expressed at all.
// Arguments originate in JSON, so only plain values are encountered here.
function substituteOverrides(
    value: unknown,
    overrides: Override[],
    cmdName: string,
    logger?: (msg: string) => void,
): unknown {
    if (typeof value === 'string') {
        return applyOverrides(value, overrides, cmdName, logger);
    }
    if (Array.isArray(value)) {
        return value.map((item) => substituteOverrides(item, overrides, cmdName, logger));
    }
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            out[key] = substituteOverrides(item, overrides, cmdName, logger);
        }
        return out;
    }
    return value;
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

// Human-readable summary of a VS Code-command entry, shown wherever a shell
// line would otherwise appear (the picker row and the details popup). There is
// no shell equivalent to display, so the command id and its arguments stand in
// for it.
function describeVscodeCommand(commandId: string, args: unknown[]): string {
    const rendered = args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)));
    const suffix = rendered.length > 0 ? ` ${rendered.join(' ')}` : '';
    return `VS Code command: ${commandId}${suffix}`;
}
