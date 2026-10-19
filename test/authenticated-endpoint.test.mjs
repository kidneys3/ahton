import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import {
  CLAUDE_PIPE_PREFIX,
  CLAUDE_PROTOCOL_VERSION,
  parseClaudeEnvelope,
} from "../src/claude-contract.mjs";
import { createAuthenticatedEndpoint } from "../src/authenticated-endpoint.mjs";
import { dispatchRollover } from "../src/rollover-dispatch.mjs";
import { deliver, readDescriptors, MAX_DESCRIPTORS } from "../src/claude-transport.mjs";

test("the Claude endpoint accepts only its authenticated envelope", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ahton-endpoint-"));
  let received;
  const endpoint = await createAuthenticatedEndpoint({
    extensionHostPid: process.pid,
    directory,
    pipePrefix: CLAUDE_PIPE_PREFIX,
    protocolVersion: CLAUDE_PROTOCOL_VERSION,
    parseEnvelope: parseClaudeEnvelope,
    onEnvelope: async (envelope) => {
      received = envelope;
      return true;
    },
  });
  try {
    const descriptor = JSON.parse(fs.readFileSync(endpoint.descriptorPath, "utf8"));
    assert.deepEqual(Object.keys(descriptor).sort(), [
      "createdAt", "extensionHostPid", "pipe", "token", "version",
    ]);
    assert.equal(JSON.stringify(descriptor).toLowerCase().includes("workspace"), false);

    const payload = {
      version: CLAUDE_PROTOCOL_VERSION,
      reason: "finished",
      token: descriptor.token,
      shellPid: 24644,
    };
    assert.deepEqual(await request(descriptor.pipe, payload), { status: "accepted" });
    assert.deepEqual(received, {
      reason: "finished",
      token: descriptor.token,
      shellPid: 24644,
    });

    assert.deepEqual(await request(descriptor.pipe, {
      ...payload,
      token: "B".repeat(43),
    }), { status: "rejected" });
  } finally {
    await endpoint.dispose();
    assert.equal(fs.existsSync(endpoint.descriptorPath), false);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the endpoint requires every route-specific setting", {
  skip: process.platform !== "win32",
}, async () => {
  await assert.rejects(createAuthenticatedEndpoint({ extensionHostPid: process.pid }), /directory/);
});

// A handler slower than the old 2000 ms idle timeout used to be answered
// "rejected" while it went on to launch. The answer must be the handler's own.
test("a slow handler is answered with its own result, not a timeout rejection", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ahton-endpoint-slow-"));
  let ran = 0;
  const endpoint = await createAuthenticatedEndpoint({
    extensionHostPid: process.pid,
    directory,
    pipePrefix: CLAUDE_PIPE_PREFIX,
    protocolVersion: CLAUDE_PROTOCOL_VERSION,
    parseEnvelope: parseClaudeEnvelope,
    onEnvelope: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2600));
      ran += 1;
      return true;
    },
  });
  try {
    const delivered = await deliver(directory, { shellPid: 24644, reason: "rollover", baton: ".remember/b.md" });
    assert.equal(delivered, true, "the sender must report the handler's accepted result");
    assert.equal(ran, 1, "the handler must run exactly once");
  } finally {
    await endpoint.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("descriptors of dead windows never crowd out the live window", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ahton-descriptors-"));
  const exited = spawnSync(process.execPath, ["-e", ""]);
  const deadPid = exited.pid;
  const write = (name, pid, ageSeconds) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, JSON.stringify({
      version: CLAUDE_PROTOCOL_VERSION,
      extensionHostPid: pid,
      pipe: "\\\\.\\pipe\\" + name,
      token: "t".repeat(43),
    }));
    const when = new Date(Date.now() - ageSeconds * 1000);
    fs.utimesSync(file, when, when);
  };
  try {
    write("live.json", process.pid, 1000);
    for (let index = 0; index < MAX_DESCRIPTORS + 4; index += 1) {
      write(`dead-${index}.json`, deadPid, index);
    }
    const pipes = readDescriptors(directory).map((entry) => entry.pipe);
    assert.ok(pipes.some((pipe) => pipe.endsWith("live.json")), "the live window must be listed");
    assert.equal(pipes.some((pipe) => pipe.includes("dead-")), false, "dead windows must be skipped");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function request(pipe, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(2000, () => socket.destroy(new Error("timeout")));
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => resolve(JSON.parse(response)));
    socket.on("error", reject);
  });
}

