// This file runs Power Glove "auto" commands in the background and turns
// their output into sidebar status.
// - parseAutoRunOutput() validates one stdout stream against the command
//   contract: a line "<COLOR>|<RESULT_MESSAGE>|<POPUP_MESSAGE>" where COLOR
//   is red, yellow or green (case-insensitive); the last valid line wins.
// - AutoRunEngine schedules every auto command on its own interval (a fixed
//   delay or a random one inside a configured range), executes the resolved
//   shell command, and reports start/finish callbacks so the sidebar row
//   can refresh while the run is in flight and afterwards.
// - shouldShowPopup() decides whether a finished run notifies, honoring the
//   per-command popup policy ('always' / 'onChange' / 'never'); 'onChange'
//   is the default so a repeating condition does not notify on every tick.
// - Failed runs (process error or no valid status line) are retried once
//   when the command sets "retryOnFailure": true.
// - getNextRunAtMilliseconds() exposes when each command runs next, which
//   the tree tooltip renders as a countdown.
// - A per-command "timeoutSeconds" overrides the default 120 s kill timer.
// - Non-empty popup messages raise a VS Code notification; the severity
//   follows the color: green -> information, yellow -> warning, red -> error.

import * as vscode from 'vscode';
import { exec } from 'child_process';
import {
    DEFAULT_POPUP_POLICY,
    DEFAULT_TIMEOUT_SECONDS,
    ResolvedCommand,
} from './resolver';
import { PopupPolicy } from './types';

export type AutoRunStatus = 'green' | 'yellow' | 'red' | 'unknown';

export interface AutoRunResult {
    status: AutoRunStatus;
    message: string;
    popupMessage: string;
    finishedAt: number;
    /** True when stdout contained no parseable "<COLOR>|..." line. */
    invalid?: boolean;
}

export interface ParsedAutoRunOutput {
    status: AutoRunStatus;
    message: string;
    popupMessage: string;
}

/** Last valid verdict of one command, used by the 'onChange' popup policy. */
export interface AutoRunPopupState {
    status: AutoRunStatus;
    popupMessage: string;
}

// Pure popup decision, exported for unit tests. An empty popup message never
// notifies; 'never' always suppresses; 'always' notifies on every non-empty
// message; 'onChange' (the default) notifies only when the status or the
// popup message differs from the last valid run.
export function shouldShowPopup(
    policy: PopupPolicy,
    previous: AutoRunPopupState | undefined,
    current: AutoRunPopupState,
): boolean {
    if (!current.popupMessage || policy === 'never') { return false; }
    if (policy === 'always') { return true; }
    return previous === undefined ||
        previous.status !== current.status ||
        previous.popupMessage !== current.popupMessage;
}

// Scan stdout for the command contract and return the LAST valid line, so a
// script may print logging or warnings before its final status line. Missing
// message fields are allowed and become empty strings; a stream with no valid
// line returns undefined, which the engine reports as an invalid result.
export function parseAutoRunOutput(stdout: string): ParsedAutoRunOutput | undefined {
    const lines = stdout.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index].trim();
        if (!line) { continue; }
        const segments = line.split('|');
        const color = (segments[0] ?? '').trim().toLowerCase();
        if (color !== 'green' && color !== 'yellow' && color !== 'red') { continue; }
        return {
            status: color,
            message: (segments[1] ?? '').trim(),
            popupMessage: (segments[2] ?? '').trim(),
        };
    }
    return undefined;
}

export interface AutoRunEngineOptions {
    /** Current auto commands; re-read on every resync so edits take effect. */
    getCommands: () => ResolvedCommand[];
    /** Diagnostics sink (the Power Glove output channel). */
    logger: (message: string) => void;
    /** Called when a command starts running (drives the "running" hint). */
    onRunStarted: (name: string) => void;
    /** Called when a command finished, with its parsed result. */
    onRunFinished: (name: string, result: AutoRunResult) => void;
}

/** Delay before the single retry of a failed run (retryOnFailure). */
const RETRY_DELAY_MILLISECONDS = 3_000;

