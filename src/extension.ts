import { existsSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import {
  CLAUDE_PIPE_PREFIX,
  CLAUDE_PROTOCOL_VERSION,
  claudeDescriptorDirectory,
  parseClaudeEnvelope,
} from "./claude-contract.mjs";
import { selectExactTerminal } from "./terminal-selection.mjs";
import { createAuthenticatedEndpoint } from "./authenticated-endpoint.mjs";
import { OscSignalParser } from "./osc-parser.mjs";
import { RouteRegistry } from "./route-registry.mjs";
import { MANAGED_PROVIDER_ENV } from "./signals.mjs";
import { captureOwningWindow, focusOwningWindow, verifyOwningWindow } from "./window-focus.mjs";
import { startShellIntegratedTerminal } from "./managed-terminal.mjs";
import { dispatchRollover } from "./rollover-dispatch.mjs";
import { activateExactTerminal } from "./terminal-activation.mjs";
import { startNativeNotification } from "./native-notification.mjs";
import { TerminalDisplayRegistry, withLabelPreference, workspaceLabel } from "./terminal-display-label.mjs";
import { withTimestamps } from "./diagnostic-log.mjs";
import { terminalFocusCommand } from "./terminal-location.mjs";
import { holdActivatedWindow } from "./focus-hold.mjs";
import { COMMAND_IDS } from "./command-ids.mjs";
import { isSupportedPlatform, registerWindowsOnlyCommands } from "./platform-guard.mjs";
import { createRolloverGate } from "./rollover-gate.mjs";
import { syncAdapters } from "./adapter-sync.mjs";
import { findNodeExecutable, runConfigure } from "./configure-command.mjs";

type Provider = "claude" | "codex";
type Signal = { provider: Provider; reason: "finished" | "attention" };
type PopupSession = { outcome: Promise<string>; dispose: () => void };

let registry: RouteRegistry | undefined;
let claudeEndpoint: { dispose: () => Promise<void> } | undefined;
let output: { appendLine(value: string): void } | undefined;
let focusHelperPath: string | undefined;
let owningWindowHandle: string | undefined;
let claudeRoutingReady = false;
let routeAvailable = false;
const livePopups = new Set<PopupSession>();
let terminalActivationQueue: Promise<void> = Promise.resolve();
let activationGeneration = 0;
let terminalDisplayRegistry = new TerminalDisplayRegistry();
let rolloverGate = createRolloverGate({ enabled: () => false, log: () => {} });

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (!isSupportedPlatform(process.platform)) {
    // Ahton needs the Windows native helper. Elsewhere every command answers
    // with one message, and no listener, terminal or helper is started.
    context.subscriptions.push(...registerWindowsOnlyCommands({
      commandIds: COMMAND_IDS,
      register: (id, handler) => vscode.commands.registerCommand(id, handler),
      show: (message) => vscode.window.showInformationMessage(message),
    }));
    return;
  }
  activationGeneration += 1;
  terminalDisplayRegistry = new TerminalDisplayRegistry();
  terminalActivationQueue = Promise.resolve();
  const channel = vscode.window.createOutputChannel("Ahton");
  output = withTimestamps(channel);
  rolloverGate = createRolloverGate({ enabled: isRolloverEnabled, log: (line) => output?.appendLine(line) });
  syncHookAdapters(context);
  const focusWindowAvailable = new Set(await vscode.commands.getCommands(true))
    .has("workbench.action.focusWindow");
  focusHelperPath = context.asAbsolutePath(path.join("native", "windows-focus-helper.exe"));
  const nativeFocusAvailable = process.platform === "win32" && existsSync(focusHelperPath);
  const nativeRouteAvailable = focusWindowAvailable && nativeFocusAvailable;
  routeAvailable = nativeRouteAvailable;

  if (nativeFocusAvailable && vscode.window.state.focused) {
    await captureFocusTarget();
  }

  registry = new RouteRegistry({
    isTerminalLive: (terminal) => {
      const candidate = terminal as vscode.Terminal;
      return vscode.window.terminals.includes(candidate) && candidate.exitStatus === undefined;
    },
  });
  if (!nativeRouteAvailable) {
    output.appendLine("router_disabled reason=exact_native_focus_unavailable");
  } else {
    output.appendLine(
      `router_ready route_storage=memory notification_content=constant ` +
      `focus_target=${owningWindowHandle ? "captured" : "pending"}`,
    );
  }

  if (nativeRouteAvailable && isEnabled()) {
    await startClaudeRouting();
  } else {
    output.appendLine("claude_router_disabled reason=native_route_unavailable");
  }

  context.subscriptions.push(
    channel,
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && nativeFocusAvailable) {
        void captureFocusTarget();
      }
    }),
    vscode.window.onDidCloseTerminal((terminal) => registry?.close(terminal)),
    vscode.window.onDidStartTerminalShellExecution((event) => {
      if (!nativeRouteAvailable || !isEnabled()) {
        return;
      }
      const provider = providerForTerminal(event.terminal);
      if (!provider || !registry) {
        return;
      }

      registry.bind(event.terminal, provider);
      const stream = event.execution.read();
      const parser = new OscSignalParser((signal) => {
        if (signal.provider !== provider) {
          output?.appendLine("signal_rejected reason=provider_mismatch");
          return;
        }
        output?.appendLine(`signal_accepted provider=${provider} target=terminal reason=${signal.reason}`);
        void sendNotification(event.terminal, signal, nativeRouteAvailable);
      });

      void (async () => {
        try {
          for await (const chunk of stream) {
            parser.feed(String(chunk));
          }
        } catch {
          output?.appendLine("execution_stream_closed status=error");
        }
      })();
    }),
    vscode.commands.registerCommand("ahton.configure", async () => {
      await configureProviders(context);
    }),
    vscode.commands.registerCommand("ahton.sendClaudeTestNotification", async () => {
      await sendTestNotification("claude", nativeRouteAvailable);
    }),
    vscode.commands.registerCommand("ahton.sendCodexTestNotification", async () => {
      await sendTestNotification("codex", nativeRouteAvailable);
    }),
    vscode.commands.registerCommand("ahton.startCodexTerminal", async () => {
      await startManagedCodexTerminal();
    }),
    vscode.commands.registerCommand("ahton.showDiagnostics", async () => {
      const snapshot = registry?.snapshot() ?? { routes: 0, activations: 0, claude: 0, codex: 0 };
      const state = nativeRouteAvailable ? "ready" : "disabled";
      // The version is the first thing shown. Without it the attended run on
      // 2026-08-13 could not confirm which build produced the behaviour it saw.
      const version = String(context.extension.packageJSON.version ?? "unknown");
      await vscode.window.showInformationMessage(
        `Ahton ${version}; router: ${state}; routes ${snapshot.routes} ` +
        `(Claude ${snapshot.claude}, Codex ${snapshot.codex}); pending terminal activations ${snapshot.activations}; ` +
        `Claude terminal route ${claudeRoutingReady ? "ready" : "disabled"}; ` +
        `exact window target ${owningWindowHandle ? "captured" : "pending"}; ` +
        `rollover ${isRolloverEnabled() ? "enabled" : "disabled"} (refused ${rolloverGate.snapshot().refused}).`,
      );
    }),
    new vscode.Disposable(() => {
      registry?.revokeAll();
      void claudeEndpoint?.dispose();
    }),
  );
}

