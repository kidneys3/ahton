import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAcceptanceEvidence, summarizeAcceptanceEvidence } from "../src/acceptance-evidence.mjs";

test("attended evidence requires two windows, terminal lifecycle clicks, and stale failure", () => {
  const terminalCycle = [
    "signal_accepted provider=codex target=terminal reason=attention",
    "popup_issued target=terminal provider=codex reason=attention",
    "activation_succeeded target=terminal evidence=exact_window+exact_active_terminal+terminal_focus_command",
  ].join("\n");
  const summary = summarizeAcceptanceEvidence([
    { windowId: "window1", text: [
      "router_ready route_storage=memory notification_content=constant focus_target=captured",
      "managed_terminal_started provider=codex route=exact_terminal",
      terminalCycle,
      terminalCycle,
    ].join("\n") },
    { windowId: "window2", text: [
      "router_ready route_storage=memory notification_content=constant focus_target=captured",
      "managed_terminal_started provider=codex route=exact_terminal",
      terminalCycle,
      "activation_rejected reason=expired_closed_or_replayed",
      "private prompt and path that must never be returned",
    ].join("\n") },
  ]);

  // This fixture exercises Codex only. It proves the Codex rollup. It no longer
  // passes the gate, because the gate now enumerates both providers and Claude is
  // unmeasured here. That change is the point: an uncovered surface is a named
  // failing check, not a silent absence.
  const evaluation = evaluateAcceptanceEvidence(summary);
  assert.equal(evaluation.providers.codex, true);
  assert.equal(evaluation.providers.claude, false);
  assert.equal(evaluation.passed, false);
  assert.equal(JSON.stringify(summary).includes("private prompt"), false);
});

test("attended evidence fails when a target cannot be focused", () => {
  const summary = summarizeAcceptanceEvidence([{
    windowId: "window1",
    text: "router_ready route_storage=memory\nactivation_failed reason=native_exact_focus_rejected",
  }]);
  const evaluation = evaluateAcceptanceEvidence(summary);
  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.checks.noUnexpectedFailures, false);
});

test("legacy self-reported terminal success is not exact-focus evidence", () => {
  const legacy = [
    "router_ready route_storage=memory notification_content=constant focus_target=captured",
    "managed_terminal_started provider=codex route=exact_terminal",
    "signal_accepted provider=codex target=terminal reason=attention",
    "popup_issued target=terminal provider=codex reason=attention",
    "activation_succeeded target=terminal",
  ].join("\n");
  const summary = summarizeAcceptanceEvidence([
    { windowId: "window1", text: `${legacy}\n${legacy}` },
    { windowId: "window2", text: legacy },
  ]);
  assert.equal(summary.terminalActivations, 0);
  assert.equal(evaluateAcceptanceEvidence(summary).passed, false);
});

test("Claude-only log passes Claude checks with two windows", () => {
  const claudeTerminalCycle = [
    "signal_accepted provider=claude target=terminal reason=attention",
    "popup_issued target=terminal provider=claude reason=attention",
    "activation_succeeded target=terminal provider=claude evidence=exact_window+exact_active_terminal+terminal_focus_command",
  ].join("\n");
  const summary = summarizeAcceptanceEvidence([
    { windowId: "window1", text: [
      "router_ready route_storage=memory notification_content=constant focus_target=captured",
      claudeTerminalCycle,
    ].join("\n") },
    { windowId: "window2", text: [
      "router_ready route_storage=memory notification_content=constant focus_target=captured",
      claudeTerminalCycle,
      "activation_rejected reason=expired_closed_or_replayed",
    ].join("\n") },
  ]);
  const evaluation = evaluateAcceptanceEvidence(summary);
  assert.equal(summary.claudeTerminalSignals, 2);
  assert.equal(summary.claudeTerminalToasts, 2);
  assert.equal(summary.claudeTerminalActivations, 2);
  assert.equal(evaluation.checks.twoClaudeTerminalSignals, true);
  assert.equal(evaluation.checks.twoClaudeTerminalToasts, true);
  assert.equal(evaluation.checks.twoClaudeTerminalActivations, true);
  // The Claude route is proved, and the gate still fails because Codex is unmeasured.
  // An uncovered surface must stay a named failing check, not be hidden by the verdict.
  assert.equal(evaluation.providers.claude, true);
  assert.equal(evaluation.providers.codex, false);
  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.checks.twoManagedTerminals, false);
});

test("one-window Claude log fails Claude activation checks", () => {
  const claudeTerminalCycle = [
    "signal_accepted provider=claude target=terminal reason=attention",
    "popup_issued target=terminal provider=claude reason=attention",
    "activation_succeeded target=terminal provider=claude evidence=exact_window+exact_active_terminal+terminal_focus_command",
  ].join("\n");
  const summary = summarizeAcceptanceEvidence([
    { windowId: "window1", text: [
      "router_ready route_storage=memory notification_content=constant focus_target=captured",
      claudeTerminalCycle,
    ].join("\n") },
  ]);
  const evaluation = evaluateAcceptanceEvidence(summary);
  assert.equal(summary.claudeTerminalSignals, 1);
  assert.equal(summary.claudeTerminalToasts, 1);
  assert.equal(summary.claudeTerminalActivations, 1);
  assert.equal(evaluation.checks.twoReadyWindows, false);
  assert.equal(evaluation.checks.twoClaudeTerminalSignals, false);
  assert.equal(evaluation.checks.twoClaudeTerminalToasts, false);
  assert.equal(evaluation.checks.twoClaudeTerminalActivations, false);
  assert.equal(evaluation.passed, false);
});

