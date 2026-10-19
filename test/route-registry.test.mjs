import assert from "node:assert/strict";
import test from "node:test";

import { RouteRegistry } from "../src/route-registry.mjs";

test("opaque routes and activations are 256-bit base64url capabilities", () => {
  const terminal = {};
  const registry = new RouteRegistry();
  const route = registry.bind(terminal, "claude");
  const activation = registry.issueActivation(terminal, "claude");
  assert.match(route, /^[A-Za-z0-9_-]{43}$/);
  assert.match(activation, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(route, activation);
});

test("an activation selects exactly its terminal and is one-use", () => {
  const terminalA = {};
  const terminalB = {};
  const registry = new RouteRegistry();
  registry.bind(terminalA, "claude");
  registry.bind(terminalB, "claude");
  const activation = registry.issueActivation(terminalA, "claude");
  assert.deepEqual(registry.consume(activation), { terminal: terminalA, provider: "claude" });
  assert.equal(registry.consume(activation), null);
});

test("provider mismatch, closed terminals, and expired activations fail closed", () => {
  let now = 1_000;
  const live = new Set();
  const terminal = {};
  live.add(terminal);
  const registry = new RouteRegistry({
    clock: () => now,
    isTerminalLive: (candidate) => live.has(candidate),
    activationTtlMs: 50,
  });
  registry.bind(terminal, "claude");
  assert.equal(registry.issueActivation(terminal, "codex"), null);

  const expired = registry.issueActivation(terminal, "claude");
  now += 51;
  assert.equal(registry.consume(expired), null);

  const closed = registry.issueActivation(terminal, "claude");
  live.delete(terminal);
  assert.equal(registry.consume(closed), null);
});

test("closing and rebinding revoke stale activations", () => {
  const terminal = {};
  const registry = new RouteRegistry();
  registry.bind(terminal, "claude");
  const stale = registry.issueActivation(terminal, "claude");
  registry.close(terminal);
  registry.bind(terminal, "claude");
  assert.equal(registry.consume(stale), null);
});

test("100 shuffled terminal activations never misroute", () => {
  const terminals = Array.from({ length: 100 }, (_, index) => ({ index }));
  const registry = new RouteRegistry();
  const pairs = terminals.map((terminal, index) => {
    const provider = index % 2 === 0 ? "claude" : "codex";
    registry.bind(terminal, provider);
    return { terminal, provider, activation: registry.issueActivation(terminal, provider) };
  });

  let seed = 0x5eed1234;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let index = pairs.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [pairs[index], pairs[swap]] = [pairs[swap], pairs[index]];
  }

  for (const pair of pairs) {
    assert.deepEqual(registry.consume(pair.activation), {
      terminal: pair.terminal,
      provider: pair.provider,
    });
  }
});
