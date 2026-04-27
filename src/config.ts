// This file defines Power Glove's configuration schema and reader.
// - Declares the TypeScript interfaces (CommandConfig, MachineSetting,
//   Override, Machine, PowerGloveConfig) mirroring package.json schema.
// - Exposes readConfig() which reads workspace/user settings under the
//   `powerGlove` section via the vscode workspace API.
// - Defensively sanitizes incoming arrays so consumers can rely on shape.

import * as vscode from 'vscode';

export interface Override {
    key: string;
    value: string;
}

export interface MachineSetting {
    machineName: string;
    show?: boolean;
    overrides?: Override[];
}

export interface CommandConfig {
    name: string;
    description?: string;
    project?: string;
    directory?: string;
    command: string;
    machineSettings?: MachineSetting[];
}

export interface Machine {
    name: string;
}

export interface PowerGloveConfig {
    machines: Machine[];
    commands: CommandConfig[];
}

const SECTION = 'powerGlove';

// Reads the `powerGlove` configuration section from VS Code settings
// (workspace folder → workspace → user, per VS Code's normal precedence)
// and returns it as a typed PowerGloveConfig with arrays guaranteed to exist.
export function readConfig(): PowerGloveConfig {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    return {
        machines: sanitizeArray<Machine>(cfg.get('machines', [])),
        commands: sanitizeArray<CommandConfig>(cfg.get('commands', [])),
    };
}

// Defensive coercion: anything that isn't an array becomes an empty array,
// so downstream code (resolver, manager UI) can iterate without null checks.
function sanitizeArray<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
}
