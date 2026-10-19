import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { createAuthenticatedEndpoint } from "../src/authenticated-endpoint.mjs";
import { parseClaudeEnvelope, CLAUDE_PROTOCOL_VERSION } from "../src/claude-contract.mjs";
import { dispatchRollover } from "../src/rollover-dispatch.mjs";

// This exercises the surface that actually runs: a real named pipe, the real
// endpoint, the real envelope parser, ending at a terminal double. Asserting on
// planRolloverLaunch alone would prove the validator and nothing about the path
// a signal really takes.

function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ahton-dispatch-")));
  const ws = path.join(root, "workspace");
  fs.mkdirSync(path.join(ws, ".remember"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".remember", "baton-1.md"), "baton\n");
  fs.writeFileSync(path.join(root, "outside.md"), "not yours\n");
  return { root, ws };
}

/** Records everything a real VS Code terminal would have been asked to do. */
function terminalApi() {
  const created = [];
  return {
    created,
    api: {
      createTerminal(options) {
        const terminal = {
          options,
          sent: [],
          shellIntegration: {},
          exitStatus: undefined,
          shown: false,
          show() { this.shown = true; },
          sendText(text) { this.sent.push(text); },
          dispose() { this.disposed = true; },
        };
        created.push(terminal);
        return terminal;
      },
      onDidChangeTerminalShellIntegration: () => ({ dispose() {} }),
    },
  };
}

async function endpointFor(ws, recorder) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ahton-dispatch-desc-"));
  const endpoint = await createAuthenticatedEndpoint({
    extensionHostPid: process.pid,
    directory,
    pipePrefix: "agent-bridge-claude-test-",
    protocolVersion: CLAUDE_PROTOCOL_VERSION,
    parseEnvelope: parseClaudeEnvelope,
    onEnvelope: async (envelope) => {
      if (envelope.reason !== "rollover") return true; // the notification route
      return dispatchRollover(envelope, {
        workspaceFolder: ws,
        realpath: fs.realpathSync,
        api: recorder.api,
        timeoutMs: 200,
      });
    },
  });
  const descriptor = JSON.parse(fs.readFileSync(endpoint.descriptorPath, "utf8"));
  return { endpoint, descriptor };
}

/** Writes one envelope down the real pipe and waits for the endpoint's answer. */
function send(descriptor, envelope) {
  return new Promise((resolve) => {
    const socket = net.createConnection(descriptor.pipe);
    let body = "";
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(3000, () => finish("timeout"));
    socket.on("error", (error) => finish("error:" + error.code));
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(envelope) + "\n"));
    socket.on("data", (chunk) => {
      body += chunk;
      if (body.includes("\n")) {
        try { finish(JSON.parse(body.trim()).status); } catch { finish("unparsable"); }
      }
    });
    socket.on("close", () => finish("closed"));
  });
}

const WINDOWS_ONLY = { skip: process.platform !== "win32" };

