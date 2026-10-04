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

/** How a command is triggered: from the UI, or automatically in background. */
export type CommandType = 'manual' | 'auto';

export interface CommandConfig {
    name: string;
    description?: string;
    /** Optional hex color ("#rgb" or "#rrggbb") shown as a square in front of
     *  the command in the sidebar tree and in the Commands Manager. */
    color?: string;
    /** 'auto' runs the command in the background on an interval; missing or
     *  'manual' keeps it a picker/tree command. */
    type?: CommandType;
    /** Minutes between background runs when type is 'auto' (default 5).
     *  A [min, max] pair (for example [1, 3]) schedules each next run after
     *  a random delay in that range instead of a fixed interval. */
    autoRunIntervalMinutes?: number | [number, number];
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
