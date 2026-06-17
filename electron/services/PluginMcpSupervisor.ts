import { z } from "zod";
import {
  PLUGIN_MCP_DEFAULT_MAX_TOOLS_PER_SESSION,
  PLUGIN_MCP_STDERR_RING_LINES,
  PLUGIN_MCP_TOOL_DESCRIPTION_CAP,
  type PluginMcpFullTool,
  type PluginMcpGetFullSchemaResult,
  type PluginMcpListToolsResult,
  type PluginMcpServerInfo,
  type PluginMcpServerStatus,
  type PluginMcpStderrResult,
  type PluginMcpToolSummary,
} from "../../shared/types/ipc/pluginMcp.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
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
  /**
   * Working directory for the child process. The supervisor anchors this to
   * the plugin's on-disk directory so a manifest like
   * `command: "node", args: ["./dist/server.js"]` resolves against the plugin
   * regardless of the Electron process's own cwd. Plugins cannot override
   * this — it's set by the host, not the manifest.
   */
  cwd: string | undefined;
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
  /**
   * Monotonic spawn counter, bumped each time a fresh subprocess is registered
   * onto this key. A delayed Windows tree-kill captures the generation it was
   * scheduled for and bails if a restart has since registered a newer one —
   * so a reused PID for the post-restart server is never tree-killed (#9235).
   */
  spawnGeneration: number;
  nextRequestId: number;
  pendingCalls: Map<number, PendingCall>;
  /** Resolves when the handshake completes (or rejects on failure). */
  readyPromise: Promise<void> | null;
  /**
   * Resolves when the in-flight `startOne` run for this server settles (ready
   * or crashed) — never rejects. Concurrent lazy-spawn callers (two windows
   * opening the same cold plugin) await this so they don't race the handshake
   * and see a transient `spawning` status. Cleared once the run settles (#9235).
   */
  inflightStart: Promise<void> | null;
  /** Stdout NDJSON parse buffer carryover across stream chunks. */
  stdoutBuffer: string;
  /**
   * Lazily-fetched `tools/list` result (#9235), full tier-2 entries with input
   * schemas. `null` means "not yet fetched, or invalidated by a crash/restart
   * or a `notifications/tools/list_changed`". Never holds stale data across a
   * subprocess exit — see {@link handleSubprocessExit}.
   */
  toolsCache: PluginMcpFullTool[] | null;
  /**
   * Singleflight guard for {@link fetchToolsList} — concurrent enumerations
   * (multiple agent panes hitting `plugin-mcp:list-tools` before the cache
   * warms) share one in-flight `tools/list` round instead of each spawning a
   * fresh request. Cleared in `.finally()`. See lessons #4832 / #4441.
   */
  toolsListInflight: Promise<PluginMcpFullTool[]> | null;
  /**
   * Count of tools this server contributed to the last enumeration AFTER the
   * global per-session cap was applied. Summed across the other servers to
   * compute the remaining budget so the ~200 cap spans all servers, not each.
   */
  surfacedToolCount: number;
}

const HANDSHAKE_TIMEOUT_MS = 15_000;
const SHUTDOWN_GRACE_MS = 3_000;
const TOOL_CALL_TIMEOUT_MS = 30_000;
/**
 * Debounce window for {@link PluginMcpSupervisor.notifySettingChanged} (#10619).
 * Settings writes from the form fire one event per keystroke-committed field, so
 * coalesce a rapid burst (e.g. paste-then-blur, or a multi-field save) into a
 * single respawn rather than thrashing the subprocess.
 */
const SETTING_CHANGE_DEBOUNCE_MS = 1_000;
/**
 * Upper bound on `tools/list` cursor pages (#9235). A misbehaving server that
 * returns the same non-empty `nextCursor` forever would otherwise loop without
 * end and accumulate tools unbounded — the cap is only applied after the full
 * fetch. 200 tools/page × 100 pages is far above any legitimate tool surface.
 */
