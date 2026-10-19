/**
 * A terminal can live in the bottom panel or as a tab in the editor area.
 * Many users work in editor tabs, so the reveal must not assume the panel.
 *
 * `workbench.action.terminal.focus` acts on the terminal panel. For a terminal
 * that lives in the editor area the correct control to focus is the editor
 * group holding its tab. Sending the panel command for an editor terminal is
 * the case that could open the panel over the work, or move focus away from the
 * tab that was just revealed.
 *
 * `Terminal.show()` reveals either kind. This module only decides which control
 * takes focus afterwards.
 */

/** VS Code's TerminalLocation.Editor. Compared numerically so the module stays
 * importable outside the extension host, where the vscode enum does not exist. */
const TERMINAL_LOCATION_EDITOR = 2;

/**
 * @param {{creationOptions?: {location?: unknown}}} terminal
 * @returns {boolean}
 */
export function isEditorAreaTerminal(terminal) {
  const location = terminal?.creationOptions?.location;
  if (location === TERMINAL_LOCATION_EDITOR) return true;
  // A profile launched into the editor area reports an object form,
  // { viewColumn: ... }, rather than the plain enum.
  if (location && typeof location === "object" && "viewColumn" in location) return true;
  return false;
}

/**
 * @param {{creationOptions?: {location?: unknown}}} terminal
 * @returns {"workbench.action.focusActiveEditorGroup" | "workbench.action.terminal.focus"}
 */
export function terminalFocusCommand(terminal) {
  return isEditorAreaTerminal(terminal)
    ? "workbench.action.focusActiveEditorGroup"
    : "workbench.action.terminal.focus";
}
