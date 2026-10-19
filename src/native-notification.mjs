import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseWindowHandle } from "./window-focus.mjs";
import { shortLabel, workspaceLabel } from "./terminal-display-label.mjs";

const execFileAsync = promisify(execFile);
const PROVIDERS = new Set(["claude", "codex"]);
const REASONS = new Set(["finished", "attention"]);

/** @param {unknown} value */
function validPid(value) {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 0xffff_ffff;
}

function failedSession() {
  return { outcome: Promise.resolve("failed"), dispose() {} };
}

/** @param {unknown} value */
function validDisplayTarget(value) {
  if (!value || typeof value !== "object") return false;
  const target = /** @type {Record<string, unknown>} */ (value);
  if (!Number.isInteger(target.index)) return false;
  // The label is re-checked here, not trusted from the caller. It is the one
  // field that carries text a person chose, so it is validated at the boundary
  // it crosses as well as where it was produced.
  if (target.label !== undefined && shortLabel(target.label) !== target.label) return false;
  if (target.workspace !== undefined && workspaceLabel(target.workspace) !== target.workspace) return false;
  return target.kind === "terminal" && Number(target.index) >= 1 && Number(target.index) <= 999;
}

/**
 * Launch a fixed-content, non-activating native Ahton popup.
 * The helper receives only authoritative numeric identity and allowlisted enums.
 * @param {string} helperPath
 * @param {string} windowHandle
 * @param {number} extensionHostPid
 * @param {string} provider
 * @param {string} reason
 * @param {{kind: string, index: number, label?: string, workspace?: string}} displayTarget
 * @param {typeof execFileAsync} [run]
 * @param {NodeJS.Platform} [platform]
 */
export function startNativeNotification(
  helperPath,
  windowHandle,
  extensionHostPid,
  provider,
  reason,
  displayTarget,
  run = execFileAsync,
  platform = process.platform,
) {
  const target = parseWindowHandle(windowHandle);
  if (platform !== "win32" || !target || !validPid(extensionHostPid) ||
      !PROVIDERS.has(provider) || !REASONS.has(reason)) {
    return failedSession();
  }
  if (!validDisplayTarget(displayTarget)) return failedSession();

  const controller = new AbortController();
  const outcome = (async () => {
    try {
      await run(
        helperPath,
        // Optional trailing arguments, omitted when absent, so the helper's older
        // 8-argument (ordinal) and 9-argument (ordinal+label) forms stay exactly
        // as they were. The 10-argument form is used only when a workspace name
        // is present: argv[8] is the label or "" for none, argv[9] the workspace.
        ["notify", target, String(extensionHostPid), provider, reason,
          displayTarget.kind, String(displayTarget.index),
          ...(displayTarget.workspace !== undefined
            ? [displayTarget.label ?? "", displayTarget.workspace]
            : displayTarget.label === undefined ? [] : [displayTarget.label])],
        { windowsHide: true, timeout: 125_000, maxBuffer: 1024, signal: controller.signal },
      );
      return "activated";
    } catch (error) {
      if (controller.signal.aborted) return "cancelled";
      const record = error && typeof error === "object"
        ? /** @type {Record<string, unknown>} */ (error)
        : undefined;
      const code = record?.code;
      if (code === 20) return "dismissed";
      if (code === 21) return "timed_out";
      return "failed";
    }
  })();

  return {
    outcome,
    dispose() {
      controller.abort();
    },
  };
}
