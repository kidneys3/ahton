import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

import { createAuthenticatedEndpoint } from "../src/authenticated-endpoint.mjs";
import {
  CLAUDE_PIPE_PREFIX,
  CLAUDE_PROTOCOL_VERSION,
  TERMINAL_PID_ENV,
  parseClaudeEnvelope,
} from "../src/claude-contract.mjs";

// The adapter's transport -- find the descriptors, connect, write, read the
// answer -- had no test of its own. `grep -rln claude-signal test/` named only
// configuration.test.mjs, which checks the hook command string; the positive
// control `grep -rln managed-terminal test/` names its own dedicated file.
//
// This covers it the way it actually runs: the real script, spawned as a child
// process, reading a real hook event on stdin, talking to a real named pipe.
// It was written BEFORE the transport was extracted, so the extraction has
// something to be checked against rather than a promise.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const WINDOWS_ONLY = { skip: process.platform !== "win32" };

/** A LOCALAPPDATA the adapter will resolve its descriptor directory inside. */
function descriptorHome() {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "ahton-adapter-"));
  const directory = path.join(localAppData, "AgentBridge", "ClaudeWindowRoutes", "v1");
  fs.mkdirSync(directory, { recursive: true });
  return { localAppData, directory };
}

async function listeningEndpoint(directory, received) {
  return createAuthenticatedEndpoint({
    extensionHostPid: process.pid,
    directory,
    pipePrefix: CLAUDE_PIPE_PREFIX,
    protocolVersion: CLAUDE_PROTOCOL_VERSION,
    parseEnvelope: parseClaudeEnvelope,
    onEnvelope: async (envelope) => { received.push(envelope); return true; },
  });
}

function runAdapter(script, { localAppData, shellPid, stdin, argv = [] }) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [path.join(REPO, script), ...argv],
      {
        cwd: REPO,
        env: { ...process.env, LOCALAPPDATA: localAppData, [TERMINAL_PID_ENV]: String(shellPid) },
        timeout: 15_000,
      },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
    child.stdin.end(stdin ?? "");
  });
}

test("the hook adapter delivers a notification over a real pipe", WINDOWS_ONLY, async () => {
  const { localAppData, directory } = descriptorHome();
  const received = [];
  const endpoint = await listeningEndpoint(directory, received);
  try {
    const result = await runAdapter("adapters/claude-signal.mjs", {
      localAppData,
      shellPid: 4242,
      stdin: JSON.stringify({ hook_event_name: "Notification", notification_type: "idle_prompt" }),
    });
    assert.equal(result.stdout, "", "a hook adapter must print nothing");
    assert.equal(received.length, 1, "the endpoint must have received exactly one envelope");
    assert.equal(received[0].reason, "finished");
    assert.equal(received[0].shellPid, 4242);
    assert.equal("baton" in received[0], false, "a notification carries no path");
  } finally { await endpoint.dispose?.(); }
});

test("the hook adapter stays silent when the event is not a signal", WINDOWS_ONLY, async () => {
  const { localAppData, directory } = descriptorHome();
  const received = [];
  const endpoint = await listeningEndpoint(directory, received);
  try {
    await runAdapter("adapters/claude-signal.mjs", {
      localAppData,
      shellPid: 4242,
      stdin: JSON.stringify({ hook_event_name: "PreToolUse" }),
    });
    assert.equal(received.length, 0, "an event that is not a signal must send nothing");
  } finally { await endpoint.dispose?.(); }
});

test("the hook adapter never fails a turn when nothing is listening", WINDOWS_ONLY, async () => {
  const { localAppData } = descriptorHome();
  const result = await runAdapter("adapters/claude-signal.mjs", {
    localAppData,
    shellPid: 4242,
    stdin: JSON.stringify({ hook_event_name: "Notification", notification_type: "idle_prompt" }),
  });
  assert.equal(result.error, null, "the adapter must exit 0 with no window open");
  assert.equal(result.stdout, "");
});

// --- the rollover sender ---
// A different contract from the notification adapter beside it. That one must
// never fail a turn, so it exits 0 whatever happens. This one is asked a
// question -- did the tab open? -- and the rollover hook falls back to handing the user a
// command when the answer is no, so it must report failure honestly.

test("the rollover adapter delivers a baton over a real pipe", WINDOWS_ONLY, async () => {
  const { localAppData, directory } = descriptorHome();
  const received = [];
  const endpoint = await listeningEndpoint(directory, received);
  try {
    const result = await runAdapter("adapters/claude-rollover.mjs", {
      localAppData,
      shellPid: 4242,
      argv: [".remember/baton-1.md"],
    });
    assert.equal(result.error, null, "a delivered rollover must exit 0");
    assert.equal(result.stdout, "", "a hook adapter must print nothing");
    assert.equal(received.length, 1, "the endpoint must have received exactly one envelope");
    assert.equal(received[0].reason, "rollover");
    assert.equal(received[0].baton, ".remember/baton-1.md");
    assert.equal(received[0].shellPid, 4242);
  } finally { await endpoint.dispose?.(); }
});

test("the rollover adapter reports failure when no window is listening", WINDOWS_ONLY, async () => {
  const { localAppData } = descriptorHome();
  const result = await runAdapter("adapters/claude-rollover.mjs", {
    localAppData,
    shellPid: 4242,
    argv: [".remember/baton-1.md"],
  });
  assert.notEqual(result.error, null, "no listener must be reported, not swallowed");
});

test("the rollover adapter sends nothing without a shell pid or a baton", WINDOWS_ONLY, async () => {
  const { localAppData, directory } = descriptorHome();
  const received = [];
  const endpoint = await listeningEndpoint(directory, received);
  try {
    const noBaton = await runAdapter("adapters/claude-rollover.mjs", {
      localAppData, shellPid: 4242, argv: [],
    });
    assert.notEqual(noBaton.error, null, "no baton must fail");

    const noPid = await runAdapter("adapters/claude-rollover.mjs", {
      localAppData, shellPid: "", argv: [".remember/baton-1.md"],
    });
    assert.notEqual(noPid.error, null, "no shell pid must fail");

    assert.equal(received.length, 0, "neither case may put anything on the pipe");
  } finally { await endpoint.dispose?.(); }
});
