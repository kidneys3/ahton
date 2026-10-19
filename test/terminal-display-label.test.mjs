import assert from "node:assert/strict";
import test from "node:test";

import { TerminalDisplayRegistry, shortLabel, withLabelPreference } from "../src/terminal-display-label.mjs";

test("terminal display assigns stable non-reused session ordinals", () => {
  const labels = new TerminalDisplayRegistry();
  const first = { name: "private patient title" };
  const second = { name: "C:\\private\\path" };
  assert.deepEqual(labels.targetFor(first), { kind: "terminal", index: 1 });
  assert.deepEqual(labels.targetFor(first), { kind: "terminal", index: 1 });
  assert.deepEqual(labels.targetFor(second), { kind: "terminal", index: 2 });
});

test("a terminal title that is not a chosen label never enters the display target", () => {
  // The popup shows a short label the user sets. The boundary is
  // "only a name in the provider-prefix convention", never an arbitrary title.
  // Everything else must still be absent, not shortened.
  const labels = new TerminalDisplayRegistry();
  const sentinel = "PRIVATE-PATIENT-PATH-PROMPT";
  const target = labels.targetFor({ name: sentinel, creationOptions: { name: sentinel } });
  assert.equal(JSON.stringify(target).includes(sentinel), false);
});

test("a short private title is refused because it is not in the convention", () => {
  // Length alone cannot separate a name the user typed from a title a shell wrote.
  // "private patient title" is 21 characters and three words, so it would have
  // passed a length rule. The provider prefix is what refuses it.
  const labels = new TerminalDisplayRegistry();
  assert.equal(shortLabel("private patient title"), null);
  assert.equal(shortLabel("wrong-patient defect"), null);
  assert.deepEqual(labels.targetFor({ name: "private patient title" }), { kind: "terminal", index: 1 });
});

test("chosen names are shown", () => {
  for (const name of ["Claude Api", "Claude Ahton", "Claude Web Docs", "Codex Notes"]) {
    assert.equal(shortLabel(name), name);
  }
});

test("an agent's task-derived tab title is refused, not truncated", () => {
  // A truncation would still disclose the start of the task. These are real tab
  // titles an agent derived from its task.
  assert.equal(shortLabel("Review mid bundle workflow with tiered agent delegation"), null);
  assert.equal(shortLabel("Check on project completion status and timeline"), null);
});

test("a path, command or shell metacharacter never reaches the popup", () => {
  for (const name of [
    "Claude D:\records\export",
    "Claude /var/records/export",
    "node scripts/x.mjs --token abc",
    "bash -c 'cat ~/.ssh/id_rsa'",
    "Claude ..\..\etc",
    "Claude: Api",
    "Claude \"Api\"",
  ]) {
    assert.equal(shortLabel(name), null, name);
  }
});

test("only a real name qualifies, and whitespace is normalised", () => {
  assert.equal(shortLabel("  Claude   Api  "), "Claude Api");
  assert.equal(shortLabel(""), null);
  assert.equal(shortLabel("   "), null);
  assert.equal(shortLabel("---"), null);
  assert.equal(shortLabel("Api"), null);
  assert.equal(shortLabel(undefined), null);
  assert.equal(shortLabel(42), null);
  assert.equal(shortLabel("Claude " + "a".repeat(22)), null);
  assert.equal(shortLabel("Claude " + "a".repeat(21)), "Claude " + "a".repeat(21));
});

test("the ordinal survives a refused name, so the popup still names its target", () => {
  const registry = new TerminalDisplayRegistry();
  const named = { name: "Claude Api" };
  const taskTitled = { name: "Review mid bundle workflow with tiered agent delegation" };
  assert.deepEqual(registry.targetFor(named), { kind: "terminal", index: 1, label: "Claude Api" });
  assert.deepEqual(registry.targetFor(taskTitled), { kind: "terminal", index: 2 });
  // The ordinal stays stable when the name later changes.
  named.name = "Claude Wine Selling";
  assert.deepEqual(registry.targetFor(named), { kind: "terminal", index: 1, label: "Claude Wine Selling" });
});

test("lowercase is accepted, because many people type lowercase", () => {
  assert.equal(shortLabel("claude ahton"), "claude ahton");
  assert.equal(shortLabel("codex docs"), "codex docs");
  assert.equal(shortLabel("CLAUDE API"), "CLAUDE API");
});

test("the one-letter provider prefixes are accepted", () => {
  // c Claude, d Codex, k Kimi, chosen on 2026-08-13.
  assert.equal(shortLabel("c web"), "c web");
  assert.equal(shortLabel("d docs"), "d docs");
  assert.equal(shortLabel("k notes"), "k notes");
  assert.equal(shortLabel("C Wine Selling"), "C Wine Selling");
});

test("a letter that is not a provider, or a letter alone, is still refused", () => {
  assert.equal(shortLabel("x web"), null);
  assert.equal(shortLabel("c"), null);
  assert.equal(shortLabel("c "), null);
  assert.equal(shortLabel("cweb"), null);
  // A long task title still fails on length even if it happens to start with c.
  assert.equal(shortLabel("check on project completion status"), null);
});

test("with the label setting off the popup target keeps its ordinal and drops the typed name", () => {
  const labels = new TerminalDisplayRegistry();
  const target = labels.targetFor({ name: "Claude Api" });
  assert.deepEqual(target, { kind: "terminal", index: 1, label: "Claude Api" });
  assert.deepEqual(withLabelPreference(target, true), target);
  assert.deepEqual(withLabelPreference(target, false), { kind: "terminal", index: 1 });
  // A target with no label passes through unchanged, and the input is not mutated.
  assert.deepEqual(withLabelPreference({ kind: "terminal", index: 2 }, false), { kind: "terminal", index: 2 });
  assert.equal(target.label, "Claude Api");
});