// A handler that never answers, and a client that keeps the pipe open, must not
// stop the extension from deactivating: server.close waits for every socket.
test("dispose completes with a stalled handler and an open client", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ahton-endpoint-stall-"));
  let handlerStarted;
  const started = new Promise((resolve) => { handlerStarted = resolve; });
  const endpoint = await createAuthenticatedEndpoint({
    extensionHostPid: process.pid,
    directory,
    pipePrefix: CLAUDE_PIPE_PREFIX,
    protocolVersion: CLAUDE_PROTOCOL_VERSION,
    parseEnvelope: parseClaudeEnvelope,
    onEnvelope: () => { handlerStarted(); return new Promise(() => {}); },
  });
  const descriptor = JSON.parse(fs.readFileSync(endpoint.descriptorPath, "utf8"));
  const client = net.createConnection(descriptor.pipe);
  client.on("error", () => {});
  client.on("connect", () => client.write(`${JSON.stringify({
    version: CLAUDE_PROTOCOL_VERSION, reason: "finished", token: descriptor.token, shellPid: 24644,
  })}\n`));
  try {
    await started;
    const closed = await Promise.race([
      endpoint.dispose().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 3000)),
    ]);
    assert.equal(closed, "closed", "dispose must close the server despite the open peer");
  } finally {
    client.destroy();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a handler past its deadline is answered rejected and its signal is aborted", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ahton-endpoint-deadline-"));
  let sawAborted;
  const endpoint = await createAuthenticatedEndpoint({
    extensionHostPid: process.pid,
    directory,
    pipePrefix: CLAUDE_PIPE_PREFIX,
    protocolVersion: CLAUDE_PROTOCOL_VERSION,
    parseEnvelope: parseClaudeEnvelope,
    handlerDeadlineMs: 300,
    onEnvelope: async (_envelope, context) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      sawAborted = context?.signal?.aborted;
      return true;
    },
  });
  try {
    const descriptor = JSON.parse(fs.readFileSync(endpoint.descriptorPath, "utf8"));
    const answer = await request(descriptor.pipe, {
      version: CLAUDE_PROTOCOL_VERSION, reason: "finished", token: descriptor.token, shellPid: 24644,
    });
    assert.deepEqual(answer, { status: "rejected" });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(sawAborted, true, "the late handler must see an aborted signal");
  } finally {
    await endpoint.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// Settled implies aborted: whatever ends a request, the handler's signal must
// abort with it, so a late handler cannot act on a request already answered.
// These clients stay half-open so the server's own close handler cannot be the
// thing that aborts; only finish() can.
async function startPending(handlerDeadlineMs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ahton-endpoint-abort-"));
  const state = { signal: undefined };
  let handlerStarted;
  const started = new Promise((resolve) => { handlerStarted = resolve; });
  const endpoint = await createAuthenticatedEndpoint({
    extensionHostPid: process.pid,
    directory,
    pipePrefix: CLAUDE_PIPE_PREFIX,
    protocolVersion: CLAUDE_PROTOCOL_VERSION,
    parseEnvelope: parseClaudeEnvelope,
    ...(handlerDeadlineMs ? { handlerDeadlineMs } : {}),
    onEnvelope: (_envelope, context) => {
      state.signal = context.signal;
      handlerStarted();
      return new Promise(() => {});
    },
  });
  const descriptor = JSON.parse(fs.readFileSync(endpoint.descriptorPath, "utf8"));
  const cleanup = async () => {
    await endpoint.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  };
  return { state, started, endpoint, descriptor, cleanup };
}

function openClient(pipe) {
  const socket = net.createConnection(pipe, { allowHalfOpen: true });
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  const received = { text: "" };
  const answered = new Promise((resolve) => {
    socket.on("data", (chunk) => { received.text += chunk; if (received.text.includes("\n")) resolve(); });
  });
  return { socket, answered, received };
}

test("an oversize body sent while the handler is pending aborts its signal", {
  skip: process.platform !== "win32",
}, async () => {
  const { state, started, descriptor, cleanup } = await startPending();
  const client = openClient(descriptor.pipe);
  try {
    client.socket.write(`${JSON.stringify({
      version: CLAUDE_PROTOCOL_VERSION, reason: "finished", token: descriptor.token, shellPid: 24644,
    })}
`);
    await started;
    client.socket.write("x".repeat(5000));
    await client.answered;
    assert.deepEqual(JSON.parse(client.received.text), { status: "rejected" });
    assert.equal(state.signal.aborted, true, "a request answered rejected must have an aborted signal");
  } finally {
    client.socket.destroy();
    await cleanup();
  }
});

test("a client socket destroyed while the handler is pending aborts its signal", {
  skip: process.platform !== "win32",
}, async () => {
  const { state, started, descriptor, cleanup } = await startPending();
  const client = openClient(descriptor.pipe);
  try {
    client.socket.write(`${JSON.stringify({
      version: CLAUDE_PROTOCOL_VERSION, reason: "finished", token: descriptor.token, shellPid: 24644,
    })}
`);
    await started;
    client.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(state.signal.aborted, true, "a dead peer must abort the handler's signal");
  } finally {
    await cleanup();
  }
});

test("a rollover pending on shell integration sends no command after an oversize rejection", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ahton-endpoint-rollover-"));
  const commands = [];
  let listener;
  const terminal = {
    shellIntegration: undefined,
    exitStatus: undefined,
    show() {},
    sendText(text) { commands.push(text); },
    dispose() {},
  };
  const api = {
    createTerminal: () => terminal,
    onDidChangeTerminalShellIntegration: (fn) => { listener = fn; return { dispose() { listener = undefined; } }; },
  };
  let handlerStarted;
  const started = new Promise((resolve) => { handlerStarted = resolve; });
  const endpoint = await createAuthenticatedEndpoint({
    extensionHostPid: process.pid,
    directory,
    pipePrefix: CLAUDE_PIPE_PREFIX,
    protocolVersion: CLAUDE_PROTOCOL_VERSION,
    parseEnvelope: parseClaudeEnvelope,
    onEnvelope: (envelope, context) => {
      const pending = dispatchRollover(envelope, {
        workspaceFolder: "C:\\Work\\ahton-ws",
        realpath: (value) => value,
        api,
        timeoutMs: 5000,
        signal: context.signal,
      });
      handlerStarted();
      return pending;
    },
  });
  const descriptor = JSON.parse(fs.readFileSync(endpoint.descriptorPath, "utf8"));
  const client = openClient(descriptor.pipe);
  try {
    client.socket.write(`${JSON.stringify({
      version: CLAUDE_PROTOCOL_VERSION, reason: "rollover", token: descriptor.token,
      shellPid: 24644, baton: ".remember/b.md",
    })}
`);
    await started;
    client.socket.write("x".repeat(5000));
    await client.answered;
    assert.deepEqual(JSON.parse(client.received.text), { status: "rejected" });
    listener?.({ terminal });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(commands.length, 0, "a rejected rollover must send no command");
  } finally {
    client.socket.destroy();
    await endpoint.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
