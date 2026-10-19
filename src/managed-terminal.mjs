/**
 * Start Codex only after VS Code has established terminal shell integration.
 * Without that integration Ahton cannot observe the command's execution stream,
 * so launching anyway would create a Codex session that silently never routes.
 *
 * @param {{
 *   createTerminal: (options: Record<string, unknown>) => {
 *     shellIntegration?: unknown,
 *     exitStatus?: unknown,
 *     show: (preserveFocus?: boolean) => void,
 *     sendText: (text: string, addNewLine?: boolean) => void,
 *     dispose: () => void,
 *   },
 *   onDidChangeTerminalShellIntegration: (listener: (event: {terminal: unknown}) => void) => {dispose: () => void},
 * }} api
 * @param {{terminalOptions: Record<string, unknown>, command?: string, timeoutMs?: number, signal?: AbortSignal}} options
 * @returns {Promise<{started: true} | {started: false, reason: "shell_integration_unavailable" | "cancelled"}>}
 */
export async function startShellIntegratedTerminal(api, options) {
  if (options.signal?.aborted) return { started: false, reason: "cancelled" };
  const terminal = api.createTerminal(options.terminalOptions);
  terminal.show(false);

  if (!terminal.shellIntegration) {
    const ready = await waitForShellIntegration(
      terminal,
      api.onDidChangeTerminalShellIntegration,
      options.timeoutMs ?? 10_000,
    );
    if (!ready || terminal.exitStatus !== undefined) {
      terminal.dispose();
      return { started: false, reason: "shell_integration_unavailable" };
    }
  }

  // The caller gave up (deadline or dispose) while integration was pending: the
  // request was reported rejected, so it must not launch.
  if (options.signal?.aborted) {
    terminal.dispose();
    return { started: false, reason: "cancelled" };
  }
  terminal.sendText(options.command ?? "codex", true);
  return { started: true };
}

/**
 * @param {{shellIntegration?: unknown}} terminal
 * @param {(listener: (event: {terminal: unknown}) => void) => {dispose: () => void}} subscribe
 * @param {number} timeoutMs
 */
function waitForShellIntegration(terminal, subscribe, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    /** @type {{dispose: () => void} | undefined} */
    let subscription;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeout;

    /** @param {boolean} ready */
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      subscription?.dispose();
      resolve(ready);
    };

    subscription = subscribe((event) => {
      if (event.terminal === terminal) finish(true);
    });
    timeout = setTimeout(() => finish(false), timeoutMs);

    // Close the check/subscribe race: integration can appear between the
    // caller's first check and listener registration without another event.
    if (terminal.shellIntegration) finish(true);
  });
}
