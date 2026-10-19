import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Measured 2026-10-19: the 0.6.9 VSIX shipped an untracked claim note holding a
// private home path, because vsce packages the working directory and the
// .vscodeignore exclusion list only covered names someone remembered to add.
// This asks vsce itself, the thing that builds the package, what it would ship.
const SHIPPED = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "dist/adapters/claude-rollover.mjs",
  "dist/adapters/claude-signal.mjs",
  "dist/extension.js",
  "images/icon.png",
  "native/windows-focus-helper.exe",
  "package.json",
];

function vsceListing() {
  const vsce = path.join(root, "node_modules", "@vscode", "vsce", "vsce");
  return execFileSync(process.execPath, [vsce, "ls", "--no-dependencies"], {
    cwd: root,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter(Boolean)
    .sort();
}

test("the VSIX ships only the allowlisted files, whatever else sits in the folder", () => {
  // A unique name, created exclusively: the test never overwrites, and never
  // deletes, a file it did not create itself.
  const planted = path.join(
    root,
    `.remember-CLAIM-vsix-probe-${process.pid}-${randomBytes(6).toString("hex")}.md`,
  );
  fs.writeFileSync(planted, "probe: an untracked note must never ship\n", { flag: "wx" });
  try {
    const listed = vsceListing();
    assert.deepEqual(listed, SHIPPED);
  } finally {
    fs.rmSync(planted, { force: true });
  }
});

test("the third-party notice names no runtime dependency the package does not declare", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const notices = fs.readFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.deepEqual(manifest.dependencies, {});
  assert.doesNotMatch(notices, /node-notifier/);
});

// w79e9: nothing public carries a personal name, a private project word or a
// home-directory path. The words are built from parts so this file does not
// match its own check. The text scan covers every file vsce would ship and every
// source folder that feeds the repository's first public commit.
const FORBIDDEN = [
  ["a personal name", new RegExp(["sha", "ne"].join(""), "i")],
  ["a private project word", new RegExp(
    String.raw`\b(${["med" + "bundle", "scri" + "be", "cali" + "brate", "lat" + "ch", "resea" + "rch"].join("|")})\b`,
    "i",
  )],
  ["a home-directory path", new RegExp(String.raw`[A-Za-z]:[\/]{1,2}` + "Us" + String.raw`ers[\/]`, "i")],
];

function textFilesUnder(relative) {
  const full = path.join(root, relative);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return [relative];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? textFilesUnder(path.join(relative, entry.name)) : [path.join(relative, entry.name)]);
}

function assertNoForbidden(files) {
  const found = [];
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(root, file));
    if (bytes.includes(0)) continue;
    const lines = bytes.toString("utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const [what, pattern] of FORBIDDEN) {
        if (pattern.test(line)) found.push(`${file.replaceAll("\\", "/")}:${index + 1} ${what}`);
      }
    });
  }
  assert.deepEqual(found, []);
}

test("no file vsce would ship holds a personal name, a private project word or a home path", () => {
  assertNoForbidden(vsceListing());
});

test("the source folders hold no personal name, private project word or home path", () => {
  const files = [
    ...["src", "adapters", "test", "scripts"].flatMap(textFilesUnder),
    "native/windows-focus-helper.cpp",
    "native/README.md",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "package.json",
    "llms.txt",
  ].filter((file) => fs.existsSync(path.join(root, file)));
  assertNoForbidden(files);
});

test("the listing icon is a 128 by 128 PNG", () => {
  const bytes = fs.readFileSync(path.join(root, "images", "icon.png"));
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(bytes.readUInt32BE(16), 128);
  assert.equal(bytes.readUInt32BE(20), 128);
});

test("llms.txt is not shipped in the VSIX and follows the llmstxt.org shape", () => {
  assert.equal(vsceListing().includes("llms.txt"), false);
  const text = fs.readFileSync(path.join(root, "llms.txt"), "utf8");
  assert.match(text, /^# Ahton/);
  assert.match(text, /^> .+/m);
  assert.match(text, /marketplace\.visualstudio\.com\/items\?itemName=kidneys3\.ahton/);
  assert.match(text, /open-vsx\.org\/extension\/kidneys3\/ahton/);
});
