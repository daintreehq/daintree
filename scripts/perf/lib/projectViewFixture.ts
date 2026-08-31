import { EventEmitter } from "node:events";
import nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectViewManager as ProjectViewManagerType } from "../../../electron/window/ProjectViewManager";
import type { ViewEntry } from "../../../electron/window/ProjectViewManagerTypes";
import { createPerfTempRoot } from "./tempRoots";

/**
 * Harness for the REAL per-project view machinery (PERF-074..077).
 *
 * What is real: `ProjectViewManager`, `ProjectViewSwitchController`,
 * `ProjectViewEvictionController`, `ProjectViewLifecycleController`,
 * `ProjectViewFactory`, `ProjectViewPaintGateController`, the agent-state
 * cache and `webContentsRegistry` — imported unmodified and driven through
 * their public entry points. Every decision the scenarios measure (which view
 * is created, which is reactivated warm, which is evicted and in what order,
 * how many a pressure pass may take, which are protected) is made by that
 * code, not here.
 *
 * What is NOT real, and cannot be in a plain Node process: Chromium.
 * `WebContentsView`, `BrowserWindow` and the `electron` module are replaced by
 * inert stand-ins at the module boundary so the product graph loads. So there
 * is no renderer process, no navigation, no paint, no GPU and no
 * `app.getAppMetrics()` footprint, and every headline here is a COUNT or a
 * structural cardinality — a duration across this seam would be measuring
 * `setImmediate`, not a switch.
 *
 * Read the limits precisely, because they bound what these numbers can say:
 *
 * - The stand-in renderer decides that every load SUCCEEDS. It commits, it
 *   answers the bootstrap probe healthy, it emits the skeleton signal, it
 *   replies to the warm-activate send. Failure modes on the renderer's side
 *   of the boundary — a 404 document, a dead preload, a wake fan-out that
 *   never paints — are not exercised.
 * - The fixture reads `CHANNELS` from the same module the product does, so a
 *   channel RENAME is invisible here. What it does catch is the product
 *   subscribing on a channel it never sends on, arming its gate too late to
 *   receive a one-shot signal, or threading the wrong project id into a view.
 * - "Memory release" is structural only: whether the product closed the
 *   WebContents and detached its listeners. Actual RSS reclaim is unobservable
 *   without a renderer process.
 * - Wall-clock cost recorded by the runner is harness time (fixture setup plus
 *   the cold prefill), NOT switch latency. Read the counts.
 *
 * What the stand-ins never decide is policy: which view is created, kept,
 * ordered, protected or destroyed is entirely the product's call.
 */

// --- Environment isolation ---------------------------------------------------
// Must run before any product module is imported: the logger resolves its file
// destination from DAINTREE_USER_DATA at module eval. Product modules are
// therefore loaded lazily through loadProjectViewModules() below.

let envReady = false;

function ensurePerfEnv(): void {
  if (envReady) return;
  process.env.DAINTREE_USER_DATA ??= createPerfTempRoot("daintree-perf-viewdata-");
  envReady = true;
}

// --- electron module stand-in ------------------------------------------------

/**
 * Reads everything from a global set before the first product import, so the
 * classes below stay ordinary TypeScript in this file rather than a string.
 * The export list is deliberately wider than the graph currently needs: a
 * missing name is a link-time `does not provide an export named` failure, not
 * a graceful undefined, so it is cheap insurance against a product import
 * added later.
 */
