import { CLAUDE_MARKERS } from "./signals.mjs";

const ESC = "\u001b";
const BEL = "\u0007";
const OSC_PREFIX = `${ESC}]`;
const ST = `${ESC}\\`;
const DCS_TMUX_PREFIX = `${ESC}Ptmux;`;
const DEFAULT_MAX_BUFFER = 16 * 1024;
const DEFAULT_MAX_FRAME = 4 * 1024;

/**
 * Streaming, allowlist-only parser for the compatibility markers Ahton accepts.
 * The parser never returns OSC title/body content.
 */
export class OscSignalParser {
  #buffer = "";
  #onSignal;
  #maxBuffer;
  #maxFrame;

  /**
   * @param {(signal: {provider: "claude" | "codex", reason: "finished" | "attention"}) => void} onSignal
   * @param {{maxBuffer?: number, maxFrame?: number}} [options]
   */
  constructor(onSignal, options = {}) {
    this.#onSignal = onSignal;
    this.#maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.#maxFrame = options.maxFrame ?? DEFAULT_MAX_FRAME;
  }

  /** @param {string} chunk */
  feed(chunk) {
    if (!chunk) {
      return;
    }

    this.#buffer += chunk;
    if (this.#buffer.length > this.#maxBuffer) {
      this.#buffer = this.#buffer.slice(-this.#maxBuffer);
    }

    while (true) {
      // A complete wrapper is unwrapped before scanning. An incomplete wrapper
      // is a protected suffix: OSC-looking bytes inside it must not be parsed
      // until the outer DCS terminator arrives.
      let protectedDcsStart = this.#unwrapTmuxPassthrough();
      const start = this.#buffer.indexOf(OSC_PREFIX);
      if (start === -1 || (protectedDcsStart !== -1 && start >= protectedDcsStart)) {
        this.#buffer = protectedDcsStart !== -1
          ? this.#buffer.slice(protectedDcsStart)
          : this.#buffer.endsWith(ESC) ? ESC : "";
        return;
      }

      if (start > 0) {
        this.#buffer = this.#buffer.slice(start);
        if (protectedDcsStart !== -1) {
          protectedDcsStart -= start;
        }
      }

      const afterStart = OSC_PREFIX.length;
      const endBel = this.#buffer.indexOf(BEL, afterStart);
      const endSt = this.#buffer.indexOf(ST, afterStart);
      let end = -1;
      let terminatorLength = 0;

      if (endBel !== -1 && (endSt === -1 || endBel < endSt)) {
        end = endBel;
        terminatorLength = BEL.length;
      } else if (endSt !== -1) {
        end = endSt;
        terminatorLength = ST.length;
      }

      if (protectedDcsStart !== -1 && end >= protectedDcsStart) {
        end = -1;
      }

      if (end === -1) {
        if (protectedDcsStart !== -1) {
          this.#buffer = this.#buffer.slice(protectedDcsStart);
          return;
        }
        if (this.#buffer.length > this.#maxFrame) {
          this.#buffer = this.#buffer.slice(OSC_PREFIX.length);
          continue;
        }
        return;
      }

      const content = this.#buffer.slice(afterStart, end);
      this.#buffer = this.#buffer.slice(end + terminatorLength);
      if (content.length <= this.#maxFrame) {
        this.#parseAllowlistedContent(content);
      }
    }
  }

  get bufferedLength() {
    return this.#buffer.length;
  }

  /** @param {string} content */
  #parseAllowlistedContent(content) {
    if (content === CLAUDE_MARKERS.finished) {
      this.#onSignal({ provider: "claude", reason: "finished" });
      return;
    }
    if (content === CLAUDE_MARKERS.attention) {
      this.#onSignal({ provider: "claude", reason: "attention" });
      return;
    }

    // Codex's supported `tui.notification_method = "osc9"` emits OSC 9.
    // Discard its body and ignore the OSC 9;4 progress protocol.
    if (content.startsWith("9;") && !content.startsWith("9;4;") && content.length > 2) {
      this.#onSignal({ provider: "codex", reason: "attention" });
    }
  }

  #unwrapTmuxPassthrough() {
    while (true) {
      const start = this.#buffer.indexOf(DCS_TMUX_PREFIX);
      if (start === -1) {
        const partialLength = longestSuffixPrefix(this.#buffer, DCS_TMUX_PREFIX);
        return partialLength > 0 ? this.#buffer.length - partialLength : -1;
      }

      const payloadStart = start + DCS_TMUX_PREFIX.length;
      const end = findUnescapedStringTerminator(this.#buffer, payloadStart);
      if (end === -1) {
        return start;
      }

      const inner = this.#buffer
        .slice(payloadStart, end)
        .replaceAll(`${ESC}${ESC}`, ESC);
      this.#buffer = this.#buffer.slice(0, start) + inner + this.#buffer.slice(end + ST.length);
    }
  }
}

/** @param {string} value @param {string} prefix */
function longestSuffixPrefix(value, prefix) {
  const limit = Math.min(value.length, prefix.length - 1);
  for (let length = limit; length > 0; length -= 1) {
    if (value.endsWith(prefix.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

/**
 * tmux doubles inner ESC bytes. An outer ST therefore has an odd-length run
 * of ESC bytes before its backslash; doubled inner ST has an even-length run.
 * @param {string} value
 * @param {number} from
 */
function findUnescapedStringTerminator(value, from) {
  for (let index = from; index < value.length - 1; index += 1) {
    if (value[index] !== ESC || value[index + 1] !== "\\") {
      continue;
    }

    let runLength = 1;
    for (let prior = index - 1; prior >= from && value[prior] === ESC; prior -= 1) {
      runLength += 1;
    }
    if (runLength % 2 === 1) {
      return index;
    }
  }
  return -1;
}
