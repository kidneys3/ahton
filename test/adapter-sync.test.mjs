import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { syncAdapters } from "../src/adapter-sync.mjs";

function folders() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ahton-adapters-"));
  const source = path.join(root, "extension", "dist", "adapters");
  const target = path.join(root, "storage", "adapters");
  fs.mkdirSync(source, { recursive: true });
  return { root, source, target };
}

test("adapters are copied into storage that survives an extension update", () => {
  const { root, source, target } = folders();
  try {
    fs.writeFileSync(path.join(source, "claude-signal.mjs"), "signal v1");
    fs.writeFileSync(path.join(source, "claude-rollover.mjs"), "rollover v1");
    fs.writeFileSync(path.join(source, "notes.txt"), "not an adapter");
    const result = syncAdapters({ sourceDirectory: source, targetDirectory: target });
    assert.deepEqual(result.copied.sort(), ["claude-rollover.mjs", "claude-signal.mjs"]);
    assert.equal(fs.readFileSync(path.join(target, "claude-signal.mjs"), "utf8"), "signal v1");
    assert.equal(fs.existsSync(path.join(target, "notes.txt")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an adapter whose bytes already match is not rewritten", () => {
  const { root, source, target } = folders();
  try {
    fs.writeFileSync(path.join(source, "claude-signal.mjs"), "signal v1");
    syncAdapters({ sourceDirectory: source, targetDirectory: target });
    const before = fs.statSync(path.join(target, "claude-signal.mjs")).mtimeMs;
    const again = syncAdapters({ sourceDirectory: source, targetDirectory: target });
    assert.deepEqual(again.copied, []);
    assert.deepEqual(again.unchanged, ["claude-signal.mjs"]);
    assert.equal(fs.statSync(path.join(target, "claude-signal.mjs")).mtimeMs, before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a changed adapter replaces the old copy and leaves no temporary file", () => {
  const { root, source, target } = folders();
  try {
    fs.writeFileSync(path.join(source, "claude-signal.mjs"), "signal v1");
    syncAdapters({ sourceDirectory: source, targetDirectory: target });
    fs.writeFileSync(path.join(source, "claude-signal.mjs"), "signal v2");
    const result = syncAdapters({ sourceDirectory: source, targetDirectory: target });
    assert.deepEqual(result.copied, ["claude-signal.mjs"]);
    assert.equal(fs.readFileSync(path.join(target, "claude-signal.mjs"), "utf8"), "signal v2");
    assert.deepEqual(fs.readdirSync(target), ["claude-signal.mjs"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed write leaves the previous copy in place and removes its temporary file", () => {
  const { root, source, target } = folders();
  try {
    fs.writeFileSync(path.join(source, "claude-signal.mjs"), "signal v1");
    syncAdapters({ sourceDirectory: source, targetDirectory: target });
    fs.writeFileSync(path.join(source, "claude-signal.mjs"), "signal v2");
    const failing = { ...fs, renameSync() { throw new Error("rename refused"); } };
    assert.throws(
      () => syncAdapters({ sourceDirectory: source, targetDirectory: target, fsApi: failing }),
      /rename refused/,
    );
    assert.equal(fs.readFileSync(path.join(target, "claude-signal.mjs"), "utf8"), "signal v1");
    assert.deepEqual(fs.readdirSync(target), ["claude-signal.mjs"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