/** Output cap; longer stdout would otherwise be truncated by Node. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

// Schedules and executes auto commands. One interval per command; the engine
// never runs the same command twice concurrently, and rebuilds all timers on
// resync() so configuration changes apply without an extension reload.
export class AutoRunEngine {
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private readonly runningCommands = new Set<string>();
    private readonly knownCommands = new Set<string>();
    // When each scheduled command fires next (epoch ms); rendered by the
    // tree tooltip as a countdown and rebuilt on every resync.
    private readonly nextRunAtMilliseconds = new Map<string, number>();
    // Last verdict per command, consulted by the 'onChange' popup policy.
    private readonly lastPopupStates = new Map<string, AutoRunPopupState>();
    // Pending retry timers, kept apart from `timers` so a retry can never
    // displace the command's regular schedule.
    private readonly retryTimers = new Set<NodeJS.Timeout>();
    private disposed = false;

    constructor(private readonly options: AutoRunEngineOptions) {}

    // Rebuild every timer from the current command list. Commands seen for
    // the first time in this session (including all commands right after
    // activation) run immediately so their row is not stuck on "unknown".
    resync(): void {
        for (const timer of this.timers.values()) { clearTimeout(timer); }
        this.timers.clear();
        for (const timer of this.retryTimers) { clearTimeout(timer); }
        this.retryTimers.clear();
        this.nextRunAtMilliseconds.clear();

        // Drop engine-side state for commands that no longer exist (renames,
        // deletions), mirroring the tree's result pruning: a stale popup
        // baseline must not suppress the next notification, and a re-added
        // command runs immediately again like any other first sighting.
        const currentNames = new Set(this.options.getCommands().map((c) => c.name));
        for (const name of [...this.knownCommands]) {
            if (!currentNames.has(name)) { this.knownCommands.delete(name); }
        }
        for (const name of [...this.lastPopupStates.keys()]) {
            if (!currentNames.has(name)) { this.lastPopupStates.delete(name); }
        }

        for (const command of this.options.getCommands()) {
            if (command.enabled === false) { continue; }
            if (typeof command.autoRunIntervalMinutes !== 'number') { continue; }
            const isFirstSighting = !this.knownCommands.has(command.name);
            this.knownCommands.add(command.name);
            if (isFirstSighting) { this.runCommand(command.name); }
            this.scheduleNextRun(command.name);
        }
    }

    /** When the next scheduled background run of `name` fires (epoch ms), or
     *  undefined when the command is not scheduled (manual, disabled, or no
     *  interval configured). */
    getNextRunAtMilliseconds(name: string): number | undefined {
        return this.nextRunAtMilliseconds.get(name);
    }

    // Arm the next background run. A fixed interval re-arms with the same
    // delay; a [min, max] range re-arms with a fresh random delay each time,
    // so periodic checks neither sync up nor hit an API on a fixed cadence.
    private scheduleNextRun(name: string): void {
        if (this.disposed) { return; }
        const command = this.options.getCommands().find((c) => c.name === name);
        if (!command || command.enabled === false || typeof command.autoRunIntervalMinutes !== 'number') { return; }
        const minimumMinutes = command.autoRunIntervalMinutes;
        const maximumMinutes = command.autoRunIntervalMaxMinutes ?? minimumMinutes;
        const delayMilliseconds =
            (minimumMinutes + Math.random() * (maximumMinutes - minimumMinutes)) * 60_000;
        this.nextRunAtMilliseconds.set(name, Date.now() + delayMilliseconds);
        this.timers.set(name, setTimeout(() => {
            this.runCommand(name);
            this.scheduleNextRun(name);
        }, delayMilliseconds));
    }

    // Run one auto command now (tree "run now" click, or an interval tick).
    runCommand(name: string): void {
        if (this.disposed || this.runningCommands.has(name)) { return; }
        const command = this.options.getCommands().find((c) => c.name === name);
        if (!command || command.enabled === false) { return; }
        this.executeCommand(command, 0);
    }

    // Start one execution attempt of `command`. `attempt` is 0 for the
    // regular run and 1 for the automatic retry, so a run can never retry
    // more than once.
    private executeCommand(command: ResolvedCommand, attempt: number): void {
        const name = command.name;
        this.runningCommands.add(name);
        this.options.onRunStarted(name);
        this.options.logger(`auto run started: ${name}${attempt > 0 ? ' (retry)' : ''}`);
        // Auto runs start from the first workspace folder (or the extension
        // host's directory when no folder is open); the resolved command's
        // own `cd` prefix still wins when a directory is configured.
        exec(
            command.finalShellCommand,
            {
                cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
                timeout: (command.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
                windowsHide: true,
                maxBuffer: MAX_OUTPUT_BYTES,
            },
            (error, stdout, stderr) => this.handleExecutionFinished(command, attempt, error, stdout, stderr),
        );
    }

    // Run every currently configured auto command once.
    runAll(): void {
        for (const command of this.options.getCommands()) {
            this.runCommand(command.name);
        }
    }

    dispose(): void {
        this.disposed = true;
        for (const timer of this.timers.values()) { clearTimeout(timer); }
        this.timers.clear();
        for (const timer of this.retryTimers) { clearTimeout(timer); }
        this.retryTimers.clear();
    }

    // Parse a finished run and report the result. stdout wins when it holds a
    // valid status line; otherwise the run counts as failed: it is retried
    // once when the command sets retryOnFailure, and finally reported as an
    // invalid-output placeholder with the first stderr / error line logged.
    private handleExecutionFinished(
        command: ResolvedCommand,
        attempt: number,
        error: Error | null,
        stdout: string,
        stderr: string,
    ): void {
        const name = command.name;
        this.runningCommands.delete(name);
        if (this.disposed) { return; }

        const parsed = parseAutoRunOutput(stdout);
        if (parsed) {
            this.options.logger(
                `auto run finished: ${name} -> ${parsed.status}` +
                (parsed.message ? ` (${parsed.message})` : ''),
            );
            this.options.onRunFinished(name, { ...parsed, finishedAt: Date.now() });
            this.maybeShowPopup(command, parsed);
            return;
        }

        const firstDetailLine = (stderr || error?.message || stdout || '')
            .trim()
            .split(/\r?\n/)[0] ?? '';
        this.options.logger(
            `auto run finished: ${name} -> invalid output` +
            (firstDetailLine ? `: ${firstDetailLine}` : ''),
        );

        // One retry for transient failures (flaky network, slow startup).
        // The row keeps showing "running…" until the retry settles, so only
        // the verdict pair's final outcome is reported.
        if (attempt === 0 && command.retryOnFailure === true) {
            this.options.logger(`auto run retrying: ${name}`);
            const retryTimer = setTimeout(() => {
                this.retryTimers.delete(retryTimer);
                if (this.disposed) { return; }
                const current = this.options.getCommands().find((c) => c.name === name);
                if (current && current.enabled !== false) { this.executeCommand(current, 1); }
            }, RETRY_DELAY_MILLISECONDS);
            this.retryTimers.add(retryTimer);
            return;
        }

        this.options.onRunFinished(name, {
            status: 'unknown',
            message: 'invalid output',
            popupMessage: '',
            finishedAt: Date.now(),
            invalid: true,
        });
    }

    // Raise a notification when the command's popup policy allows it. The
    // last verdict is remembered either way, so a status that flips back
    // later counts as a change and notifies again.
    private maybeShowPopup(command: ResolvedCommand, parsed: ParsedAutoRunOutput): void {
        const previous = this.lastPopupStates.get(command.name);
        const current: AutoRunPopupState = {
            status: parsed.status,
            popupMessage: parsed.popupMessage,
        };
        this.lastPopupStates.set(command.name, current);
        const policy = command.popupPolicy ?? DEFAULT_POPUP_POLICY;
        if (shouldShowPopup(policy, previous, current)) {
            showAutoRunPopup(parsed.status, parsed.popupMessage);
        }
    }
}

// Map the result color onto a notification severity: green is a healthy
// report, yellow a warning, red a problem. The message is shown verbatim so
// the command controls exactly what the user reads.
function showAutoRunPopup(status: AutoRunStatus, message: string): void {
    if (status === 'red') {
        vscode.window.showErrorMessage(message);
    } else if (status === 'yellow') {
        vscode.window.showWarningMessage(message);
    } else if (status === 'green') {
        vscode.window.showInformationMessage(message);
    }
}
