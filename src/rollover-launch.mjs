import path from "node:path";

/**
 * Turning the Claude pipe into something that STARTS a process is a different
 * security class from raising a notification, so every decision about what runs
 * is made here, from the workspace, and never from the envelope.
 *
 * Three things the envelope cannot do, by construction rather than by filtering:
 *   - it cannot name a program: ROLLOVER_PROGRAM is a constant,
 *   - it cannot supply arguments: the prompt is built here,
 *   - it cannot name a directory: the cwd is the window's own workspace folder.
 *
 * What it may carry is one workspace-relative path, and that is checked twice:
 * as a string, before it can reach a shell, and as a resolved real path, so a
 * `..` walk cannot leave the workspace.
 */

/**
 * The program a rollover may start. A constant on purpose: a caller that reaches
 * the pipe still cannot choose what runs.
 */
export const ROLLOVER_PROGRAM = "claude";

/** Every refusal this module can return. Closed, so a test can assert on it. */
export const ROLLOVER_REFUSALS = new Set([
  "no_workspace_folder",
  "baton_not_a_string",
  "baton_not_relative",
  "baton_unresolvable",
  "baton_escapes_workspace",
  "baton_shell_metacharacter",
]);

/**
 * An allowlist, not a denylist. `sendText` writes this string into a live
 * PowerShell, which gives meaning to far more than `&|;<>^"'` -- `%`, `!`, braces
 * and the Unicode quotation marks U+2018 to U+201E among them -- and a denylist
 * only ever names the characters someone has already thought of. A path outside
 * this set is refused, never escaped: escaping rules differ per shell and a miss
 * starts a process.
 */
const SAFE_PATH = /^[A-Za-z0-9 _.\-\\/:]+$/;

/** True when the value holds anything outside the allowlist.
 * @type {{test: (value: string) => boolean}} */
const SHELL_METACHARACTER = { test: (value) => !SAFE_PATH.test(value) };

const MAX_BATON_LENGTH = 512;

/**
 * @param {{baton?: unknown}} request  the fields that arrived on the pipe
 * @param {{workspaceFolder?: unknown, realpath: (p: string) => string}} environment
 * @returns {{ok: true, program: string, cwd: string, baton: string, command: string}
 *          | {ok: false, reason: string}}
 */
export function planRolloverLaunch(request, environment) {
  const realpath = environment?.realpath;
  if (typeof realpath !== "function") {
    return { ok: false, reason: "no_workspace_folder" };
  }

  // Insufficient evidence fails closed. There is deliberately no fallback to a
  // default directory: guessing where to run is the misroute this design exists
  // to prevent, and here a guess also starts a process.
  const folder = environment?.workspaceFolder;
  if (typeof folder !== "string" || folder.length === 0 || !path.isAbsolute(folder)) {
    return { ok: false, reason: "no_workspace_folder" };
  }
  let workspaceReal;
  try {
    workspaceReal = realpath(folder);
  } catch {
    return { ok: false, reason: "no_workspace_folder" };
  }
  if (SHELL_METACHARACTER.test(workspaceReal)) {
    return { ok: false, reason: "baton_shell_metacharacter" };
  }

  const baton = request?.baton;
  if (typeof baton !== "string" || baton.length === 0 || baton.length > MAX_BATON_LENGTH) {
    return { ok: false, reason: "baton_not_a_string" };
  }

  // Checked before the path is resolved, so a metacharacter is reported as what
  // it is even when the file it names does not exist.
  if (SHELL_METACHARACTER.test(baton)) {
    return { ok: false, reason: "baton_shell_metacharacter" };
  }

  // An absolute path is not a workspace-relative baton, whatever it resolves to.
  // path.isAbsolute alone misses `C:foo` and `\\server\share`, so both are named.
  if (path.isAbsolute(baton) || /^[A-Za-z]:/.test(baton) || baton.startsWith("\\\\")) {
    return { ok: false, reason: "baton_not_relative" };
  }

  // The real path, not the string. A string comparison here is defeated by `..`,
  // by a symlink, and by a short 8.3 name; resolving is what closes all three.
  let batonReal;
  try {
    batonReal = realpath(path.resolve(workspaceReal, baton));
  } catch {
    return { ok: false, reason: "baton_unresolvable" };
  }

  const inside = path.relative(workspaceReal, batonReal);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
    return { ok: false, reason: "baton_escapes_workspace" };
  }

  // Resolving can produce characters the caller's string did not hold, so the
  // guard runs again on what will actually be sent.
  if (SHELL_METACHARACTER.test(batonReal)) {
    return { ok: false, reason: "baton_shell_metacharacter" };
  }

  const prompt =
    "Read " + batonReal.replace(/\\/g, "/") + " in full. It is your handover from " +
    "the previous session. Re-derive its facts before trusting them: check the branch, " +
    "HEAD and any open PR yourself. Then continue the work it names.";

  return {
    ok: true,
    program: ROLLOVER_PROGRAM,
    cwd: workspaceReal,
    baton: batonReal,
    // One line: a newline in sendText submits the prompt half-written.
    command: ROLLOVER_PROGRAM + ' "' + prompt.replace(/\s+/g, " ") + '"',
  };
}
