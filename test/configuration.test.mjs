import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

import {
  configureClaudeSettings,
  configureCodexConfig,
  configureVsCodeSettings,
} from "../src/configuration.mjs";
import * as configuration from "../src/configuration.mjs";
import { runConfigure } from "../src/configure-command.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = "D:\\fixture\\node.exe";
const CLAUDE_ADAPTER = "D:\\fixture\\claude-signal.mjs";
const CODEX_ADAPTER = "D:\\fixture\\codex-signal.mjs";

test("Claude migration isolates Ahton groups and leaves sibling handlers unchanged", () => {
  const sibling = { type: "command", command: "other.exe", args: ["keep"] };
  const hybrid = {
    type: "command",
    command: 'node.exe "D:/fixture/vscode-agent-notify.mjs" --provider claude --port-file x',
    args: [CLAUDE_ADAPTER],
  };
  const source = JSON.stringify({ hooks: {
    Stop: [{ matcher: "old", hooks: [sibling, hybrid] }],
    Notification: [{ matcher: "all", hooks: [sibling, hybrid] }],
  } });
  const configured = JSON.parse(configureClaudeSettings(source, { nodePath: NODE, adapterPath: CLAUDE_ADAPTER }));
  assert.deepEqual(configured.hooks.Stop, [{ matcher: "old", hooks: [sibling] }]);
  assert.deepEqual(configured.hooks.Notification[0], { matcher: "all", hooks: [sibling] });
  assert.equal(configured.hooks.Notification.length, 2);
  assert.equal(configured.hooks.Notification[1].hooks.length, 1);
  assert.match(configured.hooks.Notification[1].matcher, /idle_prompt/);
  assert.equal(configured.hooks.StopFailure.length, 1);
  assert.equal(configureClaudeSettings(
    configureClaudeSettings(source, { nodePath: NODE, adapterPath: CLAUDE_ADAPTER }),
    { nodePath: NODE, adapterPath: CLAUDE_ADAPTER },
  ), configureClaudeSettings(source, { nodePath: NODE, adapterPath: CLAUDE_ADAPTER }));
});

test("Claude migration never writes an args key on the managed hook entry", () => {
  const source = JSON.stringify({ hooks: {} });
  const configured = JSON.parse(configureClaudeSettings(source, { nodePath: NODE, adapterPath: CLAUDE_ADAPTER }));
  for (const event of ["StopFailure", "Notification"]) {
    for (const group of configured.hooks[event]) {
      for (const handler of group.hooks) {
        assert.equal(Object.hasOwn(handler, "args"), false, `${event} handler must not carry an args key`);
      }
    }
  }
});

test("Claude migration writes the events the adapter actually maps, and never Stop", () => {
  const source = JSON.stringify({ hooks: {} });
  const configured = JSON.parse(configureClaudeSettings(source, { nodePath: NODE, adapterPath: CLAUDE_ADAPTER }));
  // reasonForHookEvent() returns null for Stop, so a handler there would run on
  // every turn end and post nothing. StopFailure carries the API-error case.
  assert.equal(Object.hasOwn(configured.hooks, "Stop"), false);
  assert.equal(configured.hooks.StopFailure.length, 1);
  assert.equal(configured.hooks.Notification[0].matcher, "idle_prompt|permission_prompt|elicitation_dialog|agent_needs_input|agent_completed");
});

