# Power Glove - VS Code Extension

VS Code extension for defining and running reusable shell commands from a single command-palette popup. Commands can be filtered per machine and per project, with `<PLACEHOLDER>` substitution so the same command list works across multiple workstations.

<!-- <p align="left">
  <img src="media/usage.gif" img width=100%>
</p> -->

## Features

### Command Picker

Run any of your saved shell commands from a single Quick Pick popup.

- **Open Picker** - Run `Power Glove: Open` from the Command Palette (recommended: bind it to a hotkey such as `Ctrl+Alt+P`).
- **Run In Current Terminal** - Press `Enter` on a selection, or click the `play` button on the row, to send the command to the active terminal (a fresh terminal is created if none is open).
- **Run In New Terminal** - Click the `terminal-new` button on a row to spawn a dedicated terminal named `Power Glove: <command>`.
- **Grouping** - Commands are grouped by their `project` field, with a `(general)` section for commands that have no project.
- **Search** - Picker matching covers the command name, description, and the resolved shell command line.
- **Manage shortcut** - A gear button in the picker title bar opens the Commands Manager.

### Commands Manager

A webview that lets you edit `powerGlove.commands` without hand-editing JSON.

- **Open Manager** - Run `Power Glove: Manage Commands` from the Command Palette, or click the gear button in the picker.
- **Add / Edit** - Use `+ New command` to append a new entry. Click any row to expand and edit its name, description, project, directory, command, and per-machine settings.
- **Reorder** - Use the up/down arrows on each row to change command order.
- **Duplicate** - The copy button creates a clone of the row.
- **Delete (two-step)** - Click the delete button once to arm it (it turns red and says "Confirm?"); click again within ~2.5 s to remove. The button auto-disarms otherwise.
- **Auto-save** - Every change is persisted immediately to your `settings.json` in the same scope where `powerGlove.commands` currently lives (workspace folder → workspace → user).
- **Machine view** - A "Only show commands for this machine" toggle dims commands that wouldn't appear on the detected host.
- **Help** - A `?` button reveals an inline cheat-sheet at the bottom of the manager.

### Per-Machine Filtering and Overrides

Each command lists the machines it should appear on, plus per-machine value overrides.

- **Machine detection** - On startup the extension picks the current machine name from the remote SSH host (when running over Remote-SSH) or `os.hostname()` otherwise.
- **Visibility** - A command is shown only if it has a `machineSettings` entry matching the detected machine and that entry doesn't have `show: false`.
- **Overrides** - `<KEY>` tokens inside `command` or `directory` are substituted using the matching machine's `overrides` list. Tokens with no matching override are left untouched and a warning is logged to the **Power Glove** output channel.

### Per-Project Filtering

The `project` field hides a command unless one of the open workspace folder paths contains the given substring. An empty `project` means "always show".

### Working-Directory Prefixing

When `directory` is non-empty the command is automatically prefixed with the right `cd` form for the platform:

- Windows → `cd /d "<dir>" && <command>`
- POSIX  → `cd "<dir>" && <command>`

## Installation

1. Download the latest `.vsix` from the project releases.
2. In VS Code, open the Command Palette (`Ctrl+Shift+P`).
3. Choose **"Extensions: Install from VSIX..."**.
4. Select the downloaded `.vsix` file.

## Configuration

You can edit commands through the **Commands Manager** webview, or directly in `settings.json`. Both write to the same `powerGlove.commands` array.

### Minimal example

```json
{
  "powerGlove.commands": [
    {
      "name": "Run tests",
      "command": "npm test",
      "machineSettings": [
        { "machineName": "my-laptop", "show": true }
      ]
    }
  ]
}
```

### Full example

```jsonc
{
  "powerGlove.machines": [
    { "name": "my-laptop" },
    { "name": "build-server" }
  ],

  "powerGlove.commands": [
    {
      "name": "Build (release)",
      "description": "Compile the project in release mode",
      "project": "my-app",
      "directory": "<REPO>",
      "command": "cargo build --release --manifest-path <REPO>/crate/Cargo.toml",
      "machineSettings": [
        {
          "machineName": "my-laptop",
          "show": true,
          "overrides": [
            { "key": "REPO", "value": "/home/user/code/my-app" }
          ]
        },
        {
          "machineName": "build-server",
          "show": true,
          "overrides": [
            { "key": "REPO", "value": "/srv/ci/my-app" }
          ]
        }
      ]
    },
    {
      "name": "Tail logs",
      "command": "tail -f /var/log/syslog",
      "machineSettings": [
        { "machineName": "build-server", "show": true },
        { "machineName": "my-laptop",    "show": false }
      ]
    }
  ]
}
```

