import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serializedBytes } from "./ipcFixture";
import { createPerfTempRoot, releasePerfTempRoot } from "./tempRoots";

/**
 * A REAL plugin boundary for the plugin-host scenarios (PERF-220..225).
 *
 * Daintree runs plugins two ways, and both are exercised here.
 *
 *   1. USER-INSTALLED plugins run in a `utilityProcess.fork` child whose entry
 *      is `electron/plugin-dev-worker.ts` (dev and packaged prod share it —
 *      see `PLUGIN_DEV_WORKER_KIND` / `PLUGIN_PROD_WORKER_KIND`). That entry
 *      imports nothing from `electron`; the only Electron-supplied thing it
 *      needs is `process.parentPort`, so it runs unmodified under plain Node
 *      once something supplies that port. This fixture supplies it over a
 *      forked child's own IPC channel, exactly as `lib/ipcFixture.ts` does for
 *      the workspace and pty hosts.
 *   2. BUILT-IN plugins (the GitHub forge plugin among them) activate on the
 *      in-process `import()` loader inside `PluginService`. `PluginService`
 *      imports `electron` for `app`, and its collaborators reach for
 *      `clipboard`/`shell`/`webContents`, so the bare `electron` specifier is
 *      remapped to an inert stub via `module.registerHooks` — the same seam
 *      `lib/projectViewFixture.ts` uses. Everything else in that path is the
 *      product's own code, unmodified.
 *
 * What that buys, and what it does not:
 *
 *   - REAL: the plugin worker entry and `PluginDevWorkerHostProxy`; the whole
 *     of `PluginService` (directory scan, `getPluginManifestSchema` validation,
 *     the reserved-namespace and blocklist gates, contribution registration
 *     into the product's own panel-kind / toolbar / keybinding / context-menu /
 *     agent / forge-provider registries, `createHost`, `activatePlugin`,
 *     `activatePluginForForgeProvider`); `PluginCapabilityConsentService`,
 *     `PluginCapabilityConsentStore` and `resolveContainedPath`, i.e. the whole
 *     capability + consent + path-containment gate.
 *   - INDICATIVE: transit time. The channel is Node's fork IPC in
 *     `serialization: "advanced"` (V8 structured clone), the same family
 *     Electron's `MessagePortMain` uses but not the same pipe. Message and byte
 *     counts are deterministic; wall-clock transit is not authoritative.
 *   - ABSENT: the main-process half of the worker protocol.
 *     `PluginDevWorkerHost` (fork, watcher-debounced reload, respawn
 *     supervision) and `PluginDevWorkerMainBridge` (which forwards every
 *     `host-call` to the real `PluginHostApi`) are NOT in the loop. The parent
 *     side here is a counting stand-in that echoes. Nothing measured here is
 *     evidence about the supervisor or about main-side deep validation of a
 *     registration.
 *   - ABSENT: Electron and Chromium. `utilityProcess.fork` is inert, so
 *     `activateViaWorker` cannot run inside the `PluginService` child and every
 *     corpus plugin that activates is loaded as a BUILT-IN (the in-process
 *     loader), which is the real path for `plugins/builtin/github`. There is no
 *     renderer, so `broadcastToRenderer`, the consent DIALOG, panel views and
 *     the settings UI are all no-ops; the consent BRIDGE is supplied by this
 *     fixture, playing the renderer's part.
 *   - ABSENT: `PluginMcpSupervisor`, `PluginInstaller` and `PluginArchive`.
 *     They spawn external servers and download and verify archives; neither is
 *     hermetic and neither is measured.
 *
 * The corpus is generated into a temp directory. Nothing under `plugins/` or
 * `packages/` is read, written or activated.
 */

const CHILD_KIND_ENV = "DAINTREE_PERF_PLUGIN_CHILD";

const SELF_PATH = fileURLToPath(import.meta.url);

const PLUGIN_WORKER_ENTRY = fileURLToPath(
  new URL("../../../electron/plugin-dev-worker.ts", import.meta.url)
);

/** Bounded stderr tail per child, so a boot failure is diagnosable. */
const STDERR_TAIL_LIMIT = 1500;

// --- shared temp root -------------------------------------------------------

let sharedRoot: string | null = null;

function perfRoot(): string {
  if (!sharedRoot) {
    // Hooked here rather than only in the child constructor: the corpus and the
    // worker bundle can be generated without forking anything, and a temp tree
    // nothing reaps is still litter.
    installExitHook();
    // Registered with the shared owner as a backstop; `installExitHook` ran
    // first, so on a signal the children die before the sweep reaches this.
    sharedRoot = createPerfTempRoot("daintree-perf-plugin-");
  }
  return sharedRoot;
}

// --- child process bookkeeping ---------------------------------------------

const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

/**
 * Last-resort reaper, mirroring `ipcFixture`. Every scenario kills its own
 * child in a `finally`; this only fires for one stranded by a throw between
 * fork and try. A leaked plugin child is not a slow number — it holds an open
 * IPC channel and, in the service case, a hydrated electron-store — and it is
 * invisible to every in-process counter because it has its own runtime.
 */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;

  const killAll = (): void => {
    for (const child of liveChildren) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
    liveChildren.clear();
    // After the children: a service child holds a JSON store open in here.
    if (sharedRoot) {
      releasePerfTempRoot(sharedRoot);
      sharedRoot = null;
    }
  };

  process.on("exit", killAll);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      killAll();
      process.exit(1);
    });
  }
}

/**
 * Plugin children this process still has alive. The structural pairing for
 * every teardown number here: a fast dispose means nothing if the OS process is
 * still running.
 */
export function livePluginChildCount(): number {
  let alive = 0;
  for (const child of liveChildren) {
    if (child.exitCode === null && child.signalCode === null) alive += 1;
  }
  return alive;
}

export interface ChildMessage {
  type?: string;
  [key: string]: unknown;
}

interface ForkOptions {
  kind: "worker" | "service";
  extraEnv?: Record<string, string>;
}

/**
 * One forked plugin child plus the message and byte accounting for its channel.
 * Counters are cumulative over the child's whole life; take a {@link mark} and
 * diff to price one phase.
 */
