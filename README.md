# Ahton: Claude Code and Codex CLI Notifications

Ahton shows a desktop popup on Windows when Claude Code or Codex CLI finishes or needs you in a VS Code terminal. Click the popup and VS Code brings the right window and the right terminal to the front. It works with several VS Code windows and several agent terminals open at once.

The popup text is fixed. It never contains your prompts, replies, file paths or workspace names.

## Install

Ahton targets Windows 10 or 11 on x64 and VS Code 1.93 or later.

- VS Code Marketplace: <https://marketplace.visualstudio.com/items?itemName=kidneys3.ahton>
- Open VSX: <https://open-vsx.org/extension/kidneys3/ahton>
- Command line: `code --install-extension kidneys3.ahton`

Claude Code and Codex CLI must already be installed. Node.js must be on your `PATH` for the Claude Code hook.

## Setup

1. Open the Command Palette and run **Ahton: Configure Claude Code and Codex**.
2. Read the preview. It lists each file Ahton will change and a short summary. It shows no file contents.
3. Choose **Apply**. Ahton writes nothing before this step.
4. Open a new terminal from the **Claude Code** profile for Claude Code sessions.
5. Run **Ahton: Start Managed Codex Terminal** for each Codex CLI session.

What the command changes:

- Claude Code: adds `Notification` and `StopFailure` hooks to `~/.claude/settings.json` that run Ahton's adapter.
- Codex CLI: sets `notifications`, `notification_method` and `notification_condition` in the `[tui]` section of `~/.codex/config.toml`.
- VS Code: adds a `Claude Code` and a `Codex` terminal profile to your user settings.

A missing file is created. A missing `~/.claude` or `~/.codex` folder means that tool is skipped with a message. Each changed file gets a timestamped backup beside it (`.bak-ahton-<time>`), and a journal records the run so it can be rolled back.

Send a test with **Ahton: Send Claude Routing Test Notification** or **Ahton: Send Codex Routing Test Notification** from the terminal you want to test.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `ahton.enabled` | `true` | Routes Claude Code and Codex CLI terminal signals to a popup. |
| `ahton.showTerminalLabel` | `true` | Shows a name you gave the terminal in the popup. When off, the popup shows the provider name and a terminal number only. |
| `ahton.showWorkspaceName` | `true` | Shows the VS Code window's folder name (for example `api`) in the popup, so each window's popup says which project it belongs to. A name over 28 characters, over four words, or with a path or quote character is left out. Unlike a terminal name, it needs no `claude` or `codex` prefix. |
| `ahton.rollover.enabled` | `false` | Lets a Claude Code session ask Ahton to open a fresh Claude terminal in the workspace. When off, the request is refused and counted, and no terminal opens. |

A terminal name is shown only if it starts with `claude`, `codex`, `kimi`, `c`, `d` or `k`, then a word, and is at most 28 characters and four words. Examples: `claude api`, `c web`, `d docs`, `k notes`. Any other name is not shown. The popup shows `Terminal 3` instead.

## Commands

| Command | What it does |
| --- | --- |
| Ahton: Configure Claude Code and Codex | Previews, then applies, the hook, profile and Codex settings. |
| Ahton: Start Managed Codex Terminal | Opens a Codex terminal in the editor area with notifications wired. |
| Ahton: Send Claude Routing Test Notification | Raises a test popup for the active terminal as Claude Code. |
| Ahton: Send Codex Routing Test Notification | Raises a test popup for the active terminal as Codex. |
| Ahton: Show Router Diagnostics | Shows the version, route readiness and counts. No names, paths or prompts. |

## Privacy and safety boundary

- Ahton makes no network requests. The only inter-process channel is a local named pipe, with a random token, scoped to one VS Code window.
- Popup text comes from a fixed list. Signals are allowlisted and never become popup text.
- Prompts, replies, paths, workspace names and transcripts are never read into a popup.
- Only terminals Ahton manages can raise a popup. A terminal that closed, went stale or matches more than one candidate is refused. Ahton never falls back to the active terminal.
- Click targets are one-use, short-lived and held in memory only.
- The native helper receives numbers and fixed values only. Its source and a SHA-256 of the binary are in `native/`.
- Configuration changes need your confirmation, keep backups and can be rolled back.

## Limits

- Windows x64 only. On macOS and Linux each command shows one "Windows only" message and does nothing else.
- Claude Code CLI and Codex CLI in VS Code terminals only. VS Code chat, the ChatGPT desktop app and terminals outside VS Code are not covered.
- Windows may refuse to bring a window to the front. The popup click then flashes the taskbar button instead.
- Claude Code signals are `StopFailure`, `idle_prompt`, `agent_completed`, `permission_prompt`, `elicitation_dialog` and `agent_needs_input`. Codex signals are `agent-turn-complete`, `approval-requested` and `plan-mode-prompt`.
- The Claude hook runs `node` from your `PATH`. Without Node.js, **Configure** skips Claude Code and says why.

## FAQ

**How do I get a notification when Claude Code finishes in VS Code on Windows?**
Install Ahton, run **Ahton: Configure Claude Code and Codex**, then start Claude Code from the `Claude Code` terminal profile. A popup appears when it finishes or needs input.

**Is there a VS Code extension for Codex CLI notifications?**
Yes. Ahton covers Codex CLI in a VS Code terminal. Run **Ahton: Start Managed Codex Terminal** after configuring.

**Which popup appears when I have several VS Code windows open?**
Only the window that owns the terminal raises the popup, and clicking it focuses that window and terminal.

**Does Ahton work on macOS or Linux?**
No. It is Windows x64 only.

**Does Ahton send my prompts or code anywhere?**
No. It makes no network requests and the popup text is fixed. See the privacy section.

**How do I undo the configuration?**
Each changed file has a `.bak-ahton-<time>` backup beside it. The journal of each run is in Ahton's VS Code storage folder under `migrations`. From a clone of the repository, `node scripts/configure-ahton.mjs --rollback <journal>` restores the exact original bytes.

**Why is there no popup?**
Check that `ahton.enabled` is on, that you opened the terminal from the `Claude Code` profile or **Start Managed Codex Terminal**, and run **Ahton: Show Router Diagnostics**.

**Does it need Node.js?**
Yes for the Claude Code hook. Install Node.js and run **Configure** again.

## Build from source

```powershell
npm ci
npm run verify
npm run package
```

`npm run verify` runs the classified-data check, the type check, the build and the tests. `npm run package` builds `ahton-<version>-win32-x64.vsix`.

## Licence

MIT. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
