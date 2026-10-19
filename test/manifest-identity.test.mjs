import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const extensionSource = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const vscodeIgnore = fs.readFileSync(path.join(root, ".vscodeignore"), "utf8");

test("the public VS Code extension identity is Ahton", () => {
  assert.equal(manifest.name, "ahton");
  assert.equal(manifest.displayName, "Ahton: Claude Code and Codex CLI Notifications");
  assert.equal(manifest.publisher, "kidneys3");
  assert.deepEqual(manifest.extensionKind, ["ui"]);

  const commands = manifest.contributes.commands;
  assert.ok(commands.length > 0);
  for (const command of commands) {
    assert.match(command.command, /^ahton\./);
    assert.match(command.title, /^Ahton:/);
    assert.match(extensionSource, new RegExp(command.command.replaceAll(".", "\\.")));
  }

  assert.equal(manifest.contributes.configuration.title, "Ahton");
  assert.deepEqual(
    Object.keys(manifest.contributes.configuration.properties),
    ["ahton.enabled", "ahton.showTerminalLabel", "ahton.rollover.enabled"],
  );
  const settings = manifest.contributes.configuration.properties;
  assert.equal(settings["ahton.showTerminalLabel"].type, "boolean");
  assert.equal(settings["ahton.showTerminalLabel"].default, true);
  assert.equal(settings["ahton.rollover.enabled"].type, "boolean");
  assert.equal(settings["ahton.rollover.enabled"].default, false);
  assert.ok(commands.some((command) =>
    command.command === "ahton.configure" &&
    command.title === "Ahton: Configure Claude Code and Codex"));
  assert.doesNotMatch(JSON.stringify(manifest), /Agent Bridge/);
});

test("the extension still runs in a Restricted Mode window", () => {
  // Measured 2026-08-01: in an untrusted folder VS Code activated no
  // third-party extension at all, so without this declaration Ahton is silently
  // dead there and no notification is ever raised.
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, true);
});

test("the shipped product boundary is managed CLI terminals only", () => {
  assert.match(manifest.description, /Claude Code/);
  assert.match(manifest.description, /Codex CLI/);
  assert.doesNotMatch(JSON.stringify(manifest), /conversation/i);
  assert.doesNotMatch(extensionSource, /openai\.chatgpt|conversation_router|vscode\.openWith/);
  assert.equal(fs.existsSync(path.join(root, "adapters", "codex-signal.mjs")), false);
  // .vscode/ holds the live discovery file with a private workspace path. The
  // allowlist excludes everything, so .vscode/ must never be re-included.
  assert.match(vscodeIgnore, /^\*\*$/m);
  assert.doesNotMatch(vscodeIgnore, /^!\.vscode/m);
});

test("the managed Codex CLI terminal opens in the editor tabs", () => {
  const start = extensionSource.indexOf("async function startManagedCodexTerminal");
  const end = extensionSource.indexOf("async function sendTestNotification", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(extensionSource.slice(start, end), /location:\s*vscode\.TerminalLocation\.Editor/);
});

test("the managed Codex CLI terminal uses the green provider colour", () => {
  const start = extensionSource.indexOf("async function startManagedCodexTerminal");
  const end = extensionSource.indexOf("async function sendTestNotification", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(extensionSource.slice(start, end), /color:\s*new vscode\.ThemeColor\("terminal\.ansiGreen"\)/);
});

test("the manifest is ready for a public, Windows x64 Marketplace listing", () => {
  assert.equal(Object.hasOwn(manifest, "private"), false);
  assert.equal(manifest.version, "0.7.0");
  assert.equal(manifest.scripts.package, "vsce package --target win32-x64 --out ahton-0.7.0-win32-x64.vsix");
  assert.equal(manifest.homepage, "https://github.com/kidneys3/ahton#readme");
  assert.equal(manifest.bugs.url, "https://github.com/kidneys3/ahton/issues");
  assert.equal(manifest.repository.url, "https://github.com/kidneys3/ahton.git");
  assert.equal(manifest.icon, "images/icon.png");
});

test("the listing text names both CLIs, the OS, the editor and the click-to-focus behaviour", () => {
  const sentence = manifest.description;
  assert.equal((sentence.match(/\./g) ?? []).length, 1, "one sentence");
  for (const term of [/Claude Code/, /Codex CLI/, /Windows/, /VS Code/, /desktop/i, /click/i, /terminal/i]) {
    assert.match(sentence, term);
  }
  assert.ok(manifest.categories.includes("AI"));
  assert.ok(manifest.categories.includes("Other"));
  // Documented VS Code Marketplace categories. vsce 3.9.2 does not validate them.
  const known = new Set([
    "Programming Languages", "Snippets", "Linters", "Themes", "Debuggers", "Formatters", "Keymaps",
    "SCM Providers", "Other", "Extension Packs", "Language Packs", "Data Science", "Machine Learning",
    "Visualization", "Notebooks", "Education", "Testing", "AI", "Chat",
  ]);
  for (const category of manifest.categories) assert.ok(known.has(category), category);
  assert.ok(manifest.keywords.length >= 10 && manifest.keywords.length <= 30);
  assert.equal(new Set(manifest.keywords.map((word) => word.toLowerCase())).size, manifest.keywords.length);
  for (const term of ["claude code", "codex cli", "notification"]) assert.ok(manifest.keywords.includes(term), term);
});
