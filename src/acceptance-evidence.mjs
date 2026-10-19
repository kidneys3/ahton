const ZERO = {
  routerReadyWindows: 0,
  managedTerminals: 0,
  terminalSignals: 0,
  terminalToasts: 0,
  terminalActivations: 0,
  claudeTerminalSignals: 0,
  claudeTerminalToasts: 0,
  claudeTerminalActivations: 0,
  staleTargetRejections: 0,
  unexpectedFailures: 0,
};

/**
 * Match a whole fixed token, whether or not the line carries the appended
 * `t=<iso>` stamp added in 0.5.2. Equality alone would stop counting every
 * timestamped line; a bare prefix test would let a longer, different token
 * match. Requiring either the exact line or the token followed by a space keeps
 * both cases honest.
 * @param {string} line
 * @param {string} token
 */
function isToken(line, token) {
  return line === token || line.startsWith(`${token} `);
}

/**
 * Count only fixed Ahton diagnostic tokens. Log bodies, paths, terminal names,
 * task identifiers and model content are neither returned nor copied.
 * @param {{windowId: string, text: string}[]} logs
 */
export function summarizeAcceptanceEvidence(logs) {
  const summary = { ...ZERO };
  const readyWindows = new Set();
  for (const log of logs) {
    for (const line of log.text.split(/\r?\n/)) {
      if (line.startsWith("router_ready ")) readyWindows.add(log.windowId);
      if (isToken(line, "managed_terminal_started provider=codex route=exact_terminal")) summary.managedTerminals += 1;
      if (line.startsWith("signal_accepted provider=codex target=terminal ")) summary.terminalSignals += 1;
      if (line.startsWith("popup_issued target=terminal provider=codex ")) summary.terminalToasts += 1;
      // Accept both legacy pattern (no provider) and new pattern (with provider=codex)
      if (isToken(line, "activation_succeeded target=terminal evidence=exact_window+exact_active_terminal+terminal_focus_command") ||
          isToken(line, "activation_succeeded target=terminal provider=codex evidence=exact_window+exact_active_terminal+terminal_focus_command")) {
        summary.terminalActivations += 1;
      }
      if (line.startsWith("signal_accepted provider=claude target=terminal ")) summary.claudeTerminalSignals += 1;
      if (line.startsWith("popup_issued target=terminal provider=claude ")) summary.claudeTerminalToasts += 1;
      if (isToken(line, "activation_succeeded target=terminal provider=claude evidence=exact_window+exact_active_terminal+terminal_focus_command")) {
        summary.claudeTerminalActivations += 1;
      }
      if (isToken(line, "activation_rejected reason=expired_closed_or_replayed") ||
          isToken(line, "activation_rejected reason=terminal_not_live")) summary.staleTargetRejections += 1;
      if (/^(?:activation_failed|managed_terminal_rejected) /.test(line)) {
        summary.unexpectedFailures += 1;
      }
    }
  }
  summary.routerReadyWindows = readyWindows.size;
  return summary;
}

/** @param {ReturnType<typeof summarizeAcceptanceEvidence>} summary */
export function evaluateAcceptanceEvidence(summary) {
  const checks = {
    twoReadyWindows: summary.routerReadyWindows >= 2,
    twoManagedTerminals: summary.managedTerminals >= 2,
    threeTerminalLifecycleSignals: summary.terminalSignals >= 3,
    threeTerminalToasts: summary.terminalToasts >= 3,
    threeTerminalActivations: summary.terminalActivations >= 3,
    twoClaudeTerminalSignals: summary.claudeTerminalSignals >= 2,
    twoClaudeTerminalToasts: summary.claudeTerminalToasts >= 2,
    twoClaudeTerminalActivations: summary.claudeTerminalActivations >= 2,
    staleTargetFailsClosed: summary.staleTargetRejections >= 1,
    noUnexpectedFailures: summary.unexpectedFailures === 0,
  };

  // `passed` is every check, never a choice between providers. A provider that has
  // not been exercised is a failing check with a name, so the gap shows in the output
  // instead of being hidden by an OR. The per-provider rollups below let one attended
  // run be read on its own without letting it claim the whole gate.
  const codexChecksPassed =
    checks.twoReadyWindows &&
    checks.twoManagedTerminals &&
    checks.threeTerminalLifecycleSignals &&
    checks.threeTerminalToasts &&
    checks.threeTerminalActivations &&
    checks.staleTargetFailsClosed &&
    checks.noUnexpectedFailures;

  const claudeChecksPassed =
    checks.twoReadyWindows &&
    checks.twoClaudeTerminalSignals &&
    checks.twoClaudeTerminalToasts &&
    checks.twoClaudeTerminalActivations &&
    checks.staleTargetFailsClosed &&
    checks.noUnexpectedFailures;

  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    providers: { claude: claudeChecksPassed, codex: codexChecksPassed },
  };
}
