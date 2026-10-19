import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { planRolloverLaunch, ROLLOVER_PROGRAM } from "../src/rollover-launch.mjs";

// A real directory, not a fake realpath. The guard under test resolves `..` and
// canonical case through the filesystem, so faking that away would test the fake.
// Every input the checks depend on is created here, never read from the machine.
function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ahton-rollover-")));
  const ws = path.join(root, "workspace");
  fs.mkdirSync(path.join(ws, ".remember"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".remember", "baton-1.md"), "baton\n");
  fs.writeFileSync(path.join(root, "outside.md"), "not yours\n");
  return { root, ws, environment: { workspaceFolder: ws, realpath: fs.realpathSync } };
}

test("a baton inside the workspace starts the fixed program in the workspace", () => {
  const { ws, environment } = workspace();
  const result = planRolloverLaunch({ baton: ".remember/baton-1.md" }, environment);
  assert.equal(result.ok, true);
  assert.equal(result.cwd, ws);
  assert.equal(result.program, ROLLOVER_PROGRAM);
  assert.match(result.command, /^claude "/);
  assert.ok(result.command.includes("baton-1.md"), "the command must name the baton");
});

// Constraint 2: the launched program is fixed. The caller does not choose it.
test("the envelope cannot choose the program", () => {
  const { environment } = workspace();
  const result = planRolloverLaunch(
    { baton: ".remember/baton-1.md", program: "powershell", command: "calc.exe" },
    environment,
  );
  assert.equal(result.ok, true);
  assert.equal(result.program, "claude");
  assert.ok(!result.command.includes("powershell"), "a caller-named program must not survive");
  assert.ok(!result.command.includes("calc.exe"), "a caller-named command must not survive");
});

// Constraint 3, the string half: an absolute path is not a workspace-relative baton.
test("an absolute baton path is refused", () => {
  const { root, environment } = workspace();
  const result = planRolloverLaunch({ baton: path.join(root, "outside.md") }, environment);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "baton_not_relative");
});

// Constraint 3, the real-path half: `..` must not walk out of the workspace.
// The check must resolve the path, not compare the string, or this walk survives.
test("a baton that walks out of the workspace with .. is refused", () => {
  const { environment } = workspace();
  const result = planRolloverLaunch({ baton: "../outside.md" }, environment);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "baton_escapes_workspace");
});

test("a baton that does not exist is refused rather than launched blind", () => {
  const { environment } = workspace();
  const result = planRolloverLaunch({ baton: ".remember/baton-99.md" }, environment);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "baton_unresolvable");
});

// Constraint 4: the same guard rollover.js already holds. sendText writes this
// string into a live shell, so a metacharacter here is a command, not a path.
test("a baton path holding a shell metacharacter is refused", () => {
  const { ws, environment } = workspace();
  const nasty = ".remember/baton-1.md & calc.exe";
  fs.writeFileSync(path.join(ws, ".remember", "evil"), "x\n");
  for (const ch of ["&", "|", ";", "<", ">", "^", '"', "'", "`", "$", "(", ")", "\n", "\r"]) {
    const result = planRolloverLaunch({ baton: ".remember/baton-1.md" + ch }, environment);
    assert.equal(result.ok, false, "must refuse a baton holding " + JSON.stringify(ch));
    assert.equal(result.reason, "baton_shell_metacharacter",
      "the metacharacter guard must run BEFORE the file is resolved, for " + JSON.stringify(ch));
  }
  const combined = planRolloverLaunch({ baton: nasty }, environment);
  assert.equal(combined.reason, "baton_shell_metacharacter");
});

// Constraint 5: insufficient evidence fails closed. An unresolvable workspace
// opens nothing, rather than falling back to a default directory.
test("no workspace folder opens nothing", () => {
  for (const folder of [undefined, null, "", 7, "relative/not/absolute"]) {
    const result = planRolloverLaunch({ baton: ".remember/baton-1.md" },
      { workspaceFolder: folder, realpath: fs.realpathSync });
    assert.equal(result.ok, false, "must refuse workspace " + JSON.stringify(folder));
    assert.equal(result.reason, "no_workspace_folder");
  }
});

test("a baton that is not a string is refused", () => {
  const { environment } = workspace();
  for (const baton of [undefined, null, 5, {}, [".remember/baton-1.md"], ""]) {
    const result = planRolloverLaunch({ baton }, environment);
    assert.equal(result.ok, false, "must refuse baton " + JSON.stringify(baton));
    assert.equal(result.reason, "baton_not_a_string");
  }
});

