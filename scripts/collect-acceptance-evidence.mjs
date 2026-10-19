#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { evaluateAcceptanceEvidence, summarizeAcceptanceEvidence } from "../src/acceptance-evidence.mjs";

const sinceArg = process.argv.indexOf("--since");
const sinceText = sinceArg === -1 ? "" : process.argv[sinceArg + 1] ?? "";
const since = Date.parse(sinceText);
if (!Number.isFinite(since)) {
  process.stderr.write("Usage: node scripts/collect-acceptance-evidence.mjs --since <ISO-8601 timestamp>\n");
  process.exit(2);
}

const appData = process.env.APPDATA;
if (!appData) throw new Error("APPDATA is unavailable");
const root = path.join(appData, "Code", "logs");
const logs = [];
for (const file of walk(root)) {
  if (!/-Ahton\.log$/i.test(file)) continue;
  const stat = fs.statSync(file);
  if (stat.mtimeMs < since) continue;
  const relative = path.relative(root, file);
  const windowId = relative.match(/(?:^|[\\/])(window\d+)(?:[\\/]|$)/i)?.[1]?.toLowerCase() ?? "unknown-window";
  logs.push({ windowId, text: fs.readFileSync(file, "utf8") });
}

const summary = summarizeAcceptanceEvidence(logs);
const evaluation = evaluateAcceptanceEvidence(summary);
process.stdout.write(`${JSON.stringify({ summary, ...evaluation }, null, 2)}\n`);
process.exitCode = evaluation.passed ? 0 : 1;

function* walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(child);
    else if (entry.isFile()) yield child;
  }
}