/**
 * The Claude hook must not name a path that changes with each extension
 * version, so the adapters are copied to storage VS Code keeps across updates.
 */
function adapterDirectory(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "adapters");
}

function syncHookAdapters(context: vscode.ExtensionContext): void {
  try {
    const result = syncAdapters({
      sourceDirectory: context.asAbsolutePath(path.join("dist", "adapters")),
      targetDirectory: adapterDirectory(context),
    });
    output?.appendLine(`adapters_synced copied=${result.copied.length} unchanged=${result.unchanged.length}`);
  } catch {
    output?.appendLine("adapters_sync_failed reason=copy_error");
  }
}

async function configureProviders(context: vscode.ExtensionContext): Promise<void> {
  const storage = context.globalStorageUri.fsPath;
  const home = os.homedir();
  try {
    syncAdapters({
      sourceDirectory: context.asAbsolutePath(path.join("dist", "adapters")),
      targetDirectory: adapterDirectory(context),
    });
    const result = await runConfigure({
      paths: {
        claudeHome: path.join(home, ".claude"),
        claudeSettings: path.join(home, ".claude", "settings.json"),
        codexHome: path.join(home, ".codex"),
        codexConfig: path.join(home, ".codex", "config.toml"),
        // globalStorage is <User>/globalStorage/<id>, so the settings file that
        // belongs to this edition of VS Code is two folders up.
        vscodeSettings: path.join(path.dirname(path.dirname(storage)), "settings.json"),
        journalDirectory: path.join(storage, "migrations"),
      },
      nodePath: findNodeExecutable(process.env.PATH ?? process.env.Path),
      adapterPath: path.join(adapterDirectory(context), "claude-signal.mjs"),
      ui: {
        confirm: async (message, detail) =>
          (await vscode.window.showWarningMessage(message, { modal: true, detail }, "Apply")) === "Apply",
        notify: async (message) => { await vscode.window.showInformationMessage(message); },
      },
    });
    output?.appendLine(`configure_finished status=${result.status}`);
    if (result.status === "applied") {
      await vscode.window.showInformationMessage(
        "Ahton is configured. Open a new terminal to pick up the profiles. A backup and journal were kept.",
      );
    }
  } catch (error) {
    output?.appendLine("configure_failed");
    await vscode.window.showErrorMessage(
      `Ahton could not configure: ${error instanceof Error ? error.message : "unknown error"}. No file was left half-written.`,
    );
  }
}

