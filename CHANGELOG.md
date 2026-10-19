# Changelog

## 0.7.0

First public release, Windows x64.

- Added **Ahton: Configure Claude Code and Codex**. It previews the files it will change, writes only after you confirm, keeps timestamped backups and a journal, and creates files that do not exist yet.
- The Claude Code hook now points at a copy of the adapters in VS Code's global storage, so an extension update does not break the hook path.
- Added `ahton.showTerminalLabel` (default on). When off, the popup shows the provider name and a terminal number only.
- Added `ahton.showWorkspaceName` (default on). The popup shows the VS Code window's folder name before the terminal name, for example `api · Terminal 3`. The old "PROVIDER" line is gone.
- Added `ahton.rollover.enabled` (default off). When off, a rollover request is refused and counted, and no terminal opens.
- On macOS and Linux every command shows one "Windows only" message and nothing else starts.
- Package is built with `--target win32-x64` and carries an icon and this changelog.

## 0.6.9

- Internal build. The package allowlist moved to `.vscodeignore` so only the files the extension runs are packaged.

## 0.6.8

- Codex terminals are green and Claude Code terminals use a yellow-orange accent.

## 0.6.7

- The managed Codex terminal opens in the editor area.

## 0.6.6

- Terminal-only product boundary. Removed the Codex IDE route.
