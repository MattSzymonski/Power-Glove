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

/** When an auto command's popup message raises a VS Code notification:
 *  on every run, only when status/message changed (default), or never. */
export type PopupPolicy = 'always' | 'onChange' | 'never';

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
     *  Fractional values are allowed (for example 0.5 = every 30 seconds).
     *  A [min, max] pair schedules each next run after a random delay in
     *  that range instead of a fixed interval. */
    autoRunIntervalMinutes?: number | [number, number];
    /** Popup policy for auto commands (default 'onChange'). 'onChange'
     *  notifies only when the status or popup message differs from the
     *  previous run, so a repeating condition does not notify every tick. */
    popup?: PopupPolicy;
    /** Kill a background run after this many seconds (default 120, max 3600). */
    timeoutSeconds?: number;
    /** Retry once when a background run errors or prints no status line. */
    retryOnFailure?: boolean;
    /** Set to false to disable the command without deleting it: it disappears
     *  from the picker and stops auto running, but stays visible in the
     *  sidebar tree (dimmed) and editable in the Commands Manager. */
    enabled?: boolean;
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
