import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_PROTOCOL_VERSION,
  TERMINAL_PID_ENV,
  claudeDescriptorDirectory,
  parseClaudeEnvelope,
  reasonForHookEvent,
  shellPidFromEnvironment,
} from "../src/claude-contract.mjs";

const TOKEN = "a".repeat(43);

function envelope(overrides = {}) {
  return {
    version: CLAUDE_PROTOCOL_VERSION,
    token: TOKEN,
    shellPid: 4242,
    reason: "finished",
    ...overrides,
  };
}

test("the Claude handoff accepts only one exact envelope shape", () => {
  assert.deepEqual(parseClaudeEnvelope(envelope()), {
    token: TOKEN,
    shellPid: 4242,
    reason: "finished",
  });
  assert.deepEqual(parseClaudeEnvelope(envelope({ reason: "attention" })), {
    token: TOKEN,
    shellPid: 4242,
    reason: "attention",
  });

  for (const bad of [
    null,
    undefined,
    "finished",
    [envelope()],
    envelope({ version: 2 }),
    envelope({ version: "1" }),
    envelope({ token: "short" }),
    envelope({ token: `${TOKEN}=` }),
    envelope({ token: 42 }),
    envelope({ reason: "idle" }),
    envelope({ reason: "" }),
    envelope({ shellPid: 0 }),
    envelope({ shellPid: -1 }),
    envelope({ shellPid: 1.5 }),
    envelope({ shellPid: "4242" }),
    envelope({ shellPid: 0x1_0000_0000 }),
    { ...envelope(), extra: "surface" },
  ]) {
    assert.equal(parseClaudeEnvelope(bad), null, JSON.stringify(bad));
  }
});

test("the envelope carries no prompt, path, or session metadata", () => {
  const parsed = parseClaudeEnvelope(envelope());
  assert.deepEqual(Object.keys(parsed).sort(), ["reason", "shellPid", "token"]);
});

test("only Claude events that make the terminal ready for a human are signals", () => {
  assert.equal(reasonForHookEvent({ hook_event_name: "StopFailure" }), "attention");
  for (const notification_type of ["idle_prompt", "agent_completed"]) {
    assert.equal(reasonForHookEvent({ hook_event_name: "Notification", notification_type }), "finished");
  }
  for (const notification_type of [
    "permission_prompt",
    "elicitation_dialog",
    "agent_needs_input",
  ]) {
    assert.equal(reasonForHookEvent({
      hook_event_name: "Notification",
      notification_type,
    }), "attention");
  }

  for (const bad of [
    null,
    undefined,
    {},
    [],
    "Stop",
    { hook_event_name: "PreToolUse" },
    { hook_event_name: "Stop" },
    { hook_event_name: "SessionStart" },
    { hook_event_name: "Notification" },
    { hook_event_name: "Notification", notification_type: "auth_success" },
    { hook_event_name: "Notification", notification_type: "elicitation_complete" },
    { hook_event_name: "Notification", notification_type: "elicitation_response" },
    { hook_event_name: "Notification", notification_type: "unknown_future_event" },
    { hook_event_name: "" },
    { hook_event_name: 1 },
  ]) {
    assert.equal(reasonForHookEvent(bad), null, JSON.stringify(bad));
  }
});

test("a terminal outside the managed profile reports no shell pid", () => {
  assert.equal(shellPidFromEnvironment({ [TERMINAL_PID_ENV]: "32664" }), 32664);
  assert.equal(shellPidFromEnvironment({ [TERMINAL_PID_ENV]: " 32664 " }), 32664);

  for (const bad of [
    {},
    { [TERMINAL_PID_ENV]: "" },
    { [TERMINAL_PID_ENV]: "0" },
    { [TERMINAL_PID_ENV]: "-5" },
    { [TERMINAL_PID_ENV]: "1.5" },
    { [TERMINAL_PID_ENV]: "0x20" },
    { [TERMINAL_PID_ENV]: "$PID" },
    { [TERMINAL_PID_ENV]: "99999999999999" },
    { [TERMINAL_PID_ENV]: 32664 },
    { AGENT_BRIDGE_PROVIDER: "claude" },
    undefined,
  ]) {
    assert.equal(shellPidFromEnvironment(bad), null, JSON.stringify(bad));
  }
});

test("the descriptor directory is per-user and refuses a relative root", () => {
  // Deliberately not a real-looking user home: the classified-data guard reads
  // one of those as a leaked path, and it is right to.
  const directory = claudeDescriptorDirectory("D:\\fixture\\AppData\\Local");
  assert.match(directory, /ClaudeWindowRoutes/);
  assert.notEqual(directory, claudeDescriptorDirectory("D:\\other"));
  assert.throws(() => claudeDescriptorDirectory(""));
  assert.throws(() => claudeDescriptorDirectory("relative\\path"));
  // Only an explicit null bypasses the LOCALAPPDATA default.
  assert.throws(() => claudeDescriptorDirectory(null));
});

// --- the rollover envelope ---
// A rollover STARTS a process, so this shape is deliberately narrower than the
// notification shape: it carries one workspace-relative path and never a command.

const rollover = (over = {}) => ({
  version: 1,
  token: "a".repeat(43),
  shellPid: 4242,
  reason: "rollover",
  baton: ".remember/baton-1.md",
  ...over,
});

test("a rollover envelope carries the baton path through", () => {
  const parsed = parseClaudeEnvelope(rollover());
  assert.notEqual(parsed, null);
  assert.equal(parsed.reason, "rollover");
  assert.equal(parsed.baton, ".remember/baton-1.md");
  assert.equal(parsed.shellPid, 4242);
});

test("a rollover envelope with no baton is rejected", () => {
  const { baton, ...withoutBaton } = rollover();
  assert.equal(parseClaudeEnvelope(withoutBaton), null);
});

// Constraint 1, at the parser: no shape this build accepts holds a command line.
test("an envelope carrying a command line is rejected", () => {
  assert.equal(parseClaudeEnvelope(rollover({ command: "calc.exe" })), null);
  assert.equal(parseClaudeEnvelope({ ...rollover(), program: "powershell" }), null);
  const { baton, ...notification } = rollover({ reason: "finished" });
  assert.equal(parseClaudeEnvelope({ ...notification, command: "calc.exe" }), null);
});

// A notification may not carry a path. Keeping the two shapes apart is what stops
// a path reaching notification text, which ahton's own rules forbid.
test("a notification envelope may not carry a baton", () => {
  for (const reason of ["finished", "attention"]) {
    assert.equal(parseClaudeEnvelope(rollover({ reason })), null,
      "a " + reason + " envelope with a baton must be rejected");
  }
});

test("a rollover envelope with an unusable baton is rejected", () => {
  for (const baton of [null, 5, "", {}, ["x"], "x".repeat(513)]) {
    assert.equal(parseClaudeEnvelope(rollover({ baton })), null,
      "must reject baton " + JSON.stringify(baton).slice(0, 30));
  }
});

test("the two notification reasons still parse and carry no baton", () => {
  for (const reason of ["finished", "attention"]) {
    const { baton, ...notification } = rollover({ reason });
    const parsed = parseClaudeEnvelope(notification);
    assert.notEqual(parsed, null, reason + " must still parse");
    assert.equal(parsed.reason, reason);
    assert.equal("baton" in parsed, false, reason + " must carry no baton");
  }
});
