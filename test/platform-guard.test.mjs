import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COMMAND_IDS } from "../src/command-ids.mjs";
import {
  WINDOWS_ONLY_MESSAGE,
  isSupportedPlatform,
  registerWindowsOnlyCommands,
} from "../src/platform-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("only win32 is a supported platform", () => {
  assert.equal(isSupportedPlatform("win32"), true);
  for (const platform of ["darwin", "linux", "freebsd"]) assert.equal(isSupportedPlatform(platform), false);
});

test("the command list in code is exactly the commands the manifest contributes", () => {
  // Two sources: package.json is written by hand, COMMAND_IDS by the guard. If
  // either gains a command alone, a user on another OS gets "command not found".
  assert.deepEqual(
    [...COMMAND_IDS].sort(),
    manifest.contributes.commands.map((command) => command.command).sort(),
  );
});

test("each stub command shows the one Windows-only message and nothing else", async () => {
  const handlers = new Map();
  const shown = [];
  registerWindowsOnlyCommands({
    commandIds: COMMAND_IDS,
    register: (id, handler) => { handlers.set(id, handler); return { dispose() {} }; },
    show: async (message) => { shown.push(message); },
  });
  assert.deepEqual([...handlers.keys()].sort(), [...COMMAND_IDS].sort());
  for (const handler of handlers.values()) await handler();
  assert.equal(shown.length, COMMAND_IDS.length);
  assert.ok(shown.every((message) => message === WINDOWS_ONLY_MESSAGE));
  assert.match(WINDOWS_ONLY_MESSAGE, /Windows only/);
});