export const TOOLS_LIST_MAX_PAGES = 100;

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
  /**
   * Per-server debounce timers for {@link notifySettingChanged}. Keyed by
   * {@link stateKey}; a burst of rapid secret edits coalesces into one restart.
   * Cleared in {@link shutdownOne} so a teardown (plugin unload, app shutdown)
   * never leaves a timer that would respawn a server the host has dropped.
   */
  private readonly settingChangeTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    pluginDir?: string;
    contributions: McpServerContribution[];
    resolveSettings: (template: string) => Promise<string>;
  }): Promise<void> {
    const { pluginId, pluginDir, contributions, resolveSettings } = input;
    if (contributions.length === 0) return;
    await Promise.all(
      contributions.map((contribution) =>
        this.startOne(pluginId, pluginDir, contribution, resolveSettings).catch((err) => {
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

  /**
   * Idempotent per `(pluginId, serverId)`. A call against an already-spawning or
   * ready server returns the in-flight start promise (so concurrent lazy-spawn
   * callers await readiness rather than proceeding against a transient
   * `spawning` state — #9235) instead of being a fire-and-forget no-op.
   */
  private startOne(
    pluginId: string,
    pluginDir: string | undefined,
    contribution: McpServerContribution,
    resolveSettings: (template: string) => Promise<string>
  ): Promise<void> {
    const key = stateKey(pluginId, contribution.id);
    const existing = this.states.get(key);
    if (existing && (existing.status === "spawning" || existing.status === "ready")) {
      return existing.inflightStart ?? Promise.resolve();
    }
    // `doStartOne` runs synchronously up to its first `await` — by the time it
    // returns the promise the state is already in the map, so we can stamp the
    // in-flight handle onto it for concurrent callers to await.
    const run = this.doStartOne(pluginId, pluginDir, contribution, resolveSettings);
    const state = this.states.get(key);
    if (state) {
      state.inflightStart = run;
      void run.finally(() => {
        if (state.inflightStart === run) state.inflightStart = null;
      });
    }
    return run;
  }

  private async doStartOne(
    pluginId: string,
    pluginDir: string | undefined,
    contribution: McpServerContribution,
    resolveSettings: (template: string) => Promise<string>
  ): Promise<void> {
    const key = stateKey(pluginId, contribution.id);
    const existing = this.states.get(key);

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
      spawnGeneration: 0,
      nextRequestId: 1,
      pendingCalls: new Map(),
      readyPromise: null,
      inflightStart: null,
      stdoutBuffer: "",
      toolsCache: null,
      toolsListInflight: null,
      surfacedToolCount: 0,
    };
    // Reset transient fields for a restart of a previously-stopped/crashed
    // entry. A "crashed" entry may still hold a live subprocess (e.g. the
    // handshake timed out but the server is still running), so kill it
    // before nulling the reference — otherwise the orphan process leaks.
    if (existing) {
      if (existing.subprocess) {
        try {
          existing.subprocess.kill();
        } catch {
          // already-exited or detached — fall through
        }
      }
      state.contribution = contribution;
      state.status = "spawning";
      state.lastError = null;
      state.subprocess = null;
      state.pid = null;
      state.nextRequestId = 1;
      state.pendingCalls.clear();
      state.stdoutBuffer = "";
      // A restart may bring up a server with a different tool surface — discard
      // the previous tool cache so the next enumeration refetches and re-runs
      // the TOFU comparison (#9235).
      state.toolsCache = null;
      state.toolsListInflight = null;
      state.surfacedToolCount = 0;
      // Restart marker so the log viewer can tell pre-restart and post-restart
      // output apart inside the bounded ring without a separate UI mode.
      this.appendStderrLine(state, `--- restarted at ${new Date().toISOString()} ---`);
    }
    this.states.set(key, state);

    let resolved: ResolvedMcpServerConfig;
    try {
      resolved = await resolveContribution(contribution, pluginDir, resolveSettings);
    } catch (err) {
      // A concurrent shutdown may have flipped state.status to "stopped"
      // while we were resolving — don't claim crashed in that case.
      if (state.status !== "stopped") {
        state.status = "crashed";
        state.lastError = formatErrorMessage(err, "MCP supervisor error");
      }
      return;
    }

    // If a shutdown landed during resolveContribution, abandon the spawn
    // entirely so we don't strand a fresh subprocess outside the supervisor's
    // teardown bookkeeping.
    if (state.status === "stopped") return;

    let handle: SpawnHandle;
    try {
      handle = await this.spawner(resolved);
    } catch (err) {
      if (state.status === "spawning") {
        state.status = "crashed";
        state.lastError = formatErrorMessage(err, "MCP supervisor error");
      }
      return;
    }
    // Same guard after the spawn-await: if a shutdown raced in (status flipped
    // to "stopped" while we were awaiting spawn), kill the freshly-spawned
    // child immediately rather than registering it as live state. TS narrows
    // away "stopped" here because the captured-state type tracker can't see
    // the mutation from a concurrent shutdownOne — the runtime check is real,
    // the typeof cast just bypasses the dead-code narrowing.
    if ((state.status as PluginMcpServerStatus) === "stopped") {
      try {
        handle.subprocess.kill();
      } catch {
        // best-effort
      }
      handle.exit.catch(() => {});
      return;
    }
    const subprocess = handle.subprocess;
    state.subprocess = subprocess;
    state.pid = subprocess.pid ?? null;
    // Bump the spawn generation so a delayed tree-kill scheduled by a prior
    // shutdownOne (for this same key) can detect that a newer process now owns
    // the key and skip the kill — guarding against Windows PID reuse (#9235).
    state.spawnGeneration++;
    // Execa's subprocess promise rejects with the kill error when the child
    // exits non-zero or is killed. Without a `.catch` attached at spawn time
    // it surfaces as an unhandled rejection, which Electron 37+ utility
    // processes (and increasingly the main process under strict modes) treat
    // as fatal. See #4372.
    handle.exit.catch(() => {});

    // Swallow async 'error' events on stdin (e.g. EPIPE after the child
    // crashed). The pending-call rejection paths handle the logical error;
    // letting the stream's own error event surface unhandled would crash
    // the utility process under Electron 37+'s strict rejection mode.
    subprocess.stdin?.on("error", () => {});

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
      // A shutdown that lands mid-handshake already set status to "stopped"
      // and rejected the pending init call. Don't clobber that with "crashed"
      // — the UI distinction between user-cancelled and crashed matters.
      if (state.status !== "stopped") {
        state.status = "crashed";
        state.lastError = formatErrorMessage(err, "MCP supervisor error");
      }
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
    const message = parsed as {
      id?: unknown;
      result?: unknown;
      error?: unknown;
      method?: unknown;
    };
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
      return;
    }
    // The server advertised that its tool set changed mid-session. The spec
    // marks this notification best-effort, so it's only a fast-path refresh —
    // crash/restart invalidation does NOT depend on it (#9235). Drop the cache
    // so the next enumeration refetches; leave any in-flight fetch to settle.
    if (message.method === "notifications/tools/list_changed") {
      state.toolsCache = null;
      state.surfacedToolCount = 0;
      // Supersede any in-flight fetch so its resolution can't re-cache the
      // pre-notification tool list (the `.then` identity guard then no-ops). The
      // next enumeration starts a fresh fetch.
      state.toolsListInflight = null;
      return;
    }
    // Other notifications (no id) are ignored — we don't subscribe to any.
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
    // Invalidate the tool cache on crash so a post-restart enumeration refetches
    // and the TOFU comparator re-runs against the consent store before any tool
    // is re-injected (#9235). An in-flight fetch's pending call is rejected by
    // the loop below; its `.finally()` clears `toolsListInflight` (the identity
    // guard there tolerates this eager null).
    state.toolsCache = null;
    state.toolsListInflight = null;
    state.surfacedToolCount = 0;
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
    return this.sendRequest(
      state,
      "tools/call",
      { name: input.tool, arguments: input.args ?? {} },
      TOOL_CALL_TIMEOUT_MS,
      () => plainError("TIMEOUT", `tools/call "${input.tool}" timed out`)
    );
  }

  /**
   * Send a JSON-RPC request frame and resolve with its `result`. Centralises
   * the request-id allocation, pending-call bookkeeping, timeout wiring, and
   * the synchronous-write-failure fast-reject shared by {@link callTool} and
   * {@link fetchToolsList}. Returns a rejected promise (never throws) so call
   * sites can uniformly `await`.
   */
  private sendRequest(
    state: SupervisedServerState,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    makeTimeoutError: () => Error
  ): Promise<unknown> {
    const stdin = state.subprocess?.stdin;
    if (!stdin) {
      return Promise.reject(plainError("NOT_READY", "subprocess has no stdin stream"));
    }
    const requestId = state.nextRequestId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pendingCalls.delete(requestId);
        reject(makeTimeoutError());
      }, timeoutMs);
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
    try {
      writeFrame(stdin, { jsonrpc: "2.0" as const, id: requestId, method, params });
    } catch (err) {
      // stdin may have ended between the status check and the write — e.g.
      // the child crashed in the same tick. Reject the pending call now
      // rather than waiting for the timeout.
      const pending = state.pendingCalls.get(requestId);
      if (pending) {
        state.pendingCalls.delete(requestId);
        pending.reject(plainError("WRITE_FAILED", formatErrorMessage(err, "stdin write failed")));
      }
    }
    return promise;
  }

  /**
   * Tier-1 enumeration (#9235). Lazily fetches and caches `tools/list`, then
   * returns name + truncated-description summaries (never input schemas) up to
   * the global per-session cap aggregated across every supervised server. The
   * caller (the `plugin-mcp:list-tools` IPC handler) is responsible for having
   * spawned the server first via {@link start} — `listTools` then awaits the
   * handshake so a first-call-after-lazy-spawn enumeration resolves correctly.
   *
   * `maxToolsPerSession` is supplied by the caller (read from the
   * `pluginMcpConfig` setting at the IPC boundary) so the supervisor stays free
   * of any electron-store dependency and unit-testable in isolation.
   */
  async listTools(
    pluginId: string,
    serverId: string,
    maxToolsPerSession: number = PLUGIN_MCP_DEFAULT_MAX_TOOLS_PER_SESSION
  ): Promise<PluginMcpListToolsResult> {
    const state = this.states.get(stateKey(pluginId, serverId));
    if (!state) {
      throw plainError("NOT_FOUND", `MCP server "${pluginId}/${serverId}" is not registered`);
    }
    const all = await this.fetchToolsList(state);
    const maxTools =
      Number.isFinite(maxToolsPerSession) && maxToolsPerSession > 0
        ? Math.floor(maxToolsPerSession)
        : PLUGIN_MCP_DEFAULT_MAX_TOOLS_PER_SESSION;
    const alreadySurfaced = this.surfacedToolsExcluding(state);
    const remaining = Math.max(0, maxTools - alreadySurfaced);
    const capped = all.slice(0, remaining);
    state.surfacedToolCount = capped.length;
    return {
      pluginId,
      serverId,
      tools: capped.map(
        (tool): PluginMcpToolSummary => ({
          name: tool.name,
          description: truncateToolDescription(tool.description),
        })
      ),
      truncated: capped.length < all.length,
      maxToolsPerSession: maxTools,
    };
  }

  /**
   * Tier-2 lookup (#9235). Returns the full cached tool definition (input
   * schema + annotations) for a single tool the agent has selected, fetching
   * `tools/list` first if the cache is cold. A discriminated union rather than
   * a throw so a stale tool name (e.g. requested after a crash refetch dropped
   * it) surfaces as `{ found: false }`.
   */
  async getFullSchema(
    pluginId: string,
    serverId: string,
    toolName: string
  ): Promise<PluginMcpGetFullSchemaResult> {
    const state = this.states.get(stateKey(pluginId, serverId));
    if (!state) {
      throw plainError("NOT_FOUND", `MCP server "${pluginId}/${serverId}" is not registered`);
    }
    const all = await this.fetchToolsList(state);
    const tool = all.find((t) => t.name === toolName);
    return tool ? { found: true, tool } : { found: false };
  }

  /**
   * Resolve the cached tool list, or fetch it once under a singleflight guard.
   * On success the result is cached on the state; on failure the cache stays
   * `null` (so a crashed-mid-fetch server never serves stale data after
   * restart) and the rejection propagates to every concurrent caller.
   */
  private fetchToolsList(state: SupervisedServerState): Promise<PluginMcpFullTool[]> {
    if (state.toolsCache) return Promise.resolve(state.toolsCache);
    if (state.toolsListInflight) return state.toolsListInflight;
    const promise = this.runToolsListFetch(state)
      .then((tools) => {
        // Identity guard: a crash/restart or a mid-fetch
        // `notifications/tools/list_changed` may have invalidated this fetch by
        // nulling/replacing the in-flight handle. Only cache if we still own it,
        // so a superseded fetch can't repopulate the cache with stale tools.
        if (state.toolsListInflight === promise) state.toolsCache = tools;
        return tools;
      })
      .finally(() => {
        if (state.toolsListInflight === promise) state.toolsListInflight = null;
      });
    state.toolsListInflight = promise;
    return promise;
  }

  /** Drive the `tools/list` cursor loop to completion, paging until exhausted. */
  private async runToolsListFetch(state: SupervisedServerState): Promise<PluginMcpFullTool[]> {
    // Await the in-flight spawn first — there's a window where a concurrent
    // lazy spawn has registered the state (`status: "spawning"`) but not yet
    // assigned `readyPromise`. Awaiting `inflightStart` closes that race so a
    // first-call-after-lazy-spawn enumeration doesn't see a transient status.
    if (state.inflightStart) await state.inflightStart;
    // Then await the handshake so the `initialize` round has completed. A
    // handshake failure rejects here.
    if (state.readyPromise) await state.readyPromise;
    if (state.status !== "ready") {
      throw plainError(
        "NOT_READY",
        `MCP server "${state.pluginId}/${state.serverId}" is ${state.status}, not ready`
      );
    }
    const tools: PluginMcpFullTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < TOOLS_LIST_MAX_PAGES; page++) {
      const params = cursor === undefined ? {} : { cursor };
      const result = await this.sendRequest(state, "tools/list", params, TOOL_CALL_TIMEOUT_MS, () =>
        plainError("TIMEOUT", `tools/list for "${state.pluginId}/${state.serverId}" timed out`)
      );
      const parsed = parseToolsListResult(result);
      tools.push(...parsed.tools);
      if (!parsed.nextCursor) return tools;
      cursor = parsed.nextCursor;
    }
    // Exhausted the page budget without a terminal page — a server paging
    // forever. Fail rather than loop unbounded.
    throw plainError(
      "TOOLS_LIST_PAGINATION",
      `tools/list for "${state.pluginId}/${state.serverId}" exceeded ${TOOLS_LIST_MAX_PAGES} pages`
    );
  }

  /** Tools already surfaced by every OTHER server — the consumed cap budget. */
  private surfacedToolsExcluding(exclude: SupervisedServerState): number {
    let total = 0;
    for (const state of this.states.values()) {
      if (state === exclude) continue;
      total += state.surfacedToolCount;
    }
    return total;
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
    // Cancel any pending settings-change respawn for this server first — once
    // it's being torn down, a debounced restart would resurrect a server the
    // host meant to drop (#10619, leak guard #9533).
    const pendingTimer = this.settingChangeTimers.get(key);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.settingChangeTimers.delete(key);
    }
    const state = this.states.get(key);
    if (!state) return;
    state.status = "stopped";
    // Drop the tool cache and release this server's slice of the global cap
    // budget so a stopped/unloaded server doesn't pin tools or budget (#9235).
    // Done before the `!subprocess` early-return so it always runs.
    state.toolsCache = null;
    state.toolsListInflight = null;
    state.surfacedToolCount = 0;
    const subprocess = state.subprocess;
    if (!subprocess) return;
    const pid = state.pid;
    const killGeneration = state.spawnGeneration;

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
      // shell out after the grace window — but skip it if a restart has since
      // registered a newer subprocess on this key, because Windows can reuse
      // the freed PID and the tree-kill would then take down the fresh server.
      setTimeout(() => {
        const current = this.states.get(key);
        if (current && current.spawnGeneration !== killGeneration) return;
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
   * Drop every supervised-server state entry owned by `pluginId` from the map.
   * Call this ONLY on a full uninstall, after {@link shutdown} — a plain
   * disable/reload must keep the entry so the log viewer retains pre-restart
   * stderr history. Without this, an uninstalled plugin's state (its bounded
   * stderr ring, contribution, lastError) leaks in `this.states` forever.
   */
  removeState(pluginId: string): void {
    for (const key of this.states.keys()) {
      if (key.startsWith(`${pluginId} `)) this.states.delete(key);
    }
  }

  /**
   * Force a restart of a single server. Used by `PluginService` when a
   * settings entry referenced by the manifest changes — the new value is
   * folded into the env at spawn time, so the existing subprocess has to
   * exit and respawn for the change to take effect.
   */
  async restart(input: {
    pluginId: string;
    pluginDir?: string;
    serverId: string;
    contribution: McpServerContribution;
    resolveSettings: (template: string) => Promise<string>;
  }): Promise<void> {
    await this.shutdownOne(stateKey(input.pluginId, input.serverId));
    await this.startOne(input.pluginId, input.pluginDir, input.contribution, input.resolveSettings);
  }

  /**
   * React to a `${settings:*}` value change for `pluginId` (#10619). Restarts
   * every supervised server that (a) is currently `ready` or `crashed` and (b)
   * embeds the changed `settingId` in its command/args/env — so a rotated secret
   * takes effect without the user manually restarting the server. Servers that
   * were never lazily started (no live state) are left alone, preserving the
   * lazy-spawn contract (#5782): a settings change never eagerly boots a server.
   *
   * Restarts are debounced per server ({@link SETTING_CHANGE_DEBOUNCE_MS}). The
   * actual restart is delegated to `restart` (supplied by `PluginService`) so
   * the supervisor never holds a `resolveSettings` closure across calls — the
   * same decoupling the `plugin-mcp:restart` IPC path relies on; the closure is
   * minted fresh at fire time against the then-current setting value.
   */
  notifySettingChanged(
    pluginId: string,
    settingId: string,
    restart: (serverId: string) => void | Promise<void>
  ): void {
    for (const [key, state] of this.states) {
      if (state.pluginId !== pluginId) continue;
      // Only act on servers with a settled process. A `spawning` server is
      // mid-handshake; its `resolveSettings` closure reads the store lazily, so
      // a change committed before `resolveContribution` runs is already picked
      // up by the in-flight start, and one committed slightly after is a narrow,
      // recoverable miss (the user re-saves or restarts manually). We don't
      // chase that window with a follow-up timer — it'd add real complexity for
      // a rare race. `stopped` servers stay stopped (lazy-spawn contract).
      if (state.status !== "ready" && state.status !== "crashed") continue;
      if (!contributionReferencesSetting(state.contribution, settingId)) continue;

      const existing = this.settingChangeTimers.get(key);
      if (existing) clearTimeout(existing);

      const serverId = state.serverId;
      const timer = setTimeout(() => {
        this.settingChangeTimers.delete(key);
        // Re-check at fire time: the server may have been shut down or unloaded
        // between scheduling and firing, or already replaced by another restart.
        const current = this.states.get(key);
        if (!current || (current.status !== "ready" && current.status !== "crashed")) return;
        void (async () => {
          try {
            await restart(serverId);
          } catch (err) {
            console.warn(
              `[PluginMcpSupervisor] Auto-restart after settings change failed for "${pluginId}/${serverId}":`,
              err
            );
          }
        })();
      }, SETTING_CHANGE_DEBOUNCE_MS);
      // Don't let a pending respawn timer keep the event loop (and the app)
      // alive on shutdown.
      timer.unref?.();
      this.settingChangeTimers.set(key, timer);
    }
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
  cwd: string | undefined,
  resolve: (template: string) => Promise<string>
): Promise<ResolvedMcpServerConfig> {
  const command = await substitute(contribution.command, resolve);
  const args = await Promise.all((contribution.args ?? []).map((arg) => substitute(arg, resolve)));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(contribution.env ?? {})) {
    env[key] = await substitute(value, resolve);
  }
  return { contribution, command, args, env, cwd };
}

