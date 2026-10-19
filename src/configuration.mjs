import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { applyEdits, findNodeAtLocation, modify, parse as parseJsonc, parseTree, visit } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

const HUMAN_NOTIFICATION_MATCHER = [
  "idle_prompt",
  "permission_prompt",
  "elicitation_dialog",
  "agent_needs_input",
  "agent_completed",
].join("|");

// ---------------------------------------------------------------------------
// Shared: parsing, JSONC editing and the fail-closed write gate.
// ---------------------------------------------------------------------------

/**
 * One value the migration means to set. `value` undefined means "must be absent".
 * @typedef {{path: string[], value: unknown}} ManagedValue
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {string} text @param {string} label */
function parseJsoncStrict(text, label) {
  /** @type {import("jsonc-parser").ParseError[]} */
  const errors = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error(`${label} is not valid JSONC`);
  // jsonc-parser drops a "__proto__" member (escaped spellings included), so
  // the deep-equal gate could not see it removed. Refuse rather than lose it.
  let protoKey = false;
  visit(text, { onObjectProperty: (property) => { if (property === "__proto__") protoKey = true; } }, { allowTrailingComma: true });
  if (protoKey) throw new Error(`${label} holds a __proto__ key, which Ahton cannot edit safely`);
  return value;
}

/** @param {"jsonc" | "toml"} format @param {string} text @param {string} label */
function parseDocument(format, text, label) {
  if (format === "toml") {
    try { return parseToml(text); } catch { throw new Error(`${label} is not valid TOML`); }
  }
  return text.trim() === "" ? {} : parseJsoncStrict(text, label);
}

