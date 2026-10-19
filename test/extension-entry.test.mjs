import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Drives the built extension entry point (dist/extension.js) with a recording
// stand-in for the `vscode` module. The guard is only real if the bundle that
// ships does what the pure function does, so this runs the real entry.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const bundle = path.join(root, "dist", "extension.js");
const require = createRequire(import.meta.url);

function fakeVscode(record) {
  const disposable = () => ({ dispose() {} });
  const note = (name) => () => { record.touched.push(name); return disposable(); };
  return {
    commands: {
      getCommands: async () => { record.touched.push("getCommands"); return []; },
      registerCommand: (id, handler) => { record.commands.set(id, handler); return disposable(); },
      executeCommand: async () => undefined,
    },
    window: {
      state: { focused: false },
      terminals: [],
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createTerminal: () => { record.touched.push("createTerminal"); return {}; },
      showInformationMessage: async (message) => { record.messages.push(String(message)); },
      showWarningMessage: async (message) => { record.messages.push(String(message)); },
      showErrorMessage: async (message) => { record.messages.push(String(message)); },
      onDidChangeWindowState: note("onDidChangeWindowState"),
      onDidCloseTerminal: note("onDidCloseTerminal"),
      onDidStartTerminalShellExecution: note("onDidStartTerminalShellExecution"),
      onDidChangeTerminalShellIntegration: note("onDidChangeTerminalShellIntegration"),
      onDidChangeActiveTerminal: note("onDidChangeActiveTerminal"),
    },
    workspace: {
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      workspaceFolders: [],
    },
    Disposable: class { constructor(fn) { this.dispose = fn; } },
    ThemeIcon: class {},
    ThemeColor: class {},
    TerminalLocation: { Editor: 2, Panel: 1 },
  };
}

async function activateOn(platform) {
  const record = { commands: new Map(), messages: [], touched: [] };
  const originalLoad = Module._load;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Module._load = function load(request, ...rest) {
    return request === "vscode" ? fakeVscode(record) : originalLoad.call(this, request, ...rest);
  };
  Object.defineProperty(process, "platform", { value: platform });
  delete require.cache[bundle];
  try {
    const extension = require(bundle);
    const context = {
      subscriptions: [],
      asAbsolutePath: (relative) => path.join(root, relative),
      globalStorageUri: { fsPath: path.join(root, "dist", "unused-test-storage") },
      extension: { packageJSON: manifest },
    };
    await extension.activate(context);
    return { record, context };
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
    Module._load = originalLoad;
  }
}

for (const platform of ["linux", "darwin"]) {
  test(`on ${platform} every command shows one Windows-only message and nothing is started`, async () => {
    const { record, context } = await activateOn(platform);
    assert.deepEqual(
      [...record.commands.keys()].sort(),
      manifest.contributes.commands.map((command) => command.command).sort(),
    );
    for (const handler of record.commands.values()) await handler();
    assert.equal(record.messages.length, record.commands.size);
    assert.ok(record.messages.every((message) => /Windows only/.test(message)), record.messages.join("|"));
    assert.deepEqual(record.touched, [], "no listener, terminal or command lookup may run off Windows");
    assert.ok(context.subscriptions.length > 0);
  });
}
