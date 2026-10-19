/**
 * Timestamps for Ahton's own diagnostics.
 *
 * The attended run on 2026-08-13 raised a question the log could not answer:
 * a popup was felt to arrive late, and its click was felt to reveal the terminal
 * much later still. Every line in the channel was untimed, so "late" stayed a
 * feeling and no latency could be measured. The stamp is appended, never
 * prefixed, so the existing fixed tokens remain the start of each line and the
 * acceptance collector keeps matching them.
 *
 * The stamp is an ISO instant and nothing else. It carries no path, prompt,
 * reply, terminal name, thread id or process id, so it does not widen what the
 * channel discloses.
 */

/**
 * @param {string} line
 * @param {Date} now
 * @returns {string}
 */
export function timestampedLine(line, now) {
  return `${line} t=${now.toISOString()}`;
}

/**
 * Wrap an output channel so every diagnostic line carries the instant it was
 * written. Only appendLine is used by the router, so only appendLine is wrapped.
 *
 * @param {{appendLine(value: string): void}} channel
 * @param {() => Date} [clock]
 * @returns {{appendLine(value: string): void}}
 */
export function withTimestamps(channel, clock = () => new Date()) {
  return {
    appendLine(line) {
      channel.appendLine(timestampedLine(line, clock()));
    },
  };
}