/** @param {any} root @param {string[]} keys */
function valueAt(root, keys) {
  let node = root;
  for (const key of keys) {
    if (!isPlainObject(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/** A copy of `root` without the value at `keys`; parents emptied by the removal go too. @param {any} root @param {string[]} keys @returns {any} */
function without(root, keys) {
  if (keys.length === 0 || !isPlainObject(root) || !Object.hasOwn(root, keys[0])) return root;
  const [head, ...rest] = keys;
  const copy = Object.assign(Object.create(Object.getPrototypeOf(root)), root);
  if (rest.length === 0) {
    delete copy[head];
  } else {
    copy[head] = without(root[head], rest);
    if (isPlainObject(copy[head]) && Object.keys(copy[head]).length === 0) delete copy[head];
  }
  return copy;
}

/**
 * The gate every file passes before it is written. It parses the candidate with
 * a real parser (jsonc-parser or smol-toml), then refuses unless the managed
 * values hold what the migration intended and everything else is deep-equal to
 * the original's parsed value. The intended values come from the migration's
 * plan; the candidate comes from the parser reading the edited text, so the two
 * sides share no writer. Messages carry no file content.
 *
 * @param {"jsonc" | "toml"} format
 * @param {string} original
 * @param {string} candidate
 * @param {ManagedValue[]} managed
 */
export function assertCandidateSafe(format, original, candidate, managed) {
  const label = format === "toml" ? "TOML" : "JSONC";
  const before = parseDocument(format, original, `Refusing to write: the original ${label} file`);
  const after = parseDocument(format, candidate, `Refusing to write: the candidate ${label} file`);
  if (!isPlainObject(before) || !isPlainObject(after)) {
    throw new Error(`Refusing to write: the ${label} file is not a top-level table of keys`);
  }
  for (const { path: keys, value } of managed) {
    if (!isDeepStrictEqual(valueAt(after, keys), value)) {
      throw new Error(`Refusing to write: managed value ${keys.join(".")} is not the intended value`);
    }
  }
  let rest = before;
  let candidateRest = after;
  for (const { path: keys } of managed) {
    rest = without(rest, keys);
    candidateRest = without(candidateRest, keys);
  }
  if (!isDeepStrictEqual(rest, candidateRest)) {
    throw new Error("Refusing to write: the change would alter an unrelated key or table");
  }
}

/**
 * Renders a value for insertion. Short objects and arrays of plain values stay
 * on one line, as people write them in settings files; the rest is indented.
 *
 * @param {any} value @param {string} indent @param {string} newline @returns {string}
 */
function renderJson(value, indent, newline) {
  const isPrimitive = (/** @type {unknown} */ item) => item === null || typeof item !== "object";
  const entries = Array.isArray(value) ? value : isPlainObject(value) ? Object.entries(value) : null;
  if (entries === null) return JSON.stringify(value);
  if (entries.length === 0) return Array.isArray(value) ? "[]" : "{}";
  const flat = Array.isArray(value)
    ? value.every(isPrimitive) && `[${value.map((item) => JSON.stringify(item)).join(", ")}]`
    : Object.values(value).every(isPrimitive) &&
      `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${JSON.stringify(item)}`).join(", ")}}`;
  if (flat && flat.length <= 72) return flat;
  const inner = `${indent}  `;
  const lines = Array.isArray(value)
    ? value.map((item) => `${inner}${renderJson(item, inner, newline)}`)
    : Object.entries(value).map(([key, item]) => `${inner}${JSON.stringify(key)}: ${renderJson(item, inner, newline)}`);
  return `${Array.isArray(value) ? "[" : "{"}${newline}${lines.join(`,${newline}`)}${newline}${indent}${Array.isArray(value) ? "]" : "}"}`;
}

/** The leading whitespace of the line holding `offset`. @param {string} text @param {number} offset */
function lineIndent(text, offset) {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start, offset))?.[0] ?? "";
}

/**
 * Sets (or, with undefined, removes) one value through jsonc-parser's modify()
 * and applyEdits(), so comments, trailing commas and every untouched byte stay.
 * modify() gets no formatting options: its formatter would re-indent the
 * neighbouring members. This function renders the new text itself instead.
 *
 * @param {string} text @param {(string | number)[]} keys @param {unknown} value @param {string} newline
 */
function editJsonc(text, keys, value, newline) {
  const planned = modify(text, keys, value, {});
  if (planned.length !== 1) throw new Error("Unexpected JSONC edit shape");
  const edit = planned[0];
  if (value === undefined) return applyEdits(text, planned);
  if (edit.length > 0) {
    const content = renderJson(value, lineIndent(text, edit.offset), newline);
    return applyEdits(text, [{ ...edit, content }]);
  }
  // An insertion: the new member goes inside the parent object.
  const tree = parseTree(text, [], { allowTrailingComma: true });
  if (!tree) throw new Error("Unexpected JSONC insertion point");
  // The nearest object that already exists takes the first missing key; any
  // keys below it nest inside the inserted value.
  let depth = keys.length - 1;
  while (depth > 0 && !findNodeAtLocation(tree, keys.slice(0, depth))) depth -= 1;
  const parent = depth === 0 ? tree : findNodeAtLocation(tree, keys.slice(0, depth));
  if (!parent || parent.type !== "object") throw new Error("Unexpected JSONC insertion point");
  const missing = keys.slice(depth);
  const nested = missing.slice(1).reduceRight((inner, key) => ({ [key]: inner }), value);
  const baseIndent = lineIndent(text, parent.offset);
  const indent = `${baseIndent}  `;
  const member = `${JSON.stringify(missing[0])}: ${renderJson(nested, indent, newline)}`;
  const last = parent.children?.[parent.children.length - 1];
  if (!last) {
    const inner = text.slice(parent.offset + 1, parent.offset + parent.length - 1);
    const content = `${newline}${indent}${member}${/\n/.test(inner) ? "" : `${newline}${baseIndent}`}`;
    return applyEdits(text, [{ ...edit, content }]);
  }
  // After the last member: keep its comma and same-line comment with it, so the
  // new member does not take over a comment that described the old one.
  const end = last.offset + last.length;
  const tail = /^[ \t]*(,)?[ \t]*(\/\/[^\r\n]*|\/\*[^\r\n]*?\*\/)?/.exec(text.slice(end));
  const after = end + (tail?.[0].length ?? 0);
  const edits = tail?.[1]
    ? [{ offset: after, length: 0, content: `${newline}${indent}${member},` }]
    : [{ offset: end, length: 0, content: "," }, { offset: after, length: 0, content: `${newline}${indent}${member}` }];
  return applyEdits(text, edits);
}

/** Refuses an object whose key list repeats a name, because the parser would keep only the last. @param {string} text @param {string[]} keys @param {string} label */
function assertUniqueKeys(text, keys, label) {
  const tree = parseTree(text, [], { allowTrailingComma: true });
  const node = tree && (keys.length === 0 ? tree : findNodeAtLocation(tree, keys));
  if (!node || node.type !== "object") return;
  const names = (node.children ?? []).map((property) => property.children?.[0]?.value);
  if (new Set(names).size !== names.length) throw new Error(`${label} has duplicate keys`);
}

// ---------------------------------------------------------------------------
// Claude Code settings.json
// ---------------------------------------------------------------------------

/** @param {string} text @param {{nodePath: string, adapterPath: string}} options */
export function configureClaudeSettings(text, { nodePath, adapterPath }) {
  // A fresh install has no settings file yet; an empty file is the same case.
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const source = text.trim() === "" ? `{}${newline}` : text;
  const before = parseJsoncStrict(source, "Claude settings");
  if (!isPlainObject(before)) throw new Error("Claude settings are not a JSON object");
  if (before.hooks !== undefined && !isPlainObject(before.hooks)) throw new Error("Claude settings hooks are not an object");
  assertUniqueKeys(source, [], "Claude settings");
  assertUniqueKeys(source, ["hooks"], "Claude settings hooks");
  /** @type {Record<string, any>} */
  const hooks = parseJsoncStrict(source, "Claude settings").hooks ?? {};
  // Claude Code hook entries read only "command" -- there is no "args" field.
  // Both the argument and the program must live in one command string.
  const command = `"${nodePath.replaceAll("\\", "/")}" "${adapterPath.replaceAll("\\", "/")}"`;
  // Stop is cleaned but never written. reasonForHookEvent() maps StopFailure and
  // filtered Notification kinds only, so an adapter registered on Stop would run
  // on every turn and return nothing. idle_prompt is the completion authority
  // because a parallel Stop hook can continue the turn after Stop first fires.
  const managedEvents = ["Stop", "StopFailure", "Notification"];
  for (const event of managedEvents) {
    const keptGroups = [];
    for (const group of hooks[event] ?? []) {
      const keptHandlers = (group.hooks ?? []).filter((/** @type {any} */ handler) =>
        !isLegacyClaudeHandler(handler) && !isAhtonClaudeHandler(handler));
      if (keptHandlers.length > 0) keptGroups.push({ ...group, hooks: keptHandlers });
    }
    if (keptGroups.length > 0) hooks[event] = keptGroups;
    else delete hooks[event];
  }
  const handler = { type: "command", command };
  hooks.StopFailure = [...(hooks.StopFailure ?? []), { matcher: "", hooks: [handler] }];
  hooks.Notification = [...(hooks.Notification ?? []), { matcher: HUMAN_NOTIFICATION_MATCHER, hooks: [handler] }];

  let result = source;
  /** @type {ManagedValue[]} */
  const managed = [];
  for (const event of managedEvents) {
    managed.push({ path: ["hooks", event], value: hooks[event] });
    if (!isDeepStrictEqual(before.hooks?.[event], hooks[event])) {
      result = editJsonc(result, ["hooks", event], hooks[event], newline);
    }
  }
  assertCandidateSafe("jsonc", source, result, managed);
  return result;
}

// ---------------------------------------------------------------------------
// VS Code settings.json
// ---------------------------------------------------------------------------

const PROFILES_KEY = "terminal.integrated.profiles.windows";
const PLAIN_CLAUDE_ARGS = ["-NoLogo", "-NoExit", "-Command", "claude"];
const SHELL_PID_CLAUDE_ARGS = ["-NoLogo", "-NoExit", "-Command", "$env:AHTON_SHELL_PID=$PID; claude"];
const CODEX_ARGS = ["-NoLogo", "-NoExit", "-Command", "codex"];

/**
 * Creates the profiles block and either profile when they are missing, so a
 * fresh VS Code install works. Existing profiles are migrated, never replaced.
 * The file is edited as JSONC, so comments, trailing commas and formatting
 * outside the changed values survive.
 *
 * @param {string} text
 * @param {{claude?: boolean, codex?: boolean}} [options] providers to configure
 */
export function configureVsCodeSettings(text, { claude = true, codex = true } = {}) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const source = text.trim() === "" ? `{}${newline}` : text;
  const root = parseJsoncStrict(source, "VS Code settings");
  if (!isPlainObject(root)) throw new Error("VS Code settings are not a JSON object");
  assertUniqueKeys(source, [], "VS Code settings");
  let working = source;
  if (root[PROFILES_KEY] === undefined) working = editJsonc(working, [PROFILES_KEY], {}, newline);
  else if (!isPlainObject(root[PROFILES_KEY])) throw new Error("VS Code terminal profiles are not an object");
  assertUniqueKeys(working, [PROFILES_KEY], "VS Code terminal profiles");

  const wanted = [
    claude && { name: "Claude Code", provider: "claude", color: "terminal.ansiYellow", command: "claude" },
    codex && { name: "Codex", provider: "codex", color: "terminal.ansiGreen", command: "codex" },
  ].filter((entry) => entry !== false);
  /** @type {ManagedValue[]} */
  const managed = [];
  for (const profile of wanted) {
    const base = [PROFILES_KEY, profile.name];
    const args = profile.provider === "claude" ? SHELL_PID_CLAUDE_ARGS : CODEX_ARGS;
    const current = parseJsoncStrict(working, "VS Code settings")[PROFILES_KEY][profile.name];
    managed.push(
      { path: [...base, "args"], value: args },
      { path: [...base, "env", "AGENT_BRIDGE_PROVIDER"], value: profile.provider },
      { path: [...base, "color"], value: profile.color },
    );
    if (current === undefined) {
      managed.push({ path: [...base, "path"], value: "powershell.exe" });
      working = editJsonc(working, base, {}, newline);
      working = editJsonc(working, [...base, "path"], "powershell.exe", newline);
      working = editJsonc(working, [...base, "args"], args, newline);
      working = editJsonc(working, [...base, "env"], { AGENT_BRIDGE_PROVIDER: profile.provider }, newline);
      working = editJsonc(working, [...base, "color"], profile.color, newline);
      continue;
    }
    if (!isPlainObject(current)) throw new Error(`${profile.name} profile is not an object`);
    assertUniqueKeys(working, base, `${profile.name} profile`);
    if (profile.provider === "claude") {
      if (isDeepStrictEqual(current.args, PLAIN_CLAUDE_ARGS)) {
        working = editJsonc(working, [...base, "args", 3], SHELL_PID_CLAUDE_ARGS[3], newline);
      } else if (!isDeepStrictEqual(current.args, SHELL_PID_CLAUDE_ARGS)) {
        throw new Error("Claude Code profile arguments are not recognized");
      }
    } else if (!isDeepStrictEqual(current.args, CODEX_ARGS)) {
      throw new Error("Codex profile arguments are not recognized");
    }
    if (current.env === undefined) {
      working = editJsonc(working, [...base, "env"], { AGENT_BRIDGE_PROVIDER: profile.provider }, newline);
    } else if (!isPlainObject(current.env) || current.env.AGENT_BRIDGE_PROVIDER !== profile.provider) {
      throw new Error(`${profile.name} profile has an unrelated environment block`);
    }
    if (current.color !== profile.color) working = editJsonc(working, [...base, "color"], profile.color, newline);
  }
  assertCandidateSafe("jsonc", source, working, managed);
  return working;
}

/** @param {string} text @param {{exists?: (path: string) => boolean}} [options] */
export function configureCodexConfig(text, { exists = fs.existsSync } = {}) {
  assertNoDottedOrInlineTui(text);
  const assignments = [...text.matchAll(/^[ \t]*notify[ \t]*=[^\r\n]*$/gm)];
  if (assignments.length > 1) throw new Error("Codex config contains duplicate notify assignments");
  let updated = text;
  /** @type {ManagedValue[]} */
  const managed = [
    { path: ["tui", "notification_condition"], value: "unfocused" },
    { path: ["tui", "notification_method"], value: "osc9" },
    { path: ["tui", "notifications"], value: ["agent-turn-complete", "approval-requested", "plan-mode-prompt"] },
  ];
  if (assignments.length === 1) {
    const assignment = assignments[0];
    const literal = assignment[0].match(/^[ \t]*notify[ \t]*=[ \t]*(\[[^\r\n]+\])[ \t]*$/);
    if (!literal) throw new Error("Codex notify is not a supported literal array");
    const existing = parseTomlStringArray(literal[1]);
    const unwrapped = unwrapAhtonNotifier(existing, { exists });
    if (unwrapped.matched) {
      const start = assignment.index ?? 0;
      managed.push({ path: ["notify"], value: unwrapped.values.length > 0 ? unwrapped.values : undefined });
      if (unwrapped.values.length > 0) {
        updated = text.slice(0, start) +
          `notify = ${formatTomlStringArray(unwrapped.values)}` +
          text.slice(start + assignment[0].length);
      } else {
        let end = start + assignment[0].length;
        if (text.startsWith("\r\n", end)) end += 2;
        else if (text.startsWith("\n", end)) end += 1;
        updated = text.slice(0, start) + text.slice(end);
      }
    }
  }
  updated = ensureTuiSection(updated);
  updated = ensureTuiSetting(updated, "notification_condition", 'notification_condition = "unfocused"');
  updated = ensureTuiSetting(updated, "notification_method", 'notification_method = "osc9"');
  updated = ensureTuiSetting(
    updated,
    "notifications",
    'notifications = ["agent-turn-complete", "approval-requested", "plan-mode-prompt"]',
    ['notifications = ["agent-turn-complete"]'],
  );
  assertCandidateSafe("toml", text, updated, managed);
  return updated;
}

/** @param {string[]} values @param {{exists: (path: string) => boolean}} options */
function unwrapAhtonNotifier(values, options) {
  const wrapper = values.length === 4 && path.basename(values[0]).toLowerCase() === "codex-computer-use.exe" &&
    values[1] === "turn-ended" && values[2] === "--previous-notify";
  if (wrapper) {
    let nested;
    try { nested = JSON.parse(values[3]); } catch { throw new Error("Codex Computer Use previous notifier is invalid"); }
    if (!Array.isArray(nested) || nested.some((value) => typeof value !== "string")) {
      throw new Error("Codex Computer Use previous notifier is not a string array");
    }
    const unwrapped = unwrapDirectAhtonNotifier(nested, options);
    if (!unwrapped.matched) return { matched: false, values };
    if (!options.exists(values[0])) return unwrapped;
    if (unwrapped.values.length === 0) {
      return { matched: true, values: [values[0], values[1]] };
    }
    return {
      matched: true,
      values: [values[0], values[1], values[2], JSON.stringify(unwrapped.values)],
    };
  }
  return unwrapDirectAhtonNotifier(values, options);
}

/** @param {string[]} values @param {{exists: (path: string) => boolean}} options */
function unwrapDirectAhtonNotifier(values, { exists }) {
  const legacy = values.length >= 6 && path.basename(values[0]).toLowerCase() === "node.exe" &&
    path.basename(values[1]).toLowerCase() === "vscode-agent-notify.mjs" &&
    values[2] === "--provider" && values[3] === "codex" && values[4] === "--port-file";
  const current = values.length >= 2 && path.basename(values[0]).toLowerCase() === "node.exe" &&
    path.basename(values[1]).toLowerCase() === "codex-signal.mjs";
  if (!legacy && !current) return { matched: false, values };
  const tail = values.slice(legacy ? 6 : 2);
  for (let index = 0; index < tail.length; index += 2) {
    if (tail[index] !== (index === 0 ? "--forward-program" : "--forward-arg") || !tail[index + 1]) {
      throw new Error("Codex notifier forwarding tail is ambiguous");
    }
  }
  if (tail.length === 0) return { matched: true, values: [] };
  const program = tail[1];
  const args = [];
  for (let index = 2; index < tail.length; index += 2) args.push(tail[index + 1]);
  if (!exists(program)) {
    const staleComputerUse = path.basename(program).toLowerCase() === "codex-computer-use.exe" &&
      args.length === 1 && args[0] === "turn-ended";
    if (!staleComputerUse) throw new Error("Codex preserved notifier program is unavailable");
    return { matched: true, values: [] };
  }
  return { matched: true, values: [program, ...args] };
}

// A table header: `[tui]`, `[ tui ]`, `["tui"]`, each with an optional trailing comment.
const TUI_HEADER = /^[ \t]*\[[ \t]*(?:tui|"tui"|'tui')[ \t]*\][ \t]*(?:#[^\r\n]*)?\r?$/m;
// Any table or array-of-tables header. Keys only: a line such as `[1, 2],` is not one.
const ANY_HEADER = /^[ \t]*\[\[?[ \t]*[A-Za-z0-9_\-"'. \t]+[ \t]*\]\]?[ \t]*(?:#[^\r\n]*)?\r?$/gm;

/**
 * `tui.key = ...` or `tui = { ... }` at the top of the file already defines the
 * tui table. Appending `[tui]` would declare it twice, and guessing which form
 * to extend could change what the user wrote, so Ahton refuses.
 *
 * @param {string} config
 */
function assertNoDottedOrInlineTui(config) {
  const firstHeader = new RegExp(ANY_HEADER.source, "m").exec(config);
  const top = firstHeader ? config.slice(0, firstHeader.index) : config;
  if (/^[ \t]*(?:tui|"tui"|'tui')[ \t]*[.=]/m.test(top)) {
    throw new Error("Codex config defines tui with dotted keys or an inline table. Ahton will not guess; move those settings under a [tui] table first");
  }
}

/** A fresh Codex install has no [tui] table; it goes last, after any top-level keys. @param {string} config */
function ensureTuiSection(config) {
  if (TUI_HEADER.test(config)) return config;
  const newline = config.includes("\r\n") ? "\r\n" : "\n";
  const body = config.trimEnd();
  return body === "" ? `[tui]${newline}` : `${body}${newline}${newline}[tui]${newline}`;
}

/** @param {string} config @param {string} key @param {string} line @param {string[]} [managedPriorValues] */
function ensureTuiSetting(config, key, line, managedPriorValues = []) {
  const header = TUI_HEADER.exec(config);
  if (!header) throw new Error("Codex config has no [tui] section");
  const afterHeader = header.index + header[0].length;
  const next = new RegExp(ANY_HEADER.source, "gm");
  next.lastIndex = afterHeader;
  const nextHeader = next.exec(config);
  const sectionEnd = nextHeader?.index ?? config.length;
  const section = config.slice(header.index, sectionEnd);
  const matches = [...section.matchAll(new RegExp(`^[ \\t]*${escapeRegex(key)}[ \\t]*=[^\\r\\n]*`, "gm"))];
  if (matches.length > 1) throw new Error(`Codex [tui] contains duplicate ${key}`);
  if (matches.length === 1) {
    const existing = matches[0][0].trim();
    if (existing === line) return config;
    if (!managedPriorValues.includes(existing)) throw new Error(`Codex has an unrelated tui.${key} value`);
    const absoluteStart = header.index + (matches[0].index ?? 0);
    return config.slice(0, absoluteStart) + line + config.slice(absoluteStart + matches[0][0].length);
  }
  const newline = config.includes("\r\n") ? "\r\n" : "\n";
  const insertion = config.indexOf("\n", header.index) + 1;
  return config.slice(0, insertion) + line + newline + config.slice(insertion);
}

/** @param {string} source @returns {string[]} */
function parseTomlStringArray(source) {
  const inner = source.trim().slice(1, -1);
  const values = [];
  let index = 0;
  while (index < inner.length) {
    while (/\s/.test(inner[index])) index += 1;
    const quote = inner[index];
    if (quote !== "'" && quote !== '"') throw new Error("Codex notify contains a non-string value");
    index += 1;
    let value = "";
    while (index < inner.length) {
      const char = inner[index++];
      if (char === quote) {
        if (quote === "'" && inner[index] === "'") { value += "'"; index += 1; continue; }
        break;
      }
      if (quote === '"' && char === "\\") {
        // TOML escapes are the JSON ones, but \u carries four hex digits that
        // follow it; the writer emits \u for control characters.
        const kind = inner[index++];
        const digits = kind === "u" ? inner.slice(index, index + 4) : "";
        if (kind === "u") index += digits.length;
        value += JSON.parse(`"\\${kind}${digits}"`);
      } else value += char;
    }
    values.push(value);
    while (/\s/.test(inner[index])) index += 1;
    if (index < inner.length) {
      if (inner[index] !== ",") throw new Error("Codex notify array is malformed");
      index += 1;
    }
  }
  return values;
}

/** @param {string[]} values */
function formatTomlStringArray(values) {
  return `[${values.map(formatTomlString).join(", ")}]`;
}

/**
 * A literal string cannot hold an apostrophe or a control character, and
 * doubling the apostrophe ends the string early. Those values get a basic
 * (double-quoted) string with escapes; every other value stays a literal.
 *
 * @param {string} value
 */
function formatTomlString(value) {
  if (!/['\u0000-\u001f\u007f]/.test(value)) return `'${value}'`;
  /** @type {Record<string, string>} */
  const named = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" };
  const escaped = value.replace(/[\\"\u0000-\u001f\u007f]/g, (char) => {
    if (char === "\\" || char === '"') return "\\" + char;
    return named[char] ?? "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0");
  });
  return `"${escaped}"`;
}

/** @param {any} handler */
function isLegacyClaudeHandler(handler) {
  const command = String(handler?.command ?? "");
  return /(?:^|[\\/\s"])vscode-agent-notify\.mjs(?:["\s]|$)/i.test(command) &&
    /--provider\s+claude(?:\s|$)/i.test(command) && /--port-file(?:\s|$)/i.test(command);
}

/** @param {any} handler */
function isAhtonClaudeHandler(handler) {
  const tokens = tokenizeCommand(String(handler?.command ?? ""));
  return tokens.length === 2 &&
    path.basename(tokens[0]).toLowerCase() === "node.exe" &&
    path.basename(tokens[1]).toLowerCase() === "claude-signal.mjs";
}

/** @param {string} command */
function tokenizeCommand(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(command))) tokens.push(match[1] ?? match[2]);
  return tokens;
}

/** @param {string} value */
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
