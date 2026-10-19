import fs from "node:fs";
import path from "node:path";

import {
  configureClaudeSettings,
  configureCodexConfig,
  configureVsCodeSettings,
} from "./configuration.mjs";
import { applyPlan, readIfPresent } from "./configure-runner.mjs";

/**
 * @typedef {{
 *   claudeHome: string, claudeSettings: string,
 *   codexHome: string, codexConfig: string,
 *   vscodeSettings: string, journalDirectory: string,
 * }} ConfigurePaths
 * @typedef {{
 *   confirm: (message: string, detail: string) => Promise<boolean>,
 *   notify: (message: string) => Promise<void>,
 * }} ConfigureUi
 */

/**
 * First `node.exe` on PATH, or null. The extension host's own process.execPath
 * is the editor, not Node, so a hook command cannot use it.
 *
 * @param {string | undefined} pathValue
 * @param {(file: string) => boolean} [exists]
 */
export function findNodeExecutable(pathValue, exists = fs.existsSync) {
  for (const directory of String(pathValue ?? "").split(path.delimiter)) {
    const trimmed = directory.trim().replace(/^"|"$/g, "");
    if (!trimmed) continue;
    const candidate = path.join(trimmed, "node.exe");
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Plans the migration with the same writers the command-line script uses, shows
 * the user which files change, and writes only after an explicit yes. The
 * preview carries paths and a summary, never the content of any file.
 *
 * @param {{
 *   paths: ConfigurePaths,
 *   nodePath: string | null,
 *   adapterPath: string,
 *   ui: ConfigureUi,
 * }} options
 * @returns {Promise<{status: "applied" | "already_configured" | "cancelled" | "nothing_to_configure", journal?: string}>}
 */
export async function runConfigure({ paths, nodePath, adapterPath, ui }) {
  /** @type {string[]} */
  const skipped = [];
  /** @type {string[]} */
  const summary = [];
  let claude = false;
  if (!fs.existsSync(paths.claudeHome)) skipped.push("Claude Code skipped: no .claude folder was found.");
  else if (!nodePath) skipped.push("Claude Code skipped: Node.js was not found on PATH. The Claude hook needs it.");
  else claude = true;
  const codex = fs.existsSync(paths.codexHome);
  if (!codex) skipped.push("Codex CLI skipped: no .codex folder was found.");

  if (!claude && !codex) {
    await ui.notify(`Nothing to configure. ${skipped.join(" ")}`);
    return { status: "nothing_to_configure" };
  }

  /** @type {import("./configure-runner.mjs").PlanItem[]} */
  const items = [];
  /** @param {string} key @param {string} file @param {(original: string) => string} write */
  const plan = (key, file, write) => {
    const original = readIfPresent(file);
    const updated = write(original ?? "");
    items.push({ key, path: file, original, updated, changed: original !== updated });
  };
  if (claude) {
    plan("claude", paths.claudeSettings, (text) => configureClaudeSettings(text, { nodePath: /** @type {string} */ (nodePath), adapterPath }));
    summary.push("Claude Code: Notification and StopFailure hooks that run the Ahton adapter.");
  }
  if (codex) {
    plan("codex", paths.codexConfig, (text) => configureCodexConfig(text));
    summary.push("Codex CLI: terminal notification options in the [tui] section.");
  }
  plan("vscode", paths.vscodeSettings, (text) => configureVsCodeSettings(text, { claude, codex }));
  summary.push(`VS Code: terminal profiles for ${[claude && "Claude Code", codex && "Codex"].filter(Boolean).join(" and ")}.`);

  if (!items.some((item) => item.changed)) {
    await ui.notify("Ahton is already configured. Nothing to change.");
    return { status: "already_configured" };
  }

  const lines = items.map((item) => {
    const state = !item.changed ? "unchanged" : item.original === null ? "new file" : "change";
    return `${state}: ${item.path}`;
  });
  const detail = [
    ...lines,
    "",
    ...summary,
    ...skipped,
    "",
    "A timestamped backup of each changed file is kept beside it, and a journal records the run so it can be rolled back.",
  ].join("\n");
  if (!(await ui.confirm("Ahton will change these files.", detail))) return { status: "cancelled" };

  const journal = applyPlan(items, paths);
  return { status: "applied", journal };
}
