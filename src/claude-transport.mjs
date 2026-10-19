/**
 * The Claude side's per-window transport: find the listening windows, connect,
 * write one envelope, read the answer.
 *
 * Lifted out of `adapters/claude-signal.mjs` unchanged in behaviour, so the
 * rollover adapter reuses this path instead of growing a second copy of it. A
 * second copy is how two senders drift apart, and the one that drifts is always
 * the one nobody is watching.
 *
 * It refuses to send anything this build cannot parse back, which is what keeps
 * a sender from inventing a shape the receiver would have to be loosened to
 * accept.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { CLAUDE_PROTOCOL_VERSION, parseClaudeEnvelope } from "./claude-contract.mjs";

export const CONNECT_TIMEOUT_MS = 1000;
export const RESPONSE_TIMEOUT_MS = 2000;
/**
 * A rollover answers only after the terminal is ready, which waits up to 10 s
 * for shell integration. Giving up sooner would report "not delivered" for a
 * request that then launches, and try the next window as well.
 */
export const ROLLOVER_RESPONSE_TIMEOUT_MS = 15_000;
export const MAX_DESCRIPTORS = 16;

/**
 * @param {string} directory
 * @returns {Array<{pipe: string, token: string, mtimeMs: number}>}
 */
export function readDescriptors(directory) {
  /** @type {Array<{pipe: string, token: string, mtimeMs: number}>} */
  const descriptors = [];
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return descriptors;
  }

  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const full = path.join(directory, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
      if (parsed?.version !== CLAUDE_PROTOCOL_VERSION ||
          typeof parsed.pipe !== "string" ||
          !parsed.pipe.startsWith("\\\\.\\pipe\\") ||
          typeof parsed.token !== "string") {
        continue;
      }
      // A crashed window leaves its descriptor behind. Counted against the cap,
      // sixteen of them would push the live window out of the list.
      if (!isProcessAlive(parsed.extensionHostPid)) {
        continue;
      }
      descriptors.push({
        pipe: parsed.pipe,
        token: parsed.token,
        mtimeMs: fs.statSync(full).mtimeMs,
      });
    } catch {
      // A descriptor being rewritten, or left by a crashed window, is skipped.
    }
  }

  // Newest first: the window most likely to still be listening is tried first.
  descriptors.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return descriptors.slice(0, MAX_DESCRIPTORS);
}

/** @param {unknown} pid */
function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || /** @type {number} */ (pid) < 1) {
    return false;
  }
  try {
    process.kill(/** @type {number} */ (pid), 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/**
 * @param {{pipe: string, token: string}} descriptor
 * @param {{shellPid: number, reason: string, baton?: string}} fields
 * @returns {Promise<boolean>}
 */
export function postEnvelope(descriptor, fields) {
  return new Promise((resolve) => {
    const envelope = {
      version: CLAUDE_PROTOCOL_VERSION,
      token: descriptor.token,
      shellPid: fields.shellPid,
      reason: fields.reason,
      ...(fields.baton === undefined ? {} : { baton: fields.baton }),
    };
    // Refuse to send anything this build cannot parse back.
    if (!parseClaudeEnvelope(envelope)) {
      resolve(false);
      return;
    }

    let settled = false;
    /** @param {boolean} accepted */
    const finish = (accepted) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(accepted);
    };

    const socket = net.createConnection(descriptor.pipe);
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("connect", () => {
      socket.setTimeout(
        fields.reason === "rollover" ? ROLLOVER_RESPONSE_TIMEOUT_MS : RESPONSE_TIMEOUT_MS,
        () => finish(false),
      );
      socket.write(`${JSON.stringify(envelope)}\n`);
    });
    socket.setEncoding("utf8");
    let body = "";
    socket.on("data", (chunk) => {
      body += chunk;
      if (body.includes("\n")) {
        try {
          finish(JSON.parse(body.trim()).status === "accepted");
        } catch {
          finish(false);
        }
      }
    });
    socket.on("close", () => finish(false));
  });
}

/**
 * Try each listening window, newest first, and stop at the first that accepts.
 *
 * @param {string} directory
 * @param {{shellPid: number, reason: string, baton?: string}} fields
 * @returns {Promise<boolean>}
 */
export async function deliver(directory, fields) {
  for (const descriptor of readDescriptors(directory)) {
    if (await postEnvelope(descriptor, fields)) {
      return true;
    }
  }
  return false;
}
