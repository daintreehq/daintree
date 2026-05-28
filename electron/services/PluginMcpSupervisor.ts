import { z } from "zod";
import {
  PLUGIN_MCP_STDERR_RING_LINES,
  type PluginMcpServerInfo,
  type PluginMcpServerStatus,
  type PluginMcpStderrResult,
} from "../../shared/types/ipc/pluginMcp.js";
import { McpServerContributionSchema } from "../schemas/plugin.js";

type McpServerContribution = z.infer<typeof McpServerContributionSchema>;

/**
 * Minimal surface of an `execa` subprocess that the supervisor actually
 * exercises. Declared as an interface so unit tests can hand in a fake duplex
 * without pulling in execa's full module surface or relying on
 * `child_process.spawn`. Mirrors the shape of `ExecaSubprocess` at runtime.
 *
 * NOTE: this interface intentionally does NOT inherit from `Promise` /
 * `PromiseLike`. Execa's real subprocess IS a promise (it resolves when the
 * child exits), but `await this.spawner(...)` would silently follow that
 * promise all the way to exit if the interface were thenable. Instead the
 * spawner returns a {@link SpawnHandle} wrapper that exposes the subprocess
 * plus a separate `exit` promise.
 */
interface SupervisedSubprocess {
  pid: number | undefined;
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(): boolean;
}

/**
 * Result returned by the spawner. The `subprocess` field is the live handle
 * the supervisor reads from / writes to; the `exit` promise resolves (or
 * rejects) when the child process terminates. The wrapper is non-thenable so
 * that `await spawner(...)` cannot accidentally wait for child-process exit.
 */
export interface SpawnHandle {
  subprocess: SupervisedSubprocess;
  exit: Promise<unknown>;
}

export interface ResolvedMcpServerConfig {
  /** Raw manifest entry, kept for `name` and identity. */
  contribution: McpServerContribution;
  /** `command`/`args`/`env` after `${settings:*}` substitution at spawn time. */
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Spawn shim. Injected so unit tests can substitute a controllable duplex.
 * Production wiring uses `execa` with `cleanup: true`, `windowsHide: true`,
 * `detached: false` and `stdio: ["pipe", "pipe", "pipe"]`.
 */
export type SubprocessSpawner = (
  config: ResolvedMcpServerConfig
) => SpawnHandle | Promise<SpawnHandle>;

/**
 * Process-tree teardown shim. On Windows we shell out to
 * `taskkill /T /F /PID <pid>` because Windows does not cascade kills and the
 * supervisor's direct child is often a shell (`npx`, `uvx`, `.bat`) whose
 * actual MCP server is a grandchild. Injected so tests can assert the
 * platform-specific tree-kill is invoked without actually shelling out.
 *
 * On POSIX a plain `SIGKILL` is sufficient — `execa` runs children with
 * `detached: false` so the kernel reparents stranded grandchildren to PID 1
 * only if the immediate child itself was a shell wrapper. The CVE-cited
 * failure mode is Windows-specific; POSIX-side cleanup is best-effort.
 */
export type ProcessTreeKiller = (pid: number) => void | Promise<void>;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface SupervisedServerState {
  pluginId: string;
  serverId: string;
  contribution: McpServerContribution;
  status: PluginMcpServerStatus;
  pid: number | null;
  lastError: string | null;
  stderrRing: string[];
  /** Total stderr lines emitted since last spawn — may exceed the ring cap. */
  stderrTotal: number;
  subprocess: SupervisedSubprocess | null;
  nextRequestId: number;
  pendingCalls: Map<number, PendingCall>;
  /** Resolves when the handshake completes (or rejects on failure). */
  readyPromise: Promise<void> | null;
  /** Stdout NDJSON parse buffer carryover across stream chunks. */
  stdoutBuffer: string;
}

const HANDSHAKE_TIMEOUT_MS = 15_000;
const SHUTDOWN_GRACE_MS = 3_000;
const TOOL_CALL_TIMEOUT_MS = 30_000;

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "daintree-plugin-supervisor", version: "1" } as const;

