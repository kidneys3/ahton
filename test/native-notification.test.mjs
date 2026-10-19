import assert from "node:assert/strict";
import test from "node:test";

import { startNativeNotification } from "../src/native-notification.mjs";

test("native notification carries only exact identity and fixed enums", async () => {
  const calls = [];
  const run = async (...args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };
  const session = startNativeNotification(
    "focus-helper.exe", "67514", 2832, "codex", "attention",
    { kind: "terminal", index: 3 }, run, "win32",
  );
  assert.equal(await session.outcome, "activated");
  assert.deepEqual(calls[0][1], ["notify", "67514", "2832", "codex", "attention", "terminal", "3"]);
});

test("native notification rejects malformed identity and arbitrary content", async () => {
  let called = false;
  const run = async () => { called = true; };
  for (const values of [
    ["0", 2832, "codex", "attention", { kind: "terminal", index: 1 }],
    ["67514", 0, "codex", "attention", { kind: "terminal", index: 1 }],
    ["67514", 2832, "other", "attention", { kind: "terminal", index: 1 }],
    ["67514", 2832, "codex", "private text", { kind: "terminal", index: 1 }],
    ["67514", 2832, "codex", "attention", { kind: "terminal", index: 0 }],
    ["67514", 2832, "codex", "attention", { kind: "conversation", index: 1 }],
  ]) {
    const session = startNativeNotification("helper.exe", ...values, run, "win32");
    assert.equal(await session.outcome, "failed");
  }
  assert.equal(called, false);
});

test("native notification maps dismiss, timeout, failure, and cancellation", async () => {
  for (const [code, expected] of [[20, "dismissed"], [21, "timed_out"], [22, "failed"]]) {
    const run = async () => { throw Object.assign(new Error("native exit"), { code }); };
    const session = startNativeNotification(
      "helper.exe", "67514", 2832, "claude", "finished",
      { kind: "terminal", index: 2 }, run, "win32",
    );
    assert.equal(await session.outcome, expected);
  }

  const runUntilAbort = (_path, _args, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const session = startNativeNotification(
    "helper.exe", "67514", 2832, "codex", "attention",
    { kind: "terminal", index: 1 }, runUntilAbort, "win32",
  );
  session.dispose();
  assert.equal(await session.outcome, "cancelled");
});

test("native notification accepts terminal display targets only", async () => {
  let called = false;
  const run = async () => {
    called = true;
    return { stdout: "", stderr: "" };
  };
  const session = startNativeNotification(
    "helper.exe", "67514", 2832, "codex", "finished",
    { kind: "conversation", index: 0 }, run, "win32",
  );
  assert.equal(await session.outcome, "failed");
  assert.equal(called, false);
});

async function argvFor(target) {
  const calls = [];
  const run = async (...args) => { calls.push(args); return { stdout: "", stderr: "" }; };
  const session = startNativeNotification(
    "helper.exe", "67514", 2832, "codex", "attention", target, run, "win32",
  );
  return { outcome: await session.outcome, args: calls[0]?.[1] };
}

test("a workspace name alone is sent in the ten-argument form with an empty label slot", async () => {
  const { outcome, args } = await argvFor({ kind: "terminal", index: 3, workspace: "api" });
  assert.equal(outcome, "activated");
  assert.deepEqual(args, ["notify", "67514", "2832", "codex", "attention", "terminal", "3", "", "api"]);
});

test("label and workspace are sent together in the ten-argument form", async () => {
  const { args } = await argvFor({ kind: "terminal", index: 3, label: "claude web", workspace: "web docs" });
  assert.deepEqual(args.slice(6), ["3", "claude web", "web docs"]);
});

test("without a workspace the eight and nine-argument forms are unchanged", async () => {
  assert.deepEqual((await argvFor({ kind: "terminal", index: 3 })).args,
    ["notify", "67514", "2832", "codex", "attention", "terminal", "3"]);
  assert.deepEqual((await argvFor({ kind: "terminal", index: 3, label: "claude web" })).args,
    ["notify", "67514", "2832", "codex", "attention", "terminal", "3", "claude web"]);
});

test("a tampered workspace refuses the whole popup", async () => {
  for (const workspace of ["C:\Work\api", "a".repeat(29), 'x"y', "api (Workspace)", 5, ""]) {
    const { outcome, args } = await argvFor({ kind: "terminal", index: 1, workspace });
    assert.equal(outcome, "failed");
    assert.equal(args, undefined);
  }
});
