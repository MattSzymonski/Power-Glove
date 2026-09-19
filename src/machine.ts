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
//   host name from HOSTNAME / COMPUTERNAME env vars, then SSH_CONNECTION's
//   server-IP field as a last resort.
// - Otherwise falls back to os.hostname(), and finally the literal 'unknown'
//   if even that throws.
export function detectMachineName(): string {
    // When running on a remote (SSH etc.), os.hostname() reads from the kernel
    // (/etc/hostname on Linux) and is the most reliable source. Env vars are
    // checked as a secondary option; SSH_CONNECTION[2] is a last resort because
    // it contains the server IP, not the hostname.
    if (vscode.env.remoteName) {
        try {
            const h = os.hostname();
            if (h && h.trim().length > 0) { return h.trim(); }
        } catch { /* fall through */ }

        const remoteHost =
            process.env.HOSTNAME ||
            process.env.COMPUTERNAME ||
            process.env.SSH_CONNECTION?.split(' ')[2];
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
