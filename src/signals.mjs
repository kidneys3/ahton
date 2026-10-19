export const MANAGED_PROVIDER_ENV = "AGENT_BRIDGE_PROVIDER";

export const CLAUDE_MARKERS = Object.freeze({
  finished: "777;notify;agent-bridge-v1;claude-finished",
  attention: "777;notify;agent-bridge-v1;claude-attention",
});

const NOTIFICATIONS = Object.freeze({
  "claude:finished": Object.freeze({
    title: "Claude Code",
    message: "Claude Code finished and is ready for you.",
  }),
  "claude:attention": Object.freeze({
    title: "Claude Code",
    message: "Claude Code needs your attention.",
  }),
  "codex:attention": Object.freeze({
    title: "Codex",
    message: "Codex is ready for you.",
  }),
  "codex:finished": Object.freeze({
    title: "Codex",
    message: "Codex finished and is ready for you.",
  }),
});

/**
 * @param {{provider: "claude" | "codex", reason: "finished" | "attention"}} signal
 */
export function notificationForSignal(signal) {
  const notification = NOTIFICATIONS[`${signal.provider}:${signal.reason}`];
  if (!notification) {
    throw new Error("unsupported signal");
  }
  return notification;
}
