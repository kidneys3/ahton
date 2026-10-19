#!/usr/bin/env node

/**
 * Claude Code hook adapter for Ahton.
 *
 * Claude Code cannot put bytes into its own terminal from a hook: hook stdout is
 * captured on a pipe, and the hook is spawned with CREATE_NO_WINDOW, so its
 * console device is a fresh detached console rather than the VS Code terminal.
 * This adapter therefore hands the signal to the extension over the per-window
 * named-pipe transport in `src/claude-transport.mjs`, which the rollover
 * adapter beside it also uses.
 *
 * It carries no prompt, reply, path, workspace name, session id or transcript
 * metadata. It carries the shell pid the managed profile recorded in the
 * terminal environment -- which the extension matches against the terminals it
 * owns -- and which of the two fixed notifications to raise.
 *
 * It must never disrupt a turn: every failure path exits 0 and prints nothing.
 */

import fs from "node:fs";

import {
  claudeDescriptorDirectory,
  reasonForHookEvent,
  shellPidFromEnvironment,
} from "../src/claude-contract.mjs";
import { deliver } from "../src/claude-transport.mjs";


function readEvent() {
  try {
    if (process.stdin.isTTY) {
      return {};
    }
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

async function run() {
  const reason = reasonForHookEvent(readEvent());
  if (!reason) {
    return;
  }

  // A Claude session started outside the managed profile has no terminal to
  // return to, so it stays silent rather than guessing one.
  const shellPid = shellPidFromEnvironment(process.env);
  if (shellPid === null) {
    return;
  }

  let directory;
  try {
    directory = claudeDescriptorDirectory();
  } catch {
    return;
  }

  await deliver(directory, { shellPid, reason });
}

run()
  .catch(() => {})
  .finally(() => {
    // Notifications must never fail a turn.
    process.exitCode = 0;
  });
