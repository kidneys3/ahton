import assert from "node:assert/strict";
import test from "node:test";

import {
  captureOwningWindow,
  focusOwningWindow,
  parseWindowHandle,
  verifyOwningWindow,
} from "../src/window-focus.mjs";

test("window handle parser accepts only positive decimal uintptr values", () => {
  assert.equal(parseWindowHandle("67514\r\n"), "67514");
  assert.equal(parseWindowHandle("18446744073709551615"), "18446744073709551615");

  for (const value of [
    "",
    "0",
    "-1",
    "+1",
    "0x107ba",
    "67514 extra",
    "18446744073709551616",
    null,
  ]) {
    assert.equal(parseWindowHandle(value), null);
  }
});

test("read-only foreground verification uses a distinct native command", async () => {
  const calls = [];
  const accepted = async (...args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };
  assert.equal(await verifyOwningWindow("focus-helper.exe", "67514", 2832, accepted, "win32"), true);
  assert.deepEqual(calls[0][1], ["verify", "67514", "2832"]);
  assert.equal(await verifyOwningWindow("focus-helper.exe", "0", 2832, accepted, "win32"), false);
});

test("native focus protocol carries only an HWND and extension-host PID", () => {
  const serialized = JSON.stringify({ command: "focus", hwnd: "67514", pid: 2832 });
  for (const privateValue of ["prompt", "reply", "thread", "workspace", "terminal", "path"]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("capture accepts only a native-verified HWND", async () => {
  const calls = [];
  const run = async (...args) => {
    calls.push(args);
    return { stdout: "67514\r\n", stderr: "" };
  };
  assert.equal(await captureOwningWindow("focus-helper.exe", 2832, run, "win32"), "67514");
  assert.deepEqual(calls[0][1], ["capture", "2832"]);

  const rejected = async () => ({ stdout: "api - Docs", stderr: "" });
  assert.equal(await captureOwningWindow("focus-helper.exe", 2832, rejected, "win32"), null);
});

test("focus fails closed when the helper rejects or the HWND is malformed", async () => {
  const calls = [];
  const accepted = async (...args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };
  assert.equal(await focusOwningWindow("focus-helper.exe", "67514", 2832, accepted, "win32"), true);
  assert.deepEqual(calls[0][1], ["focus", "67514", "2832"]);
  assert.equal(await focusOwningWindow("focus-helper.exe", "0x107ba", 2832, accepted, "win32"), false);

  const rejected = async () => { throw new Error("native authority rejected"); };
  assert.equal(await focusOwningWindow("focus-helper.exe", "67514", 2832, rejected, "win32"), false);
});