/**
 * Whether a contribution embeds the literal `${settings:<settingId>}` token in
 * its command, any arg, or any env value (#10619). Uses an exact substring
 * match rather than the resolver regex so detection is independent of the id
 * grammar and pinpoints exactly the placeholder a change to `settingId` would
 * alter — driving {@link PluginMcpSupervisor.notifySettingChanged}'s restart
 * decision.
 */
function contributionReferencesSetting(
  contribution: McpServerContribution,
  settingId: string
): boolean {
  const token = `\${settings:${settingId}}`;
  if (contribution.command.includes(token)) return true;
  if (contribution.args?.some((arg) => arg.includes(token))) return true;
  if (contribution.env && Object.values(contribution.env).some((value) => value.includes(token))) {
    return true;
  }
  return false;
}

async function substitute(
  input: string,
  resolve: (template: string) => Promise<string>
): Promise<string> {
  if (!input.includes("${settings:")) return input;
  // Resolve each unique placeholder once, then do a single global pass per
  // key. `replace()` would only consume the first occurrence per call, and
  // if an earlier resolved value happened to itself contain a `${settings:*}`
  // literal the placeholder substitution would become order-dependent.
  const matches = [...input.matchAll(SETTINGS_TEMPLATE_RE)];
  const unique = new Map<string, string>();
  for (const match of matches) {
    const key = match[1]!;
    if (!unique.has(key)) unique.set(key, await resolve(key));
  }
  let out = input;
  for (const [key, value] of unique) {
    out = out.replaceAll(`\${settings:${key}}`, value);
  }
  return out;
}