class PluginChild {
  protected readonly child: ChildProcess;
  private readonly listeners = new Set<(message: ChildMessage) => void>();
  private stderrTail = "";
  private exited = false;
  private exitedAt = 0;
  private channelDead = false;
  private readonly channelDeadWaiters = new Set<() => void>();

  requestMessages = 0;
  responseMessages = 0;
  requestBytes = 0;
  responseBytes = 0;
  /** Messages the channel delivered that were not object-shaped. */
  malformedMessages = 0;

  constructor(options: ForkOptions) {
    installExitHook();
    const home = mkdtempSync(join(perfRoot(), "home-"));

    this.child = fork(SELF_PATH, [], {
      // The plugin worker entry and the whole PluginService graph are
      // TypeScript source here, not the built `dist-electron` output, and a
      // child does not reliably inherit tsx's loader registration.
      execArgv: ["--import", "tsx"],
      serialization: "advanced",
      // Plugin loading is chatty on stdout; a perf run's report must stay
      // readable. stderr is kept so a failed boot can say why.
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {
        ...process.env,
        [CHILD_KIND_ENV]: options.kind,
        // `PluginService.pluginDataDir` resolves under `os.homedir()`, and the
        // consent store persists through electron-store under userData. Both
        // are redirected into the temp tree so nothing here can reach the
        // user's real `~/.daintree`.
        HOME: home,
        USERPROFILE: home,
        DAINTREE_USER_DATA: join(home, "userdata"),
        DAINTREE_INSTANCE_ROLE: "worker",
        ...options.extraEnv,
      },
    });

    liveChildren.add(this.child);
    // Unref'd so a child that outlives its scenario despite the `finally` can
    // never hold the harness open.
    this.child.unref();
    this.child.channel?.unref();

    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });

    this.child.on("message", (raw: unknown) => {
      this.responseMessages += 1;
      this.responseBytes += serializedBytes(raw);
      if (typeof raw !== "object" || raw === null) {
        this.malformedMessages += 1;
        return;
      }
      const message = raw as ChildMessage;
      for (const listener of [...this.listeners]) listener(message);
    });

    // `exit` is the ONLY thing that marks a child gone, so
    // `livePluginChildCount()` reports processes rather than intentions.
    this.child.on("exit", () => {
      this.exited = true;
      this.channelDead = true;
      this.exitedAt = performance.now();
      liveChildren.delete(this.child);
      for (const settle of [...this.channelDeadWaiters]) settle();
    });
    this.child.on("error", () => {
      this.channelDead = true;
      for (const settle of [...this.channelDeadWaiters]) settle();
    });
  }

  get alive(): boolean {
    return !this.exited;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  get exitCode(): number | null {
    return this.child.exitCode;
  }

  send(message: unknown): void {
    this.requestMessages += 1;
    this.requestBytes += serializedBytes(message);
    try {
      // `send` is typed for the JSON serializer; the channel is in `advanced`
      // mode, where the structured-clone algorithm accepts more than
      // `Serializable` describes. Narrowed at the boundary rather than by
      // constraining every caller to a type the channel does not enforce.
      this.child.send(message as Parameters<ChildProcess["send"]>[0]);
    } catch {
      // Channel gone. Silent on purpose: the caller's paired `*Misses` reading
      // is what reports it, and throwing here would lose every other metric in
      // the iteration.
    }
  }

  onMessage(listener: (message: ChildMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  mark(): ChannelMark {
    return {
      requestMessages: this.requestMessages,
      responseMessages: this.responseMessages,
      requestBytes: this.requestBytes,
      responseBytes: this.responseBytes,
    };
  }

  since(mark: ChannelMark): ChannelMark {
    return {
      requestMessages: this.requestMessages - mark.requestMessages,
      responseMessages: this.responseMessages - mark.responseMessages,
      requestBytes: this.requestBytes - mark.requestBytes,
      responseBytes: this.responseBytes - mark.responseBytes,
    };
  }

  /**
   * Resolve on the first matching message, or `null` on timeout or on the child
   * dying first. Never rejects: a null is the caller's `*Misses` reading.
   */
  waitFor(
    predicate: (message: ChildMessage) => boolean,
    timeoutMs: number
  ): Promise<ChildMessage | null> {
    if (this.channelDead) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: ChildMessage | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        this.channelDeadWaiters.delete(onDead);
        resolve(value);
      };
      const onDead = (): void => finish(null);
      const unsubscribe = this.onMessage((message) => {
        if (predicate(message)) finish(message);
      });
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.channelDeadWaiters.add(onDead);
    });
  }

  /**
   * Ask the child to shut itself down and wait for the process to actually go.
   * Returns elapsed ms, or `null` when it did not exit on its own AND zero —
   * a SIGKILLed child "shuts down" instantly and a child that crashes out of
   * dispose also exits promptly, and a duration cannot tell either apart from
   * a graceful teardown.
   */
  async disposeGracefully(timeoutMs: number): Promise<number | null> {
    if (this.exited) return null;
    const started = performance.now();
    const gone = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    this.send({ type: "dispose" });
    if (!(await gone)) {
      this.kill();
      return null;
    }
    if (this.child.exitCode !== 0) return null;
    return this.exitedAt > 0 ? this.exitedAt - started : performance.now() - started;
  }

  /**
   * Signal the child. Deliberately does NOT drop it from the live set: only the
   * `exit` event does that.
   */
  kill(): void {
    try {
      this.child.kill("SIGKILL");
    } catch {
      // Already reaped.
    }
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

export interface ChannelMark {
  requestMessages: number;
  responseMessages: number;
  requestBytes: number;
  responseBytes: number;
}

// --- worker half (parent side) ---------------------------------------------

export interface RegistrationRecord {
  method: string;
  registrationKey: string | null;
}

/**
 * The real `electron/plugin-dev-worker.ts` in its own OS process, plus the
 * counting stand-in for the main-side bridge.
 *
 * Every `host-call` is answered with `{ echo: params }` so a nonce the plugin
 * sent comes back through the product's own correlation machinery. The real
 * `PluginDevWorkerMainBridge` would forward to the live `PluginHostApi`; that
 * half is out of frame (see the module doc), which is why this class counts
 * what crossed rather than claiming a host round trip.
 */
export class PluginWorker extends PluginChild {
  /** Every `host-notify` registration the plugin's `activate()` produced. */
  readonly registrations: RegistrationRecord[] = [];
  /** `host-call` messages answered by the stand-in bridge. */
  hostCalls = 0;

  constructor(extraEnv?: Record<string, string>) {
    super({ kind: "worker", extraEnv });

    this.onMessage((message) => {
      if (message.type === "host-notify") {
        this.registrations.push({
          method: typeof message.method === "string" ? message.method : "<none>",
          registrationKey:
            typeof message.registrationKey === "string" ? message.registrationKey : null,
        });
        return;
      }
      if (message.type === "host-call" && typeof message.requestId === "string") {
        this.hostCalls += 1;
        this.send({
          type: "host-result",
          requestId: message.requestId,
          ok: true,
          result: { echo: message.params },
        });
      }
    });
  }

  /** Wait for the worker's `ready`. Returns elapsed ms, or `null`. */
  async waitForReady(timeoutMs: number): Promise<number | null> {
    const started = performance.now();
    const ready = await this.waitFor((message) => message.type === "ready", timeoutMs);
    return ready ? performance.now() - started : null;
  }

  /**
   * Send `start` and wait for the worker to report `activated`. Returns the
   * elapsed ms and whether `activate()` returned a disposer — a plugin that
   * registered nothing and a plugin whose cleanup was dropped both look
   * identical without the second half.
   */
  async activate(
    bundlePath: string,
    pluginId: string,
    timeoutMs: number
  ): Promise<{ activateMs: number; hasCleanup: boolean } | null> {
    const started = performance.now();
    this.send({ type: "start", bundleUrl: pathToFileURL(bundlePath).href, pluginId });
    const done = await this.waitFor(
      (message) => message.type === "activated" || message.type === "activate-error",
      timeoutMs
    );
    if (!done || done.type !== "activated") return null;
    return { activateMs: performance.now() - started, hasCleanup: done.hasCleanup === true };
  }

  /**
   * Invoke a worker-held action handler and await its reply. Returns the result
   * payload, or `null` on timeout / a rejected invoke.
   */
  async invokeAction(
    requestId: string,
    namespacedId: string,
    args: unknown,
    timeoutMs: number
  ): Promise<unknown | null> {
    this.send({ type: "invoke", requestId, kind: "action", namespacedId, args });
    const reply = await this.waitFor(
      (message) => message.type === "invoke-result" && message.requestId === requestId,
      timeoutMs
    );
    if (!reply || reply.ok !== true) return null;
    return reply.result;
  }
}

export function spawnPluginWorker(extraEnv?: Record<string, string>): PluginWorker {
  return new PluginWorker(extraEnv);
}

// --- worker fixture plugin --------------------------------------------------

/** Actions the fixture plugin registers, beyond the two service actions. */
export const FIXTURE_ACTION_COUNT = 8;

/** Action id that echoes its args back — the invoke-direction nonce carrier. */
export const ECHO_ACTION = "echo";

/**
 * Action id that issues N `host.getWorktreeStatus(nonce)` calls and returns
 * what came back — the host-call-direction nonce carrier. `getWorktreeStatus`
 * is chosen because its proxy sends the caller's argument as the whole `params`
 * payload, so the nonce is the message rather than a field beside it.
 */
export const HOST_CALL_ACTION = "hostcalls";

/**
 * Provider id the fixture plugin's file-decoration registration claims.
 *
 * A third registration surface beside actions and IPC handlers, and the one a
 * proxy is most likely to drop quietly: nothing invokes it during these
 * scenarios, so only the registration key it forwards can show it happened.
 */
export const FIXTURE_DECORATION_PROVIDER_ID = "perf-decorations";

let workerBundlePath: string | null = null;

/**
 * The fixture plugin the worker activates. Written to the temp tree rather than
 * added to `plugins/` — the repo's plugin tree is not a benchmark fixture, and
 * the built-in GitHub plugin must stay untouched.
 */
export function workerFixtureBundle(): string {
  if (workerBundlePath) return workerBundlePath;
  const dir = join(perfRoot(), "worker-plugin");
  mkdirSync(dir, { recursive: true });
  workerBundlePath = join(dir, "index.mjs");
  writeFileSync(
    workerBundlePath,
    `const ACTIONS = ${FIXTURE_ACTION_COUNT};
export async function activate(host) {
  host.registerAction(
    { id: ${JSON.stringify(ECHO_ACTION)}, title: "Echo", description: "echo", category: "Perf", kind: "command", danger: "safe" },
    async (args) => args
  );
  host.registerAction(
    { id: ${JSON.stringify(HOST_CALL_ACTION)}, title: "Host calls", description: "host calls", category: "Perf", kind: "command", danger: "safe" },
    async (args) => {
      const out = [];
      for (let i = 0; i < args.rounds; i += 1) {
        out.push(await host.getWorktreeStatus(args.nonce + "-" + i));
      }
      return out;
    }
  );
  for (let i = 0; i < ACTIONS; i += 1) {
    host.registerAction(
      { id: "bulk" + i, title: "Bulk " + i, description: "bulk", category: "Perf", kind: "command", danger: "safe" },
      async () => i
    );
    host.registerHandler("bulk-channel-" + i, async () => i);
  }
  host.registerFileDecorationProvider(
    { id: ${JSON.stringify(FIXTURE_DECORATION_PROVIDER_ID)}, scopes: ["perf:*"] },
    { provideDecorations: async () => [] }
  );
  return () => {};
}
`,
    "utf8"
  );
  return workerBundlePath;
}

/**
 * Registration keys the fixture plugin's `activate()` must produce, in the
 * product's own `action:<pluginId>.<id>` / `handler:<channel>` /
 * `fileDecorationProvider:<id>` form.
 *
 * This is the independent oracle for activation: a plugin host that boots and
 * contributes nothing is instant, and instant is the best-looking result the
 * harness can record. Comparing what arrived against this set is what makes
 * "activated" mean something.
 *
 * Every registering call the bundle makes has to be named here — a set that
 * covers only two of the three surfaces grades only two of them, and the
 * uncovered forward is free to stop carrying anything. `pluginHost.test.ts`
 * reads the bundle source back and fails on a surface this set does not name.
 */
export function expectedRegistrationKeys(pluginId: string): Set<string> {
  const keys = new Set<string>([
    `action:${pluginId}.${ECHO_ACTION}`,
    `action:${pluginId}.${HOST_CALL_ACTION}`,
    `fileDecorationProvider:${FIXTURE_DECORATION_PROVIDER_ID}`,
  ]);
  for (let i = 0; i < FIXTURE_ACTION_COUNT; i += 1) {
    keys.add(`action:${pluginId}.bulk${i}`);
    keys.add(`handler:bulk-channel-${i}`);
  }
  return keys;
}

/**
 * Registration keys the fixture plugin owed that never crossed the boundary.
 *
 * The reading that makes `registrationCount` mean something. A worker whose
 * `host.registerAction` forwards nothing still boots, still reports `activated`,
 * still returns its disposer and still exits zero — faster than one that does
 * the work — so counting what arrived is not enough on its own.
 */
export function missingRegistrationCount(worker: PluginWorker, pluginId: string): number {
  const arrived = new Set(
    worker.registrations
      .filter((record) => record.registrationKey !== null)
      .map((record) => record.registrationKey as string)
  );
  return [...expectedRegistrationKeys(pluginId)].filter((key) => !arrived.has(key)).length;
}

/** A requestId whose body is a nonce, so an echo proves the payload survived. */
export function nonce(prefix: string): string {
  let body = "";
  while (body.length < 64) body += Math.random().toString(36).slice(2);
  return `${prefix}-${body.slice(0, 64)}`;
}

// --- manifest corpus --------------------------------------------------------

/** Valid plugins in the built-in root — the ones that can also activate. */
const CORPUS_BUILTIN = 20;
/** Valid plugins in the user root: loaded and registered, never activated. */
const CORPUS_USER = 4;

/** Panels (and matching views) each corpus plugin declares. */
const PANELS_PER_PLUGIN = 2;

/**
 * The plugin whose forge provider PERF-225 activates, and the remote its
 * `matches` claims. Taken from the built-in root because the GitHub forge
 * plugin is itself a built-in, so this is the production activation path for
 * that shape rather than a stand-in for one.
 */
export const FORGE_PLUGIN_ID = "perfco.plugin0";
export const FORGE_PROVIDER_ID = `${FORGE_PLUGIN_ID}.prov`;
export const FORGE_REMOTE_URL = "https://forge0.example.com/acme/widgets";

/**
 * The user-root plugin the consent ladder runs against. Deliberately NOT a
 * built-in: `ensureCapabilityConsent` resolves silently for first-party code,
 * so a built-in would never reach the prompt at all.
 */
export const CONSENT_PLUGIN_ID = "perfco.userplugin0";

export interface PluginCorpus {
  builtinRoot: string;
  userRoot: string;
  /** Directories containing a `plugin.json`, valid or not. */
  manifestDirCount: number;
  /** Manifests that must load. */
  validCount: number;
  /** Manifests that must be REJECTED — 4 schema violations plus one reserved namespace. */
  invalidCount: number;
  /** Contribution totals the loaded manifests declare, per registry. */
  expected: {
    panelKinds: number;
    toolbarButtons: number;
    keybindings: number;
    contextMenus: number;
    agents: number;
    forgeDescriptors: number;
  };
}

let corpus: PluginCorpus | null = null;

function writeCorpusPlugin(root: string, id: string, index: number, withForge: boolean): void {
  const dir = join(root, id);
  mkdirSync(join(dir, "main"), { recursive: true });
  mkdirSync(join(dir, "view"), { recursive: true });

  const panels: Array<Record<string, unknown>> = [];
  const views: Array<Record<string, unknown>> = [];
  for (let p = 0; p < PANELS_PER_PLUGIN; p += 1) {
    panels.push({
      id: `panel${p}`,
      name: `Panel ${p}`,
      iconId: "layout-panel-top",
      color: "#6366f1",
      hasPty: false,
      showInPalette: true,
    });
    views.push({ id: `panel${p}`, componentPath: `./view/panel${p}.js`, location: "panel" });
    writeFileSync(
      join(dir, "view", `panel${p}.js`),
      "export default function V() { return null; }\n",
      "utf8"
    );
  }

  const manifest = {
    name: id,
    version: "1.0.0",
    displayName: `Perf Plugin ${index}`,
    description: "Generated perf corpus plugin.",
    main: "main/index.js",
    engines: { daintree: ">=0.11.0" },
    capabilities: ["agent:register", "fs:user-data-read", "fs:user-data-write"],
    contributes: {
      panels,
      views,
      toolbarButtons: [
        { id: "go", label: "Go", iconId: "sparkles", actionId: `${id}.go`, priority: 5 },
      ],
      keybindings: [
        {
          actionId: `${id}.go`,
          combo: "CmdOrCtrl+Shift+G",
          scope: "global",
          description: "Perf corpus keybinding",
        },
      ],
      contextMenus: [{ actionId: `${id}.go`, location: "worktree", label: "Perf corpus item" }],
      agents: [
        {
          id: `perfagent${index}`,
          name: `Perf Agent ${index}`,
          command: "echo",
          color: "#6366f1",
          iconId: "bot",
        },
      ],
      fileDecorationProviders: [{ id: "perfdec", scopes: [`perf${index}:*`] }],
      forgeProviders: withForge
        ? [
            {
              id: "prov",
              name: `Perf Forge ${index}`,
              matches: [`forge${index}.example.com`],
              capabilities: ["issues", "pulls"],
            },
          ]
        : [],
      settings: [
        { id: "greeting", type: "string", label: "Greeting", default: "hello" },
        { id: "retries", type: "number", label: "Retries", default: 3, min: 0, max: 10 },
        { id: "verbose", type: "boolean", label: "Verbose", default: false },
      ],
    },
  };

  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  // A forge provider's impl binds during `activate()`, never from the manifest
  // — the descriptor/impl split PERF-225 exists to measure.
  const registerForge = withForge
    ? `  host.registerForgeProvider(
    { id: "prov", name: "Perf Forge" },
    {
      parseRemote: () => null,
      buildRepoUrl: () => "",
      buildIssueUrl: () => "",
      buildPullUrl: () => "",
      classifyPushError: () => "unknown",
    }
  );
`
    : "";
  writeFileSync(
    join(dir, "main", "index.js"),
    `export async function activate(host) {\n${registerForge}  return () => {};\n}\n`,
    "utf8"
  );
}

/**
 * Generate the manifest corpus once per process and reuse it. The content is
 * read-only input, so regenerating it per iteration would only price `writeFile`.
 *
 * Four rejects are schema violations and the fifth claims the reserved
 * `daintree.*` namespace from the USER root, where only first-party code may
 * use it. Both directions matter: a validator that accepts everything is fast
 * and wrong, and one that rejects everything is faster still.
 */
export function pluginCorpus(): PluginCorpus {
  if (corpus) return corpus;

  const builtinRoot = join(perfRoot(), "corpus-builtin");
  const userRoot = join(perfRoot(), "corpus-user");
  mkdirSync(builtinRoot, { recursive: true });
  mkdirSync(userRoot, { recursive: true });

  for (let i = 0; i < CORPUS_BUILTIN; i += 1) {
    writeCorpusPlugin(builtinRoot, `perfco.plugin${i}`, i, true);
  }
  for (let i = 0; i < CORPUS_USER; i += 1) {
    writeCorpusPlugin(userRoot, `perfco.userplugin${i}`, 1000 + i, false);
  }

  const rejects: Array<{ dir: string; body: Record<string, unknown> }> = [
    { dir: "perfbad.noname", body: { version: "1.0.0" } },
    { dir: "perfbad.badversion", body: { name: "perfbad.badversion", version: "not-semver" } },
    {
      dir: "perfbad.badcapability",
      body: { name: "perfbad.badcapability", version: "1.0.0", capabilities: ["nope:invalid"] },
    },
    {
      dir: "perfbad.unknownkey",
      body: { name: "perfbad.unknownkey", version: "1.0.0", notAManifestField: true },
    },
    { dir: "daintree.perfreserved", body: { name: "daintree.perfreserved", version: "1.0.0" } },
  ];
  for (const reject of rejects) {
    const dir = join(userRoot, reject.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(reject.body), "utf8");
  }

  const valid = CORPUS_BUILTIN + CORPUS_USER;
  corpus = {
    builtinRoot,
    userRoot,
    manifestDirCount: valid + rejects.length,
    validCount: valid,
    invalidCount: rejects.length,
    expected: {
      panelKinds: valid * PANELS_PER_PLUGIN,
      toolbarButtons: valid,
      keybindings: valid,
      contextMenus: valid,
      agents: valid,
      forgeDescriptors: CORPUS_BUILTIN,
    },
  };
  return corpus;
}

// --- PluginService child (parent side) --------------------------------------

export interface ServiceInitResult {
  /** Cost of loading the whole `PluginService` module graph in a cold realm. */
  moduleLoadMs: number;
  /** `PluginService.initialize()` — scan, validate, register, reconcile. */
  initializeMs: number;
  pluginLoadCount: number;
  loadedIds: string[];
  /** Read back out of the product's own registries, not out of the scan. */
  panelKindCount: number;
  toolbarButtonCount: number;
  keybindingCount: number;
  contextMenuCount: number;
  agentCount: number;
  forgeDescriptorCount: number;
  /** Bytes of `plugin.json` the scan read off disk. */
  manifestBytes: number;
  /** Forge impls bound before anything activated. Must be zero. */
  forgeImplCountBeforeActivate: number;
}

export interface ForgeActivationResult {
  activateMs: number;
  forgeImplCountBefore: number;
  forgeImplCountAfter: number;
  implBound: boolean;
  /** Providers the registry routes to for {@link FORGE_REMOTE_URL}. */
  matchCount: number;
  descriptorCount: number;
}

export type DenialKind = "none" | "capability" | "containment" | "consent" | "other";

export interface GateProbeOutcome {
  label: string;
  allowed: boolean;
  denialKind: DenialKind;
  /** Payload the host returned when it allowed the call, for a content check. */
  value: string | null;
}

export interface GateResult {
  /** Wall clock for the whole repeated static battery. */
  batteryMs: number;
  rounds: number;
  decisionCount: number;
  /** One round of the static capability / containment battery. */
  staticOutcomes: GateProbeOutcome[];
  /** The four-step JIT consent ladder, run once. */
  consentOutcomes: GateProbeOutcome[];
}

/**
 * A forked child running the REAL `PluginService` under an inert `electron`.
 * One child per iteration: the contribution registries are module-global
 * singletons, so a second `initialize()` in the same realm would measure a warm
 * registry and collide on every id.
 */
export class PluginServiceHost extends PluginChild {
  private nextRequest = 1;

  constructor() {
    super({ kind: "service" });
  }

  private async command<T>(payload: Record<string, unknown>, timeoutMs: number): Promise<T | null> {
    const requestId = `req-${this.nextRequest++}`;
    this.send({ ...payload, requestId });
    const reply = await this.waitFor(
      (message) => message.requestId === requestId && message.type === `${payload.type}-result`,
      timeoutMs
    );
    if (!reply || reply.ok !== true) return null;
    return reply.result as T;
  }

  init(target: PluginCorpus, timeoutMs: number): Promise<ServiceInitResult | null> {
    return this.command<ServiceInitResult>(
      { type: "init", builtinRoot: target.builtinRoot, userRoot: target.userRoot },
      timeoutMs
    );
  }

  activateForge(namespacedId: string, timeoutMs: number): Promise<ForgeActivationResult | null> {
    return this.command<ForgeActivationResult>(
      { type: "activate-forge", namespacedId, remoteUrl: FORGE_REMOTE_URL },
      timeoutMs
    );
  }

  runGateBattery(rounds: number, sentinel: string, timeoutMs: number): Promise<GateResult | null> {
    return this.command<GateResult>({ type: "gate", rounds, sentinel }, timeoutMs);
  }
}

export function spawnPluginServiceHost(): PluginServiceHost {
  return new PluginServiceHost();
}

/**
 * What each static gate probe must do. The oracle lives HERE, in the parent,
 * rather than in the child that produced the answers — a child that decided for
 * itself whether it was right would be grading its own homework.
 *
 * Both directions are represented on purpose. A gate that fails open is fast
 * and wrong; a gate that denies everything is faster and just as wrong, and
 * only the allow rows can tell them apart.
 */
export const EXPECTED_STATIC_GATE: ReadonlyArray<{
  label: string;
  allowed: boolean;
  denialKind: DenialKind;
}> = [
  {
    label: "fs.readFile in data dir (fs:user-data-read declared)",
    allowed: true,
    denialKind: "none",
  },
  { label: "fs.readFile outside every allowed root", allowed: false, denialKind: "containment" },
  { label: "fs.readFile traversal out of the data dir", allowed: false, denialKind: "containment" },
  { label: "git.status (git:read not declared)", allowed: false, denialKind: "capability" },
  { label: "git.commit (git:write not declared)", allowed: false, denialKind: "capability" },
  { label: "process.spawn (shell:exec not declared)", allowed: false, denialKind: "capability" },
  { label: "getAgentState (agent:read not declared)", allowed: false, denialKind: "capability" },
  {
    label: "sendToActiveAgent (agent:input not declared)",
    allowed: false,
    denialKind: "capability",
  },
  {
    label: "clipboard.readText (clipboard:read not declared)",
    allowed: false,
    denialKind: "capability",
  },
];

/**
 * The JIT consent ladder, in order. `fs:user-data-write` IS declared in the
 * manifest throughout, so every row below is decided by consent alone — which
 * is what separates "may this plugin ever do X" from "has the user agreed to it
 * doing X now".
 */
export const EXPECTED_CONSENT_LADDER: ReadonlyArray<{
  label: string;
  allowed: boolean;
  denialKind: DenialKind;
}> = [
  { label: "fs.writeFile with no consent bridge installed", allowed: false, denialKind: "consent" },
  {
    label: "fs.writeFile with the bridge answering rejected",
    allowed: false,
    denialKind: "consent",
  },
  {
    label: "fs.writeFile with the bridge answering approved-and-pin",
    allowed: true,
    denialKind: "none",
  },
  {
    label: "fs.writeFile after the bridge is removed (grant persisted)",
    allowed: true,
    denialKind: "none",
  },
];

// --- child: inert electron --------------------------------------------------

/**
 * Remap the bare `electron` specifier so the main-process plugin graph loads
 * outside Electron. Only that specifier is touched, and only inside the forked
 * child — the parent never imports product main code.
 *
 * `module.registerHooks` (synchronous, in-thread) is preferred on supported
 * runtimes; `module.register` remains a defensive fallback for older Node 22
 * installations. Same seam, same reasoning, as
 * `lib/projectViewFixture.ts`.
 */
const ELECTRON_STUB_SOURCE = `
const bridge = globalThis.__daintreePerfPluginElectron;
export const app = bridge.app;
export const ipcMain = bridge.ipcMain;
export const shell = bridge.shell;
export const clipboard = bridge.clipboard;
export const dialog = bridge.dialog;
export const session = bridge.session;
export const webContents = bridge.webContents;
export const BrowserWindow = bridge.BrowserWindow;
export const WebContentsView = bridge.WebContentsView;
export const Menu = bridge.Menu;
export const MenuItem = bridge.MenuItem;
export const Tray = bridge.Tray;
export const Notification = bridge.Notification;
export const protocol = bridge.protocol;
export const net = bridge.net;
export const nativeTheme = bridge.nativeTheme;
export const nativeImage = bridge.nativeImage;
export const powerMonitor = bridge.powerMonitor;
export const screen = bridge.screen;
export const utilityProcess = bridge.utilityProcess;
export const MessageChannelMain = bridge.MessageChannelMain;
export const systemPreferences = bridge.systemPreferences;
export const safeStorage = bridge.safeStorage;
export const globalShortcut = bridge.globalShortcut;
export const crashReporter = bridge.crashReporter;
export const contextBridge = bridge.contextBridge;
export const desktopCapturer = bridge.desktopCapturer;
export const inAppPurchase = bridge.inAppPurchase;
export default bridge;
`;

const ELECTRON_STUB_URL = `data:text/javascript,${encodeURIComponent(ELECTRON_STUB_SOURCE)}`;

function installElectronStub(): void {
  const noop = (): void => {};
  // Anything the graph reaches for that is not listed below answers with an
  // inert chainable. It is inert on purpose and it is why every headline in the
  // service scenarios is a count or a structural cardinality: nothing Chromium
  // owns can be measured through a stub.
  const chain = (): unknown =>
    new Proxy(noop, { get: () => chain(), apply: () => chain(), construct: () => ({}) });

  const bridge = new Proxy(
    {
      app: {
        getPath: () => process.env.DAINTREE_USER_DATA ?? tmpdir(),
        getAppPath: () => perfRoot(),
        getVersion: () => "99.0.0",
        on: noop,
        once: noop,
        whenReady: () => Promise.resolve(),
        isPackaged: false,
      },
      ipcMain: { handle: noop, on: noop, removeHandler: noop, removeAllListeners: noop },
      webContents: { getAllWebContents: () => [] },
      BrowserWindow: class {
        static getAllWindows(): unknown[] {
          return [];
        }
      },
      shell: { openPath: async () => "", showItemInFolder: noop },
      clipboard: { writeText: noop, readText: () => "" },
      safeStorage: { isEncryptionAvailable: () => false },
    } as Record<string, unknown>,
    { get: (target, prop) => (prop in target ? target[prop as string] : chain()) }
  );

  (globalThis as Record<string, unknown>).__daintreePerfPluginElectron = bridge;

  const registerHooks = (
    nodeModule as unknown as {
      registerHooks?: (hooks: {
        resolve: (
          specifier: string,
          context: unknown,
          next: (s: string, c: unknown) => unknown
        ) => unknown;
      }) => void;
    }
  ).registerHooks;

  if (typeof registerHooks === "function") {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "electron") return { url: ELECTRON_STUB_URL, shortCircuit: true };
        return nextResolve(specifier, context);
      },
    });
    return;
  }

  nodeModule.register(
    `data:text/javascript,${encodeURIComponent(
      `const U=${JSON.stringify(ELECTRON_STUB_URL)};` +
        `export async function resolve(s,c,n){if(s==="electron")return{url:U,shortCircuit:true};return n(s,c);}`
    )}`
  );
}

