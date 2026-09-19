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
    command: string;
    machineSettings?: MachineSetting[];
}
