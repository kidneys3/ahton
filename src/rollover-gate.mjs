/**
 * Rollover starts a new Claude terminal on request, so it is off until the user
 * turns it on. The gate reads the setting at each request: a change applies
 * without a reload, and a refusal is counted and logged by reason only.
 *
 * @param {{enabled: () => boolean, log: (line: string) => void}} options
 */
export function createRolloverGate({ enabled, log }) {
  let refused = 0;
  return {
    /** @returns {boolean} true when a rollover may proceed */
    admit() {
      if (enabled()) return true;
      refused += 1;
      log("claude_rollover_refused reason=rollover_disabled");
      return false;
    },
    snapshot() {
      return { refused };
    },
  };
}