function writeFrame(stdin: NodeJS.WritableStream, payload: unknown): void {
  // MCP stdio framing is NDJSON — one JSON-RPC 2.0 message per `\n`. Reject
  // synchronously if the stream has ended so the caller can surface a
  // structured error instead of waiting for the async 'error' emission.
  // The `writable` / `writableEnded` properties are defined on every Node
  // writable stream; the runtime cast keeps the helper signature minimal.
  const writable = stdin as NodeJS.WritableStream & {
    writable?: boolean;
    writableEnded?: boolean;
    destroyed?: boolean;
  };
  if (writable.writableEnded || writable.destroyed || writable.writable === false) {
    throw new Error("subprocess stdin is closed");
  }
  stdin.write(`${JSON.stringify(payload)}\n`);
}

function stateKey(pluginId: string, serverId: string): string {
  return `${pluginId} ${serverId}`;
}

/**
 * Truncate a tier-1 tool description to {@link PLUGIN_MCP_TOOL_DESCRIPTION_CAP}
 * code units, appending an ellipsis when clipped. `slice` is UTF-16-unit based
 * (V8 serialises a dangling surrogate safely), which is sufficient for the
 * context-budget guard this enforces (#9235).
 */
function truncateToolDescription(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  if (description.length <= PLUGIN_MCP_TOOL_DESCRIPTION_CAP) return description;
  return `${description.slice(0, PLUGIN_MCP_TOOL_DESCRIPTION_CAP)}…`;
}

