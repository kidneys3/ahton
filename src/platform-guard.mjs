export const WINDOWS_ONLY_MESSAGE = "Ahton works on Windows only. It does nothing on this operating system.";

/** @param {string} platform */
export function isSupportedPlatform(platform) {
  return platform === "win32";
}

/**
 * Off Windows the extension registers each command with one message and starts
 * nothing: no listener, no terminal, no native helper.
 *
 * @param {{
 *   commandIds: readonly string[],
 *   register: (id: string, handler: () => Promise<void>) => {dispose(): void},
 *   show: (message: string) => PromiseLike<unknown>,
 * }} options
 */
export function registerWindowsOnlyCommands({ commandIds, register, show }) {
  return commandIds.map((id) => register(id, async () => { await show(WINDOWS_ONLY_MESSAGE); }));
}