test("a rollover over the pipe opens a terminal in the workspace", WINDOWS_ONLY, async () => {
  const { ws } = workspace();
  const recorder = terminalApi();
  const { endpoint, descriptor } = await endpointFor(ws, recorder);
  try {
    const status = await send(descriptor, {
      version: CLAUDE_PROTOCOL_VERSION,
      token: descriptor.token,
      shellPid: process.pid,
      reason: "rollover",
      baton: ".remember/baton-1.md",
    });
    assert.equal(status, "accepted");
    assert.equal(recorder.created.length, 1, "exactly one terminal must be created");
    const terminal = recorder.created[0];
    assert.equal(terminal.shown, true, "the tab must be shown, not created hidden");
    assert.equal(terminal.options.cwd, ws, "the tab must open in the workspace folder");
    assert.equal(terminal.sent.length, 1);
    assert.match(terminal.sent[0], /^claude "/, "the fixed program must start the line");
    assert.match(terminal.sent[0], /Re-derive/);
  } finally { await endpoint.dispose?.(); }
});

test("a rollover whose baton leaves the workspace opens nothing", WINDOWS_ONLY, async () => {
  const { ws } = workspace();
  const recorder = terminalApi();
  const { endpoint, descriptor } = await endpointFor(ws, recorder);
  try {
    for (const baton of ["../outside.md", "C:/Windows/System32/calc.exe",
                         ".remember/baton-1.md & calc.exe", ".remember/nope.md"]) {
      await send(descriptor, {
        version: CLAUDE_PROTOCOL_VERSION,
        token: descriptor.token,
        shellPid: process.pid,
        reason: "rollover",
        baton,
      });
    }
    assert.equal(recorder.created.length, 0,
      "no terminal may be created for " + JSON.stringify(recorder.created.map((t) => t.options)));
  } finally { await endpoint.dispose?.(); }
});

// Constraint 5, at the transport: an unverifiable token opens nothing.
test("a rollover with a wrong token opens nothing", WINDOWS_ONLY, async () => {
  const { ws } = workspace();
  const recorder = terminalApi();
  const { endpoint, descriptor } = await endpointFor(ws, recorder);
  try {
    const status = await send(descriptor, {
      version: CLAUDE_PROTOCOL_VERSION,
      token: "b".repeat(43),
      shellPid: process.pid,
      reason: "rollover",
      baton: ".remember/baton-1.md",
    });
    assert.notEqual(status, "accepted", "a wrong token must not be accepted");
    assert.equal(recorder.created.length, 0, "a wrong token must open no terminal");
  } finally { await endpoint.dispose?.(); }
});

// Accept condition 3: the existing notification route is unchanged.
test("a finished notification over the same pipe opens nothing", WINDOWS_ONLY, async () => {
  const { ws } = workspace();
  const recorder = terminalApi();
  const { endpoint, descriptor } = await endpointFor(ws, recorder);
  try {
    for (const reason of ["finished", "attention"]) {
      const status = await send(descriptor, {
        version: CLAUDE_PROTOCOL_VERSION,
        token: descriptor.token,
        shellPid: process.pid,
        reason,
      });
      assert.equal(status, "accepted", reason + " must still be accepted");
    }
    assert.equal(recorder.created.length, 0, "a notification must open no terminal");
  } finally { await endpoint.dispose?.(); }
});

// A request answered "rejected" must never launch, even when shell integration
// arrives after the endpoint gave up on the handler.
test("a rollover finishing after the handler deadline launches nothing", WINDOWS_ONLY, async () => {
  const { ws } = workspace();
  const recorder = terminalApi();
  let integrate;
  recorder.api.createTerminal = (options) => {
    const terminal = {
      options, sent: [], shown: false, exitStatus: undefined,
      show() { this.shown = true; },
      sendText(text) { this.sent.push(text); },
      dispose() { this.disposed = true; },
    };
    recorder.created.push(terminal);
    integrate = () => { terminal.shellIntegration = {}; };
    return terminal;
  };
  let listener;
  recorder.api.onDidChangeTerminalShellIntegration = (callback) => { listener = callback; return { dispose() {} }; };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ahton-dispatch-late-"));
  const endpoint = await createAuthenticatedEndpoint({
    extensionHostPid: process.pid,
    directory,
    pipePrefix: "agent-bridge-claude-test-",
    protocolVersion: CLAUDE_PROTOCOL_VERSION,
    parseEnvelope: parseClaudeEnvelope,
    handlerDeadlineMs: 300,
    onEnvelope: (envelope, context) => dispatchRollover(envelope, {
      workspaceFolder: ws,
      realpath: fs.realpathSync,
      api: recorder.api,
      timeoutMs: 5000,
      signal: context?.signal,
    }),
  });
  try {
    const descriptor = JSON.parse(fs.readFileSync(endpoint.descriptorPath, "utf8"));
    const status = await send(descriptor, {
      version: CLAUDE_PROTOCOL_VERSION, token: descriptor.token, shellPid: process.pid,
      reason: "rollover", baton: ".remember/baton-1.md",
    });
    assert.equal(status, "rejected");
    integrate();
    listener({ terminal: recorder.created[0] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(recorder.created[0].sent, [], "a rejected request must not send the launch command");
  } finally { await endpoint.dispose(); }
});
