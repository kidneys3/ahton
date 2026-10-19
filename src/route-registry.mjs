import { randomBytes } from "node:crypto";

const PROVIDERS = new Set(["claude", "codex"]);

/**
 * In-memory capability registry. Terminals are deliberately represented by
 * object identity, never by title, PID, cwd, session id, or filesystem path.
 */
export class RouteRegistry {
  #terminalRoutes = new Map();
  #routes = new Map();
  #activations = new Map();
  #generation = 0;
  #clock;
  #isTerminalLive;
  #routeTtlMs;
  #activationTtlMs;
  #maxActivations;

  /**
   * @param {{clock?: () => number, isTerminalLive?: (terminal: object) => boolean, routeTtlMs?: number, activationTtlMs?: number, maxActivations?: number}} [options]
   */
  constructor(options = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#isTerminalLive = options.isTerminalLive ?? (() => true);
    this.#routeTtlMs = options.routeTtlMs ?? 24 * 60 * 60 * 1000;
    this.#activationTtlMs = options.activationTtlMs ?? 15 * 60 * 1000;
    this.#maxActivations = options.maxActivations ?? 256;
  }

  /** @param {object} terminal @param {"claude" | "codex"} provider */
  bind(terminal, provider) {
    assertProvider(provider);
    const now = this.#clock();
    const existing = this.#terminalRoutes.get(terminal);
    if (existing && existing.provider === provider && existing.expiresAt > now) {
      return existing.routeId;
    }
    if (existing) {
      this.close(terminal);
    }

    const record = {
      routeId: opaqueId(),
      terminal,
      provider,
      generation: ++this.#generation,
      expiresAt: now + this.#routeTtlMs,
    };
    this.#terminalRoutes.set(terminal, record);
    this.#routes.set(record.routeId, record);
    return record.routeId;
  }

  /** @param {object} terminal @param {"claude" | "codex"} provider */
  issueActivation(terminal, provider) {
    assertProvider(provider);
    this.cleanup();
    const route = this.#terminalRoutes.get(terminal);
    if (!route || route.provider !== provider || !this.#isTerminalLive(terminal)) {
      return null;
    }

    this.#trimActivations();
    const nonce = opaqueId();
    this.#activations.set(nonce, {
      nonce,
      routeId: route.routeId,
      generation: route.generation,
      provider,
      issuedAt: this.#clock(),
      expiresAt: this.#clock() + this.#activationTtlMs,
    });
    return nonce;
  }

  /** @param {string} nonce */
  consume(nonce) {
    const activation = this.#activations.get(nonce);
    // Delete before validation: every attempted use is one-shot, including a
    // malformed, expired, or racing activation.
    this.#activations.delete(nonce);
    if (!activation || activation.expiresAt <= this.#clock()) {
      return null;
    }

    const route = this.#routes.get(activation.routeId);
    if (!route ||
        route.generation !== activation.generation ||
        route.provider !== activation.provider ||
        route.expiresAt <= this.#clock() ||
        this.#terminalRoutes.get(route.terminal) !== route ||
        !this.#isTerminalLive(route.terminal)) {
      return null;
    }

    return { terminal: route.terminal, provider: route.provider };
  }

  /** @param {string} nonce */
  cancelActivation(nonce) {
    this.#activations.delete(nonce);
  }

  /** @param {object} terminal */
  close(terminal) {
    const route = this.#terminalRoutes.get(terminal);
    if (!route) {
      return;
    }
    this.#terminalRoutes.delete(terminal);
    this.#routes.delete(route.routeId);
    for (const [nonce, activation] of this.#activations) {
      if (activation.routeId === route.routeId) {
        this.#activations.delete(nonce);
      }
    }
  }

  cleanup() {
    const now = this.#clock();
    for (const route of [...this.#routes.values()]) {
      if (route.expiresAt <= now || !this.#isTerminalLive(route.terminal)) {
        this.close(route.terminal);
      }
    }
    for (const [nonce, activation] of this.#activations) {
      if (activation.expiresAt <= now || !this.#routes.has(activation.routeId)) {
        this.#activations.delete(nonce);
      }
    }
  }

  snapshot() {
    this.cleanup();
    let claude = 0;
    let codex = 0;
    for (const route of this.#routes.values()) {
      if (route.provider === "claude") claude += 1;
      if (route.provider === "codex") codex += 1;
    }
    return Object.freeze({
      routes: this.#routes.size,
      activations: this.#activations.size,
      claude,
      codex,
    });
  }

  revokeAll() {
    this.#terminalRoutes.clear();
    this.#routes.clear();
    this.#activations.clear();
  }

  #trimActivations() {
    if (this.#activations.size < this.#maxActivations) {
      return;
    }
    const oldest = [...this.#activations.values()]
      .sort((left, right) => left.issuedAt - right.issuedAt)[0];
    if (oldest) {
      this.#activations.delete(oldest.nonce);
    }
  }
}

function opaqueId() {
  return randomBytes(32).toString("base64url");
}

/** @param {string} provider */
function assertProvider(provider) {
  if (!PROVIDERS.has(provider)) {
    throw new Error("unsupported provider");
  }
}
