import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * One file the migration may change. `original` is null when the file does not
 * exist yet, so a fresh install is a plan to create it, not an error.
 *
 * @typedef {{key: string, path: string, original: string | null, updated: string, changed: boolean, backup?: string}} PlanItem
 */

/** @param {string | Buffer} value */
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

/** @param {string} file @returns {string | null} */
export function readIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") return null;
    throw error;
  }
}

/** @param {string} target @param {string | Buffer} content @param {string} runId */
export function atomicWrite(target, content, runId) {
  const temporary = `${target}.${runId}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  if (process.platform === "win32" && fs.existsSync(target)) {
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "& { param($source,$destination) Move-Item -LiteralPath $source -Destination $destination -Force }",
      temporary, target,
    ], { windowsHide: true, stdio: "pipe", encoding: "utf8" });
    if (result.status !== 0 || result.error) {
      fs.rmSync(temporary, { force: true });
      throw result.error ?? new Error("Atomic replacement failed");
    }
  } else {
    fs.renameSync(temporary, target);
  }
}

/**
 * Writes every changed item, or none: a failure part-way restores the files
 * already written. Each existing file is backed up first and the run is
 * journalled, so `rollback` can undo it later.
 *
 * @param {PlanItem[]} items
 * @param {{journalDirectory: string}} paths
 * @returns {string} the journal path
 */
export function applyPlan(items, paths) {
  const changed = items.filter((item) => item.changed);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  // Check every file before touching any of them.
  for (const item of changed) {
    if (readIfPresent(item.path) !== item.original) throw new Error(`Configuration changed during planning: ${item.key}`);
  }
  fs.mkdirSync(paths.journalDirectory, { recursive: true });
  const journalPath = path.join(paths.journalDirectory, `${runId}.json`);
  for (const item of changed) {
    if (item.original === null) continue;
    item.backup = `${item.path}.bak-ahton-${runId}`;
    fs.copyFileSync(item.path, item.backup, fs.constants.COPYFILE_EXCL);
  }
  const journal = {
    version: 1,
    runId,
    status: "prepared",
    createdAt: new Date().toISOString(),
    targets: changed.map((item) => ({
      key: item.key, path: item.path, backup: item.backup ?? null,
      beforeSha256: item.original === null ? null : hash(item.original), afterSha256: hash(item.updated),
    })),
  };
  atomicWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`, runId);
  /** @type {PlanItem[]} */
  const written = [];
  try {
    for (const item of changed) {
      if (readIfPresent(item.path) !== item.original) throw new Error(`Configuration changed before write: ${item.key}`);
      atomicWrite(item.path, item.updated, runId);
      written.push(item);
    }
    journal.status = "applied";
    /** @type {any} */ (journal).appliedAt = new Date().toISOString();
    fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  } catch (error) {
    for (const item of written.reverse()) {
      if (item.backup) atomicWrite(item.path, fs.readFileSync(item.backup), `${runId}-recovery-${item.key}`);
      else fs.rmSync(item.path, { force: true });
    }
    journal.status = "rolled_back_after_error";
    /** @type {any} */ (journal).error = error instanceof Error ? error.message : "unknown error";
    fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    throw error;
  }
  return journalPath;
}

/** @param {string} journalPath */
export function rollback(journalPath) {
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  if (journal.version !== 1 || journal.status !== "applied" || !Array.isArray(journal.targets)) {
    throw new Error("Journal is not an applied Ahton migration");
  }
  for (const target of journal.targets) {
    if (hash(fs.readFileSync(target.path)) !== target.afterSha256) throw new Error(`Rollback precondition failed: ${target.key}`);
    // A file the run created has no backup; rollback removes it again.
    if (target.backup && hash(fs.readFileSync(target.backup)) !== target.beforeSha256) {
      throw new Error(`Rollback backup failed verification: ${target.key}`);
    }
  }
  const rollbackId = `${journal.runId}-rollback-${crypto.randomUUID()}`;
  const restored = [];
  const afterContents = new Map(journal.targets.map((/** @type {any} */ target) => [target.key, fs.readFileSync(target.path)]));
  try {
    for (const target of journal.targets) {
      if (target.backup) atomicWrite(target.path, fs.readFileSync(target.backup), `${rollbackId}-${target.key}`);
      else fs.rmSync(target.path, { force: true });
      restored.push(target);
    }
  } catch (error) {
    for (const target of restored.reverse()) {
      atomicWrite(target.path, afterContents.get(target.key), `${rollbackId}-recovery-${target.key}`);
    }
    journal.status = "rollback_failed_recovered";
    journal.rollbackError = error instanceof Error ? error.message : "unknown error";
    fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    throw error;
  }
  journal.status = "rolled_back";
  journal.rolledBackAt = new Date().toISOString();
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
}
