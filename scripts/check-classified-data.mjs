#!/usr/bin/env node
// Classified-data guard — keeps secrets, private paths and must-ignore files out of git, enforced mechanically ("a check, not a promise").
//
// CANONICAL, CROSS-PLATFORM implementation. This is the one the pre-commit hooks call, on
// Windows and on the Mac mini alike. `check-classified-data.ps1` is the original and is kept
// for PowerShell callers; this file is authoritative when the two disagree, because it is the
// one that runs on both machines.
//
// Provenance: promoted from paper-resolver's `tools/check-classified-data.mjs` (2026-07-25, CP2),
// which was itself the Node port of the .ps1. paper-resolver keeps its vendored copy on purpose —
// it must stand alone without agent-bridge present. Changes here should be mirrored there.
//
// ZERO DEPENDENCIES, ON PURPOSE. The pre-commit hook calls this directly, so it must keep working
// when node_modules is absent, half-installed, or stale. A guard that can be disabled by a broken
// install is not a guard.
//
// Scans ONLY git-tracked text files (untracked/gitignored files are out of scope by definition).
// Flags three classes:
//   1. Secret material — private-key headers, AWS keys, GitHub/Slack tokens, JWTs, and generic
//      api_key/secret/password/token = "literal" assignments.
//   2. Machine-local absolute paths — a Windows user-profile path, /home/<name>, /Users/<name> (the
//      "username leaked in an export" class, when it lands in source).
//   3. Must-be-ignored files — any TRACKED file matching a .classified-deny glob (the
//      "answer keys committed by mistake" class).
//
// Repo-root config:
//   .classified-allow — one regex per line; a matching LINE is a known-safe exception.
//   .classified-deny  — one git pathspec/glob per line; any TRACKED match is a violation.
//
// Usage:
//   node check-classified-data.mjs [repo] [--quiet]   scan a repo; exit 1 on violations, 2 if it
//                                                     could not run (fail closed), 0 when clean
//   node check-classified-data.mjs --self-test        prove the detector still detects; exit 0/1
//
// SCOPE NOTE: a static scan cannot see data a program emits at RUNTIME (e.g. an absolute path baked
// into a generated PDF). Those need an app-level output test — this covers committed source only.

