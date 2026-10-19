import assert from "node:assert/strict";
import test from "node:test";

import { holdActivatedWindow } from "../src/focus-hold.mjs";

const noWait = async () => {};

function harness({ verdicts, refocusResult = true, live = true }) {
  const calls = { verify: 0, focus: 0 };
  return {
    calls,
    options: {
      wait: noWait,
      isTerminalLive: () => live,
      verifyExactWindow: async () => {
        const verdict = verdicts[calls.verify] ?? verdicts[verdicts.length - 1];
        calls.verify += 1;
        return verdict;
      },
      focusExactWindow: async () => {
        calls.focus += 1;
        return refocusResult;
      },
    },
  };
}

test("a window that stays foreground is held, and is never refocused", () => {
  // Re-asserting focus on a window that already has it would be a visible
  // flicker for no reason.
  const { calls, options } = harness({ verdicts: [true, true, true] });
  return holdActivatedWindow(options).then((outcome) => {
    assert.equal(outcome, "held");
    assert.equal(calls.focus, 0);
  });
});

test("a window that fades back is refocused once and reported as recovered", () => {
  // This is the 2026-08-13 symptom: the right window came forward, then the
  // other window took the foreground back.
  const { calls, options } = harness({ verdicts: [false, true, true] });
  return holdActivatedWindow(options).then((outcome) => {
    assert.equal(outcome, "recovered");
    assert.equal(calls.focus, 1);
  });
});

test("it re-asserts once only, then reports the loss instead of fighting", () => {
  // The user deliberately switching away must not be overridden. One recovery is a
  // handover repair; a second is the extension arguing with him.
  const { calls, options } = harness({ verdicts: [false, false, false] });
  return holdActivatedWindow(options).then((outcome) => {
    assert.equal(outcome, "lost");
    assert.equal(calls.focus, 1);
  });
});

test("a refused native refocus is a loss, not a recovery", () => {
  const { calls, options } = harness({ verdicts: [false], refocusResult: false });
  return holdActivatedWindow(options).then((outcome) => {
    assert.equal(outcome, "lost");
    assert.equal(calls.focus, 1);
  });
});

test("a re-assert on the final check is verified before recovery is claimed", async () => {
  // Without the closing verify, a re-assert issued on the last check would be
  // reported as a recovery that nothing ever confirmed.
  const verdicts = [true, true, false, false];
  const { calls, options } = harness({ verdicts });
  const outcome = await holdActivatedWindow(options);
  assert.equal(outcome, "lost");
  assert.equal(calls.focus, 1);
  assert.equal(calls.verify, 4);
});

test("a terminal closed during the hold ends it without refocusing", () => {
  const { calls, options } = harness({ verdicts: [false], live: false });
  return holdActivatedWindow(options).then((outcome) => {
    assert.equal(outcome, "terminal_not_live");
    assert.equal(calls.focus, 0);
  });
});
