/**
 * Bring the exact window forward, reveal the bound terminal, and prove both
 * postconditions before reporting success. No fallback target is allowed.
 * @param {{terminal: {show: (preserveFocus?: boolean) => void}, isTerminalLive: () => boolean,
 * focusWindow: () => PromiseLike<unknown>, focusExactWindow: () => Promise<boolean>,
 * focusTerminalControl: () => PromiseLike<unknown>,
 * verifyExactWindow: () => Promise<boolean>, getActiveTerminal: () => unknown,
 * onDidChangeActiveTerminal: (listener: (terminal: unknown) => void) => {dispose: () => void},
 * timeoutMs?: number}} options
 * @returns {Promise<"succeeded" | "terminal_not_live" | "native_exact_focus_rejected" | "exact_terminal_not_active" | "exact_window_not_foreground" | "focus_command_error">}
 */
export async function activateExactTerminal(options) {
  const terminal = options.terminal;
  try {
    if (!options.isTerminalLive()) return "terminal_not_live";
    await options.focusWindow();
    if (!options.isTerminalLive()) return "terminal_not_live";
    if (!await options.focusExactWindow()) return "native_exact_focus_rejected";
    const selected = await waitForExactTerminal({ ...options, timeoutMs: options.timeoutMs ?? 500 });
    if (!selected) return options.isTerminalLive() ? "exact_terminal_not_active" : "terminal_not_live";
    await options.focusTerminalControl();
    if (!await options.verifyExactWindow()) return "exact_window_not_foreground";
    if (!options.isTerminalLive() || options.getActiveTerminal() !== terminal) {
      return options.isTerminalLive() ? "exact_terminal_not_active" : "terminal_not_live";
    }
    return "succeeded";
  } catch {
    return "focus_command_error";
  }
}

/** @param {{terminal: {show: (preserveFocus?: boolean) => void}, isTerminalLive: () => boolean,
 * getActiveTerminal: () => unknown, onDidChangeActiveTerminal: (listener: (terminal: unknown) => void) => {dispose: () => void},
 * timeoutMs: number}} options */
function waitForExactTerminal(options) {
  return new Promise((resolve) => {
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeout;
    /** @type {{dispose: () => void} | undefined} */
    let subscription;
    /** @param {boolean} value */
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      subscription?.dispose();
      resolve(value);
    };
    subscription = options.onDidChangeActiveTerminal((candidate) => {
      if (candidate === options.terminal) finish(true);
    });
    timeout = setTimeout(() => finish(false), options.timeoutMs);
    try {
      options.terminal.show(false);
      if (options.isTerminalLive() && options.getActiveTerminal() === options.terminal) finish(true);
    } catch {
      finish(false);
    }
  });
}