test("Claude migration's command invokes the bundled adapter path it was given, not a repo-relative path", () => {
  const source = JSON.stringify({ hooks: {} });
  const configured = JSON.parse(configureClaudeSettings(source, { nodePath: NODE, adapterPath: CLAUDE_ADAPTER }));
  const stopHandler = configured.hooks.StopFailure[0].hooks[0];
  const repoAdapter = path.join(ROOT, "adapters", "claude-signal.mjs").replaceAll("\\", "/");
  assert.match(stopHandler.command, /claude-signal\.mjs/);
  assert.match(stopHandler.command, /D:\/fixture\/claude-signal\.mjs/);
  assert.doesNotMatch(stopHandler.command, new RegExp(repoAdapter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Claude migration removes the superseded vscode-agent-notify hook, leaving only the new one", () => {
  const legacy = {
    type: "command",
    command: '"C:/Program Files/nodejs/node.exe" "C:/fixture-home/.claude/hooks/vscode-agent-notify.mjs" --provider claude --port-file "C:/fixture-home/Apps/.vscode/vscode-notify-desktop-port.json"',
    args: ["C:/fixture-home/Apps/ahton/adapters/claude-signal.mjs"],
  };
  const source = JSON.stringify({ hooks: {
    Stop: [{ matcher: "", hooks: [legacy] }],
    Notification: [{ matcher: "", hooks: [legacy] }],
  } });
  const configured = JSON.parse(configureClaudeSettings(source, { nodePath: NODE, adapterPath: CLAUDE_ADAPTER }));
  assert.equal(Object.hasOwn(configured.hooks, "Stop"), false, "the superseded Stop registration must be removed, not kept beside the new one");
  for (const event of ["StopFailure", "Notification"]) {
    const allHandlers = configured.hooks[event].flatMap((group) => group.hooks);
    assert.equal(allHandlers.length, 1, `${event} must carry exactly one handler, not the old notifier beside the new one`);
    assert.doesNotMatch(allHandlers[0].command, /vscode-agent-notify/);
  }
});

test("VS Code migration edits only the named profiles", () => {
  const source = `{
  "terminal.integrated.profiles.windows": {
    "Other": { "args": ["-NoLogo", "-NoExit", "-Command", "codex"], "color": "terminal.ansiCyan", "nested": {"x": 1} },
    "Claude Code": {
      "args": ["-NoLogo", "-NoExit", "-Command", "claude"],
      "overrideName": true,
      "color": "terminal.ansiMagenta"
    },
    "Codex": {
      "args": ["-NoLogo", "-NoExit", "-Command", "codex"],
      "overrideName": true,
      "color": "terminal.ansiCyan"
    }
  }
}\n`;
  const updated = configureVsCodeSettings(source);
  assert.equal((updated.match(/AHTON_SHELL_PID/g) ?? []).length, 1);
  assert.equal((updated.match(/AGENT_BRIDGE_PROVIDER/g) ?? []).length, 2);
  assert.match(updated, /"Claude Code": \{\s*"args": \["-NoLogo", "-NoExit", "-Command", "\$env:AHTON_SHELL_PID=\$PID; claude"\]/);
  assert.match(updated, /"AGENT_BRIDGE_PROVIDER": "claude"/);
  assert.match(updated, /"Claude Code": \{[\s\S]*?"color": "terminal\.ansiYellow"[\s\S]*?\}\s*,\s*"Codex"/);
  assert.match(updated, /"Codex": \{\s*"args": \["-NoLogo", "-NoExit", "-Command", "codex"\]/);
  assert.match(updated, /"AGENT_BRIDGE_PROVIDER": "codex"/);
  assert.match(updated, /"Codex": \{[\s\S]*?"color": "terminal\.ansiGreen"[\s\S]*?\}\s*\}/);
  assert.match(updated, /"Other": \{ "args": \["-NoLogo", "-NoExit", "-Command", "codex"\], "color": "terminal\.ansiCyan", "nested": \{"x": 1\} \}/);
  assert.doesNotMatch(updated, /terminal\.ansiMagenta/);
  assert.equal(configureVsCodeSettings(updated), updated);
});

test("VS Code migration adds the shell-pid prelude and provider env only to Claude Code", () => {
  const source = `{
  "terminal.integrated.profiles.windows": {
    "Claude Code": {
      "args": ["-NoLogo", "-NoExit", "-Command", "claude"],
      "overrideName": true
    },
    "Codex": {
      "args": ["-NoLogo", "-NoExit", "-Command", "codex"],
      "overrideName": true
    }
  },
  "editor.fontSize": 14
}\n`;
  const updated = configureVsCodeSettings(source);
  assert.match(updated, /"editor.fontSize": 14/);
  const claudeBlock = updated.slice(updated.indexOf('"Claude Code"'), updated.indexOf('"Codex"'));
  assert.match(claudeBlock, /\$env:AHTON_SHELL_PID=\$PID; claude/);
  assert.match(claudeBlock, /"AGENT_BRIDGE_PROVIDER": "claude"/);
  assert.match(claudeBlock, /"color": "terminal\.ansiYellow"/);
  const codexBlock = updated.slice(updated.indexOf('"Codex"'));
  assert.doesNotMatch(codexBlock, /AHTON_SHELL_PID/);
  assert.match(codexBlock, /"AGENT_BRIDGE_PROVIDER": "codex"/);
  assert.match(codexBlock, /"color": "terminal\.ansiGreen"/);
  // idempotent on a second pass
  assert.equal(configureVsCodeSettings(updated), updated);
});

test("Codex migration preserves forwarding and unwraps only a missing outer runtime", () => {
  const forward = "D:\\fixture\\forward.exe";
  const legacy = [NODE, "D:\\fixture\\vscode-agent-notify.mjs", "--provider", "codex", "--port-file", "D:\\fixture\\port.json", "--forward-program", forward, "--forward-arg", "turn-ended"];
  const wrapper = ["D:\\missing\\codex-computer-use.exe", "turn-ended", "--previous-notify", JSON.stringify(legacy)];
  const source = `notify = ${toml(wrapper)}\n\n[tui]\nstatus_line = ["model"]\n`;
  const updated = configureCodexConfig(source, {
    exists: (candidate) => candidate === forward,
  });
  assert.equal(updated.includes(`notify = ${toml([forward, "turn-ended"])}`), true);
  assert.doesNotMatch(updated, /vscode-agent-notify|D:\\\\missing/);
  assert.match(updated, /notifications = \["agent-turn-complete", "approval-requested", "plan-mode-prompt"\]/);
  assert.equal(configureCodexConfig(updated, {
    exists: (candidate) => candidate === forward,
  }), updated);
});

test("Codex migration restores a live Computer Use wrapper without a previous notifier", () => {
  const stale = "D:\\missing\\codex-computer-use.exe";
  const legacy = [NODE, "D:\\fixture\\vscode-agent-notify.mjs", "--provider", "codex", "--port-file", "D:\\fixture\\port.json", "--forward-program", stale, "--forward-arg", "turn-ended"];
  const outer = "D:\\current\\codex-computer-use.exe";
  const source = `notify = ${toml([outer, "turn-ended", "--previous-notify", JSON.stringify(legacy)])}\n\n[tui]\n`;
  const updated = configureCodexConfig(source, {
    exists: (candidate) => candidate === outer,
  });
  assert.equal(updated.includes(`notify = ${toml([outer, "turn-ended"])}`), true);
  assert.doesNotMatch(updated, /codex-signal\.mjs|vscode-agent-notify\.mjs|--previous-notify/);
});

test("Codex migration preserves a live wrapper and its unrelated forwarded notifier", () => {
  const outer = "D:\\current\\codex-computer-use.exe";
  const forward = "D:\\fixture\\forward.exe";
  const current = [NODE, CODEX_ADAPTER, "--forward-program", forward, "--forward-arg", "turn-ended"];
  const source = `notify = ${toml([outer, "turn-ended", "--previous-notify", JSON.stringify(current)])}\n\n[tui]\n`;
  const updated = configureCodexConfig(source, {
    exists: (candidate) => candidate === outer || candidate === forward,
  });
  const preserved = [outer, "turn-ended", "--previous-notify", JSON.stringify([forward, "turn-ended"])];
  assert.equal(updated.includes(`notify = ${toml(preserved)}`), true);
  assert.doesNotMatch(updated, /codex-signal\.mjs/);
});

test("Codex migration upgrades only Ahton's previous notification list", () => {
  const current = [NODE, CODEX_ADAPTER];
  const source = `notify = ${toml(current)}\n\n[tui]\nnotifications = ["agent-turn-complete"]\n`;
  const updated = configureCodexConfig(source);
  assert.match(updated, /notifications = \["agent-turn-complete", "approval-requested", "plan-mode-prompt"\]/);
  const unrelated = source.replace('["agent-turn-complete"]', '["approval-requested"]');
  assert.throws(() => configureCodexConfig(unrelated), /unrelated tui\.notifications/);
});

test("Codex CLI migration removes only Ahton's external notifier", () => {
  const forward = "D:\\fixture\\forward.exe";
  const source = `notify = ${toml([
    NODE,
    CODEX_ADAPTER,
    "--forward-program",
    forward,
    "--forward-arg",
    "turn-ended",
  ])}\n\n[tui]\nstatus_line = ["model"]\n`;
  const updated = configureCodexConfig(source, {
    exists: (candidate) => candidate === forward,
  });
  assert.doesNotMatch(updated, /codex-signal\.mjs/);
  assert.equal(updated.includes(`notify = ${toml([forward, "turn-ended"])}`), true);
  assert.match(updated, /notification_method = "osc9"/);
  assert.match(updated, /notification_condition = "unfocused"/);
});

test("Codex CLI migration removes an unforwarded Ahton notifier", () => {
  const source = `notify = ${toml([NODE, CODEX_ADAPTER])}\n\n[tui]\nstatus_line = ["model"]\n`;
  const updated = configureCodexConfig(source);
  assert.doesNotMatch(updated, /^\s*notify\s*=/m);
  assert.match(updated, /notification_method = "osc9"/);
});

test("Codex migration writes a valid TOML string when a forwarded path holds an apostrophe", () => {
  const forward = "D:\\O'Brien\\forward.exe";
  const legacy = [NODE, "D:\\fixture\\vscode-agent-notify.mjs", "--provider", "codex", "--port-file", "D:\\fixture\\port.json", "--forward-program", forward, "--forward-arg", "turn-ended"];
  const wrapper = ["D:\\missing\\codex-computer-use.exe", "turn-ended", "--previous-notify", JSON.stringify(legacy)];
  const source = `notify = ${toml(wrapper)}\n\n[tui]\nstatus_line = ["model"]\n`;
  const exists = (candidate) => candidate === forward;
  const updated = configureCodexConfig(source, { exists });
  const line = updated.split("\n").find((entry) => entry.startsWith("notify = "));
  assert.equal(line, `notify = ["D:\\\\O'Brien\\\\forward.exe", 'turn-ended']`);
  assert.equal(configureCodexConfig(updated, { exists }), updated);
});

test("Codex migration round-trips an apostrophe and a control character through a second run", () => {
  const forward = "D:\\O'Brien\\for\u001bward.exe";
  const legacy = [NODE, "D:\\fixture\\vscode-agent-notify.mjs", "--provider", "codex", "--port-file", "D:\\fixture\\port.json", "--forward-program", forward, "--forward-arg", "turn-ended"];
  const wrapper = ["D:\\missing\\codex-computer-use.exe", "turn-ended", "--previous-notify", JSON.stringify(legacy)];
  const source = `notify = ${toml(wrapper)}\n\n[tui]\nstatus_line = ["model"]\n`;
  const exists = (candidate) => candidate === forward;
  const once = configureCodexConfig(source, { exists });
  const line = once.split("\n").find((entry) => entry.startsWith("notify = "));
  assert.equal(line, `notify = ["D:\\\\O'Brien\\\\for\\u001bward.exe", 'turn-ended']`);
  const twice = configureCodexConfig(once, { exists });
  assert.equal(twice, once, "a second run must read the escaped value back and change nothing");
});

test("Codex CLI migration preserves an unrelated notifier byte for byte", () => {
  const notify = `notify = ['D:\\fixture\\other.exe', 'done']`;
  const source = `${notify}\n\n[tui]\nstatus_line = ["model"]\n`;
  const updated = configureCodexConfig(source);
  assert.equal(updated.slice(0, notify.length), notify);
  assert.equal(configureCodexConfig(updated), updated);
});

test("Codex CLI migration accepts a config without a notifier", () => {
  const source = `[tui]\nstatus_line = ["model"]\n`;
  const updated = configureCodexConfig(source);
  assert.doesNotMatch(updated, /^\s*notify\s*=/m);
  assert.equal(configureCodexConfig(updated), updated);
});

test("Codex CLI migration rejects ambiguous Ahton forwarding", () => {
  const source = `notify = ${toml([NODE, CODEX_ADAPTER, "--forward-arg", "done"])}\n\n[tui]\n`;
  assert.throws(() => configureCodexConfig(source), /forwarding tail is ambiguous/);
});

test("coordinated apply is idempotent and journal rollback restores exact bytes", {
  skip: process.platform !== "win32",
}, () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ahton-configure-"));
  const adapters = path.join(fixture, "adapters");
  fs.mkdirSync(adapters, { recursive: true });
  fs.writeFileSync(path.join(adapters, "claude-signal.mjs"), "fixture");
  const vscode = `{"terminal.integrated.profiles.windows":{"Claude Code": {\n  "args": ["-NoLogo", "-NoExit", "-Command", "claude"],\n  "overrideName": true\n},"Codex": {\n  "args": ["-NoLogo", "-NoExit", "-Command", "codex"],\n  "overrideName": true\n}}}\n`;
  const codex = `notify = ${toml([process.execPath, "D:\\fixture\\vscode-agent-notify.mjs", "--provider", "codex", "--port-file", "D:\\fixture\\port.json"])}\n\n[tui]\nstatus_line = ["model"]\n`;
  const claude = `${JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [
    { type: "command", command: '"C:/Program Files/nodejs/node.exe" "C:/fixture-home/.claude/hooks/vscode-agent-notify.mjs" --provider claude --port-file "C:/fixture-home/Apps/.vscode/vscode-notify-desktop-port.json"', args: ["C:/fixture-home/Apps/ahton/adapters/claude-signal.mjs"] },
  ] }], Notification: [{ matcher: "", hooks: [
    { type: "command", command: '"C:/Program Files/nodejs/node.exe" "C:/fixture-home/.claude/hooks/vscode-agent-notify.mjs" --provider claude --port-file "C:/fixture-home/Apps/.vscode/vscode-notify-desktop-port.json"', args: ["C:/fixture-home/Apps/ahton/adapters/claude-signal.mjs"] },
  ] }] } }, null, 2)}\n`;
  fs.writeFileSync(path.join(fixture, "settings.json"), vscode);
  fs.writeFileSync(path.join(fixture, "config.toml"), codex);
  fs.writeFileSync(path.join(fixture, "claude-settings.json"), claude);
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "configure-ahton.mjs"), "--fixture-root", fixture, ...args], {
    cwd: ROOT, env: { ...process.env, AHTON_CONFIGURE_TEST: "1" }, encoding: "utf8", windowsHide: true,
  });
  try {
    const preview = run();
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /AHTON_PREVIEW_ONLY/);
    assert.equal(fs.readFileSync(path.join(fixture, "settings.json"), "utf8"), vscode);
    const apply = run("--apply");
    assert.equal(apply.status, 0, apply.stderr);
    const journal = apply.stdout.match(/journal=(.+)\r?\n/)?.[1];
    assert.ok(journal && fs.existsSync(journal));
    assert.deepEqual(JSON.parse(fs.readFileSync(journal, "utf8")).targets.map((target) => target.key).sort(), ["claude", "codex", "vscode"]);
    const configuredVsCode = fs.readFileSync(path.join(fixture, "settings.json"), "utf8");
    assert.match(configuredVsCode, /\$env:AHTON_SHELL_PID=\$PID; claude/);
    assert.match(configuredVsCode, /"AGENT_BRIDGE_PROVIDER": "claude"/);
    assert.match(configuredVsCode, /"AGENT_BRIDGE_PROVIDER": "codex"/);
    assert.match(configuredVsCode, /"Claude Code": \{[\s\S]*?"color": "terminal\.ansiYellow"[\s\S]*?\}\s*,\s*"Codex"/);
    assert.match(configuredVsCode, /"Codex": \{[\s\S]*?"color": "terminal\.ansiGreen"[\s\S]*?\}\s*\}/);
    const configuredCodex = fs.readFileSync(path.join(fixture, "config.toml"), "utf8");
    assert.doesNotMatch(configuredCodex, /^\s*notify\s*=/m);
    assert.match(configuredCodex, /notification_method = "osc9"/);
    const configuredClaude = JSON.parse(fs.readFileSync(path.join(fixture, "claude-settings.json"), "utf8"));
    const bundledAdapter = path.join(adapters, "claude-signal.mjs").replaceAll("\\", "/");
    const repoAdapter = path.join(ROOT, "adapters", "claude-signal.mjs").replaceAll("\\", "/");
    assert.equal(Object.hasOwn(configuredClaude.hooks, "Stop"), false);
    for (const event of ["StopFailure", "Notification"]) {
      const handlers = configuredClaude.hooks[event].flatMap((group) => group.hooks);
      assert.equal(handlers.length, 1, `${event} must carry exactly one handler after migration`);
      assert.equal(Object.hasOwn(handlers[0], "args"), false);
      assert.match(handlers[0].command, new RegExp(bundledAdapter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(handlers[0].command, new RegExp(repoAdapter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(handlers[0].command, /vscode-agent-notify/);
    }
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /: change/);
    const secondApply = run("--apply");
    assert.equal(secondApply.status, 0, secondApply.stderr);
    assert.match(secondApply.stdout, /AHTON_ALREADY_CONFIGURED/);
    assert.equal(fs.readdirSync(path.join(fixture, "journals")).length, 1);
    const rollback = spawnSync(process.execPath, [path.join(ROOT, "scripts", "configure-ahton.mjs"), "--rollback", journal], {
      cwd: ROOT, encoding: "utf8", windowsHide: true,
    });
    assert.equal(rollback.status, 0, rollback.stderr);
    assert.equal(fs.readFileSync(path.join(fixture, "settings.json"), "utf8"), vscode);
    assert.equal(fs.readFileSync(path.join(fixture, "config.toml"), "utf8"), codex);
    assert.equal(fs.readFileSync(path.join(fixture, "claude-settings.json"), "utf8"), claude);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("Claude migration creates the hooks for a settings file that does not exist yet", () => {
  for (const blank of ["", "  \n"]) {
    const configured = JSON.parse(configureClaudeSettings(blank, { nodePath: NODE, adapterPath: CLAUDE_ADAPTER }));
    assert.equal(configured.hooks.StopFailure.length, 1);
    assert.equal(configured.hooks.Notification.length, 1);
  }
});

test("VS Code migration creates both terminal profiles in an empty or profile-less settings file", () => {
  for (const source of ["", "{}\n", '{\n  "editor.fontSize": 14\n}\n', '{\n  "editor.fontSize": 14,\n}\n']) {
    const updated = configureVsCodeSettings(source);
    assert.match(updated, /"terminal\.integrated\.profiles\.windows"/);
    assert.match(updated, /"Claude Code": \{[\s\S]*?\$env:AHTON_SHELL_PID=\$PID; claude/);
    assert.match(updated, /"Codex": \{[\s\S]*?"AGENT_BRIDGE_PROVIDER": "codex"/);
    assert.equal(configureVsCodeSettings(updated), updated, "a second pass changes nothing");
    if (source.includes("fontSize")) assert.match(updated, /"editor\.fontSize": 14/);
  }
});

test("VS Code migration adds a missing profile to an existing profiles block and keeps the others", () => {
  const source = `{
  "terminal.integrated.profiles.windows": {
    "Other": { "path": "cmd.exe" }
  }
}\n`;
  const updated = configureVsCodeSettings(source);
  assert.match(updated, /"Other": \{ "path": "cmd\.exe" \},/);
  assert.match(updated, /"Claude Code": \{/);
  assert.match(updated, /"Codex": \{/);
  assert.equal(configureVsCodeSettings(updated), updated);
});

test("VS Code migration writes only the providers it is asked for", () => {
  const updated = configureVsCodeSettings("", { claude: true, codex: false });
  assert.match(updated, /"Claude Code"/);
  assert.doesNotMatch(updated, /"Codex"/);
});

test("Codex migration creates the [tui] section when the config has none", () => {
  for (const source of ["", "model = \"x\"\n", "model = \"x\""]) {
    const updated = configureCodexConfig(source);
    assert.match(updated, /^\[tui\]\r?$/m);
    assert.match(updated, /notification_method = "osc9"/);
    assert.match(updated, /notification_condition = "unfocused"/);
    assert.match(updated, /notifications = \["agent-turn-complete", "approval-requested", "plan-mode-prompt"\]/);
    if (source) assert.ok(updated.startsWith(source.trimEnd()));
    assert.equal(configureCodexConfig(updated), updated);
  }
});

// A literal string cannot hold an apostrophe or a control character, so those get a basic string.
function toml(values) { return `[${values.map((value) => /[' -]/.test(value) ? JSON.stringify(value) : `'${value}'`).join(", ")}]`; }

const PROFILES = "terminal.integrated.profiles.windows";

/** @param {string} text */
function parsedJsonc(text) {
  /** @type {import("jsonc-parser").ParseError[]} */
  const errors = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true });
  assert.deepEqual(errors, [], "the result must be valid JSONC");
  return value;
}

test("VS Code migration ignores a brace inside a leading line comment", () => {
  const source = '// example {}\n{\n  "editor.fontSize": 14\n}\n';
  const updated = configureVsCodeSettings(source);
  assert.ok(updated.startsWith("// example {}\n"), "the comment stays first and untouched");
  const value = parsedJsonc(updated);
  assert.equal(value["editor.fontSize"], 14);
  assert.ok(value[PROFILES]["Claude Code"] && value[PROFILES].Codex);
  assert.equal(configureVsCodeSettings(updated), updated);
});

test("VS Code migration ignores a profiles key quoted inside a block comment", () => {
  const source = `{\n  /* "${PROFILES}": { "Other": {} } */\n  "editor.fontSize": 14\n}\n`;
  const updated = configureVsCodeSettings(source);
  assert.ok(updated.includes(`/* "${PROFILES}": { "Other": {} } */`), "the comment is kept verbatim");
  const value = parsedJsonc(updated);
  assert.deepEqual(Object.keys(value[PROFILES]).sort(), ["Claude Code", "Codex"]);
  assert.equal(value["editor.fontSize"], 14);
});

test("VS Code migration ignores a profile name quoted inside a string value", () => {
  const source = `{\n  "note": "\\"Codex\\": { not a profile",\n  "${PROFILES}": {}\n}\n`;
  const value = parsedJsonc(configureVsCodeSettings(source));
  assert.equal(value.note, '"Codex": { not a profile');
  assert.ok(value[PROFILES].Codex);
});

test("Claude migration keeps comments and trailing commas in settings.json", () => {
  const source = '// my settings {\n{\n  "model": "x", // keep\n  "env": {"A": "1",},\n}\n';
  const updated = configureClaudeSettings(source, { nodePath: NODE, adapterPath: CLAUDE_ADAPTER });
  assert.ok(updated.includes("// my settings {"));
  assert.ok(updated.includes("// keep"));
  const value = parsedJsonc(updated);
  assert.equal(value.model, "x");
  assert.deepEqual(value.env, { A: "1" });
  assert.equal(value.hooks.StopFailure.length, 1);
});

test("Codex migration recognises a [tui] header with a trailing comment", () => {
  const source = 'model = "x"\n\n[tui] # terminal settings\nfoo = 1\n';
  const updated = configureCodexConfig(source);
  assert.equal((updated.match(/^\s*\[\s*tui\s*\]/gm) ?? []).length, 1, "one [tui] table");
  assert.ok(updated.includes("[tui] # terminal settings"));
  const value = parseToml(updated);
  assert.equal(value.tui.foo, 1);
  assert.equal(value.tui.notification_method, "osc9");
  assert.equal(configureCodexConfig(updated), updated);
});

test("Codex migration recognises a [ tui ] header with inner spaces", () => {
  const updated = configureCodexConfig("[ tui ]\nfoo = 1\n");
  const value = parseToml(updated);
  assert.equal(value.tui.foo, 1);
  assert.equal(value.tui.notification_condition, "unfocused");
  assert.equal(configureCodexConfig(updated), updated);
});

test("Codex migration ends the [tui] section at a following header that has a comment", () => {
  const source = '[tui]\nfoo = 1\n\n[other] # not tui\nnotifications = ["x"]\n';
  const value = parseToml(configureCodexConfig(source));
  assert.deepEqual({ ...value.other }, { notifications: ["x"] });
  assert.equal(value.tui.notification_method, "osc9");
});

test("Codex migration refuses a tui table written as dotted keys or an inline table", () => {
  for (const source of [
    'tui.notifications = ["agent-turn-complete"]\n',
    'model = "x"\ntui.theme = "dark"\n',
    'tui = { theme = "dark" }\n',
    '"tui".theme = "dark"\n',
  ]) {
    assert.throws(() => configureCodexConfig(source), /tui/i, source);
  }
});

test("the safety gate refuses a candidate that changes an unrelated key, breaks syntax or misses a managed value", () => {
  const original = '{\n  "a": 1,\n  "b": {"c": 2}\n}\n';
  const managed = [{ path: ["m"], value: 5 }];
  assert.doesNotThrow(() => configuration.assertCandidateSafe("jsonc", original, '{"a": 1, "b": {"c": 2}, "m": 5}', managed));
  assert.throws(() => configuration.assertCandidateSafe("jsonc", original, '{"a": 1, "b": {"c": 3}, "m": 5}', managed), /unrelated/i);
  assert.throws(() => configuration.assertCandidateSafe("jsonc", original, '{"a": 1, "m": 5}', managed), /unrelated/i);
  assert.throws(() => configuration.assertCandidateSafe("jsonc", original, '{"a": 1, "b": {"c": 2}, "m": 6}', managed), /managed/i);
  assert.throws(() => configuration.assertCandidateSafe("jsonc", original, '{"a": 1, "b": {"c": 2}, "m": 5', managed), /parse|valid/i);
  const toml = "a = 1\n[b]\nc = 2\n";
  const tomlManaged = [{ path: ["b", "m"], value: 5 }];
  assert.doesNotThrow(() => configuration.assertCandidateSafe("toml", toml, `${toml}m = 5\n`, tomlManaged));
  assert.throws(() => configuration.assertCandidateSafe("toml", toml, "a = 2\n[b]\nc = 2\nm = 5\n", tomlManaged), /unrelated/i);
  assert.throws(() => configuration.assertCandidateSafe("toml", toml, `${toml}[b]\nm = 5\n`, tomlManaged), /parse|valid/i);
});

test("a JSONC file holding a __proto__ key is refused, because the parser would drop it unseen", () => {
  // Codex review of 4870457: jsonc-parser drops a "__proto__" member from both
  // sides, so the deep-equal gate cannot see Ahton deleting it. The escaped
  // spelling even sets the parsed object's prototype.
  const managed = [{ path: ["m"], value: 5 }];
  for (const key of ['"__proto__"', '"\\u005f_proto__"']) {
    const original = `{"hooks": {${key}: "keep"}, "a": 1}`;
    assert.throws(
      () => configuration.assertCandidateSafe("jsonc", original, '{"hooks": {}, "a": 1, "m": 5}', managed),
      /__proto__/,
    );
  }
  assert.throws(
    () => configuration.assertCandidateSafe("jsonc", '{"a": 1}', '{"a": 1, "m": 5, "__proto__": {}}', managed),
    /__proto__/,
  );
});

test("a refused file stops the whole run before any of the three files is written", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ahton-gate-"));
  try {
    const paths = {
      claudeHome: path.join(root, ".claude"),
      claudeSettings: path.join(root, ".claude", "settings.json"),
      codexHome: path.join(root, ".codex"),
      codexConfig: path.join(root, ".codex", "config.toml"),
      vscodeSettings: path.join(root, "Code", "User", "settings.json"),
      journalDirectory: path.join(root, "storage", "migrations"),
    };
    fs.mkdirSync(paths.claudeHome);
    fs.mkdirSync(paths.codexHome);
    fs.mkdirSync(path.dirname(paths.vscodeSettings), { recursive: true });
    const originals = new Map([
      [paths.claudeSettings, '{"model": "x"}\n'],
      [paths.codexConfig, 'tui.theme = "dark"\n'],
      [paths.vscodeSettings, '// c {}\n{"editor.fontSize": 14}\n'],
    ]);
    for (const [file, text] of originals) fs.writeFileSync(file, text);
    const ui = { confirm: async () => true, notify: async () => {} };
    await assert.rejects(runConfigure({ paths, nodePath: "C:\\Work\\node.exe", adapterPath: "C:\\Work\\claude-signal.mjs", ui }), /tui/i);
    for (const [file, text] of originals) assert.equal(fs.readFileSync(file, "utf8"), text, `${path.basename(file)} unchanged`);
    assert.equal(fs.existsSync(paths.journalDirectory), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
