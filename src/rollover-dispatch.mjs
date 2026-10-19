import { planRolloverLaunch } from "./rollover-launch.mjs";
import { startShellIntegratedTerminal } from "./managed-terminal.mjs";

/**
 * The one place a Claude envelope may cause a process to start.
 *
 * It does nothing itself except join two halves that already existed: the
 * decision (`planRolloverLaunch`, which trusts the workspace and not the
 * envelope) and the terminal (`startShellIntegratedTerminal`, which Codex
 * already used). Keeping the join this thin is the point -- everything that can
 * refuse lives in the planner, where it can be tested without VS Code.
 *
 * Nothing here logs a path, a workspace name or a baton. A refusal logs its
 * reason code and stops, because Ahton's rules forbid a path in diagnostics and
 * a refusal reason is the one thing a person needs to debug this.
 */

/** The tab's name. Fixed, and carries no path: it is shown to a person. */
export const ROLLOVER_TERMINAL_NAME = "Claude rollover";

/**
 * @param {{baton?: unknown}} envelope
 * @param {{
 *   workspaceFolder?: unknown,
 *   realpath: (p: string) => string,
 *   api: Parameters<typeof startShellIntegratedTerminal>[0],
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   log?: (line: string) => void,
 * }} context
 * @returns {Promise<boolean>}
 */
export async function dispatchRollover(envelope, context) {
  const plan = planRolloverLaunch(envelope, context);
  if (!plan.ok) {
    context.log?.(`claude_rollover_refused reason=${plan.reason}`);
    return false;
  }

  const started = await startShellIntegratedTerminal(context.api, {
    terminalOptions: { name: ROLLOVER_TERMINAL_NAME, cwd: plan.cwd },
    command: plan.command,
    timeoutMs: context.timeoutMs,
    signal: context.signal,
  });
  if (started.started !== true) {
    // Without shell integration the tab exists but the command was never
    // observed running, so reporting success here would hide a dead successor.
    context.log?.(`claude_rollover_refused reason=${started.reason}`);
    return false;
  }
  context.log?.("claude_rollover_started target=new_terminal");
  return true;
}