/**
 * Manages stdio-only MCP subprocesses contributed by plugin manifests.
 *
 * One singleton lives in the main process for the lifetime of the app — the
 * supervisor is not its own `UtilityProcess` (each MCP server is already an
 * OS subprocess; nesting them inside a utility-process host would add cost
 * without benefit, see #4748). Plugin activation calls
 * {@link PluginMcpSupervisor.start} with the resolved manifest entries; plugin
 * deactivation (and app shutdown) call {@link shutdown}/{@link shutdownAll}.
 *
 * Lifecycle invariants:
 *  - `tools/call` before the handshake completes fails fast with `NOT_READY`
 *    rather than queueing (mirrors the in-process MCP server's readiness
 *    contract — see `readinessProbe.ts`).
 *  - stderr is drained continuously into a bounded per-server ring buffer
 *    ({@link PLUGIN_MCP_STDERR_RING_LINES}) and never injected into agent
 *    context. Surfacing it as token-budget input would burn tokens and open a
 *    prompt-injection vector from third-party binaries.
 *  - Pre-resolved settings substitutions reach the supervisor; it never reads
 *    the settings vault directly. Secret rotation triggers a restart via
 *    `PluginService`.
 */
export class PluginMcpSupervisor {
  private readonly states = new Map<string, SupervisedServerState>();
  private readonly spawner: SubprocessSpawner;
  private readonly killTree: ProcessTreeKiller;

  constructor(options?: { spawner?: SubprocessSpawner; killTree?: ProcessTreeKiller }) {
    this.spawner = options?.spawner ?? defaultSpawner;
    this.killTree = options?.killTree ?? defaultProcessTreeKiller;
  }

  /**
   * Eagerly spawn every server contributed by `pluginId`. Resolves once every
   * server has either reached `ready` or transitioned to `crashed` — never
   * rejects, so a single failing server can't strand plugin activation.
   *
   * Idempotent per `(pluginId, serverId)`: a subsequent call against an
   * already-running server is a no-op. Use {@link restart} to replace a
   * running server (e.g. after secret rotation).
   */
  async start(input: {
    pluginId: string;
    contributions: McpServerContribution[];
    resolveSettings: (template: string) => Promise<string>;
  }): Promise<void> {
    const { pluginId, contributions, resolveSettings } = input;
    if (contributions.length === 0) return;
    await Promise.all(
      contributions.map((contribution) =>
        this.startOne(pluginId, contribution, resolveSettings).catch((err) => {
          // startOne records the failure into state.lastError; the catch here
          // exists so a thrown spawn (e.g. unresolved settings template) can't
          // reject the outer Promise.all and abort plugin activation.
          console.warn(
            `[PluginMcpSupervisor] Failed to start "${pluginId}/${contribution.id}":`,
            err
          );
        })
      )
    );
  }

  private async startOne(
    pluginId: string,
    contribution: McpServerContribution,
    resolveSettings: (template: string) => Promise<string>
  ): Promise<void> {
    const key = stateKey(pluginId, contribution.id);
    const existing = this.states.get(key);
    if (existing && (existing.status === "spawning" || existing.status === "ready")) return;

    const state: SupervisedServerState = existing ?? {
      pluginId,
      serverId: contribution.id,
      contribution,
      status: "spawning",
      pid: null,
      lastError: null,
      stderrRing: [],
      stderrTotal: 0,
      subprocess: null,
      nextRequestId: 1,
      pendingCalls: new Map(),
      readyPromise: null,
      stdoutBuffer: "",
    };
    // Reset transient fields for a restart of a previously-stopped/crashed entry.
    if (existing) {
      state.contribution = contribution;
      state.status = "spawning";
      state.lastError = null;
      state.subprocess = null;
      state.nextRequestId = 1;
      state.pendingCalls.clear();
      state.stdoutBuffer = "";
      // Restart marker so the log viewer can tell pre-restart and post-restart
      // output apart inside the bounded ring without a separate UI mode.
      this.appendStderrLine(state, `--- restarted at ${new Date().toISOString()} ---`);
    }
    this.states.set(key, state);

    let resolved: ResolvedMcpServerConfig;
    try {
      resolved = await resolveContribution(contribution, resolveSettings);
    } catch (err) {
      state.status = "crashed";
      state.lastError = err instanceof Error ? err.message : String(err);
      return;
    }

    let handle: SpawnHandle;
    try {
      handle = await this.spawner(resolved);
    } catch (err) {
      state.status = "crashed";
      state.lastError = err instanceof Error ? err.message : String(err);
      return;
    }
    const subprocess = handle.subprocess;
    state.subprocess = subprocess;
    state.pid = subprocess.pid ?? null;
    // Execa's subprocess promise rejects with the kill error when the child
    // exits non-zero or is killed. Without a `.catch` attached at spawn time
    // it surfaces as an unhandled rejection, which Electron 37+ utility
    // processes (and increasingly the main process under strict modes) treat
    // as fatal. See #4372.
    handle.exit.catch(() => {});

    this.attachStderrReader(state);
    this.attachStdoutReader(state);

    const handshakePromise = this.runHandshake(state);
    state.readyPromise = handshakePromise;
    try {
      await handshakePromise;
    } catch {
      // runHandshake records the failure into state.lastError already.
    }
  }

