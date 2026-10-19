#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  configureCodexConfig,
  configureClaudeSettings,
  configureVsCodeSettings,
} from "../src/configuration.mjs";
import { applyPlan, rollback } from "../src/configure-runner.mjs";


function parseArgs(argv) {
  const options = { apply: false, rollback: "", fixtureRoot: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--rollback") options.rollback = argv[++index] ?? "";
    else if (arg === "--fixture-root") options.fixtureRoot = argv[++index] ?? "";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.rollback && (options.apply || options.fixtureRoot)) throw new Error("Rollback cannot be combined with other modes");
  return options;
}

function resolvePaths(options) {
  if (options.fixtureRoot) {
    if (process.env.AHTON_CONFIGURE_TEST !== "1") throw new Error("Fixture mode is test-only");
    return {
      adapterRoot: path.join(options.fixtureRoot, "adapters"),
      codex: path.join(options.fixtureRoot, "config.toml"),
      claude: path.join(options.fixtureRoot, "claude-settings.json"),
      vscode: path.join(options.fixtureRoot, "settings.json"),
      journalDirectory: path.join(options.fixtureRoot, "journals"),
    };
  }
  const userProfile = process.env.USERPROFILE;
  const localAppData = process.env.LOCALAPPDATA;
  const appData = process.env.APPDATA;
  if (!userProfile || !localAppData || !appData) throw new Error("Required Windows user directories are unavailable");
  return {
    // The extension copies its adapters here on activation, so the path survives updates.
    adapterRoot: path.join(appData, "Code", "User", "globalStorage", "kidneys3.ahton", "adapters"),
    codex: path.join(userProfile, ".codex", "config.toml"),
    claude: path.join(userProfile, ".claude", "settings.json"),
    vscode: path.join(appData, "Code", "User", "settings.json"),
    journalDirectory: path.join(localAppData, "Ahton", "migrations"),
  };
}

function plan(paths) {
  const claudeAdapter = path.join(paths.adapterRoot, "claude-signal.mjs");
  for (const required of [claudeAdapter, paths.codex, paths.claude, paths.vscode]) {
    if (!fs.existsSync(required)) throw new Error(`Required installed component is unavailable: ${path.basename(required)}`);
  }
  const nodePath = process.execPath;
  const originals = {
    codex: fs.readFileSync(paths.codex, "utf8"),
    claude: fs.readFileSync(paths.claude, "utf8"),
    vscode: fs.readFileSync(paths.vscode, "utf8"),
  };
  const updated = {
    codex: configureCodexConfig(originals.codex),
    claude: configureClaudeSettings(originals.claude, { nodePath, adapterPath: claudeAdapter }),
    vscode: configureVsCodeSettings(originals.vscode),
  };
  return Object.entries(originals).map(([key, original]) => ({
    key,
    path: paths[key],
    original,
    updated: updated[key],
    changed: original !== updated[key],
  }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.rollback) {
    rollback(path.resolve(options.rollback));
    process.stdout.write("AHTON_ROLLBACK_OK\n");
    return;
  }
  const paths = resolvePaths(options);
  const items = plan(paths);
  for (const item of items) process.stdout.write(`${item.key}: ${item.changed ? "change" : "unchanged"}${os.EOL}`);
  if (!options.apply) {
    process.stdout.write("AHTON_PREVIEW_ONLY\n");
    return;
  }
  if (!items.some((item) => item.changed)) {
    process.stdout.write("AHTON_ALREADY_CONFIGURED\n");
    return;
  }
  const journal = applyPlan(items, paths);
  process.stdout.write(`AHTON_APPLY_OK journal=${journal}${os.EOL}`);
}

main().catch((error) => {
  process.stderr.write(`AHTON_CONFIGURE_FAILED ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