test("Codex-only log passes every Codex CLI check", () => {
  const codexTerminalCycle = [
    "signal_accepted provider=codex target=terminal reason=attention",
    "popup_issued target=terminal provider=codex reason=attention",
    "activation_succeeded target=terminal provider=codex evidence=exact_window+exact_active_terminal+terminal_focus_command",
  ].join("\n");
  const summary = summarizeAcceptanceEvidence([
    { windowId: "window1", text: [
      "router_ready route_storage=memory notification_content=constant focus_target=captured",
      "managed_terminal_started provider=codex route=exact_terminal",
      codexTerminalCycle,
      codexTerminalCycle,
      codexTerminalCycle,
    ].join("\n") },
    { windowId: "window2", text: [
      "router_ready route_storage=memory notification_content=constant focus_target=captured",
      "managed_terminal_started provider=codex route=exact_terminal",
      codexTerminalCycle,
      "activation_rejected reason=expired_closed_or_replayed",
    ].join("\n") },
  ]);
  const evaluation = evaluateAcceptanceEvidence(summary);
  assert.equal(evaluation.checks.twoReadyWindows, true);
  assert.equal(evaluation.checks.twoManagedTerminals, true);
  assert.equal(evaluation.checks.threeTerminalLifecycleSignals, true);
  assert.equal(evaluation.checks.threeTerminalToasts, true);
  assert.equal(evaluation.checks.threeTerminalActivations, true);
  assert.equal(evaluation.checks.staleTargetFailsClosed, true);
  assert.equal(evaluation.checks.noUnexpectedFailures, true);
  // The mirror of the Claude case: Codex is proved, Claude is unmeasured, gate fails.
  assert.equal(evaluation.providers.codex, true);
  assert.equal(evaluation.providers.claude, false);
  assert.equal(evaluation.passed, false);
});

test("counts the same events when every line carries the 0.5.2 timestamp", () => {
  // The stamp is appended, so a fixed token stays the start of its line. A
  // collector that compared whole lines would silently count zero from 0.5.2
  // onward and report a working route as one that never ran.
  const stamp = (line) => `${line} t=2026-08-13T08:41:02.113Z`;
  const summary = summarizeAcceptanceEvidence([
    { windowId: "window1", text: [
      stamp("router_ready route_storage=memory notification_content=constant focus_target=captured"),
      stamp("managed_terminal_started provider=codex route=exact_terminal"),
      stamp("signal_accepted provider=claude target=terminal reason=finished"),
      stamp("popup_issued target=terminal provider=claude reason=finished"),
      stamp("activation_succeeded target=terminal provider=claude evidence=exact_window+exact_active_terminal+terminal_focus_command"),
      stamp("activation_rejected reason=terminal_not_live"),
    ].join("\n") },
  ]);
  assert.equal(summary.routerReadyWindows, 1);
  assert.equal(summary.managedTerminals, 1);
  assert.equal(summary.claudeTerminalSignals, 1);
  assert.equal(summary.claudeTerminalToasts, 1);
  assert.equal(summary.claudeTerminalActivations, 1);
  assert.equal(summary.staleTargetRejections, 1);
  assert.equal(summary.unexpectedFailures, 0);
});

test("a longer token that merely starts the same is not counted", () => {
  // isToken must not degrade into a bare prefix test. Longer lifecycle tokens
  // must not manufacture a pass.
  const summary = summarizeAcceptanceEvidence([
    { windowId: "window1", text: [
      "activation_rejected reason=terminal_not_live_yet",
      "managed_terminal_started provider=codex route=exact_terminal_pending",
    ].join("\n") },
  ]);
  assert.equal(summary.staleTargetRejections, 0);
  assert.equal(summary.managedTerminals, 0);
});

test("the CLI-only acceptance gate has no conversation surface", () => {
  const summary = summarizeAcceptanceEvidence([{
    windowId: "window1",
    text: [
      "signal_accepted provider=codex target=conversation reason=finished",
      "popup_issued target=conversation provider=codex reason=finished",
      "activation_succeeded target=conversation",
    ].join("\n"),
  }]);
  const evaluation = evaluateAcceptanceEvidence(summary);
  assert.equal(Object.hasOwn(summary, "conversationSignals"), false);
  assert.equal(Object.hasOwn(summary, "conversationToasts"), false);
  assert.equal(Object.hasOwn(summary, "conversationActivations"), false);
  assert.equal(Object.hasOwn(evaluation.checks, "conversationSignal"), false);
  assert.equal(Object.hasOwn(evaluation.checks, "conversationToast"), false);
  assert.equal(Object.hasOwn(evaluation.checks, "conversationActivation"), false);
});