  private async runHandshake(state: SupervisedServerState): Promise<void> {
    const stdin = state.subprocess?.stdin;
    if (!stdin) {
      const err = new Error("subprocess has no stdin stream");
      state.status = "crashed";
      state.lastError = err.message;
      throw err;
    }

    const initId = state.nextRequestId++;
    const initialize = {
      jsonrpc: "2.0" as const,
      id: initId,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    };

    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pendingCalls.delete(initId);
        reject(new Error(`MCP server "${state.contribution.name}" handshake timed out`));
      }, HANDSHAKE_TIMEOUT_MS);
      state.pendingCalls.set(initId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
        timer,
      });
    });

    try {
      writeFrame(stdin, initialize);
      await responsePromise;
      // notifications/initialized has no id; the server does not respond.
      writeFrame(stdin, {
        jsonrpc: "2.0" as const,
        method: "notifications/initialized",
        params: {},
      });
      state.status = "ready";
      state.lastError = null;
    } catch (err) {
      state.status = "crashed";
      state.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private attachStdoutReader(state: SupervisedServerState): void {
    const subprocess = state.subprocess;
    const stream = subprocess?.stdout;
    if (!subprocess || !stream) return;
    stream.setEncoding("utf-8");
    stream.on("data", (chunk: string) => {
      // Ignore data from a stale subprocess after a restart. Without the
      // identity check, the old stream's tail-end emit would parse into the
      // new handshake's request-id space and resolve the wrong pending call.
      if (state.subprocess !== subprocess) return;
      state.stdoutBuffer += chunk;
      // MCP stdio framing is newline-delimited JSON (NDJSON), not Content-Length
      // framed like LSP. Each `\n` terminates one JSON-RPC 2.0 message.
      for (;;) {
        const newlineIdx = state.stdoutBuffer.indexOf("\n");
        if (newlineIdx < 0) break;
        const line = state.stdoutBuffer.slice(0, newlineIdx).trim();
        state.stdoutBuffer = state.stdoutBuffer.slice(newlineIdx + 1);
        if (line.length === 0) continue;
        this.dispatchStdoutMessage(state, line);
      }
    });
    stream.on("close", () => {
      // The close listener for a killed-and-replaced subprocess can fire
      // after the new spawn has installed a fresh handshake pending call.
      // Bind by identity so a stale close doesn't reject the new call.
      if (state.subprocess !== subprocess) return;
      this.handleSubprocessExit(state);
    });
  }

  private dispatchStdoutMessage(state: SupervisedServerState, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Server emitted non-JSON on stdout. The spec forbids this, but a
      // misbehaving server shouldn't crash the supervisor; record it for the
      // log viewer alongside stderr.
      this.appendStderrLine(state, `[stdout-non-json] ${raw}`);
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const message = parsed as { id?: unknown; result?: unknown; error?: unknown };
    if (typeof message.id === "number") {
      const pending = state.pendingCalls.get(message.id);
      if (!pending) return;
      state.pendingCalls.delete(message.id);
      if (message.error !== undefined) {
        const errObj = message.error as { message?: unknown; code?: unknown };
        const msg =
          typeof errObj.message === "string"
            ? errObj.message
            : `MCP error code ${String(errObj.code)}`;
        pending.reject(new Error(msg));
      } else {
        pending.resolve(message.result);
      }
    }
    // Notifications (no id) are ignored — we don't subscribe to any.
  }

  private attachStderrReader(state: SupervisedServerState): void {
    const subprocess = state.subprocess;
    const stream = subprocess?.stderr;
    if (!subprocess || !stream) return;
    stream.setEncoding("utf-8");
    let carry = "";
    stream.on("data", (chunk: string) => {
      if (state.subprocess !== subprocess) return;
      carry += chunk;
      for (;;) {
        const newlineIdx = carry.indexOf("\n");
        if (newlineIdx < 0) break;
        const line = carry.slice(0, newlineIdx);
        carry = carry.slice(newlineIdx + 1);
        this.appendStderrLine(state, line);
      }
    });
    stream.on("close", () => {
      if (state.subprocess !== subprocess) return;
      if (carry.length > 0) this.appendStderrLine(state, carry);
    });
  }

  private appendStderrLine(state: SupervisedServerState, line: string): void {
    state.stderrRing.push(line);
    state.stderrTotal++;
    if (state.stderrRing.length > PLUGIN_MCP_STDERR_RING_LINES) {
      state.stderrRing.splice(0, state.stderrRing.length - PLUGIN_MCP_STDERR_RING_LINES);
    }
  }

  private handleSubprocessExit(state: SupervisedServerState): void {
    if (state.status === "stopped") return;
    if (state.status === "spawning" || state.status === "ready") {
      state.status = "crashed";
      if (!state.lastError) state.lastError = "MCP server exited unexpectedly";
    }
    state.pid = null;
    state.subprocess = null;
    for (const [id, pending] of state.pendingCalls) {
      state.pendingCalls.delete(id);
      pending.reject(new Error(state.lastError ?? "MCP server exited"));
    }
  }

  /**
   * Dispatch a `tools/call` against a supervised server. Rejects with a
   * `NOT_READY` error if the handshake hasn't completed — the supervisor does
   * not queue pre-ready calls because there is no upper bound on how long a
   * misbehaving server might take to settle, and callers prefer fast failure
   * over indefinite waiting.
   */
  async callTool(input: {
    pluginId: string;
    serverId: string;
    tool: string;
    args?: Record<string, unknown>;
  }): Promise<unknown> {
    const state = this.states.get(stateKey(input.pluginId, input.serverId));
    if (!state) {
      throw plainError(
        "NOT_FOUND",
        `MCP server "${input.pluginId}/${input.serverId}" is not registered`
      );
    }
    if (state.status !== "ready") {
      throw plainError(
        "NOT_READY",
        `MCP server "${input.pluginId}/${input.serverId}" is ${state.status}, not ready`
      );
    }
    const stdin = state.subprocess?.stdin;
    if (!stdin) {
      throw plainError("NOT_READY", "subprocess has no stdin stream");
    }
    const requestId = state.nextRequestId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pendingCalls.delete(requestId);
        reject(plainError("TIMEOUT", `tools/call "${input.tool}" timed out`));
      }, TOOL_CALL_TIMEOUT_MS);
      state.pendingCalls.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
        timer,
      });
    });
    writeFrame(stdin, {
      jsonrpc: "2.0" as const,
      id: requestId,
      method: "tools/call",
      params: { name: input.tool, arguments: input.args ?? {} },
    });
    return promise;
  }

  /**
   * Tear down every supervised server owned by `pluginId`. SIGTERM the
   * subprocess, wait briefly, then escalate to a process-tree kill on
   * Windows. Resolves once every owned subprocess has been signalled — does
   * not wait synchronously for the exit because Electron's app shutdown timer
   * already bounds the overall shutdown window.
   */
  async shutdown(input: { pluginId: string }): Promise<void> {
    const ownedKeys = [...this.states.keys()].filter((k) => k.startsWith(`${input.pluginId} `));
    await Promise.all(ownedKeys.map((key) => this.shutdownOne(key)));
  }

  private async shutdownOne(key: string): Promise<void> {
    const state = this.states.get(key);
    if (!state) return;
    state.status = "stopped";
    const subprocess = state.subprocess;
    if (!subprocess) return;
    const pid = state.pid;

    // Reject in-flight pending calls before we kill the process so callers
    // don't sit on a 30s tool-call timeout while teardown races.
    for (const [id, pending] of state.pendingCalls) {
      state.pendingCalls.delete(id);
      pending.reject(plainError("STOPPED", "MCP server shutting down"));
    }

    // Call .kill() with NO arguments. Passing an explicit signal disables
    // execa's `forceKillAfterDelay` escalation in v9.
    try {
      subprocess.kill();
    } catch {
      // already-exited or detached — fall through to tree-kill on Windows.
    }

    if (pid !== null && process.platform === "win32") {
      // Even with execa cleanup:true, a hard SIGKILL from outside (parent
      // crash, watchdog) leaves grandchildren stranded on Windows. Always
      // shell out after the grace window.
      setTimeout(() => {
        Promise.resolve(this.killTree(pid)).catch(() => {});
      }, SHUTDOWN_GRACE_MS);
    }

    state.subprocess = null;
    state.pid = null;
  }

  /** Tear down every server owned by every plugin. App-shutdown entry point. */
  async shutdownAll(): Promise<void> {
    const pluginIds = new Set<string>();
    for (const state of this.states.values()) pluginIds.add(state.pluginId);
    await Promise.all([...pluginIds].map((pluginId) => this.shutdown({ pluginId })));
  }

  /**
   * Force a restart of a single server. Used by `PluginService` when a
   * settings entry referenced by the manifest changes — the new value is
   * folded into the env at spawn time, so the existing subprocess has to
   * exit and respawn for the change to take effect.
   */
  async restart(input: {
    pluginId: string;
    serverId: string;
    contribution: McpServerContribution;
    resolveSettings: (template: string) => Promise<string>;
  }): Promise<void> {
    await this.shutdownOne(stateKey(input.pluginId, input.serverId));
    await this.startOne(input.pluginId, input.contribution, input.resolveSettings);
  }

  /** Snapshot every supervised server for the `plugin-mcp:list` IPC. */
  list(): PluginMcpServerInfo[] {
    return [...this.states.values()].map((state) => this.toInfo(state));
  }

  /** Per-server stderr fetch for the `plugin-mcp:get-stderr` IPC. */
  getStderr(pluginId: string, serverId: string): PluginMcpStderrResult {
    const state = this.states.get(stateKey(pluginId, serverId));
    if (!state) {
      return { pluginId, serverId, lines: [], totalLines: 0 };
    }
    return {
      pluginId,
      serverId,
      lines: [...state.stderrRing],
      totalLines: state.stderrTotal,
    };
  }

  private toInfo(state: SupervisedServerState): PluginMcpServerInfo {
    return {
      pluginId: state.pluginId,
      serverId: state.serverId,
      name: state.contribution.name,
      status: state.status,
      pid: state.pid,
      lastError: state.lastError,
      stderrLineCount: state.stderrRing.length,
    };
  }
}