async function startManagedCodexTerminal(): Promise<void> {
  const result = await startShellIntegratedTerminal({
    createTerminal: (options) => vscode.window.createTerminal(options),
    onDidChangeTerminalShellIntegration: (listener) =>
      vscode.window.onDidChangeTerminalShellIntegration(listener),
  }, {
    terminalOptions: {
      name: "Codex",
      shellPath: "powershell.exe",
      shellArgs: ["-NoLogo"],
      env: { [MANAGED_PROVIDER_ENV]: "codex" },
      iconPath: new vscode.ThemeIcon("hubot"),
      color: new vscode.ThemeColor("terminal.ansiGreen"),
      isTransient: true,
      location: vscode.TerminalLocation.Editor,
    },
  });
  if (!result.started) {
    output?.appendLine("managed_terminal_rejected reason=shell_integration_unavailable");
    await vscode.window.showWarningMessage(
      "Ahton could not establish an exact Codex terminal route; no terminal was started.",
    );
  } else {
    output?.appendLine("managed_terminal_started provider=codex route=exact_terminal placement=editor");
  }
}
async function sendTestNotification(
  provider: Provider,
  focusWindowAvailable: boolean,
): Promise<void> {
  const terminal = vscode.window.activeTerminal;
  if (!terminal || terminal.exitStatus !== undefined || !registry) {
    await vscode.window.showWarningMessage(
      "Open and select the source terminal before sending a routing test.",
    );
    return;
  }
  registry.bind(terminal, provider);
  // Give an attended routing test time to put another app in front. Real
  // provider signals already arrive while the user is working elsewhere.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await sendNotification(terminal, { provider, reason: "attention" }, focusWindowAvailable);
}

export async function deactivate(): Promise<void> {
  activationGeneration += 1;
  for (const popup of livePopups) popup.dispose();
  livePopups.clear();
  terminalActivationQueue = Promise.resolve();
  registry?.revokeAll();
  await claudeEndpoint?.dispose();
  claudeRoutingReady = false;
  routeAvailable = false;
  owningWindowHandle = undefined;
}

async function captureFocusTarget(): Promise<void> {
  if (!focusHelperPath) {
    return;
  }
  const captured = await captureOwningWindow(focusHelperPath, process.pid);
  if (captured) {
    owningWindowHandle = captured;
    output?.appendLine("focus_target status=captured authority=window_process_ancestry");
  } else {
    output?.appendLine("focus_target status=unchanged reason=foreground_not_owning_window");
  }
}

async function focusCapturedWindow(): Promise<boolean> {
  if (!focusHelperPath || !owningWindowHandle) {
    return false;
  }
  return focusOwningWindow(focusHelperPath, owningWindowHandle, process.pid);
}

async function verifyCapturedWindow(): Promise<boolean> {
  if (!focusHelperPath || !owningWindowHandle) return false;
  return verifyOwningWindow(focusHelperPath, owningWindowHandle, process.pid);
}