// --- child: PluginService driver -------------------------------------------

function repoModuleUrl(relativePath: string): string {
  return new URL(`../../../${relativePath}`, import.meta.url).href;
}

/** Bytes of `plugin.json` under a root. A deterministic input size. */
function manifestBytesUnder(root: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    try {
      total += statSync(join(root, entry, "plugin.json")).size;
    } catch {
      // Not a plugin dir.
    }
  }
  return total;
}

/**
 * Which gate rejected the call. The host speaks two prefixes and three reasons,
 * and telling them apart is what catches a gate that still denies but has
 * stopped denying for the right reason — arity drift in a host closure denies
 * with a TypeError and would otherwise read as a clean pass.
 */
function classifyDenial(error: unknown): DenialKind {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("PATH_NOT_ALLOWED")) return "containment";
  if (!message.includes("PERMISSION_REQUIRED")) return "other";
  return message.includes("requires") ? "capability" : "consent";
}

async function probe(label: string, call: () => Promise<unknown>): Promise<GateProbeOutcome> {
  try {
    const value = await call();
    return {
      label,
      allowed: true,
      denialKind: "none",
      value: typeof value === "string" ? value : null,
    };
  } catch (err) {
    return { label, allowed: false, denialKind: classifyDenial(err), value: null };
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type LooseModule = Record<string, any>;

function runServiceChild(): void {
  installElectronStub();

  let svc: any = null;
  let forgeRegistry: LooseModule | null = null;
  const home = process.env.HOME ?? tmpdir();

  const reply = (type: string, requestId: unknown, result: unknown): void => {
    process.send?.({ type: `${type}-result`, requestId, ok: true, result });
  };
  const failed = (type: string, requestId: unknown, error: unknown): void => {
    process.send?.({
      type: `${type}-result`,
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  };

  const handleInit = async (message: ChildMessage): Promise<unknown> => {
    const moduleStart = performance.now();
    const [service, panelKinds, toolbar, agents, forge, keybindings, contextMenus] =
      await Promise.all([
        import(repoModuleUrl("electron/services/PluginService.ts")) as Promise<LooseModule>,
        import(repoModuleUrl("shared/config/panelKindRegistry.ts")) as Promise<LooseModule>,
        import(repoModuleUrl("shared/config/toolbarButtonRegistry.ts")) as Promise<LooseModule>,
        import(repoModuleUrl("shared/config/pluginAgentRegistry.ts")) as Promise<LooseModule>,
        import(repoModuleUrl("electron/services/forgeProviderRegistry.ts")) as Promise<LooseModule>,
        import(
          repoModuleUrl("electron/services/pluginKeybindingRegistry.ts")
        ) as Promise<LooseModule>,
        import(
          repoModuleUrl("electron/services/pluginContextMenuRegistry.ts")
        ) as Promise<LooseModule>,
      ]);
    const moduleLoadMs = performance.now() - moduleStart;
    forgeRegistry = forge;

    const builtinRoot = String(message.builtinRoot);
    const userRoot = String(message.userRoot);

    svc = new service.PluginService(userRoot, "99.0.0", {
      builtinPluginsRoot: builtinRoot,
      globalConfigDir: join(home, "plugin-config"),
      // Injected so the scan never awaits the real kill-switch fetch. A
      // benchmark that reaches the network is not a benchmark.
      blocklistService: { getBlocklist: async () => null },
    });

    const initStart = performance.now();
    await svc.initialize();
    const initializeMs = performance.now() - initStart;

    return {
      moduleLoadMs,
      initializeMs,
      pluginLoadCount: svc.listPlugins().length,
      loadedIds: svc.listPlugins().map((p: { manifest: { name: string } }) => p.manifest.name),
      panelKindCount: panelKinds.getPluginPanelKinds().length,
      toolbarButtonCount: toolbar.getAllPluginToolbarButtonConfigs().length,
      keybindingCount: keybindings.getPluginKeybindings().length,
      contextMenuCount: contextMenus.getPluginContextMenuItems().length,
      agentCount: Object.keys(agents.getPluginAgentRegistrySnapshot()).length,
      forgeDescriptorCount: forge.getRegisteredForgeProviders().length,
      manifestBytes: manifestBytesUnder(builtinRoot) + manifestBytesUnder(userRoot),
      forgeImplCountBeforeActivate: forge.getForgeProviderImplEntries().length,
    } satisfies ServiceInitResult;
  };

  const handleActivateForge = async (message: ChildMessage): Promise<unknown> => {
    if (!svc || !forgeRegistry) throw new Error("service child not initialized");
    const namespacedId = String(message.namespacedId);
    const forgeImplCountBefore = forgeRegistry.getForgeProviderImplEntries().length;
    const started = performance.now();
    await svc.activatePluginForForgeProvider(namespacedId);
    const activateMs = performance.now() - started;
    return {
      activateMs,
      forgeImplCountBefore,
      forgeImplCountAfter: forgeRegistry.getForgeProviderImplEntries().length,
      implBound: forgeRegistry.getForgeProviderImpl(namespacedId) !== undefined,
      matchCount: forgeRegistry.listMatchingProviders(String(message.remoteUrl)).length,
      descriptorCount: forgeRegistry.getRegisteredForgeProviders().length,
    } satisfies ForgeActivationResult;
  };

  const handleGate = async (message: ChildMessage): Promise<unknown> => {
    if (!svc) throw new Error("service child not initialized");
    const rounds = Math.max(1, Number(message.rounds));
    const sentinel = String(message.sentinel);

    const host = svc._createHostForTests(CONSENT_PLUGIN_ID);
    const dataDir = join(home, ".daintree", "plugin-data", CONSENT_PLUGIN_ID);
    mkdirSync(dataDir, { recursive: true });
    const readable = join(dataDir, "allowed.txt");
    writeFileSync(readable, sentinel, "utf8");
    const outside = join(home, "outside-every-root.txt");
    writeFileSync(outside, sentinel, "utf8");
    const traversal = join(dataDir, "..", "..", "..", "outside-every-root.txt");

    const battery: Array<[string, () => Promise<unknown>]> = [
      [EXPECTED_STATIC_GATE[0]!.label, () => host.fs.readFile(readable)],
      [EXPECTED_STATIC_GATE[1]!.label, () => host.fs.readFile(outside)],
      [EXPECTED_STATIC_GATE[2]!.label, () => host.fs.readFile(traversal)],
      [EXPECTED_STATIC_GATE[3]!.label, () => host.git.status(home)],
      [EXPECTED_STATIC_GATE[4]!.label, () => host.git.commit(home, { message: "perf" })],
      [EXPECTED_STATIC_GATE[5]!.label, () => host.process.spawn("echo")],
      [EXPECTED_STATIC_GATE[6]!.label, () => host.getAgentState()],
      [EXPECTED_STATIC_GATE[7]!.label, () => host.sendToActiveAgent("perf")],
      [EXPECTED_STATIC_GATE[8]!.label, () => host.clipboard.readText()],
    ];

    let staticOutcomes: GateProbeOutcome[] = [];
    const started = performance.now();
    for (let round = 0; round < rounds; round += 1) {
      staticOutcomes = [];
      for (const [label, call] of battery) staticOutcomes.push(await probe(label, call));
    }
    const batteryMs = performance.now() - started;

    const consent = (await import(
      repoModuleUrl("electron/services/plugin-capability/instances.ts")
    )) as LooseModule;
    const consentService = consent.getPluginCapabilityConsentService();
    const target = join(dataDir, "consent.txt");
    const consentOutcomes: GateProbeOutcome[] = [];

    // No bridge: the prompt cannot be presented, so the call fails closed.
    consentService.setConsentBridge(null);
    consentOutcomes.push(
      await probe(EXPECTED_CONSENT_LADDER[0]!.label, () => host.fs.writeFile(target, sentinel))
    );

    consentService.setConsentBridge(async () => "rejected");
    consentOutcomes.push(
      await probe(EXPECTED_CONSENT_LADDER[1]!.label, () => host.fs.writeFile(target, sentinel))
    );

    // Approved and pinned: the write must actually land, so the outcome carries
    // the bytes read back off disk rather than a bare "it resolved".
    consentService.setConsentBridge(async () => "approved-and-pin");
    consentOutcomes.push(
      await probe(EXPECTED_CONSENT_LADDER[2]!.label, async () => {
        await host.fs.writeFile(target, sentinel);
        const fsp = await import("node:fs/promises");
        return fsp.readFile(target, "utf8");
      })
    );

    // Bridge gone; the persisted grant is the only thing that can let this
    // through, which is what makes it a read of the store rather than of the
    // bridge.
    consentService.setConsentBridge(null);
    consentOutcomes.push(
      await probe(EXPECTED_CONSENT_LADDER[3]!.label, async () => {
        await host.fs.writeFile(target, `${sentinel}-again`);
        const fsp = await import("node:fs/promises");
        return fsp.readFile(target, "utf8");
      })
    );

    return {
      batteryMs,
      rounds,
      decisionCount: rounds * battery.length + consentOutcomes.length,
      staticOutcomes,
      consentOutcomes,
    } satisfies GateResult;
  };

  process.on("message", (raw: unknown) => {
    const message = raw as ChildMessage;
    const type = String(message.type);
    if (type === "dispose") {
      try {
        svc?.dispose();
      } catch {
        // A dispose that throws must still exit zero-or-not on its own merits;
        // the parent reads the exit code.
      }
      setImmediate(() => process.exit(0));
      return;
    }
    const handler =
      type === "init"
        ? handleInit
        : type === "activate-forge"
          ? handleActivateForge
          : type === "gate"
            ? handleGate
            : null;
    if (!handler) return;
    handler(message).then(
      (result) => reply(type, message.requestId, result),
      (err) => failed(type, message.requestId, err)
    );
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// --- child: plugin worker ---------------------------------------------------

/**
 * Stand in for Electron's `process.parentPort`.
 *
 * `plugin-dev-worker.ts` uses `on("message")` and `postMessage`, and unwraps a
 * MessageEvent-shaped `{ data }` — reproduced rather than passed bare, so a
 * message carrying its own top-level `data` field cannot be mis-unwrapped.
 * `ports` is always empty: a forked child's IPC channel cannot transfer a
 * MessagePort, which is why nothing here reaches a renderer.
 */
function installParentPortAdapter(): void {
  const inbox = new EventEmitter();
  inbox.setMaxListeners(0);
  process.on("message", (message) => inbox.emit("message", { data: message, ports: [] }));

  (process as unknown as { parentPort: unknown }).parentPort = {
    on: (event: string, listener: (...args: unknown[]) => void) => inbox.on(event, listener),
    once: (event: string, listener: (...args: unknown[]) => void) => inbox.once(event, listener),
    off: (event: string, listener: (...args: unknown[]) => void) => inbox.off(event, listener),
    addListener: (event: string, listener: (...args: unknown[]) => void) =>
      inbox.on(event, listener),
    removeListener: (event: string, listener: (...args: unknown[]) => void) =>
      inbox.off(event, listener),
    postMessage: (message: unknown) => {
      process.send?.(message);
    },
    start: () => {},
    close: () => {},
  };
}

// --- child entry ------------------------------------------------------------

const childKind = process.env[CHILD_KIND_ENV];
if (childKind === "worker") {
  installParentPortAdapter();
  // `pathToFileURL` rather than a bare path: an absolute Windows path is not a
  // valid ESM specifier.
  void import(pathToFileURL(PLUGIN_WORKER_ENTRY).href);
} else if (childKind === "service") {
  runServiceChild();
}