const SETTINGS_TEMPLATE_RE = /\$\{settings:([a-zA-Z0-9._-]+)\}/g;

/**
 * One-shot `${settings:settingId}` substitution applied to `command`, each
 * `args` entry, and each `env` value. The supervisor is handed a resolver
 * closure by `PluginService` rather than reading the settings vault directly
 * — the supervisor never knows about the vault's storage layout, and secrets
 * stay scoped to the plugin host that owns them.
 */
async function resolveContribution(
  contribution: McpServerContribution,
  resolve: (template: string) => Promise<string>
): Promise<ResolvedMcpServerConfig> {
  const command = await substitute(contribution.command, resolve);
  const args = await Promise.all((contribution.args ?? []).map((arg) => substitute(arg, resolve)));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(contribution.env ?? {})) {
    env[key] = await substitute(value, resolve);
  }
  return { contribution, command, args, env };
}

async function substitute(
  input: string,
  resolve: (template: string) => Promise<string>
): Promise<string> {
  if (!input.includes("${settings:")) return input;
  const matches = [...input.matchAll(SETTINGS_TEMPLATE_RE)];
  let out = input;
  for (const match of matches) {
    const value = await resolve(match[1]!);
    out = out.replace(match[0], value);
  }
  return out;
}

function writeFrame(stdin: NodeJS.WritableStream, payload: unknown): void {
  // MCP stdio framing is NDJSON — one JSON-RPC 2.0 message per `\n`.
  stdin.write(`${JSON.stringify(payload)}\n`);
}