/**
 * Parse one `tools/list` JSON-RPC result into typed tool entries plus the
 * optional pagination cursor. Tolerant of a misbehaving server: non-object
 * results and malformed entries (missing `name`) are skipped rather than
 * thrown, so a single bad entry can't abort the whole enumeration.
 */
function parseToolsListResult(result: unknown): {
  tools: PluginMcpFullTool[];
  nextCursor: string | undefined;
} {
  if (!result || typeof result !== "object") return { tools: [], nextCursor: undefined };
  const obj = result as { tools?: unknown; nextCursor?: unknown };
  const rawTools = Array.isArray(obj.tools) ? obj.tools : [];
  const tools: PluginMcpFullTool[] = [];
  for (const entry of rawTools) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as {
      name?: unknown;
      description?: unknown;
      inputSchema?: unknown;
      annotations?: unknown;
    };
    if (typeof e.name !== "string") continue;
    tools.push({
      name: e.name,
      description: typeof e.description === "string" ? e.description : undefined,
      inputSchema: e.inputSchema ?? {},
      annotations: e.annotations,
    });
  }
  const nextCursor =
    typeof obj.nextCursor === "string" && obj.nextCursor.length > 0 ? obj.nextCursor : undefined;
  return { tools, nextCursor };
}

function plainError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const defaultSpawner: SubprocessSpawner = async (config) => {
  const { execa } = await import("execa");
  const subprocess = execa(config.command, config.args, {
    cwd: config.cwd,
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
