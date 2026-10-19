import assert from "node:assert/strict";
import test from "node:test";

import { parseShellPid, selectExactTerminal } from "../src/terminal-selection.mjs";

test("a shell pid is a positive in-range integer, however it arrived", () => {
  assert.equal(parseShellPid(32664), 32664);
  assert.equal(parseShellPid("32664"), 32664);

  for (const bad of [
    null, undefined, "", " ", "0", "-1", "1.5", "0x20", "032664", "abc",
    0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x1_0000_0000, {}, [],
  ]) {
    assert.equal(parseShellPid(bad), null, JSON.stringify(bad));
  }
});

test("exactly the terminal VS Code reports for that pid is selected", () => {
  const claudeTerminal = { id: "claude" };
  const otherTerminal = { id: "other" };
  const candidates = [
    { terminal: claudeTerminal, shellPid: 32664 },
    { terminal: otherTerminal, shellPid: 41000 },
  ];

  assert.equal(selectExactTerminal(32664, candidates), claudeTerminal);
  assert.equal(selectExactTerminal(41000, candidates), otherTerminal);
});

test("a pid this window does not own selects nothing", () => {
  const candidates = [{ terminal: { id: "claude" }, shellPid: 32664 }];
  assert.equal(selectExactTerminal(999999, candidates), null);
  assert.equal(selectExactTerminal(32664, []), null);
  assert.equal(selectExactTerminal(32664, null), null);
});

test("an unusable or duplicated pid fails closed rather than guessing", () => {
  const candidates = [{ terminal: { id: "claude" }, shellPid: 32664 }];
  for (const bad of [0, -1, "", null, undefined, 1.5, "not-a-pid"]) {
    assert.equal(selectExactTerminal(bad, candidates), null, JSON.stringify(bad));
  }

  // A terminal whose pid VS Code could not report never matches.
  assert.equal(selectExactTerminal(0, [{ terminal: {}, shellPid: 0 }]), null);
  assert.equal(selectExactTerminal(32664, [{ terminal: {}, shellPid: undefined }]), null);

  // Two terminals reporting one pid cannot be told apart, so neither is chosen.
  const ambiguous = [
    { terminal: { id: "a" }, shellPid: 32664 },
    { terminal: { id: "b" }, shellPid: "32664" },
  ];
  assert.equal(selectExactTerminal(32664, ambiguous), null);
});

test("a malformed candidate entry cannot crash selection", () => {
  const wanted = { id: "claude" };
  const candidates = [null, undefined, {}, { terminal: wanted, shellPid: 32664 }];
  assert.equal(selectExactTerminal(32664, candidates), wanted);
});
