// This file detects the current machine's identity for command filtering.
// - Exports detectMachineName() which returns a stable identifier used
//   to match against CommandConfig.machineSettings entries.
// - Prefers the remote host name when running through a VS Code remote
//   (SSH_CONNECTION / HOSTNAME / COMPUTERNAME), then falls back to
//   os.hostname(), then the literal 'unknown'.

import * as vscode from 'vscode';
import * as os from 'os';

// Returns a stable identifier for the machine the extension is currently
// running on. Used by the resolver to filter commands and apply per-machine
// overrides.
// - When connected via Remote-SSH (or any VS Code remote), prefers the remote
//   host name from SSH_CONNECTION / HOSTNAME / COMPUTERNAME env vars.
// - Otherwise falls back to os.hostname(), and finally the literal 'unknown'
//   if even that throws.
export function detectMachineName(): string {
    // Prefer remote host name when running over SSH / remote.
    if (vscode.env.remoteName) {
        const remoteHost =
            process.env.SSH_CONNECTION?.split(' ')[2] ||
            process.env.HOSTNAME ||
            process.env.COMPUTERNAME;
        if (remoteHost && remoteHost.trim().length > 0) {
            return remoteHost.trim();
        }
    }

    // Local fallback. os.hostname() can throw on misconfigured systems.
    try {
        return os.hostname();
    } catch {
        return 'unknown';
    }
}
