/**
 * The longest label the popup will show. Typical names -- "Claude
 * Api", "Claude Web Docs" -- are well inside it. The limit is the
 * boundary that matters: an agent's own tab title is derived from the task, and
 * those run long ("Review mid bundle workflow with tiered agent delegation",
 * 54 characters). Anything over the limit is refused rather than truncated,
 * because a truncation of a task title still discloses the start of the task.
 */
export const MAX_LABEL_LENGTH = 28;

/** At most four words. A short project name, not a sentence. */
const MAX_LABEL_WORDS = 4;

/**
 * Letters, digits, spaces and a few joiners. Excludes every path separator,
 * drive colon, quote and shell metacharacter, so a shell-set title carrying a
 * path or command cannot reach the popup.
 */
const ALLOWED_LABEL = /^[A-Za-z0-9 &._-]+$/;

/**
 * The label must open with the provider and then a project word:
 * "claude api", "c web", "d docs", "k notes". The letters are c for Claude,
 * d for Codex, k for Kimi. Case is ignored.
 *
 * Nothing in the VS Code API says who set a terminal's name, so length alone
 * cannot separate a name the user typed from a title a shell wrote -- "private
 * patient title" is short and would have passed. Requiring the prefix makes the
 * rule mechanical instead of trusting the user to remember to rename.
 *
 * The one-letter forms are a weaker discriminator than the words, by design.
 * A shell-set title beginning "c " would now be shown. The other
 * rules still bound what such a title could be: 28 characters, four words, and
 * no path separator, colon, quote or shell metacharacter.
 */
const REQUIRED_LABEL_PREFIX = /^(claude|codex|kimi|c|d|k) \S/i;

/**
 * Reduce a terminal's name to a label safe to show, or null to fall back to the
 * ordinal. Null is the safe answer and is returned whenever anything is
 * unexpected.
 *
 * @param {unknown} name
 * @returns {string | null}
 */
export function shortLabel(name) {
  if (typeof name !== "string") return null;
  const collapsed = name.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0 || collapsed.length > MAX_LABEL_LENGTH) return null;
  if (!REQUIRED_LABEL_PREFIX.test(collapsed)) return null;
  if (!ALLOWED_LABEL.test(collapsed)) return null;
  if (collapsed.split(" ").length > MAX_LABEL_WORDS) return null;
  // A label of punctuation alone names nothing.
  if (!/[A-Za-z]/.test(collapsed)) return null;
  // "..' would be a relative path fragment even inside the allowed set.
  if (collapsed.includes("..")) return null;
  return collapsed;
}

/**
 * With the label setting off the popup keeps its ordinal and drops the typed
 * name. The input is not changed.
 *
 * @param {{kind: string, index: number, label?: string}} target
 * @param {boolean} showLabel
 */
export function withLabelPreference(target, showLabel) {
  if (showLabel || target.label === undefined) return target;
  const { label: _label, ...rest } = target;
  return rest;
}

export class TerminalDisplayRegistry {
  constructor() {
    /** @type {WeakMap<object, number>} */
    this.slots = new WeakMap();
    this.nextSlot = 1;
  }

  /**
   * Stable session-local ordinal, plus a short label when the terminal's name
   * passes shortLabel(). The ordinal is always present, so a refused name costs
   * recognisability and never the route: the popup still names its exact target.
   *
   * The design is a short label the user sets, not the
   * agent's own task-derived tab title. shortLabel() is what enforces that
   * distinction mechanically rather than by the user remembering to rename.
   *
   * @param {{name?: unknown}} terminal
   */
  targetFor(terminal) {
    let index = this.slots.get(terminal);
    if (index === undefined) {
      index = this.nextSlot++;
      this.slots.set(terminal, index);
    }
    const label = shortLabel(/** @type {{name?: unknown}} */ (terminal)?.name);
    return label === null
      ? { kind: "terminal", index }
      : { kind: "terminal", index, label };
  }
}