test("the prompt tells the successor to re-derive, and stays one line", () => {
  const { environment } = workspace();
  const result = planRolloverLaunch({ baton: ".remember/baton-1.md" }, environment);
  assert.equal(result.ok, true);
  assert.ok(!result.command.includes("\n"), "a newline in the sent text submits it half-written");
  assert.match(result.command, /Re-derive/);
});

// --- checks added after a mutation run showed three guards uncovered ---
// The first mutation pass reported these three NOT LOAD-BEARING: disabling each
// changed nothing, because another clause happened to refuse the same input for
// a different reason. A guard nothing can distinguish is decoration.

// Isolates `path.isAbsolute` from the drive-letter clause beside it. On Windows
// `/Windows/...` is absolute but matches no drive letter, so only isAbsolute refuses it.
test("a rooted path with no drive letter is refused as not relative", () => {
  const { environment } = workspace();
  const result = planRolloverLaunch({ baton: "/Windows/System32/calc.exe" }, environment);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "baton_not_relative");
});

// Isolates the "workspace folder must be absolute" clause. A realpath that
// resolves the relative name is injected, so nothing else can refuse it.
test("a relative workspace folder is refused even when it resolves", () => {
  const { ws } = workspace();
  const result = planRolloverLaunch(
    { baton: ".remember/baton-1.md" },
    { workspaceFolder: "relative/workspace", realpath: (p) => p === "relative/workspace" ? ws : p },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_workspace_folder");
});

// Isolates the SECOND metacharacter check, the one on the resolved path. The
// baton string is clean; resolving a junction is what introduces the metacharacter.
// Without this, a link inside the workspace smuggles one past the string guard.
test("a clean baton string that RESOLVES onto a metacharacter is refused", (t) => {
  const { ws, environment } = workspace();
  const real = path.join(ws, ".remember", "a&b");
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, "baton-1.md"), "baton\n");
  const link = path.join(ws, ".remember", "link");
  // fs, not `cmd /c mklink`. The first version of this check shelled out, and cmd
  // split the target on its own `&` -- so the check SKIPPED, reporting "this
  // platform would not create a junction" when the platform was never asked.
  try {
    fs.symlinkSync(real, link, "junction");
  } catch (error) {
    t.skip("this platform would not create a junction: " + error.message);
    return;
  }
  const clean = ".remember/link/baton-1.md";
  assert.ok(!/[&|;<>^"'`$()]/.test(clean), "the baton string itself must be clean");
  const result = planRolloverLaunch({ baton: clean }, environment);
  assert.equal(result.ok, false, "a resolved metacharacter must not reach the shell");
  assert.equal(result.reason, "baton_shell_metacharacter");
});

// PowerShell treats the Unicode quotation marks as quote delimiters, and expands
// % ! { } in places a denylist did not think of. An allowlist refuses all of them.
const POWERSHELL_HAZARDS = [
  "%", "!", "{", "}", "@", "#", ",", "[", "]", "=", "+",
  "‘", "’", "‚", "‛", "“", "”", "„",
];

test("a baton name holding a character outside the allowlist is refused, not escaped", () => {
  const { ws, environment } = workspace();
  for (const char of POWERSHELL_HAZARDS) {
    const name = `a${char}b.md`;
    fs.writeFileSync(path.join(ws, ".remember", name), "baton\n");
    const result = planRolloverLaunch({ baton: `.remember/${name}` }, environment);
    assert.equal(result.ok, false, `U+${char.codePointAt(0).toString(16)} must be refused`);
    assert.equal(result.reason, "baton_shell_metacharacter");
  }
});

test("the quote-closing probe that smuggles --version is refused", () => {
  const { ws, environment } = workspace();
  const name = "x’ --version ’.md";
  fs.writeFileSync(path.join(ws, ".remember", name), "baton\n");
  const result = planRolloverLaunch({ baton: `.remember/${name}` }, environment);
  assert.equal(result.ok, false);
});

test("a workspace folder holding a character outside the allowlist is refused", () => {
  const { root } = workspace();
  const ws = path.join(root, "work“space%");
  fs.mkdirSync(path.join(ws, ".remember"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".remember", "baton-1.md"), "baton\n");
  const result = planRolloverLaunch(
    { baton: ".remember/baton-1.md" },
    { workspaceFolder: ws, realpath: fs.realpathSync },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "baton_shell_metacharacter");
});
