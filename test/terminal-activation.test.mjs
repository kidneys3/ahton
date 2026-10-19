import assert from "node:assert/strict";
import test from "node:test";

import { activateExactTerminal } from "../src/terminal-activation.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const target = { show: () => calls.push("show") };
  let active = target;
  let listener = () => {};
  return {
    calls,
    target,
    setActive(value) { active = value; listener(value); },
    options: {
      terminal: target,
      isTerminalLive: () => true,
      focusWindow: async () => { calls.push("workbench"); },
      focusExactWindow: async () => { calls.push("native-focus"); return true; },
      focusTerminalControl: async () => { calls.push("terminal-focus"); },
      verifyExactWindow: async () => { calls.push("native-verify"); return true; },
      getActiveTerminal: () => active,
      onDidChangeActiveTerminal: (next) => {
        listener = next;
        return { dispose: () => calls.push("dispose") };
      },
      timeoutMs: 20,
      ...overrides,
    },
  };
}

test("success requires exact window and exact active-terminal postconditions", async () => {
  const f = fixture();
  assert.equal(await activateExactTerminal(f.options), "succeeded");
  assert.deepEqual(f.calls, ["workbench", "native-focus", "show", "dispose", "terminal-focus", "native-verify"]);
});

test("a wrong active terminal fails closed without fallback", async () => {
  const decoy = {};
  const f = fixture({ getActiveTerminal: () => decoy });
  assert.equal(await activateExactTerminal(f.options), "exact_terminal_not_active");
  assert.equal(f.calls.includes("native-verify"), false);
});

test("subscription precedes show and accepts an exact synchronous event", async () => {
  const f = fixture();
  let active = null;
  f.options.getActiveTerminal = () => active;
  f.target.show = () => { f.calls.push("show"); active = f.target; f.setActive(f.target); };
  assert.equal(await activateExactTerminal(f.options), "succeeded");
});

test("final window and terminal postconditions are both rechecked", async () => {
  const lostWindow = fixture({ verifyExactWindow: async () => false });
  assert.equal(await activateExactTerminal(lostWindow.options), "exact_window_not_foreground");
  const switched = fixture();
  switched.options.verifyExactWindow = async () => { switched.setActive({}); return true; };
  assert.equal(await activateExactTerminal(switched.options), "exact_terminal_not_active");
});

test("native focus failure does not reveal any terminal", async () => {
  const f = fixture({ focusExactWindow: async () => false });
  assert.equal(await activateExactTerminal(f.options), "native_exact_focus_rejected");
  assert.equal(f.calls.includes("show"), false);
});