async function startClaudeRouting(): Promise<void> {
  try {
    claudeEndpoint = await createAuthenticatedEndpoint({
      extensionHostPid: process.pid,
      directory: claudeDescriptorDirectory(),
      pipePrefix: CLAUDE_PIPE_PREFIX,
      protocolVersion: CLAUDE_PROTOCOL_VERSION,
      parseEnvelope: parseClaudeEnvelope,
      onEnvelope: acceptClaudeEnvelope,
    });
    claudeRoutingReady = true;
    output?.appendLine("claude_router_ready target=exact_terminal route_storage=memory");
  } catch {
    output?.appendLine("claude_router_disabled reason=endpoint_start_failed");
  }
}

/**
 * The signalling process names a shell pid; that name is a selector, never
 * authority. The candidate list comes from VS Code's own `Terminal.processId`
 * values, so a pid this window does not own selects nothing. Zero or several
 * matches fail closed, and there is deliberately no fallback to the active
 * terminal: a guess here is the misroute this design exists to prevent.
 */
async function acceptClaudeEnvelope(envelope: {
  shellPid: number;
  reason: "finished" | "attention" | "rollover";
  baton?: string;
}, context: { signal: AbortSignal }): Promise<boolean> {
  if (!claudeRoutingReady || !registry || !isEnabled() || !routeAvailable) {
    return false;
  }
  if (!owningWindowHandle) {
    output?.appendLine("claude_signal_rejected reason=exact_window_not_captured");
    return false;
  }

  const candidates = await Promise.all(
    vscode.window.terminals
      .filter((candidate) => candidate.exitStatus === undefined)
      .map(async (candidate) => ({
        terminal: candidate as object,
        shellPid: (await candidate.processId) ?? 0,
      })),
  );
  const terminal = selectExactTerminal(envelope.shellPid, candidates) as vscode.Terminal | null;
  if (!terminal) {
    output?.appendLine("claude_signal_rejected reason=no_exact_owned_terminal");
    return false;
  }

  if (envelope.reason === "rollover") {
    // Starting a terminal is opt-in. Refused here, before any terminal API runs.
    if (!rolloverGate.admit()) return false;
    return acceptClaudeRollover(envelope, context.signal);
  }

  registry.bind(terminal, "claude");
  output?.appendLine(`signal_accepted provider=claude target=terminal reason=${envelope.reason}`);
  await sendNotification(terminal, { provider: "claude", reason: envelope.reason }, routeAvailable);
  return true;
}

/**
 * A rollover reaches here only after the checks above have already passed: the
 * token was verified by the endpoint, and the shell pid selected exactly one
 * terminal THIS window owns. So the request is known to come from a Claude
 * session running in this window, which is the authority that permits starting
 * a process at all.
 *
 * What still has to be decided is where and what, and neither comes from the
 * envelope. The directory is this window's own workspace folder; the program is
 * a constant inside `rollover-launch.mjs`. A workspace that is absent, or
 * ambiguous because several folders are open, opens nothing: there is no
 * defensible way to pick one, and guessing here starts a process.
 */
async function acceptClaudeRollover(envelope: { baton?: string }, signal: AbortSignal): Promise<boolean> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length !== 1) {
    output?.appendLine(
      `claude_rollover_refused reason=${folders.length === 0 ? "no_workspace_folder" : "ambiguous_workspace_folder"}`,
    );
    return false;
  }

  return dispatchRollover(envelope, {
    workspaceFolder: folders[0].uri.fsPath,
    realpath: realpathSync,
    signal,
    api: {
      createTerminal: (options) => vscode.window.createTerminal(options as vscode.TerminalOptions),
      onDidChangeTerminalShellIntegration: (listener) =>
        vscode.window.onDidChangeTerminalShellIntegration(listener),
    },
    log: (line: string) => output?.appendLine(line),
  });
}
function isRolloverEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("ahton")
    .get<boolean>("rollover.enabled", false);
}

function showTerminalLabel(): boolean {
  return vscode.workspace
    .getConfiguration("ahton")
    .get<boolean>("showTerminalLabel", true);
}

function showWorkspaceName(): boolean {
  return vscode.workspace
    .getConfiguration("ahton")
    .get<boolean>("showWorkspaceName", true);
}

