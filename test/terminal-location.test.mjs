import assert from "node:assert/strict";
import test from "node:test";

import { isEditorAreaTerminal, terminalFocusCommand } from "../src/terminal-location.mjs";

test("a panel terminal keeps the panel focus command", () => {
  assert.equal(isEditorAreaTerminal({ creationOptions: {} }), false);
  assert.equal(terminalFocusCommand({ creationOptions: {} }), "workbench.action.terminal.focus");
});

test("an editor-area terminal focuses its editor group, not the panel", () => {
  // Many users work in editor tabs. Sending the panel command here is what could
  // open the panel over his work instead of revealing the tab.
  const enumForm = { creationOptions: { location: 2 } };
  const objectForm = { creationOptions: { location: { viewColumn: 1 } } };
  for (const terminal of [enumForm, objectForm]) {
    assert.equal(isEditorAreaTerminal(terminal), true);
    assert.equal(terminalFocusCommand(terminal), "workbench.action.focusActiveEditorGroup");
  }
});

test("a terminal with no creationOptions is treated as a panel terminal", () => {
  // Fail towards the previous behaviour, which is proven to work for the panel,
  // rather than towards an editor command that may focus the wrong control.
  assert.equal(terminalFocusCommand({}), "workbench.action.terminal.focus");
  assert.equal(isEditorAreaTerminal(undefined), false);
});

test("TerminalLocation.Panel is not mistaken for the editor area", () => {
  // VS Code's TerminalLocation is Panel = 1, Editor = 2. An off-by-one here
  // would send every panel terminal down the editor path.
  assert.equal(isEditorAreaTerminal({ creationOptions: { location: 1 } }), false);
});