import { execFileSync } from 'node:child_process';
import { openSync, readSync, closeSync, readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SECRET_PATTERNS = [
  { name: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'github-pat', re: /ghp_[0-9A-Za-z]{36}/ },
  { name: 'slack-token', re: /xox[baprs]-[0-9A-Za-z]{10,}/ },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  {
    name: 'secret-assign',
    re: /(api[_-]?key|secret|access[_-]?token|auth[_-]?token|passwd|password)\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
  },
];

const PATH_PATTERNS = [
  // `\\{1,2}` is a deliberate divergence from the PowerShell original, which only matched a single
  // backslash and therefore missed the doubled form a Windows path takes when it is escaped inside
  // TS/JS/JSON source — i.e. the most likely way one actually gets committed here.
  { name: 'win-user-home', re: /[A-Za-z]:\\{1,2}Users\\{1,2}[^\\/\r\n"'<>:|*?]+/ },
  { name: 'nix-home', re: /\/home\/[A-Za-z0-9._-]+/ },
  { name: 'mac-home', re: /\/Users\/[A-Za-z0-9._-]+/ },
];

const ALL_PATTERNS = [...SECRET_PATTERNS, ...PATH_PATTERNS];

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// Same heuristic as the PowerShell original: a NUL byte in the first 8000 bytes means binary.
function isBinary(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(8000);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } catch {
    return true; // unreadable => skip, don't crash the commit
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readConfigLines(root, name) {
  const file = join(root, name);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

export function scan(repo) {
  const root = git(repo, ['rev-parse', '--show-toplevel']).trim();
  if (!root) throw new Error(`Not a git repository: ${repo}`);

  const allow = readConfigLines(root, '.classified-allow').map((r) => new RegExp(r));
  const deny = readConfigLines(root, '.classified-deny');
  const tracked = git(root, ['ls-files']).split(/\r?\n/).filter(Boolean);
  const violations = [];

  // 1 + 2: content scan (secrets + machine-local absolute paths)
  for (const rel of tracked) {
    const full = join(root, rel);
    if (!existsSync(full) || isBinary(full)) continue;
    const lines = readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const p of ALL_PATTERNS) {
        const m = p.re.exec(line);
        if (!m) continue;
        if (allow.some((a) => a.test(line))) continue;
        violations.push({ file: rel, line: i + 1, kind: p.name, excerpt: m[0].slice(0, 60) });
      }
    });
  }

  // 3: files that must be gitignored but are tracked
  for (const glob of deny) {
    const hits = git(root, ['ls-files', '--', glob]).split(/\r?\n/).filter(Boolean);
    for (const h of hits) {
      violations.push({ file: h, line: 0, kind: 'must-be-ignored', excerpt: `matches deny glob: ${glob}` });
    }
  }
  return violations;
}

// --- Self-test ------------------------------------------------------------------
// Builds a throwaway repo, plants one of each violation class plus a clean file, and asserts
// what is caught AND what is not. Mirrors `check-classified-data.ps1 -SelfTest`. This is what
// makes the guard's liveness checkable on a new machine without touching a real repo.
function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'classified-selftest-'));
  const results = [];
  const expect = (label, cond) => {
    results.push({ label, pass: !!cond });
  };
  try {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'selftest@localhost']);
    git(dir, ['config', 'user.name', 'selftest']);

    writeFileSync(join(dir, 'clean.txt'), 'nothing to see here\nconst greeting = "hello"\n');
    const syntheticSecret = ['abcdef12', '34567890'].join('');
    const syntheticName = ['api', 'Key'].join('');
    writeFileSync(join(dir, 'secret.txt'), `const ${syntheticName} = "${syntheticSecret}"\n`);
    writeFileSync(join(dir, 'path.txt'), 'const p = "C:\\\\Users\\\\someone\\\\Desktop"\n');
    writeFileSync(join(dir, 'answers.csv'), 'q,a\n1,b\n');
    writeFileSync(join(dir, 'allowed.txt'), 'const token = "PLACEHOLDER_NOT_REAL"\n');
    writeFileSync(join(dir, '.classified-deny'), 'answers.csv\n');
    writeFileSync(join(dir, '.classified-allow'), 'PLACEHOLDER_NOT_REAL\n');
    git(dir, ['add', '-A']);

    const v = scan(dir);
    const kinds = new Set(v.map((x) => x.kind));
    const files = new Set(v.map((x) => x.file));

    expect('catches a secret assignment', kinds.has('secret-assign'));
    expect('catches a Windows user-home path (escaped form)', kinds.has('win-user-home'));
    expect('catches a tracked must-be-ignored file', kinds.has('must-be-ignored'));
    expect('ignores a clean file', !files.has('clean.txt'));
    expect('honours .classified-allow', !files.has('allowed.txt'));
  } catch (e) {
    expect(`self-test harness ran without error (${e.message})`, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.label}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(failed === 0 ? `classified-data self-test: PASS (${results.length} checks)` : `classified-data self-test: ${failed} FAILURE(S)`);
  return failed === 0 ? 0 : 1;
}

// --- CLI ------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) process.exit(selfTest());

  const repo = args.find((a) => !a.startsWith('-')) ?? '.';
  const quiet = args.includes('--quiet');
  let violations;
  try {
    violations = scan(repo);
  } catch (e) {
    // Fail CLOSED: if the guard cannot run, the commit does not proceed.
    console.error(`classified-data check: FAILED TO RUN — ${e.message}`);
    process.exit(2);
  }
  if (violations.length === 0) {
    if (!quiet) console.log(`classified-data check: CLEAN (${repo})`);
    process.exit(0);
  }
  console.error(`classified-data check: ${violations.length} VIOLATION(S) in ${repo}`);
  for (const v of violations) {
    console.error(`  [${v.kind}] ${v.line > 0 ? `${v.file}:${v.line}` : v.file}  ${v.excerpt}`);
  }
  console.error('\nSuppress a known-safe hit with a regex in .classified-allow; list must-be-ignored globs in .classified-deny.');
  process.exit(1);
}
