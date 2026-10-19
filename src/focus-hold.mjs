/**
 * Hold the window that was just revealed.
 *
 * On 2026-08-13 the click brought the right window forward and it then faded
 * back to the other window. `activation_succeeded` was the last line written, so
 * the loss left no evidence at all: the router proved the postcondition once and
 * stopped looking.
 *
 * Windows can hand the foreground back after a cross-process transfer, and the
 * losing window's own thread can reassert it. This watches the postcondition for
 * a short bounded period and re-asserts once.
 *
 * The bound matters. Re-asserting forever would fight the user whenever they
 * deliberately switches away a moment after clicking. One re-assert inside a
 * short window recovers the handover; anything later is treated as their choice.
 */

export const HOLD_CHECK_DELAYS_MS = [400, 900, 1600];

/**
 * @param {{
 *   verifyExactWindow: () => Promise<boolean>,
 *   focusExactWindow: () => Promise<boolean>,
 *   isTerminalLive: () => boolean,
 *   wait: (ms: number) => Promise<void>,
 *   delays?: number[],
 * }} options
 * @returns {Promise<"held" | "recovered" | "lost" | "terminal_not_live">}
 */
export async function holdActivatedWindow(options) {
  const delays = options.delays ?? HOLD_CHECK_DELAYS_MS;
  let reasserted = false;

  for (const delay of delays) {
    await options.wait(delay);
    if (!options.isTerminalLive()) return "terminal_not_live";
    if (await options.verifyExactWindow()) {
      // Still foreground. If a re-assert was needed earlier, that re-assert is
      // what held it, and the outcome is reported as a recovery rather than as
      // an untroubled hold.
      if (reasserted) return "recovered";
      continue;
    }
    if (reasserted) return "lost";
    reasserted = true;
    if (!await options.focusExactWindow()) return "lost";
  }

  // A re-assert on the final check has not been verified yet. Claiming recovery
  // without looking would be the same unproven postcondition this module exists
  // to close.
  if (reasserted) {
    return await options.verifyExactWindow() ? "recovered" : "lost";
  }
  return "held";
}