function stateKey(pluginId: string, serverId: string): string {
  return `${pluginId} ${serverId}`;
}

function plainError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const defaultSpawner: SubprocessSpawner = async (config) => {
  const { execa } = await import("execa");
  const subprocess = execa(config.command, config.args, {
    env: { ...process.env, ...config.env },
    stdio: ["pipe", "pipe", "pipe"],
    cleanup: true,
    windowsHide: true,
    detached: false,
    forceKillAfterDelay: SHUTDOWN_GRACE_MS,
    reject: false,
  });
  return {
    subprocess: subprocess as unknown as SupervisedSubprocess,
    // execa subprocesses are also Promises that resolve / reject with the
    // child's exit result. Expose that separately so the supervisor can
    // attach a `.catch` for unhandled-rejection safety without follow-await
    // semantics polluting the spawn path.
    exit: subprocess as unknown as Promise<unknown>,
  };
};

const defaultProcessTreeKiller: ProcessTreeKiller = async (pid) => {
  if (process.platform !== "win32") return;
  const { execa } = await import("execa");
  try {
    await execa("taskkill", ["/T", "/F", "/PID", String(pid)], { reject: false });
  } catch {
    // best-effort — the process may have already exited cleanly
  }
};

/**
 * Singleton accessor. Lifecycle wiring (`PluginService` activation,
 * `unloadPlugin`, `electron/lifecycle/shutdown.ts`) imports this rather than
 * threading the instance through DI — one supervisor per app session.
 */
let singleton: PluginMcpSupervisor | null = null;
export function getPluginMcpSupervisor(): PluginMcpSupervisor {
  if (singleton === null) singleton = new PluginMcpSupervisor();
  return singleton;
}

/** Test-only: replace the singleton with one wired to controllable shims. */
export function __setPluginMcpSupervisorForTests(instance: PluginMcpSupervisor | null): void {
  singleton = instance;
}
