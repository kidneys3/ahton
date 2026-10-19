import assert from "node:assert/strict";
import test from "node:test";

import { startShellIntegratedTerminal } from "../src/managed-terminal.mjs";

test("managed terminal starts Codex only after shell integration", async () => {
  const terminal = fakeTerminal();
  let listener;
  const pending = startShellIntegratedTerminal({
    createTerminal: () => terminal,
    onDidChangeTerminalShellIntegration: (candidate) => {
      listener = candidate;
      return { dispose() {} };
    },
  }, { terminalOptions: { env: { AGENT_BRIDGE_PROVIDER: "codex" } }, timeoutMs: 100 });

  assert.deepEqual(terminal.sent, []);
  terminal.shellIntegration = {};
  listener({ terminal });
  assert.deepEqual(await pending, { started: true });
  assert.deepEqual(terminal.sent, [{ text: "codex", addNewLine: true }]);
  assert.equal(terminal.shown, true);
  assert.equal(terminal.disposed, false);
});

test("managed terminal closes the subscribe race", async () => {
  const terminal = fakeTerminal();
  const result = await startShellIntegratedTerminal({
    createTerminal: () => terminal,
    onDidChangeTerminalShellIntegration: () => {
      terminal.shellIntegration = {};
      return { dispose() {} };
    },
  }, { terminalOptions: {}, timeoutMs: 100 });

  assert.deepEqual(result, { started: true });
  assert.equal(terminal.sent.length, 1);
});

test("managed terminal fails closed when shell integration is unavailable", async () => {
  const terminal = fakeTerminal();
  const result = await startShellIntegratedTerminal({
    createTerminal: () => terminal,
    onDidChangeTerminalShellIntegration: () => ({ dispose() {} }),
  }, { terminalOptions: {}, timeoutMs: 5 });

  assert.deepEqual(result, { started: false, reason: "shell_integration_unavailable" });
  assert.deepEqual(terminal.sent, []);
  assert.equal(terminal.disposed, true);
});

function fakeTerminal() {
  return {
    shellIntegration: undefined,
    exitStatus: undefined,
    sent: [],
    shown: false,
    disposed: false,
    show() { this.shown = true; },
    sendText(text, addNewLine) { this.sent.push({ text, addNewLine }); },
    dispose() { this.disposed = true; },
  };
}
