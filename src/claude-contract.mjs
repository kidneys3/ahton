import path from "node:path";

export const CLAUDE_PROTOCOL_VERSION = 1;
export const CLAUDE_PIPE_PREFIX = "agent-bridge-claude-";

const REASONS = new Set(["finished", "attention"]);

/**
 * Deliberately NOT a member of REASONS. A rollover is not a notification: it has
 * a different envelope shape, a different consumer and a different blast radius,
 * and folding it into that set would let a five-key rollover and a four-key
 * notification share every check they should not share.
 */
export const ROLLOVER_REASON = "rollover";

/** Long enough for a real workspace-relative baton, short enough to bound a command line. */
const MAX_BATON_LENGTH = 512;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The managed Claude profile records its own shell pid in the terminal
 * environment, which Claude Code and its hooks inherit. That pid is a selector,
 * not a credential: the extension only ever matches it against the pids VS Code
 * reports for the terminals this window owns.
 */
export const TERMINAL_PID_ENV = "AHTON_SHELL_PID";

/**
 * A NOTIFICATION handoff carries no prompt, reply, path, workspace name, session
 * id, or transcript metadata -- only which terminal to return to, and which of
 * the two fixed notifications to raise.
 *
 * A ROLLOVER handoff is the one exception, and it is a narrow one. It starts a
 * process rather than showing a toast, so it carries exactly one extra field: a
 * workspace-relative baton path. Two things follow, and both are structural
 * rather than filtered:
 *
 *   - No accepted shape holds a command, a program or a directory. A caller on
 *     the pipe therefore cannot choose what runs, only which baton is read.
 *   - The two shapes are kept apart: a notification with a baton is rejected, so
 *     a path can never reach the notification text that Ahton's rules forbid it
 *     from holding.
 *
 * The path itself is not trusted here. This function checks only that it is a
 * plausible string; `src/rollover-launch.mjs` resolves it and decides.
 *
 * @param {unknown} value
 * The declared type keeps `baton` optional rather than splitting the union.
 * TypeScript cannot narrow the returned object literal to one arm of a union
 * built at runtime, and writing a cast to satisfy it would state a guarantee the
 * compiler had not checked. The separation is enforced above and asserted by
 * "a notification envelope may not carry a baton" in the contract test.
 *
 * @returns {{token: string, shellPid: number,
 *            reason: "finished" | "attention" | "rollover", baton?: string} | null}
 */
export function parseClaudeEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  // A rollover is the only shape with a fifth key, and `baton` is the only key it
  // may be. Counting keys is what keeps an unknown field -- a command, a cwd, a
  // program -- from riding along unnoticed on either shape.
  const isRollover = record.reason === ROLLOVER_REASON;
  if (Object.keys(record).length !== (isRollover ? 5 : 4)) {
    return null;
  }
  if (record.version !== CLAUDE_PROTOCOL_VERSION) {
    return null;
  }
  if (typeof record.token !== "string" || !TOKEN_PATTERN.test(record.token)) {
    return null;
  }
  if (typeof record.reason !== "string" ||
      !(REASONS.has(record.reason) || isRollover)) {
    return null;
  }
  if (isRollover &&
      (typeof record.baton !== "string" ||
       record.baton.length === 0 ||
       record.baton.length > MAX_BATON_LENGTH)) {
    return null;
  }
  if (!Number.isSafeInteger(record.shellPid) ||
      Number(record.shellPid) < 1 ||
      Number(record.shellPid) > 0xffff_ffff) {
    return null;
  }
  const parsed = {
    token: record.token,
    shellPid: Number(record.shellPid),
    reason: /** @type {"finished" | "attention" | "rollover"} */ (record.reason),
  };
  // Added only on the rollover shape, so a notification consumer that reads
  // `"baton" in envelope` gets a straight answer rather than an undefined.
  return isRollover ? { ...parsed, baton: /** @type {string} */ (record.baton) } : parsed;
}

/**
 * A terminal that was not launched by the managed Claude profile has no shell
 * pid to report, so it produces no signal at all.
 *
 * @param {Record<string, string | undefined>} environment
 */
export function shellPidFromEnvironment(environment) {
  const raw = environment?.[TERMINAL_PID_ENV];
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,9}$/.test(raw.trim())) {
    return null;
  }
  const pid = Number(raw.trim());
  return Number.isSafeInteger(pid) && pid >= 1 && pid <= 0xffff_ffff ? pid : null;
}

/** @param {string | undefined} localAppData */
export function claudeDescriptorDirectory(localAppData = process.env.LOCALAPPDATA) {
  if (!localAppData || !path.isAbsolute(localAppData)) {
    throw new Error("local app data unavailable");
  }
  return path.join(localAppData, "AgentBridge", "ClaudeWindowRoutes", "v1");
}

/**
 * Claude Code's own event names, mapped to the two notifications Ahton can show.
 * Anything else is not a signal: the adapter must stay silent rather than guess.
 *
 * @param {unknown} event
 * @returns {"finished" | "attention" | null}
 */
export function reasonForHookEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }
  const name = /** @type {Record<string, unknown>} */ (event).hook_event_name;
  if (name === "StopFailure") {
    return "attention";
  }
  if (name === "Notification") {
    const notificationType = /** @type {Record<string, unknown>} */ (event).notification_type;
    // Stop already provides the immediate completion signal. idle_prompt and
    // agent_completed are delayed/repeated completion reminders, while
    // auth/elicitation completion events do not require a person. Accept only
    // notification kinds that are themselves authoritative human-input gates.
    if (notificationType === "idle_prompt" || notificationType === "agent_completed") {
      return "finished";
    }
    if (notificationType === "permission_prompt" ||
        notificationType === "elicitation_dialog" ||
        notificationType === "agent_needs_input") {
      return "attention";
    }
  }
  return null;
}
