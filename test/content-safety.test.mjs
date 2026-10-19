import assert from "node:assert/strict";
import test from "node:test";

import { classifyActivationOutcome, isActivationResponse } from "../src/activation-response.mjs";
import { notificationForSignal } from "../src/signals.mjs";

test("notification content is constant and contains no event fields", () => {
  const sentinel = "PRIVATE-PATH-PROMPT-REPLY-PATIENT";
  const signal = {
    provider: "claude",
    reason: "finished",
    cwd: sentinel,
    prompt: sentinel,
    reply: sentinel,
  };
  const notification = notificationForSignal(signal);
  assert.deepEqual(notification, {
    title: "Claude Code",
    message: "Claude Code finished and is ready for you.",
  });
  assert.equal(JSON.stringify(notification).includes(sentinel), false);
});

test("only explicit native activation responses are accepted", () => {
  for (const value of ["activate", "activated", "click", "clicked", "CLICKED"]) {
    assert.equal(isActivationResponse(value, undefined), true);
  }
  for (const value of [undefined, null, "dismissed", "timeout", "delivered", "unknown"]) {
    assert.equal(isActivationResponse(value, undefined), false);
  }
  assert.equal(isActivationResponse(undefined, { activationType: "clicked" }), true);
  assert.equal(isActivationResponse(undefined, { activationType: "dismissed" }), false);
});

test("native close outcomes use fixed privacy-safe categories", () => {
  assert.equal(classifyActivationOutcome(null, "activate", {}), "activated");
  assert.equal(classifyActivationOutcome(null, "timeout", {}), "timed_out");
  assert.equal(classifyActivationOutcome(null, "dismissed", {}), "dismissed");
  assert.equal(classifyActivationOutcome(null, "hidden", {}), "hidden");
  assert.equal(classifyActivationOutcome(new Error("private detail"), undefined, undefined), "error");
  assert.equal(classifyActivationOutcome(null, "private detail", {}), "unknown");
});
