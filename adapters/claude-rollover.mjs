#!/usr/bin/env node

/**
 * Ask the VS Code window this Claude session is running in to open the rollover
 * successor as a new terminal tab.
 *
 * Nothing outside VS Code can create a terminal in it: there is no CLI for it
 * and Ahton registers no URI handler. This per-window pipe is the only route,
 * and it is the same one `claude-signal.mjs` beside this file already uses.
 *
 * What it carries is one workspace-relative baton path, and nothing else. It
 * names no program, no directory and no command: the extension decides all
 * three from its own workspace. See `src/rollover-launch.mjs`.
 *
 * The contract differs from the notification adapter in one way that matters.
 * That one must never fail a turn, so it exits 0 whatever happens. This one is
 * asked a question -- did the tab open? -- and a rollover hook
 * hands the user a command to paste when the answer is no. Reporting a success it
 * did not have would leave them with no tab and no notice that there is none.
 *
 * usage: claude-rollover.mjs <workspace-relative-baton-path>
 * exit:  0 delivered and accepted, 1 not delivered
 */

import {
  ROLLOVER_REASON,
  claudeDescriptorDirectory,
  shellPidFromEnvironment,
} from "../src/claude-contract.mjs";
import { deliver } from "../src/claude-transport.mjs";

async function run() {
  const baton = process.argv[2];
  if (typeof baton !== "string" || baton.length === 0) {
    return false;
  }

  // A Claude session started outside the managed profile has no terminal in this
  // window, so the extension could not match it to one. Sending anyway would put
  // a rollover request on every listening window and let the first one answer.
  const shellPid = shellPidFromEnvironment(process.env);
  if (shellPid === null) {
    return false;
  }

  let directory;
  try {
    directory = claudeDescriptorDirectory();
  } catch {
    return false;
  }

  return deliver(directory, { shellPid, reason: ROLLOVER_REASON, baton });
}

run()
  .then((delivered) => { process.exitCode = delivered ? 0 : 1; })
  // Printing nothing: the caller reads the exit code, and a hook that writes to
  // stdout can disturb the turn it runs inside.
  .catch(() => { process.exitCode = 1; });
