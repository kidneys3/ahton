import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_UINT_PTR = 18_446_744_073_709_551_615n;

/** @param {unknown} value */
export function parseWindowHandle(value) {
  if (typeof value !== "string") {
    return null;
  }
  const candidate = value.trim();
  if (!/^[1-9][0-9]{0,19}$/.test(candidate)) {
    return null;
  }
  try {
    const parsed = BigInt(candidate);
    return parsed <= MAX_UINT_PTR ? candidate : null;
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function validPid(value) {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 0xffff_ffff;
}

/**
 * @param {string} helperPath
 * @param {number} extensionHostPid
 * @param {typeof execFileAsync} [run]
 * @param {NodeJS.Platform} [platform]
 */
export async function captureOwningWindow(
  helperPath,
  extensionHostPid,
  run = execFileAsync,
  platform = process.platform,
) {
  if (platform !== "win32" || !validPid(extensionHostPid)) {
    return null;
  }
  try {
    const { stdout } = await run(
      helperPath,
      ["capture", String(extensionHostPid)],
      { windowsHide: true, timeout: 1500, maxBuffer: 1024 },
    );
    return parseWindowHandle(String(stdout));
  } catch {
    return null;
  }
}

/**
 * @param {string} helperPath
 * @param {string} windowHandle
 * @param {number} extensionHostPid
 * @param {typeof execFileAsync} [run]
 * @param {NodeJS.Platform} [platform]
 */
export async function focusOwningWindow(
  helperPath,
  windowHandle,
  extensionHostPid,
  run = execFileAsync,
  platform = process.platform,
) {
  const target = parseWindowHandle(windowHandle);
  if (platform !== "win32" || !target || !validPid(extensionHostPid)) {
    return false;
  }
  try {
    await run(
      helperPath,
      ["focus", target, String(extensionHostPid)],
      { windowsHide: true, timeout: 2000, maxBuffer: 1024 },
    );
    return true;
  } catch {
    return false;
  }
}

/** @param {string} helperPath @param {string} windowHandle @param {number} extensionHostPid
 * @param {typeof execFileAsync} [run] @param {NodeJS.Platform} [platform] */
export async function verifyOwningWindow(
  helperPath, windowHandle, extensionHostPid, run = execFileAsync, platform = process.platform,
) {
  const target = parseWindowHandle(windowHandle);
  if (platform !== "win32" || !target || !validPid(extensionHostPid)) return false;
  try {
    await run(helperPath, ["verify", target, String(extensionHostPid)],
      { windowsHide: true, timeout: 1500, maxBuffer: 1024 });
    return true;
  } catch {
    return false;
  }
}
