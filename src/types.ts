// Shared TypeScript interfaces for Power Glove configuration.
// These mirror the structure stored in power-glove-commands.json.

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
    /** Shell command typed into a terminal. Absent when `vscodeCommand` is set. */
    command?: string;
    /** VS Code command id to execute instead of a shell command. */
    vscodeCommand?: string;
    /** Arguments forwarded to `vscodeCommand`, in order. */
    vscodeCommandArgs?: unknown[];
    machineSettings?: MachineSetting[];
}
