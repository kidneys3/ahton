import assert from "node:assert/strict";
import test from "node:test";

import { createRolloverGate } from "../src/rollover-gate.mjs";

test("a disabled rollover is refused, counted, and logged with a reason only", () => {
  const lines = [];
  const gate = createRolloverGate({ enabled: () => false, log: (line) => lines.push(line) });
  assert.equal(gate.admit(), false);
  assert.equal(gate.admit(), false);
  assert.equal(gate.snapshot().refused, 2);
  assert.deepEqual(lines, [
    "claude_rollover_refused reason=rollover_disabled",
    "claude_rollover_refused reason=rollover_disabled",
  ]);
});

test("an enabled rollover is admitted and not counted as refused", () => {
  const gate = createRolloverGate({ enabled: () => true, log: () => assert.fail("no log when admitted") });
  assert.equal(gate.admit(), true);
  assert.equal(gate.snapshot().refused, 0);
});

test("the gate reads the setting at each request, so a change applies without a reload", () => {
  let enabled = false;
  const gate = createRolloverGate({ enabled: () => enabled, log: () => {} });
  assert.equal(gate.admit(), false);
  enabled = true;
  assert.equal(gate.admit(), true);
});
