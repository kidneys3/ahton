/**
 * Every command the manifest contributes. A test holds this list equal to
 * package.json, so a platform that cannot run Ahton still answers each one.
 */
export const COMMAND_IDS = [
  "ahton.configure",
  "ahton.sendClaudeTestNotification",
  "ahton.sendCodexTestNotification",
  "ahton.showDiagnostics",
  "ahton.startCodexTerminal",
];
