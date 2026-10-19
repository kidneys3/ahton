import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const MAX_REQUEST_BYTES = 4096;
const REQUEST_TIMEOUT_MS = 2000;
// The longest a handler may take once a request is parsed. A rollover waits up
// to 10 s for shell integration, and the sender gives up at 15 s
// (ROLLOVER_RESPONSE_TIMEOUT_MS in claude-transport.mjs), so 12 s leaves the
// handler its full wait and still answers before the sender does.
export const HANDLER_DEADLINE_MS = 12_000;

/**
 * Create one authenticated, per-window local pipe.
 *
 * Every route-specific value is required. This prevents another product surface
 * from appearing through hidden transport defaults.
 *
 * @param {{
 *   extensionHostPid: number,
 *   directory: string,
 *   pipePrefix: string,
 *   protocolVersion: number,
 *   parseEnvelope: (value: unknown) => any,
 *   onEnvelope: (envelope: any, context: {signal: AbortSignal}) => Promise<boolean>,
 *   handlerDeadlineMs?: number,
 * }} options
 */
export async function createAuthenticatedEndpoint(options) {
  const extensionHostPid = options.extensionHostPid;
  if (process.platform !== "win32" || !Number.isSafeInteger(extensionHostPid) || extensionHostPid < 1) {
    throw new Error("authenticated endpoint requires a Windows extension host");
  }
  if (typeof options.directory !== "string" || !path.isAbsolute(options.directory)) {
    throw new Error("endpoint directory must be absolute");
  }
  if (!options.pipePrefix || !Number.isSafeInteger(options.protocolVersion)) {
    throw new Error("endpoint protocol settings are required");
  }
  if (typeof options.parseEnvelope !== "function" || typeof options.onEnvelope !== "function") {
    throw new Error("endpoint handlers are required");
  }

  fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  removePriorPidDescriptors(options.directory, extensionHostPid);

  const generation = randomBytes(16).toString("hex");
  const token = randomBytes(32).toString("base64url");
  const pipe = `\\\\.\\pipe\\${options.pipePrefix}${generation}`;
  const descriptorPath = path.join(options.directory, `${extensionHostPid}-${generation}.json`);
  const deadlineMs = options.handlerDeadlineMs ?? HANDLER_DEADLINE_MS;
  /** @type {Set<import("node:net").Socket>} */
  const sockets = new Set();
  /** @type {Set<AbortController>} */
  const controllers = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handleSocket(socket, token, options.onEnvelope, options.parseEnvelope, deadlineMs, controllers);
  });

  /** @type {Promise<void>} */
  const listening = new Promise((resolve, reject) => {
    /** @param {Error} error */
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(pipe, () => {
      server.off("error", onError);
      resolve();
    });
  });
  await listening;

  const descriptor = {
    version: options.protocolVersion,
    extensionHostPid,
    pipe,
    token,
    createdAt: new Date().toISOString(),
  };
  const temporaryPath = path.join(
    options.directory,
    `.${extensionHostPid}-${generation}-${process.pid}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(descriptor)}${os.EOL}`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, descriptorPath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }

  let disposed = false;
  return Object.freeze({
    descriptorPath,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      removeDescriptorIfOwned(descriptorPath, token);
      // server.close waits for every open socket. Abort in-flight handlers first
      // so a late result launches nothing, then destroy the peers.
      for (const controller of controllers) controller.abort();
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  });
}

/**
 * @param {import("node:net").Socket} socket
 * @param {string} token
 * @param {(envelope: any, context: {signal: AbortSignal}) => Promise<boolean>} onEnvelope
 * @param {(value: unknown) => any} parseEnvelope
 * @param {number} deadlineMs
 * @param {Set<AbortController>} controllers
 */
function handleSocket(socket, token, onEnvelope, parseEnvelope, deadlineMs, controllers) {
  const controller = new AbortController();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let deadline;
  // A socket that closes with no answer sent still ends the request, so it goes
  // through finish() like every other path (finish is a no-op once settled).
  socket.once("close", () => finish("rejected"));
  let body = "";
  let settled = false;
  let processing = false;
  socket.setEncoding("utf8");
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => finish("rejected"));
  socket.on("data", (chunk) => {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
      finish("rejected");
    } else if (body.endsWith("\n")) {
      void processRequest();
    }
  });
  socket.on("end", () => {
    // The sender never half-closes after its request line, so an end that
    // arrives while the handler is pending means the peer is gone. With
    // allowHalfOpen no 'close' follows until we end, so settle here. An end
    // before the request was processed just terminates an unterminated body.
    if (processing) finish("rejected");
    else void processRequest();
  });
  socket.on("error", () => finish("rejected"));

  async function processRequest() {
    if (settled || processing) return;
    processing = true;
    // The request is complete. From here the answer is the handler's own result
    // (a rollover waits up to 10 s for shell integration), bounded by a deadline
    // so a stalled handler cannot hold the socket and block server.close. At the
    // deadline the signal aborts, the answer is "rejected", and a handler that
    // finishes later must see the abort before it launches anything.
    socket.setTimeout(0);
    controllers.add(controller);
    deadline = setTimeout(() => finish("rejected"), deadlineMs);
    try {
      const envelope = parseEnvelope(JSON.parse(body));
      if (!envelope || !sameSecret(envelope.token, token)) {
        finish("rejected");
        return;
      }
      const accepted = await onEnvelope(envelope, { signal: controller.signal });
      finish(accepted && !controller.signal.aborted ? "accepted" : "rejected");
    } catch {
      finish("rejected");
    }
  }

  // The one invariant: settled implies aborted. Every path that ends the
  // request (deadline, oversize, parse failure, handler throw, socket error,
  // close or end before an answer, dispose via close) calls this, so the
  // handler's signal is aborted whatever the status. Abort comes first so a
  // handler that resumes after the answer sees it.
  /** @param {"accepted" | "rejected"} status */
  function finish(status) {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    controllers.delete(controller);
    controller.abort();
    try {
      socket.end(`${JSON.stringify({ status })}\n`);
    } catch {}
  }
}

/** @param {string} left @param {string} right */
function sameSecret(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/** @param {string} directory @param {number} pid */
function removePriorPidDescriptors(directory, pid) {
  for (const name of fs.readdirSync(directory)) {
    if (new RegExp(`^${pid}-[0-9a-f]{32}\\.json$`).test(name)) {
      try { fs.rmSync(path.join(directory, name), { force: true }); } catch {}
    }
  }
}

/** @param {string} descriptorPath @param {string} token */
function removeDescriptorIfOwned(descriptorPath, token) {
  try {
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    if (descriptor?.token === token) {
      fs.rmSync(descriptorPath, { force: true });
    }
  } catch {}
}
