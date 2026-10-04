// This file runs Power Glove "auto" commands in the background and turns
// their output into sidebar status.
// - parseAutoRunOutput() validates one stdout stream against the command
//   contract: a line "<COLOR>|<RESULT_MESSAGE>|<POPUP_MESSAGE>" where COLOR
//   is red, yellow or green (case-insensitive); the last valid line wins.
// - AutoRunEngine schedules every auto command on its own interval (a fixed
//   delay or a random one inside a configured range), executes the resolved
//   shell command, and reports start/finish callbacks so the sidebar row
//   can refresh while the run is in flight and afterwards.
// - Non-empty popup messages raise a VS Code notification; the severity
//   follows the color: green -> information, yellow -> warning, red -> error.

import * as vscode from 'vscode';
import { exec } from 'child_process';
import { ResolvedCommand } from './resolver';

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

/** Safety cap for one background run; a hung command must not pile up. */
const EXECUTION_TIMEOUT_MILLISECONDS = 120_000;

/** Output cap; longer stdout would otherwise be truncated by Node. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

// Schedules and executes auto commands. One interval per command; the engine
// never runs the same command twice concurrently, and rebuilds all timers on
// resync() so configuration changes apply without an extension reload.
export class AutoRunEngine {
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private readonly runningCommands = new Set<string>();
    private readonly knownCommands = new Set<string>();
    private disposed = false;

    constructor(private readonly options: AutoRunEngineOptions) {}

    // Rebuild every timer from the current command list. Commands seen for
    // the first time in this session (including all commands right after
    // activation) run immediately so their row is not stuck on "unknown".
    resync(): void {
        for (const timer of this.timers.values()) { clearTimeout(timer); }
        this.timers.clear();
        for (const command of this.options.getCommands()) {
            if (typeof command.autoRunIntervalMinutes !== 'number') { continue; }
            const isFirstSighting = !this.knownCommands.has(command.name);
            this.knownCommands.add(command.name);
            if (isFirstSighting) { this.runCommand(command.name); }
            this.scheduleNextRun(command.name);
        }
    }

    // Arm the next background run. A fixed interval re-arms with the same
    // delay; a [min, max] range re-arms with a fresh random delay each time,
    // so periodic checks neither sync up nor hit an API on a fixed cadence.
    private scheduleNextRun(name: string): void {
        if (this.disposed) { return; }
        const command = this.options.getCommands().find((c) => c.name === name);
        if (!command || typeof command.autoRunIntervalMinutes !== 'number') { return; }
        const minimumMinutes = command.autoRunIntervalMinutes;
        const maximumMinutes = command.autoRunIntervalMaxMinutes ?? minimumMinutes;
        const delayMilliseconds =
            (minimumMinutes + Math.random() * (maximumMinutes - minimumMinutes)) * 60_000;
        this.timers.set(name, setTimeout(() => {
            this.runCommand(name);
            this.scheduleNextRun(name);
        }, delayMilliseconds));
    }

    // Run one auto command now (tree "run now" click, or an interval tick).
    runCommand(name: string): void {
        if (this.disposed || this.runningCommands.has(name)) { return; }
        const command = this.options.getCommands().find((c) => c.name === name);
        if (!command) { return; }

        this.runningCommands.add(name);
        this.options.onRunStarted(name);
        this.options.logger(`auto run started: ${name}`);
        // Auto runs start from the first workspace folder (or the extension
        // host's directory when no folder is open); the resolved command's
        // own `cd` prefix still wins when a directory is configured.
        exec(
            command.finalShellCommand,
            {
                cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
                timeout: EXECUTION_TIMEOUT_MILLISECONDS,
                windowsHide: true,
                maxBuffer: MAX_OUTPUT_BYTES,
            },
            (error, stdout, stderr) => this.handleExecutionFinished(name, error, stdout, stderr),
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
    }

    // Parse a finished run and report the result. stdout wins when it holds a
    // valid status line; otherwise the row shows an invalid-output placeholder
    // and the first stderr / error line is logged for diagnosis.
    private handleExecutionFinished(
        name: string,
        error: Error | null,
        stdout: string,
        stderr: string,
    ): void {
        this.runningCommands.delete(name);
        if (this.disposed) { return; }

        const parsed = parseAutoRunOutput(stdout);
        if (parsed) {
            this.options.logger(
                `auto run finished: ${name} -> ${parsed.status}` +
                (parsed.message ? ` (${parsed.message})` : ''),
            );
            this.options.onRunFinished(name, { ...parsed, finishedAt: Date.now() });
            if (parsed.popupMessage) {
                showAutoRunPopup(parsed.status, parsed.popupMessage);
            }
            return;
        }

        const firstDetailLine = (stderr || error?.message || stdout || '')
            .trim()
            .split(/\r?\n/)[0] ?? '';
        this.options.logger(
            `auto run finished: ${name} -> invalid output` +
            (firstDetailLine ? `: ${firstDetailLine}` : ''),
        );
        this.options.onRunFinished(name, {
            status: 'unknown',
            message: 'invalid output',
            popupMessage: '',
            finishedAt: Date.now(),
            invalid: true,
        });
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
