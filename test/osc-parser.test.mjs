import assert from "node:assert/strict";
import test from "node:test";

import { OscSignalParser } from "../src/osc-parser.mjs";
import { CLAUDE_MARKERS } from "../src/signals.mjs";

const ESC = "\u001b";
const BEL = "\u0007";
const ST = `${ESC}\\`;

function parse(chunks) {
  const signals = [];
  const parser = new OscSignalParser((signal) => signals.push(signal));
  for (const chunk of chunks) parser.feed(chunk);
  return { signals, parser };
}

test("recognizes only the two fixed Claude markers", () => {
  const finished = `${ESC}]${CLAUDE_MARKERS.finished}${BEL}`;
  const attention = `${ESC}]${CLAUDE_MARKERS.attention}${ST}`;
  const result = parse([finished, attention]);
  assert.deepEqual(result.signals, [
    { provider: "claude", reason: "finished" },
    { provider: "claude", reason: "attention" },
  ]);
});

test("parses a marker across every possible two-chunk split", () => {
  const frame = `before${ESC}]${CLAUDE_MARKERS.finished}${BEL}after`;
  for (let split = 0; split <= frame.length; split += 1) {
    const result = parse([frame.slice(0, split), frame.slice(split)]);
    assert.deepEqual(result.signals, [{ provider: "claude", reason: "finished" }]);
  }
});

test("unwraps single and nested tmux passthrough", () => {
  const marker = `${ESC}]${CLAUDE_MARKERS.attention}${BEL}`;
  const wrap = (value) => `${ESC}Ptmux;${value.replaceAll(ESC, `${ESC}${ESC}`)}${ST}`;
  for (const frame of [wrap(marker), wrap(wrap(marker))]) {
    for (let split = 0; split <= frame.length; split += 1) {
      assert.deepEqual(parse([frame.slice(0, split), frame.slice(split)]).signals, [
        { provider: "claude", reason: "attention" },
      ]);
    }
  }

  const bare = `${ESC}]${CLAUDE_MARKERS.finished}${BEL}`;
  const combined = bare + wrap(marker);
  for (let split = 0; split <= combined.length; split += 1) {
    assert.deepEqual(parse([combined.slice(0, split), combined.slice(split)]).signals, [
      { provider: "claude", reason: "finished" },
      { provider: "claude", reason: "attention" },
    ]);
  }
});

test("Codex OSC 9 bodies are discarded and progress OSC is ignored", () => {
  const privateBody = "patient-name C:/private/worktree prompt reply";
  const result = parse([
    `${ESC}]9;${privateBody}${BEL}`,
    `${ESC}]9;4;1;50${BEL}`,
  ]);
  assert.deepEqual(result.signals, [{ provider: "codex", reason: "attention" }]);
  assert.equal(JSON.stringify(result.signals).includes(privateBody), false);
});

test("near misses, oversized frames, and unrelated OSC fail closed", () => {
  const result = parse([
    `${ESC}]777;notify;agent-bridge-v1;claude-finished-extra${BEL}`,
    `${ESC}]52;c;clipboard${BEL}`,
    `${ESC}]${"x".repeat(5000)}${BEL}`,
    `${ESC}]9;4;3;100${BEL}`,
  ]);
  assert.deepEqual(result.signals, []);
  assert.ok(result.parser.bufferedLength <= 16 * 1024);

  const incompleteTmux = parse([`${ESC}Ptmux;${"x".repeat(20 * 1024)}`]);
  assert.deepEqual(incompleteTmux.signals, []);
  assert.ok(incompleteTmux.parser.bufferedLength <= 16 * 1024);
});
