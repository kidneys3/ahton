import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runConfigure } from "../src/configure-command.mjs";
import { rollback } from "../src/configure-runner.mjs";

const NODE = "C:\\Work\\fixture\\node.exe";
const ADAPTER = "C:\\Work\\fixture\\storage\\adapters\\claude-signal.mjs";

/** A fake user home with the three config locations under it. */
function home({ claude = true, codex = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ahton-configure-command-"));
  const paths = {
    claudeHome: path.join(root, ".claude"),
    claudeSettings: path.join(root, ".claude", "settings.json"),
    codexHome: path.join(root, ".codex"),
    codexConfig: path.join(root, ".codex", "config.toml"),
    vscodeSettings: path.join(root, "Code", "User", "settings.json"),
    journalDirectory: path.join(root, "storage", "migrations"),
  };
  if (claude) fs.mkdirSync(paths.claudeHome);
  if (codex) fs.mkdirSync(paths.codexHome);
  return { root, paths };
}

function recordingUi(answer) {
  const calls = { confirm: [], notify: [] };
  return {
    calls,
    ui: {
      confirm: async (message, detail) => { calls.confirm.push({ message, detail }); return answer; },
      notify: async (message) => { calls.notify.push(message); },
    },
  };
}

test("a fresh install is created, not rejected, once the user confirms", async () => {
  const { root, paths } = home();
  try {
    const { ui, calls } = recordingUi(true);
    const result = await runConfigure({ paths, nodePath: NODE, adapterPath: ADAPTER, ui });
    assert.equal(result.status, "applied");
    assert.equal(calls.confirm.length, 1);
    const hooks = JSON.parse(fs.readFileSync(paths.claudeSettings, "utf8")).hooks;
    assert.match(hooks.Notification[0].hooks[0].command, /claude-signal\.mjs/);
    assert.match(fs.readFileSync(paths.codexConfig, "utf8"), /^\[tui\]/m);
    const vscode = fs.readFileSync(paths.vscodeSettings, "utf8");
    assert.match(vscode, /"Claude Code"/);
    assert.match(vscode, /"Codex"/);
    const again = await runConfigure({ paths, nodePath: NODE, adapterPath: ADAPTER, ui: recordingUi(true).ui });
    assert.equal(again.status, "already_configured");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nothing is written until the user confirms", async () => {
  const { root, paths } = home();
  try {
    const { ui, calls } = recordingUi(false);
    const result = await runConfigure({ paths, nodePath: NODE, adapterPath: ADAPTER, ui });
    assert.equal(result.status, "cancelled");
    assert.equal(calls.confirm.length, 1);
    for (const file of [paths.claudeSettings, paths.codexConfig, paths.vscodeSettings]) {
      assert.equal(fs.existsSync(file), false, `${path.basename(file)} must not exist`);
    }
    assert.equal(fs.existsSync(paths.journalDirectory), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the preview names the files and a summary, and carries none of their contents", async () => {
  const { root, paths } = home();
  try {
    const sentinel = "SENTINEL-TOKEN-0000";
    fs.writeFileSync(paths.claudeSettings, JSON.stringify({ env: { API_TOKEN: sentinel } }));
    fs.writeFileSync(paths.codexConfig, `# ${sentinel}\n[tui]\nstatus_line = ["model"]\n`);
    const { ui, calls } = recordingUi(false);
    await runConfigure({ paths, nodePath: NODE, adapterPath: ADAPTER, ui });
    const { message, detail } = calls.confirm[0];
    const shown = `${message}\n${detail}`;
    assert.ok(shown.includes(paths.claudeSettings));
    assert.ok(shown.includes(paths.codexConfig));
    assert.ok(shown.includes(paths.vscodeSettings));
    assert.match(shown, /new file/);
    assert.equal(shown.includes(sentinel), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a confirmed run keeps a timestamped backup and a journal, and rollback restores the bytes", async () => {
  const { root, paths } = home();
  try {
    const before = `${JSON.stringify({ model: "fixture" }, null, 2)}\n`;
    fs.writeFileSync(paths.claudeSettings, before);
    const result = await runConfigure({ paths, nodePath: NODE, adapterPath: ADAPTER, ui: recordingUi(true).ui });
    assert.equal(result.status, "applied");
    const backups = fs.readdirSync(paths.claudeHome).filter((name) => name.includes(".bak-ahton-"));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /\.bak-ahton-\d{4}-\d{2}-\d{2}T/);
    assert.ok(fs.existsSync(result.journal));
    rollback(result.journal);
    assert.equal(fs.readFileSync(paths.claudeSettings, "utf8"), before);
    // A file the run created is removed again, not left behind empty.
    assert.equal(fs.existsSync(paths.codexConfig), false);
    assert.equal(fs.existsSync(paths.vscodeSettings), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a provider whose folder is missing is skipped with a message, not an error", async () => {
  const { root, paths } = home({ codex: false });
  try {
    const { ui, calls } = recordingUi(true);
    const result = await runConfigure({ paths, nodePath: NODE, adapterPath: ADAPTER, ui });
    assert.equal(result.status, "applied");
    assert.equal(fs.existsSync(paths.codexConfig), false);
    assert.equal(fs.existsSync(paths.codexHome), false);
    const vscode = fs.readFileSync(paths.vscodeSettings, "utf8");
    assert.match(vscode, /"Claude Code"/);
    assert.doesNotMatch(vscode, /"Codex"/);
    assert.match(`${calls.confirm[0].detail}`, /Codex CLI skipped/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("with neither provider installed nothing is planned and the user is told why", async () => {
  const { root, paths } = home({ claude: false, codex: false });
  try {
    const { ui, calls } = recordingUi(true);
    const result = await runConfigure({ paths, nodePath: NODE, adapterPath: ADAPTER, ui });
    assert.equal(result.status, "nothing_to_configure");
    assert.equal(calls.confirm.length, 0);
    assert.match(calls.notify.join("\n"), /Claude Code skipped/);
    assert.match(calls.notify.join("\n"), /Codex CLI skipped/);
    assert.equal(fs.existsSync(paths.vscodeSettings), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("without Node.js the Claude hook is skipped with a message and Codex still proceeds", async () => {
  const { root, paths } = home();
  try {
    const { ui, calls } = recordingUi(true);
    const result = await runConfigure({ paths, nodePath: null, adapterPath: ADAPTER, ui });
    assert.equal(result.status, "applied");
    assert.equal(fs.existsSync(paths.claudeSettings), false);
    assert.match(calls.confirm[0].detail, /Claude Code skipped: Node\.js was not found/);
    assert.match(fs.readFileSync(paths.codexConfig, "utf8"), /notification_method/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a settings file that changed after the preview aborts the write", async () => {
  const { root, paths } = home();
  try {
    fs.writeFileSync(paths.claudeSettings, "{}\n");
    const ui = {
      confirm: async () => { fs.writeFileSync(paths.claudeSettings, '{"edited":true}\n'); return true; },
      notify: async () => {},
    };
    await assert.rejects(
      runConfigure({ paths, nodePath: NODE, adapterPath: ADAPTER, ui }),
      /changed during planning/,
    );
    assert.equal(fs.readFileSync(paths.claudeSettings, "utf8"), '{"edited":true}\n');
    assert.equal(fs.existsSync(paths.codexConfig), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
