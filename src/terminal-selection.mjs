/**
 * Selecting the exact terminal a Claude signal came from.
 *
 * The signalling process names a shell pid; it is never trusted as authority.
 * The candidate list is built from VS Code's own `Terminal.processId` values,
 * so a name that matches nothing this window owns selects nothing. Zero or
 * several matches fail closed: guessing is the misroute this design exists to
 * prevent, and there is deliberately no fallback to the active terminal.
 */

/** @param {unknown} value */
export function parseShellPid(value) {
  const pid = typeof value === "string" && /^[1-9][0-9]{0,9}$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(pid) || Number(pid) < 1 || Number(pid) > 0xffff_ffff) {
    return null;
  }
  return Number(pid);
}

/**
 * @param {number} shellPid
 * @param {Array<{terminal: object, shellPid: unknown}>} candidates
 * @returns {object | null}
 */
export function selectExactTerminal(shellPid, candidates) {
  const wanted = parseShellPid(shellPid);
  if (wanted === null || !Array.isArray(candidates)) {
    return null;
  }
  const matches = candidates.filter((candidate) =>
    candidate && parseShellPid(candidate.shellPid) === wanted);
  return matches.length === 1 ? matches[0].terminal : null;
}