### Setting reference

| Setting                 | Description                                                             |
| ----------------------- | ----------------------------------------------------------------------- |
| `powerGlove.machines[]` | Optional list of known machines. Currently informational, not enforced. |
| `powerGlove.commands[]` | Commands shown in the popup and managed by the Commands Manager.        |

### Command schema

| Field                           | Type                    | Description                                                                                                                                                 |
| ------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                          | string                  | Display label shown in the picker.                                                                                                                          |
| `description`                   | string                  | Optional short text shown next to the name in the picker.                                                                                                   |
| `project`                       | string                  | If non-empty, command is shown only when at least one open workspace folder path **contains** this substring. Empty = always shown.                         |
| `directory`                     | string                  | If non-empty, command is prefixed with `cd /d "<dir>" && …` (Windows) or `cd "<dir>" && …` (POSIX). May contain `<KEY>` tokens.                             |
| `command`                       | string                  | Shell command line. May contain `<KEY>` tokens.                                                                                                             |
| `machineSettings[]`             | array                   | Per-machine config. The command appears only on machines listed here.                                                                                       |
| `machineSettings[].machineName` | string                  | Must equal the detected machine name to match.                                                                                                              |
| `machineSettings[].show`        | boolean                 | `false` hides the command on this machine. Defaults to `true`.                                                                                              |
| `machineSettings[].overrides[]` | array of `{key, value}` | `<KEY>` is replaced with `value` in `command` and `directory`. Tokens without a matching override are left as-is and logged to the **Power Glove** channel. |

### Filtering rules (in order)

1. Command must have a `machineSettings` entry whose `machineName` equals the detected machine.
2. That entry must not have `show: false`.
3. If `project` is non-empty, at least one open workspace folder path must contain it.

## Commands

| Command                                | ID                                | Description                                       |
| -------------------------------------- | --------------------------------- | ------------------------------------------------- |
| `Power Glove: Open`                    | `powerGlove.openUI`               | Open the command picker Quick Pick.               |
| `Power Glove: Manage Commands`         | `powerGlove.openManager`          | Open the Commands Manager webview.                |
| `Power Glove: Run In Current Terminal` | `powerGlove.runInCurrentTerminal` | Pick a command and run it in the active terminal. |
| `Power Glove: Run In New Terminal`     | `powerGlove.runInNewTerminal`     | Pick a command and run it in a fresh terminal.    |

No keybindings are bundled by default; bind `powerGlove.openUI` (and any others you use often) in your `keybindings.json`.

## Project layout

```
src/
  extension.ts        activation, command registration, output channel
  config.ts           settings types + reader
  machine.ts          current-machine detection
  resolver.ts         pure command resolution, filtering, overrides
  terminal.ts         VS Code terminal helpers
  ui/picker.ts        Quick Pick popup
  ui/manager.ts       Commands Manager webview
  test/               Mocha unit + activation tests
```

## Development

### Coding and Building

1. Clone the repository
2. Run `npm install` to install dependencies
3. Run `npm run compile` to build the project
4. Press `F5` to launch the Extension Development Host for testing
5. Run `npx @vscode/vsce package` to build a `.vsix` file

### Publishing a Release

Use `release_version.sh` script or manually:

1. Update the `version` field in `package.json`
2. Build the `.vsix` file: `npx @vscode/vsce package`
3. Go to [Power-Glove Releases](https://github.com/MattSzymonski/Power-Glove/releases)
4. Click **"Draft a new release"**
5. Click **"Choose a tag"** and create a new tag matching the version (e.g. `v1.1.0`)
6. Set the release title (e.g. `v1.1.0`)
7. Describe the changes in the release notes
8. Attach the built `.vsix` file by dragging it into the assets area
9. Click **"Publish release"**