const ELECTRON_STUB_SOURCE = `
const bridge = globalThis.__daintreePerfElectron;
export const app = bridge.app;
export const BrowserWindow = bridge.BrowserWindow;
export const BrowserView = bridge.BrowserView;
export const WebContentsView = bridge.WebContentsView;
export const View = bridge.View;
export const session = bridge.session;
export const webContents = bridge.webContents;
export const ipcMain = bridge.ipcMain;
export const nativeTheme = bridge.nativeTheme;
export const nativeImage = bridge.nativeImage;
export const shell = bridge.shell;
export const dialog = bridge.dialog;
export const screen = bridge.screen;
export const powerMonitor = bridge.powerMonitor;
export const powerSaveBlocker = bridge.powerSaveBlocker;
export const clipboard = bridge.clipboard;
export const Menu = bridge.Menu;
export const MenuItem = bridge.MenuItem;
export const Tray = bridge.Tray;
export const Notification = bridge.Notification;
export const protocol = bridge.protocol;
export const net = bridge.net;
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

/**
 * Hook module for the older `module.register()` path. Inlined as a data URL so
 * the whole seam stays in this one file rather than needing a sidecar loader.
 */
const ELECTRON_HOOKS_SOURCE = `
const STUB_URL = ${JSON.stringify(ELECTRON_STUB_URL)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "electron") return { url: STUB_URL, shortCircuit: true };
  return nextResolve(specifier, context);
}
`;

let hooksInstalled = false;

/**
 * Remap the bare `electron` specifier — and only that specifier, which nothing
 * else in the perf harness imports — so the main-process graph can be loaded
 * outside Electron.
 *
 * `module.registerHooks` (synchronous, in-thread) is preferred, but it landed
 * in Node 22.15 and the repo pins 22.13 in `.nvmrc`, so the older
 * `module.register` is the fallback. Under Vitest neither runs the product
 * graph — Vite's module runner resolves imports itself — so tests mock
 * `electron` with {@link perfElectronStub} instead.
 *
 * Registered LAZILY, from `loadProjectViewModules()`, so it exists only in the
 * runs that asked for it — the invariant `__tests__/moduleHookHygiene.test.ts`
 * pins for every fixture in this directory. It used to carry a second branch
 * that re-pinned relative `./Foo.js` product imports onto the real `./Foo.ts`
 * on disk, purely to un-shadow `lib/ipcEnvelopeFixture.ts`'s process-wide
 * `TelemetryService` stub — a two-export stand-in that `GpuCrashMonitorService`
 * needs a third export (`closeTelemetry`) from, which killed PERF-074..077 at
 * link time. That stub is now lazy too, so the un-shadow is gone rather than
 * left fighting it: this family's graph no longer depends on which hook Node
 * happens to run first.
 */
function installElectronStub(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  (globalThis as Record<string, unknown>).__daintreePerfElectron = electronBridge;

  // Vitest resolves imports through Vite, so a Node loader hook would never
  // fire and registering one only risks perturbing the worker.
  if (process.env.VITEST) return;

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
        if (specifier === "electron") {
          return { url: ELECTRON_STUB_URL, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });
    return;
  }

  nodeModule.register(`data:text/javascript,${encodeURIComponent(ELECTRON_HOOKS_SOURCE)}`);
}

// --- Stand-in Chromium objects -----------------------------------------------

let nextWebContentsId = 1;
let nextOsProcessId = 90_000;

// Read out of the product's own skeletonCss module once the graph is loaded;
// this default only has to survive until then.
let initialProjectIdArg = "--daintree-initial-project-id";

/** Fixture-side ledger of what the product did to each stand-in renderer. */
export interface RendererLedger {
  /** Views the product constructed — i.e. real cold starts. */
  created: number;
  /** `webContents.close()` calls the product made. */
  closed: number;
  /** Bootstrap probes the product's `verifyProjectBootstrap` ran. */
  bootstrapProbes: number;
  /** Warm-activate sends the product issued. */
  warmActivateSends: number;
  /** Skeleton-parsed subscriptions the product registered. */
  skeletonSubscriptions: number;
  byWebContentsId: Map<number, StubWebContents>;
}

function createLedger(): RendererLedger {
  return {
    created: 0,
    closed: 0,
    bootstrapProbes: 0,
    warmActivateSends: 0,
    skeletonSubscriptions: 0,
    byWebContentsId: new Map(),
  };
}

/**
 * The listener names `setupViewHandlers` binds and `cleanupHandlers` is
 * required to unbind. Counted after a teardown as the structural answer to
 * "did cleanup actually happen" — the one question a latency reading can
 * never answer, and the closest an out-of-Chromium harness can get to
 * "was the renderer really released".
 */
const PRODUCT_VIEW_EVENTS = [
  "will-navigate",
  "will-redirect",
  "will-attach-webview",
  "before-input-event",
  "did-finish-load",
  "render-process-gone",
] as const;

class StubWebContents extends EventEmitter {
  readonly id = nextWebContentsId++;
  readonly osPid = nextOsProcessId++;
  readonly projectId: string;
  destroyed = false;

  private readonly ledger: RendererLedger;
  private readonly ipcOnce = new Map<string, Array<() => void>>();

  readonly debugger = {
    isAttached: () => true,
    attach: () => {},
    detach: () => {},
    sendCommand: async () => ({}),
  };
  readonly session = { flushStorageData: () => {} };
  readonly navigationHistory = { clear: () => {} };
  readonly hostWebContents = null;

  readonly ipc = {
    once: (channel: string, handler: () => void) => {
      this.ledger.skeletonSubscriptions++;
      const list = this.ipcOnce.get(channel) ?? [];
      list.push(handler);
      this.ipcOnce.set(channel, list);
    },
    on: () => {},
    removeAllListeners: () => {},
  };

  constructor(projectId: string, ledger: RendererLedger) {
    super();
    this.setMaxListeners(0);
    this.projectId = projectId;
    this.ledger = ledger;
    ledger.byWebContentsId.set(this.id, this);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  getOSProcessId(): number {
    return this.osPid;
  }

  setWindowOpenHandler(): void {}
  setIgnoreMenuShortcuts(): void {}
  async insertCSS(): Promise<string> {
    return "";
  }
  setBackgroundThrottling(): void {}
  isLoading(): boolean {
    return false;
  }
  getURL(): string {
    return "app://daintree/index.html";
  }
  focus(): void {}
  invalidate(): void {}
  reload(): void {}
  send(channel: string, ..._args: unknown[]): void {
    void _args;
    onRendererSend?.(this, channel);
  }

  async executeJavaScript(script: string): Promise<unknown> {
    // Only the bootstrap probe gets a modelled answer. Every other eval the
    // product runs against a view (skeleton identity, idle GC) returns
    // undefined, which the product already treats as "unmodelled" — so the
    // probe counter stays a clean tally of real bootstrap verifications
    // rather than of evals in general.
    if (!script.includes("__DAINTREE_INITIAL_PROJECT__")) return undefined;
    this.ledger.bootstrapProbes++;
    // Reports the id the PRODUCT threaded through `additionalArguments`, not
    // the id the switch was asked for — so a view wired to the wrong project
    // fails the product's own `verifyProjectBootstrap` exactly as it would
    // in the app.
    return { projectId: this.projectId, hasAppRoot: true };
  }

  async loadURL(_url: string): Promise<void> {
    void _url;
    // The renderer's side of a cold start, ordered as Chromium produces it.
    // `public/skeleton-ready.js` runs during parse, so APP_SKELETON_PARSED
    // lands BEFORE `did-finish-load` — which is exactly why the product arms
    // its paint gate ahead of `loadView` (a one-shot signal it would otherwise
    // drop). Emitting it after the load would quietly excuse a regression that
    // stopped pre-arming.
    setImmediate(() => {
      if (this.destroyed) return;
      this.emit("dom-ready");
      setImmediate(() => {
        if (this.destroyed) return;
        this.fireIpcOnce(skeletonParsedChannel);
        setImmediate(() => {
          if (this.destroyed) return;
          this.emit("did-finish-load");
        });
      });
    });
  }

  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ledger.closed++;
    this.emit("destroyed");
  }

  /** Listeners the product bound and was supposed to unbind on teardown. */
  productListenerCount(): number {
    let total = 0;
    for (const event of PRODUCT_VIEW_EVENTS) total += this.listenerCount(event);
    return total;
  }

  private fireIpcOnce(channel: string): void {
    const list = this.ipcOnce.get(channel);
    if (!list) return;
    this.ipcOnce.delete(channel);
    for (const handler of list) handler();
  }
}

class StubWebContentsView {
  readonly webContents: StubWebContents;

  constructor(options?: { webPreferences?: { additionalArguments?: string[] } }) {
    const args = options?.webPreferences?.additionalArguments ?? [];
    const idArg = args.find((arg) => arg.startsWith(`${initialProjectIdArg}=`));
    const projectId = idArg ? idArg.slice(initialProjectIdArg.length + 1) : "";
    const ledger = activeLedger;
    if (!ledger) throw new Error("projectViewFixture: no harness is active");
    ledger.created++;
    this.webContents = new StubWebContents(projectId, ledger);
  }

  setBounds(): void {}
  setBackgroundColor(): void {}
  setVisible(): void {}
}

/** Chromium's child stack: last child is on top, and re-adding moves a view. */
class StubContentView {
  readonly children: StubWebContentsView[] = [];

  addChildView(view: StubWebContentsView, index?: number): void {
    const existing = this.children.indexOf(view);
    if (existing >= 0) this.children.splice(existing, 1);
    if (index === undefined || index >= this.children.length) {
      this.children.push(view);
    } else {
      this.children.splice(Math.max(0, index), 0, view);
    }
  }

  removeChildView(view: StubWebContentsView): void {
    const index = this.children.indexOf(view);
    if (index >= 0) this.children.splice(index, 1);
  }
}

class StubWindow extends EventEmitter {
  readonly id = 1;
  readonly contentView = new StubContentView();
  readonly webContents: StubWebContents;

  constructor(ledger: RendererLedger) {
    super();
    this.setMaxListeners(0);
    this.webContents = new StubWebContents("__window__", ledger);
  }

  isDestroyed(): boolean {
    return false;
  }

  getContentBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 1600, height: 1000 };
  }
}

let activeLedger: RendererLedger | null = null;
let onRendererSend: ((wc: StubWebContents, channel: string) => void) | null = null;
let skeletonParsedChannel = "app:skeleton-parsed";
let warmActivatedChannel = "app:view-warm-activated";
let systemMemoryInstalled = false;
let availableSystemMemoryKb: number | null = null;
let savedLogOverrides: Record<string, string> | null = null;

const electronBridge = {
  app: {
    isPackaged: false,
    getAppMetrics: () => [] as unknown[],
    getPath: () => process.env.DAINTREE_USER_DATA ?? tmpdir(),
    getAppPath: () => process.cwd(),
    getVersion: () => "0.0.0-perf",
    commandLine: { appendSwitch: () => {}, hasSwitch: () => false },
    on: () => {},
    once: () => {},
    setPath: () => {},
    whenReady: () => Promise.resolve(),
  },
  BrowserWindow: class {
    static getAllWindows(): unknown[] {
      return [];
    }
    static fromWebContents(): unknown {
      return null;
    }
  },
  BrowserView: class {},
  View: class {},
  WebContentsView: StubWebContentsView,
  session: {
    fromPartition: () => ({
      protocol: { handle: () => {} },
      setPermissionRequestHandler: () => {},
    }),
    defaultSession: { protocol: { handle: () => {} } },
  },
  webContents: {
    fromId: () => null,
    getAllWebContents: () => [] as unknown[],
  },
  ipcMain: { on: () => {}, once: () => {}, handle: () => {}, removeHandler: () => {} },
  nativeTheme: { shouldUseDarkColors: true, on: () => {} },
  nativeImage: { createFromPath: () => ({}), createEmpty: () => ({}) },
  shell: { openExternal: () => Promise.resolve() },
  dialog: {},
  screen: { getAllDisplays: () => [], on: () => {} },
  powerMonitor: { on: () => {} },
  powerSaveBlocker: { start: () => 0, stop: () => {} },
  clipboard: { writeText: () => {}, readText: () => "" },
  Menu: class {
    static setApplicationMenu(): void {}
    static buildFromTemplate(): unknown {
      return {};
    }
  },
  MenuItem: class {},
  Tray: class {},
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
  },
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  net: { fetch: () => Promise.reject(new Error("net unavailable in perf harness")) },
  utilityProcess: { fork: () => ({}) },
  MessageChannelMain: class {},
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  safeStorage: { isEncryptionAvailable: () => false },
  globalShortcut: { register: () => false, unregisterAll: () => {} },
  crashReporter: { start: () => {} },
  contextBridge: { exposeInMainWorld: () => {} },
  desktopCapturer: {},
  inAppPurchase: {},
};

/**
 * The inert `electron` stand-in, exported so a Vitest suite can hand it to
 * `vi.mock("electron", ...)`. It is the same object the loader hook serves, so
 * both runners drive an identical seam.
 */
export const perfElectronStub = { ...electronBridge, default: electronBridge };

// --- Lazy product-module load ------------------------------------------------

export interface ProjectViewModules {
  ProjectViewManager: typeof ProjectViewManagerType;
  setLogLevelOverrides: (overrides: Record<string, string>) => void;
  getLogLevelOverrides: () => Record<string, string>;
}

let modulesPromise: Promise<ProjectViewModules> | null = null;

export function loadProjectViewModules(): Promise<ProjectViewModules> {
  if (!modulesPromise) {
    ensurePerfEnv();
    installElectronStub();
    modulesPromise = (async () => {
      const [managerModule, channelsModule, skeletonModule, loggerModule] = await Promise.all([
        import("../../../electron/window/ProjectViewManager"),
        import("../../../electron/ipc/channels"),
        import("../../../electron/window/skeletonCss"),
        import("../../../electron/utils/logger"),
      ]);
      // Bound to the product's own constants, so a renamed channel or preload
      // argument surfaces as a failing switch rather than a silently
      // rewritten fixture.
      skeletonParsedChannel = channelsModule.CHANNELS.APP_SKELETON_PARSED;
      warmActivatedChannel = channelsModule.CHANNELS.APP_VIEW_WARM_ACTIVATED;
      initialProjectIdArg = skeletonModule.INITIAL_PROJECT_ID_ARG;
      return {
        ProjectViewManager: managerModule.ProjectViewManager,
        setLogLevelOverrides: loggerModule.setLogLevelOverrides,
        getLogLevelOverrides: loggerModule.getLogLevelOverrides,
      };
    })();
  }
  return modulesPromise;
}

// --- Available-memory control ------------------------------------------------

/**
 * Drive `readAvailableSystemMemoryMb()` — the real reader the eviction
 * controller consults — by supplying the Electron-only
 * `process.getSystemMemoryInfo`. Installed on first use so scenarios that
 * never touch memory pressure leave the reader returning `null`, which is the
 * "no policy input" path.
 */
export function setAvailableSystemMemoryMb(mb: number | null): void {
  availableSystemMemoryKb = mb === null ? null : mb * 1024;
  if (systemMemoryInstalled) return;
  systemMemoryInstalled = true;
  (
    process as unknown as {
      getSystemMemoryInfo?: () => { free: number; purgeable: number; total: number };
    }
  ).getSystemMemoryInfo = () => ({
    free: availableSystemMemoryKb ?? 0,
    purgeable: 0,
    total: 32 * 1024 * 1024,
  });
}

// --- Harness -----------------------------------------------------------------

export interface AgentSeed {
  terminalId: string;
  projectId: string;
  agentState: string;
}

export interface HarnessOptions {
  cachedProjectViews: number;
  /** Projects with a live agent, for the eviction controller's soft tier. */
  activeAgents?: AgentSeed[];
  /** Project whose view carries a live assistant backend (the hard floor). */
  assistantProject?: string;
  memoryPressurePolicy?: { criticalMb: number; warningMb: number } | null;
}

export interface SwitchOutcome {
  /** The switch resolved rather than rolling back. */
  ok: boolean;
  /** The product cold-started a view for this switch. */
  isNew: boolean;
  /** Projects the product dropped from its view map during this switch. */
  evicted: string[];
  /** Evicted entries whose recency was not minimal among the eligible set. */
  lruOrderMisses: number;
  /** Evicted entries the product never closed. */
  closeMisses: number;
  /** Product listeners still bound on an evicted view. */
  listenerLeaks: number;
}

/** Mutable holder so the assistant floor tracks a project's CURRENT view. */
interface AssistantPin {
  webContentsId: number;
}

const ASSISTANT_TERMINAL_ID = "assistant-terminal";

export class ProjectViewHarness {
  readonly manager: ProjectViewManagerType;
  readonly ledger: RendererLedger;
  readonly win: StubWindow;

  private readonly assistantProject: string | undefined;
  private readonly assistantPin: AssistantPin;
  /** Set by `create` once the logger module is resolved; synchronous on dispose. */
  private restoreLogLevels: (() => void) | null = null;

  private constructor(
    manager: ProjectViewManagerType,
    win: StubWindow,
    ledger: RendererLedger,
    assistantProject: string | undefined,
    assistantPin: AssistantPin
  ) {
    this.manager = manager;
    this.win = win;
    this.ledger = ledger;
    this.assistantProject = assistantProject;
    this.assistantPin = assistantPin;
  }

  static async create(options: HarnessOptions): Promise<ProjectViewHarness> {
    const { ProjectViewManager, setLogLevelOverrides, getLogLevelOverrides } =
      await loadProjectViewModules();
    // A real switch emits several log lines, each a synchronous file append
    // plus a console write. Left on, one perf iteration buries the harness's
    // own output and the run measures the log transport. Silenced only for
    // the harness's lifetime, and restored on dispose — the scenarios here
    // report counts, which log emission cannot move.
    if (savedLogOverrides === null) {
      savedLogOverrides = getLogLevelOverrides();
      setLogLevelOverrides({ "*": "off" });
    }
    const ledger = createLedger();
    activeLedger = ledger;
    const win = new StubWindow(ledger);

    let manager: ProjectViewManagerType | null = null;
    const assistantProject = options.assistantProject;
    // The stand-in renderer's only outbound behaviour: answer the product's
    // warm-activate send with the warm paint signal, exactly as the real
    // renderer's wake fan-out does. Registered before any switch runs.
    onRendererSend = (wc, channel) => {
      if (channel !== warmActivatedChannel) return;
      ledger.warmActivateSends++;
      setImmediate(() => {
        if (wc.isDestroyed()) return;
        manager?.signalWarmViewPainted(wc.id);
      });
    };

    const assistantPin: AssistantPin = { webContentsId: -1 };

    manager = new ProjectViewManager(win as never, {
      dirname: join(process.env.DAINTREE_USER_DATA ?? tmpdir(), "app"),
      cachedProjectViews: options.cachedProjectViews,
      // Small but non-zero: a gate that hard-times-out is a real failure mode
      // the scenarios must be able to observe, and a zero cold gate would
      // abandon every switch outright (#11635).
      paintGateTimeoutMs: 250,
      paintGateHardTimeoutMs: 1_000,
      warmPaintGateTimeoutMs: 150,
      warmPaintGateHardTimeoutMs: 600,
      viewLoadTimeoutMs: 500,
      viewLoadHardTimeoutMs: 2_000,
      assistantBackendForProject: (projectId) =>
        projectId === assistantProject
          ? { terminalId: ASSISTANT_TERMINAL_ID, webContentsId: assistantPin.webContentsId }
          : null,
      isTerminalLive: (terminalId) => terminalId === ASSISTANT_TERMINAL_ID,
    });

    const harness = new ProjectViewHarness(manager, win, ledger, assistantProject, assistantPin);
    harness.restoreLogLevels = () => {
      if (savedLogOverrides === null) return;
      setLogLevelOverrides(savedLogOverrides);
      savedLogOverrides = null;
    };

    try {
      if (options.memoryPressurePolicy !== undefined) {
        manager.setMemoryPressurePolicy(options.memoryPressurePolicy);
      }
      if (options.activeAgents && options.activeAgents.length > 0) {
        await harness.seedAgents(options.activeAgents);
      }
    } catch (error) {
      // Setup failed after the process-global hooks were claimed. Release them
      // here or every later iteration runs against a poisoned harness.
      harness.dispose();
      throw error;
    }
    return harness;
  }

  /**
   * Re-point the assistant floor at the assistant project's CURRENT view. The
   * product re-reads `assistantBackendForProject` on every eviction pass, and
   * a stale WebContents id would silently stop protecting anything.
   */
  syncAssistantPin(): void {
    if (!this.assistantProject) return;
    const entry = this.manager
      .getAllViews()
      .find((view: ViewEntry) => view.projectId === this.assistantProject);
    this.assistantPin.webContentsId = entry ? entry.view.webContents.id : -1;
  }

  /** Seed the REAL agent-state cache through its real entry point. */
  private async seedAgents(agents: AgentSeed[]): Promise<void> {
    const ptyClient = {
      getAllTerminalsAsync: async () =>
        agents.map((agent) => ({
          id: agent.terminalId,
          projectId: agent.projectId,
          agentState: agent.agentState,
        })),
      on: () => {},
      off: () => {},
    };
    await this.manager.initAgentStateCache(ptyClient as never);
  }

  private viewSnapshot(): Array<{ projectId: string; lastUsed: number; wcId: number }> {
    return this.manager.getAllViews().map((entry: ViewEntry) => ({
      projectId: entry.projectId,
      lastUsed: entry.lastUsed,
      wcId: entry.view.webContents.id,
    }));
  }

  /**
   * Drive one real switch and read back what the product did.
   *
   * `lruOrderMisses` here checks the evicted entries against the product's own
   * recorded `lastUsed` stamps — it catches a mis-sorted policy, but NOT a
   * policy whose stamps have stopped being maintained, because it reads the
   * same numbers the policy sorted. That second failure needs an oracle
   * outside the product, which only the caller has: it knows the request
   * order. PERF-075 supplies it as `lruRequestOrderMisses`. Read the two
   * together.
   */
  async switchTo(projectId: string): Promise<SwitchOutcome> {
    let ok = true;
    let isNew = false;
    try {
      const result = await this.manager.switchTo(projectId, `/perf/${projectId}`);
      isNew = result.isNew;
    } catch {
      ok = false;
    }
    // Taken AFTER the switch settles and BEFORE the deferred LRU pass runs —
    // the exact view map `evictStaleViews` is about to sort. A pre-switch
    // snapshot would be wrong: `deactivateEntry` re-stamps the outgoing view
    // on its way to the cache, so its pre-switch `lastUsed` is stale by
    // construction and every cold switch would read as an ordering violation.
    const beforeEviction = this.viewSnapshot();

    // The LRU pass is deferred one tick past the switch's resolution
    // (ProjectViewSwitchController defers it so the incoming view is settled
    // first), so the reading has to wait for it or every switch reports zero
    // evictions.
    await flushImmediates();
    // The assistant floor needs the pinned id of the view that now exists.
    this.syncAssistantPin();

    const afterIds = new Set(this.viewSnapshot().map((entry) => entry.projectId));
    const removed = beforeEviction.filter((entry) => !afterIds.has(entry.projectId));

    // Eligible = everything the policy could have taken. Only the switch
    // target is excluded — by this point the outgoing view is an ordinary
    // cached candidate and `pendingColdSwitch` has been cleared, so excluding
    // it too would let a policy that always took the second-oldest view pass
    // unnoticed.
    const eligible = beforeEviction.filter((entry) => entry.projectId !== projectId);
    const survivors = eligible.filter((entry) => afterIds.has(entry.projectId));
    let lruOrderMisses = 0;
    for (const gone of removed) {
      for (const kept of survivors) {
        if (gone.lastUsed > kept.lastUsed) lruOrderMisses++;
      }
    }

    let closeMisses = 0;
    let listenerLeaks = 0;
    for (const gone of removed) {
      const wc = this.ledger.byWebContentsId.get(gone.wcId);
      if (!wc) continue;
      if (!wc.isDestroyed()) closeMisses++;
      listenerLeaks += wc.productListenerCount();
    }

    return {
      ok,
      isNew,
      evicted: removed.map((entry) => entry.projectId),
      lruOrderMisses,
      closeMisses,
      listenerLeaks,
    };
  }

  /**
   * Start a switch WITHOUT settling it — the caller owns the promise, so
   * several requests can sit on the product's `switchChain` at once.
   *
   * This is queueing, NOT cancellation. `switchTo` chains each `performSwitch`
   * behind the previous one's settlement, so a burst runs strictly serially
   * and no switch is ever superseded mid-flight. Real supersession only
   * happens through paths outside the chain (`destroyView`, window teardown),
   * which this harness does not reach.
   */
  beginSwitch(projectId: string): Promise<unknown> {
    return this.manager.switchTo(projectId, `/perf/${projectId}`).then(
      (result) => result,
      (error: unknown) => error
    );
  }

  /**
   * One real periodic pressure pass — the path `ProjectViewManager`'s own
   * 30 s sampler takes — at a given available-memory reading. Returns the
   * projects the pass took and the WebContents ids they were holding, so the
   * caller can read cleanup against them.
   */
  pressurePass(availableMb: number): { evicted: string[]; wcIds: number[] } {
    setAvailableSystemMemoryMb(availableMb);
    const before = this.viewSnapshot();
    this.syncAssistantPin();
    this.manager.maybeEvictUnderPressure();
    const afterIds = new Set(this.viewSnapshot().map((entry) => entry.projectId));
    const removed = before.filter((entry) => !afterIds.has(entry.projectId));
    return {
      evicted: removed.map((entry) => entry.projectId),
      wcIds: removed.map((entry) => entry.wcId),
    };
  }

  /** The forced tier-2 reclaim — a one-pass collapse to the active view. */
  forcedReclaim(): { evicted: string[]; wcIds: number[]; reported: number } {
    const before = this.viewSnapshot();
    this.syncAssistantPin();
    const reported = this.manager.reclaimCachedViewsUnderPressure();
    const afterIds = new Set(this.viewSnapshot().map((entry) => entry.projectId));
    const removed = before.filter((entry) => !afterIds.has(entry.projectId));
    return {
      evicted: removed.map((entry) => entry.projectId),
      wcIds: removed.map((entry) => entry.wcId),
      reported,
    };
  }

  /** Views the product currently holds resident. */
  residentProjectIds(): string[] {
    return this.manager.getAllViews().map((entry: ViewEntry) => entry.projectId);
  }

  /** Views still attached to the window's child stack. */
  attachedViewCount(): number {
    return this.win.contentView.children.length;
  }

  /**
   * Cleanup readings for a set of projects the product has already dropped.
   * Split from `switchTo` so pressure passes — which evict without a switch —
   * get the identical treatment.
   */
  teardownMisses(wcIds: number[]): { closeMisses: number; listenerLeaks: number } {
    let closeMisses = 0;
    let listenerLeaks = 0;
    for (const wcId of wcIds) {
      const wc = this.ledger.byWebContentsId.get(wcId);
      if (!wc) continue;
      if (!wc.isDestroyed()) closeMisses++;
      listenerLeaks += wc.productListenerCount();
    }
    return { closeMisses, listenerLeaks };
  }

  /**
   * Cleanup readings across every stand-in renderer the product created and
   * then dropped — the set a queued burst of switches leaves behind, which no
   * single switch's before/after diff can see.
   */
  teardownMissesForDroppedViews(): { closeMisses: number; listenerLeaks: number } {
    const residentWcIds = new Set(this.viewSnapshot().map((entry) => entry.wcId));
    const dropped: number[] = [];
    for (const [wcId, wc] of this.ledger.byWebContentsId) {
      if (residentWcIds.has(wcId)) continue;
      // The window's own WebContents is not a project view.
      if (wc === this.win.webContents) continue;
      dropped.push(wcId);
    }
    return this.teardownMisses(dropped);
  }

  webContentsIdsFor(projectIds: string[]): number[] {
    const wanted = new Set(projectIds);
    return this.viewSnapshot()
      .filter((entry) => wanted.has(entry.projectId))
      .map((entry) => entry.wcId);
  }

  dispose(): void {
    this.manager.dispose();
    onRendererSend = null;
    if (activeLedger === this.ledger) activeLedger = null;
    // Leave no availability reading behind: a later scenario's manager reads
    // `process.getSystemMemoryInfo` on every eviction pass, and a stale
    // low-memory figure would make its pressure behaviour depend on which
    // scenario ran first.
    setAvailableSystemMemoryMb(null);
    this.restoreLogLevels?.();
    this.restoreLogLevels = null;
  }
}

/** Let queued `setImmediate` work (renderer stand-in hops, deferred evicts) run. */
export function flushImmediates(times = 3): Promise<void> {
  return new Promise((resolve) => {
    let remaining = times;
    const tick = () => {
      remaining--;
      if (remaining <= 0) {
        resolve();
        return;
      }
      setImmediate(tick);
    };
    setImmediate(tick);
  });
}