function displayTargetFor(terminal: vscode.Terminal) {
  const target = withLabelPreference(terminalDisplayRegistry.targetFor(terminal), showTerminalLabel());
  const workspace = showWorkspaceName() ? workspaceLabel(vscode.workspace.name) : null;
  return workspace === null ? target : { ...target, workspace };
}

function isEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("ahton")
    .get<boolean>("enabled", true);
}

function providerForTerminal(terminal: vscode.Terminal): Provider | null {
  const creationOptions = terminal.creationOptions;
  if (!("env" in creationOptions) || !creationOptions.env) {
    return null;
  }
  const value = creationOptions.env[MANAGED_PROVIDER_ENV];
  return value === "claude" || value === "codex" ? value : null;
}

async function sendNotification(
  terminal: vscode.Terminal,
  signal: Signal,
  nativeRouteAvailable: boolean,
): Promise<void> {
  if (!registry || !nativeRouteAvailable || !focusHelperPath) {
    output?.appendLine("notification_skipped reason=native_route_unavailable");
    return;
  }
  if (!owningWindowHandle) {
    output?.appendLine("notification_skipped reason=exact_window_not_captured");
    return;
  }

  const activation = registry.issueActivation(terminal, signal.provider);
  if (!activation) {
    output?.appendLine("notification_skipped reason=route_not_live");
    return;
  }

  const generation = activationGeneration;
  const session = startNativeNotification(
    focusHelperPath, owningWindowHandle, process.pid, signal.provider, signal.reason,
    displayTargetFor(terminal),
  );
  livePopups.add(session);
  output?.appendLine(`popup_issued target=terminal provider=${signal.provider} reason=${signal.reason}`);
  void session.outcome.then((outcome) => {
    livePopups.delete(session);
    if (generation !== activationGeneration || outcome !== "activated") {
      registry?.cancelActivation(activation);
      output?.appendLine(`popup_closed target=terminal outcome=${outcome}`);
      return;
    }
    output?.appendLine("popup_closed target=terminal outcome=activated");
    terminalActivationQueue = terminalActivationQueue
      .then(() => focusActivation(activation, generation))
      .catch(() => output?.appendLine("activation_failed reason=focus_command_error"));
  });
}

async function focusActivation(activation: string, generation: number): Promise<void> {
  const target = registry?.consume(activation);
  if (!target) {
    output?.appendLine("activation_rejected reason=expired_closed_or_replayed");
    return;
  }

  const terminal = target.terminal as vscode.Terminal;
  if (!vscode.window.terminals.includes(terminal) || terminal.exitStatus !== undefined) {
    output?.appendLine("activation_rejected reason=terminal_not_live");
    return;
  }

  const result = await activateExactTerminal({
    terminal,
    isTerminalLive: () => generation === activationGeneration &&
      vscode.window.terminals.includes(terminal) && terminal.exitStatus === undefined,
    focusWindow: () => vscode.commands.executeCommand("workbench.action.focusWindow"),
    focusExactWindow: focusCapturedWindow,
    focusTerminalControl: () => vscode.commands.executeCommand(terminalFocusCommand(terminal)),
    verifyExactWindow: verifyCapturedWindow,
    getActiveTerminal: () => vscode.window.activeTerminal,
    onDidChangeActiveTerminal: (listener) => vscode.window.onDidChangeActiveTerminal(listener),
  });
  if (result === "succeeded") {
    // The provider comes from the route the signal bound, not from the terminal's
    // creationOptions. A Claude terminal is identified by its pipe envelope, and
    // providerForTerminal() would report "unknown" for it.
    output?.appendLine(`activation_succeeded target=terminal provider=${target.provider} evidence=exact_window+exact_active_terminal+terminal_focus_command`);
    // The postcondition was true once. On 2026-08-13 the window then faded back
    // to the other one, and nothing recorded it because the router stopped
    // looking here.
    const hold = await holdActivatedWindow({
      verifyExactWindow: verifyCapturedWindow,
      focusExactWindow: focusCapturedWindow,
      isTerminalLive: () => generation === activationGeneration &&
        vscode.window.terminals.includes(terminal) && terminal.exitStatus === undefined,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    output?.appendLine(`activation_hold outcome=${hold}`);
  } else if (result === "terminal_not_live") {
    output?.appendLine("activation_rejected reason=terminal_not_live");
  } else {
    output?.appendLine(`activation_failed reason=${result}`);
  }
}
// End of the terminal-only extension entry point.
