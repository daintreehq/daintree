import { existsSync } from "node:fs";
import nodeModule from "node:module";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import type { NotificationSettings } from "../../../shared/types/ipc/api";
import type { AgentState, WaitingReason } from "../../../shared/types/agent";
import type { StoreSchema } from "../../../electron/store";
import type { WindowRegistry } from "../../../electron/window/WindowRegistry";
import type { ProjectViewManagersProvider } from "../../../electron/window/activeProjectIds";
import { createPerfTempRoot, releasePerfTempRoot } from "./tempRoots";

/**
 * The REAL notification subsystem for PERF-320..325, in a plain Node process.
 *
 * Notification routing is the user-visible face of a state machine that is
 * frequently wrong: agent state comes from passive PTY output heuristics, so
 * every fleet produces a continuous stream of transitions and this code decides,
 * for each one, whether the user hears about it. Nothing measured it before.
 *
 * WHAT IS REAL
 *   - `electron/services/AgentNotificationService.ts` unmodified: the whole
 *     `handleStateChanged` gate chain, the per-terminal completion debounce, the
 *     200ms waiting-burst collapse with its last-entry-wins dedup and its
 *     terminal-state splice, the stagger queue, the docked waiting escalation
 *     with sibling cancellation, the working-pulse loop, the boot and spawn
 *     grace periods, session mute, quiet hours, OS DND and the all-clear.
 *   - `electron/services/NotificationService.ts` unmodified: the 300ms badge
 *     debounce, per-window waiting counts, dead-owner pruning, the real window
 *     title composition, and click routing to the owning renderer.
 *   - `electron/services/IdleTerminalNotificationService.ts` unmodified, driven
 *     through `start()` — so the startup quiet window, the 5s initial check, the
 *     5-minute cadence, the dismissal and notified-at cooldowns and their
 *     opportunistic cleanup are the product's own.
 *   - The real `events` bus, the real `electron-store` (a temp profile, product
 *     defaults, product cached-read proxy — so the per-decision `appState`
 *     `structuredClone` PERF-321 measures is the real one), the real
 *     `collectActiveProjectIds`, `windowTitle`, `quietHours`,
 *     `waitingReasonDisplay` and `SystemSleepService`.
 *   - Every synthetic `agent:state-changed` payload is validated against the
 *     product's own `AgentStateChangedSchema` before it is emitted, so the
 *     inputs are the shape `AgentStateService` actually emits.
 *
 * WHAT IS NOT, AND CANNOT BE
 *   - **No OS notification is ever sent.** `electron` resolves to an inert stub
 *     whose `Notification` records the request and returns; nothing reaches
 *     Notification Center, `notify-send` or the Windows toast API. The Electron
 *     42 macOS trap — an unsigned dev build silently emitting `failed` through
 *     UNNotification instead of displaying — is therefore OUT OF FRAME here:
 *     this fixture measures the decision to notify, never the delivery, and a
 *     zero here says nothing about whether a real build would have displayed.
 *   - **No renderer.** `ipc/utils` is a recording stub, so the per-WebContents
 *     fan-out and its structured clone are not priced; `webContentsRegistry` is
 *     a stub over the fixture's own window fleet. The renderer's one-shot
 *     unwatch is not modelled — the watch set is held static, which is the
 *     upper bound on how many transitions are eligible to notify.
 *   - **No sound.** `SoundService` is a counting stub: the real one spawns an
 *     OS player and broadcasts to the renderer, and a benchmark must not make
 *     noise. Sound COUNTS are graded; sound latency is not measured.
 *   - **`ProjectStore` is a stub.** The real one is SQLite plus `GitService`,
 *     and what the notification path reads from it — effective notification
 *     settings, the project list, the current project id — is an INPUT to the
 *     decision, not part of it. Settings merge cost is out of frame.
 *   - **`logger` is a stub**, so log write cost is excluded and nothing is
 *     written to a real Daintree log directory.
 *   - **Timers run on a virtual clock.** `Date.now` and the global timer
 *     functions are patched so the 2s completion debounce, the 200ms burst
 *     window, the 3-minute escalation and the 5-minute idle cadence resolve
 *     deterministically and instantly. `performance.now` is deliberately NOT
 *     patched — it is what measures the work. Every duration reported by this
 *     family is therefore decision cost with the waiting removed, and no
 *     scenario here can measure how long a user waits for anything.
 *   - `WindowsStoreNotifierService` is absent: it polls an HTTPS update feed
 *     through Electron's `net` and only runs in Microsoft Store builds, so
 *     every number it produced here would be a number about the stub.
 */

// --- The stub bus ------------------------------------------------------------

export interface StubNativeNotification {
  title: string;
  body: string;
  silent: boolean;
  /** Fire the click handler the product registered, for click-routing checks. */
  click: () => void;
}

export interface StubWebContents {
  id: number;
  isDestroyed: () => boolean;
  send: (channel: string, payload: unknown) => void;
  __perfWindow: unknown;
}

export interface NotificationBus {
  settings: NotificationSettings;
  projects: Array<{ id: string; name: string }>;
  currentProjectId: string | null;
  osDnd: boolean | undefined;
  soundPlays: string[];
  soundFiles: string[];
  soundPulses: number;
  soundCancels: number;
  nativeNotifications: StubNativeNotification[];
  badgeCounts: number[];
  broadcasts: Array<{ channel: string; payload: unknown }>;
  rendererSends: Array<{ channel: string; payload: unknown; targetId: number }>;
  logInfoCount: number;
  logErrorCount: number;
  webContentsById: Map<number, StubWebContents>;
}

const BUS_KEY = "__daintreePerfNotificationBus";

export function notificationBus(): NotificationBus {
  const existing = (globalThis as Record<string, unknown>)[BUS_KEY] as NotificationBus | undefined;
  if (existing) return existing;
  const created: NotificationBus = {
    settings: defaultNotificationSettings(),
    projects: [],
    currentProjectId: null,
    osDnd: undefined,
    soundPlays: [],
    soundFiles: [],
    soundPulses: 0,
    soundCancels: 0,
    nativeNotifications: [],
    badgeCounts: [],
    broadcasts: [],
    rendererSends: [],
    logInfoCount: 0,
    logErrorCount: 0,
    webContentsById: new Map(),
  };
  (globalThis as Record<string, unknown>)[BUS_KEY] = created;
  return created;
}

/** Drop everything the stubs recorded, without touching the injected inputs. */
export function resetBusObservations(): void {
  const bus = notificationBus();
  bus.soundPlays = [];
  bus.soundFiles = [];
  bus.soundPulses = 0;
  bus.soundCancels = 0;
  bus.nativeNotifications = [];
  bus.badgeCounts = [];
  bus.broadcasts = [];
  bus.rendererSends = [];
  bus.logInfoCount = 0;
  bus.logErrorCount = 0;
}

/**
 * The product's own shipped defaults, lifted from `electron/store.ts`. Scenarios
 * override individual fields; starting anywhere else would benchmark a
 * configuration no user has.
 */
export function defaultNotificationSettings(): NotificationSettings {
  return {
    enabled: true,
    completedEnabled: false,
    waitingEnabled: true,
    soundEnabled: false,
    completedSoundFile: "complete.wav",
    waitingSoundFile: "waiting.wav",
    escalationSoundFile: "ping.wav",
    waitingEscalationEnabled: false,
    waitingEscalationDelayMs: 180_000,
    workingPulseEnabled: false,
    workingPulseSoundFile: "pulse.wav",
    uiFeedbackSoundEnabled: false,
    flashEnabled: false,
    quietHoursEnabled: false,
    quietHoursStartMin: 22 * 60,
    quietHoursEndMin: 8 * 60,
    quietHoursWeekdays: [],
    groupByContext: false,
  };
}

// --- Module stubs ------------------------------------------------------------

const BUS_PREAMBLE = `const bus = () => globalThis[${JSON.stringify(BUS_KEY)}];\n`;

/**
 * `Notification` records the request and stops there. Nothing in this file may
 * ever reach a real notification API — see the header.
 */
const ELECTRON_STUB_SOURCE = `${BUS_PREAMBLE}
const noop = () => undefined;
class StubEmitter {
  constructor() { this.handlers = new Map(); }
  on(event, handler) { const list = this.handlers.get(event) || []; list.push(handler); this.handlers.set(event, list); return this; }
  once(event, handler) { return this.on(event, handler); }
  off(event, handler) { const list = this.handlers.get(event) || []; this.handlers.set(event, list.filter((h) => h !== handler)); return this; }
  removeAllListeners() { this.handlers.clear(); return this; }
  emit(event, ...args) { for (const handler of [...(this.handlers.get(event) || [])]) handler(...args); return this; }
}
class StubNotification extends StubEmitter {
  constructor(options) { super(); this.options = options || {}; }
  static isSupported() { return true; }
  show() {
    const self = this;
    const record = {
      title: this.options.title,
      body: this.options.body,
      silent: this.options.silent === true,
      click: () => self.emit("click"),
    };
    const b = bus();
    if (b) b.nativeNotifications.push(record);
  }
  close() { this.emit("close"); }
}
export const Notification = StubNotification;
export const app = {
  setBadgeCount: (count) => { const b = bus(); if (b) b.badgeCounts.push(count); return true; },
  getPath: () => process.env.DAINTREE_USER_DATA || "/tmp",
  getAppPath: () => process.cwd(),
  getName: () => "Daintree",
  getVersion: () => "0.0.0-perf",
  isPackaged: false,
  on: noop,
  whenReady: () => Promise.resolve(),
};
export const webContents = {
  fromId: (id) => { const b = bus(); return (b && b.webContentsById.get(id)) || null; },
  getAllWebContents: () => { const b = bus(); return b ? [...b.webContentsById.values()] : []; },
};
export const powerMonitor = new StubEmitter();
export const systemPreferences = { subscribeNotification: () => 0, unsubscribeNotification: noop };
export const ipcMain = { on: noop, handle: noop, removeHandler: noop };
export const BrowserWindow = class { static getAllWindows() { return []; } };
export const shell = { openExternal: noop };
export const nativeTheme = new StubEmitter();
export const dialog = {};
export const session = {};
export const net = {};
export const safeStorage = { isEncryptionAvailable: () => false };
export const utilityProcess = { fork: noop };
export default { app, Notification: StubNotification, webContents, powerMonitor, systemPreferences, ipcMain, BrowserWindow, shell, nativeTheme, safeStorage };
`;

const PROJECT_STORE_STUB_SOURCE = `${BUS_PREAMBLE}
export const projectStore = {
  getEffectiveNotificationSettings: () => bus().settings,
  getCurrentProjectId: () => bus().currentProjectId,
  getAllProjects: () => bus().projects,
};
`;

const SOUND_STUB_SOURCE = `${BUS_PREAMBLE}
export const soundService = {
  play: (id) => { bus().soundPlays.push(id); },
  playFile: (file) => { bus().soundFiles.push(file); },
  previewFile: (file) => { bus().soundFiles.push(file); },
  playPulse: () => { bus().soundPulses += 1; },
  cancelPulse: () => { bus().soundCancels += 1; },
  cancel: () => { bus().soundCancels += 1; },
  getVariants: () => [],
  getVariantCount: () => 1,
};
export const SOUND_FILES = {};
export const ALLOWED_SOUND_FILES = new Set();
export function getSoundsDir() { return ""; }
`;

const OS_DND_STUB_SOURCE = `${BUS_PREAMBLE}
const service = { getState: () => bus().osDnd, onStateChange: () => () => undefined, dispose: () => undefined };
export function getOsDndService() { return service; }
export function initializeOsDndService() { return service; }
`;

const IPC_UTILS_STUB_SOURCE = `${BUS_PREAMBLE}
export function broadcastToRenderer(channel, payload) { bus().broadcasts.push({ channel, payload }); }
export function broadcastToProjectRenderers(_projectId, channel, payload) { bus().broadcasts.push({ channel, payload }); }
export function sendToRenderer(_window, channel, payload) { bus().rendererSends.push({ channel, payload, targetId: -1 }); }
export function registerHandler() {}
export function registerEventHandler() {}
`;

const WEBCONTENTS_REGISTRY_STUB_SOURCE = `${BUS_PREAMBLE}
export function getAppWebContents(win) { return (win && win.__perfWebContents) || null; }
export function getWindowForWebContents(wc) { return (wc && wc.__perfWindow) || null; }
export function getAllAppWebContents() { const b = bus(); return b ? [...b.webContentsById.values()] : []; }
export function getProjectForWebContents() { return null; }
export function getWebContentsForProject() { return []; }
export function hasRegisteredProjectViews() { return false; }
export function isCachedViewWebContents() { return false; }
`;

const LOGGER_STUB_SOURCE = `${BUS_PREAMBLE}
export function logInfo() { bus().logInfoCount += 1; }
export function logError() { bus().logErrorCount += 1; }
export function logWarn() { bus().logInfoCount += 1; }
export function logDebug() { bus().logInfoCount += 1; }
`;

function dataUrl(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

/**
 * Product modules replaced at their resolved path, matched on either extension
 * because tsx resolves the product's `.js` specifiers to the `.ts` sources.
 */
const MODULE_STUBS: ReadonlyArray<{ suffix: string; source: string }> = [
  { suffix: "/electron/services/ProjectStore", source: PROJECT_STORE_STUB_SOURCE },
  { suffix: "/electron/services/SoundService", source: SOUND_STUB_SOURCE },
  { suffix: "/electron/services/OsDndService", source: OS_DND_STUB_SOURCE },
  { suffix: "/electron/ipc/utils", source: IPC_UTILS_STUB_SOURCE },
  { suffix: "/electron/window/webContentsRegistry", source: WEBCONTENTS_REGISTRY_STUB_SOURCE },
  { suffix: "/electron/utils/logger", source: LOGGER_STUB_SOURCE },
];

const ELECTRON_STUB_URL = dataUrl(ELECTRON_STUB_SOURCE);
const STUB_TABLE: ReadonlyArray<[string, string]> = MODULE_STUBS.map(
  ({ suffix, source }) => [suffix, dataUrl(source)] as [string, string]
);

/**
 * Product modules this graph must have FOR REAL, even though another fixture in
 * the same matrix stubs them process-wide.
 *
 * `lib/cliAvailabilityFixture.ts` calls its own `installModuleStubs()` at module
 * evaluation, and `scenarios/index.ts` imports every scenario module eagerly —
 * so PERF-393/394's resolve hook is live in EVERY perf run, whichever id
 * `--scenario` names. Its table remaps `/electron/store` to a four-method stub
 * with no `path` and no `initializeStore`.
 *
 * Resolve hooks chain, and this file's hook delegated straight through
 * `nextResolve`, so the chain handed back that stub and the real electron-store
 * never loaded: `store.path` came back `undefined` and PERF-320..325 died in the
 * user-data guard below before a single iteration ran. Short-circuiting these
 * paths to the real file, computed from the importing module's own URL rather
 * than taken from the chain, is what makes this family independent of whatever
 * else the matrix has installed.
 *
 * `/electron/setup/environment` is the sibling entry in that same foreign table.
 * It is listed here for the same reason, not because the notification graph is
 * known to reach it — a fixture must not depend on the load order of a module
 * it does not own.
 */
const FORCE_REAL_SUFFIXES: readonly string[] = ["/electron/store", "/electron/setup/environment"];

const SOURCE_EXTENSIONS: readonly string[] = [".ts", ".js", ".mts", ".mjs"];

function stubUrlFor(resolvedUrl: string): string | null {
  const withoutQuery = resolvedUrl.split("?")[0] ?? resolvedUrl;
  const withoutExt = withoutQuery.replace(/\.(ts|js|mts|mjs)$/, "");
  for (const [suffix, url] of STUB_TABLE) {
    if (withoutExt.endsWith(suffix)) return url;
  }
  return null;
}

/**
 * Resolve a relative specifier against its importer WITHOUT entering the hook
 * chain, so a foreign stub registered by another fixture cannot answer for a
 * module this family owns. Returns null unless the target is on
 * `FORCE_REAL_SUFFIXES` and a real source file exists for it.
 */
function forcedRealUrlFor(specifier: string, parentURL: string | undefined): string | null {
  if (parentURL === undefined || !specifier.startsWith(".")) return null;
  let joined: string;
  try {
    joined = new URL(specifier, parentURL).href;
  } catch {
    return null;
  }
  if (!joined.startsWith("file:")) return null;
  const withoutExt = (joined.split("?")[0] ?? joined).replace(/\.(ts|js|mts|mjs)$/, "");
  if (!FORCE_REAL_SUFFIXES.some((suffix) => withoutExt.endsWith(suffix))) return null;
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${withoutExt}${extension}`;
    if (existsSync(fileURLToPath(candidate))) return candidate;
  }
  return null;
}

const HOOKS_SOURCE = `
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const ELECTRON_STUB_URL = ${JSON.stringify(ELECTRON_STUB_URL)};
const STUB_TABLE = ${JSON.stringify(STUB_TABLE)};
const FORCE_REAL_SUFFIXES = ${JSON.stringify(FORCE_REAL_SUFFIXES)};
const SOURCE_EXTENSIONS = ${JSON.stringify(SOURCE_EXTENSIONS)};
function forcedRealUrlFor(specifier, parentURL) {
  if (parentURL === undefined || !specifier.startsWith(".")) return null;
  let joined;
  try { joined = new URL(specifier, parentURL).href; } catch { return null; }
  if (!joined.startsWith("file:")) return null;
  const withoutExt = String(joined).split("?")[0].replace(/\\.(ts|js|mts|mjs)$/, "");
  if (!FORCE_REAL_SUFFIXES.some((suffix) => withoutExt.endsWith(suffix))) return null;
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = withoutExt + extension;
    if (existsSync(fileURLToPath(candidate))) return candidate;
  }
  return null;
}
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "electron") return { url: ELECTRON_STUB_URL, shortCircuit: true };
  const forced = forcedRealUrlFor(specifier, context && context.parentURL);
  if (forced) return { url: forced, shortCircuit: true };
  const resolved = await nextResolve(specifier, context);
  const withoutExt = String(resolved.url).split("?")[0].replace(/\\.(ts|js|mts|mjs)$/, "");
  for (const [suffix, url] of STUB_TABLE) {
    if (withoutExt.endsWith(suffix)) return { url, shortCircuit: true };
  }
  return resolved;
}
`;

/** The subset of Node's resolve-hook context this fixture reads. */
interface ResolveHookContext {
  parentURL?: string;
  conditions?: readonly string[];
  importAttributes?: Record<string, string>;
}

let hooksInstalled = false;

/**
 * Remap `electron` and the six collaborator modules named in the header, so the
 * main-process notification graph loads outside Electron. `registerHooks` is
 * synchronous and in-thread on supported runtimes; `module.register` — whose
 * hooks run in a worker and therefore resolve asynchronously — remains a
 * defensive fallback for older Node 22 installations. Under Vitest neither
 * fires, which is why the unit test exercises the oracles rather than the
 * loaded graph.
 */
function installModuleStubs(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  if (process.env.VITEST) return;

  const registerHooks = (
    nodeModule as unknown as {
      registerHooks?: (hooks: {
        resolve: (
          specifier: string,
          context: ResolveHookContext,
          next: (s: string, c: ResolveHookContext) => { url: string }
        ) => { url: string; shortCircuit?: boolean };
      }) => void;
    }
  ).registerHooks;

  if (typeof registerHooks === "function") {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "electron") return { url: ELECTRON_STUB_URL, shortCircuit: true };
        const forced = forcedRealUrlFor(specifier, context?.parentURL);
        if (forced) return { url: forced, shortCircuit: true };
        const resolved = nextResolve(specifier, context);
        const stub = stubUrlFor(resolved.url);
        return stub ? { url: stub, shortCircuit: true } : resolved;
      },
    });
    return;
  }

  nodeModule.register(dataUrl(HOOKS_SOURCE));
}

// --- User data ---------------------------------------------------------------

/**
 * Read at module evaluation, BEFORE anything here can import `electron/store.ts`.
 * An inherited value is normally another perf fixture's temp dir, but it could
 * equally be a developer's real Daintree profile — and these scenarios WRITE.
 */
const INHERITED_USER_DATA = process.env.DAINTREE_USER_DATA;

let ownedUserDataDir: string | null = null;

function ensureBenchUserData(): string {
  const existing = process.env.DAINTREE_USER_DATA;
  if (existing) {
    if (!resolvePath(existing).startsWith(resolvePath(tmpdir()))) {
      throw new Error(
        `DAINTREE_USER_DATA points outside the temp root (${existing}); refusing to benchmark ` +
          "the notification subsystem against what may be a real Daintree profile."
      );
    }
    return existing;
  }
  const dir = createPerfTempRoot("daintree-perf-notify-");
  ownedUserDataDir = dir;
  process.env.DAINTREE_USER_DATA = dir;
  return dir;
}

/**
 * Explicit teardown for callers that want the directory gone before the process
 * ends. The shared owner's exit and signal hooks cover everything else.
 */
export function cleanupNotificationTempDir(): void {
  if (!ownedUserDataDir) return;
  releasePerfTempRoot(ownedUserDataDir);
  ownedUserDataDir = null;
}

/** True when this process inherited its user-data dir rather than minting one. */
export function inheritedUserData(): boolean {
  return INHERITED_USER_DATA !== undefined;
}

// --- Loading the real modules ------------------------------------------------

type StoreModule = typeof import("../../../electron/store");
type EventsModule = typeof import("../../../electron/services/events");
type AgentNotificationModule = typeof import("../../../electron/services/AgentNotificationService");
type NotificationModule = typeof import("../../../electron/services/NotificationService");
type IdleModule = typeof import("../../../electron/services/IdleTerminalNotificationService");
type WindowTitleModule = typeof import("../../../electron/window/windowTitle");
type AgentSchemaModule = typeof import("../../../electron/schemas/agent");
type SleepModule = typeof import("../../../electron/services/SystemSleepService");

export interface NotificationModules {
  store: StoreModule["store"];
  events: EventsModule["events"];
  agentNotificationService: AgentNotificationModule["agentNotificationService"];
  notificationService: NotificationModule["notificationService"];
  getIdleTerminalNotificationService: IdleModule["getIdleTerminalNotificationService"];
  composeWindowTitle: WindowTitleModule["composeWindowTitle"];
  agentStateChangedSchema: AgentSchemaModule["AgentStateChangedSchema"];
  getSystemSleepService: SleepModule["getSystemSleepService"];
  storePath: string;
}

let modulesPromise: Promise<NotificationModules> | null = null;

/**
 * Load the real subsystem once per process. Lazy on purpose: importing this
 * fixture must not construct anything, so a scenario module that is merely
 * listed in the matrix pays nothing.
 */
export function loadNotificationModules(): Promise<NotificationModules> {
  if (!modulesPromise) {
    modulesPromise = (async () => {
      installModuleStubs();
      const userData = ensureBenchUserData();
      notificationBus();

      const storeModule = await import("../../../electron/store");
      const storePath: unknown = storeModule.store.path;
      // Not `!storePath.startsWith(...)`: when a foreign resolve hook answers
      // for `electron/store` the export is a stub with no `path` at all, and
      // reading through it threw a bare TypeError that named neither this
      // fixture's real problem nor the scenario. Say what happened instead.
      if (typeof storePath !== "string" || storePath === "") {
        throw new Error(
          "electron/store did not resolve to the real electron-store module " +
            `(store.path is ${typeof storePath === "undefined" ? "undefined" : JSON.stringify(storePath)}). ` +
            "Another perf fixture's resolve hook is answering for it — see FORCE_REAL_SUFFIXES " +
            "in lib/notificationFixture.ts."
        );
      }
      if (!storePath.startsWith(userData)) {
        throw new Error(
          `electron-store resolved to ${storePath}, outside the benchmark user-data dir ` +
            `${userData}. Something imported electron/store.ts before DAINTREE_USER_DATA ` +
            "was set; refusing to write."
        );
      }

      const eventsModule = await import("../../../electron/services/events");
      const agentModule = await import("../../../electron/services/AgentNotificationService");
      const notificationModule = await import("../../../electron/services/NotificationService");
      const idleModule = await import("../../../electron/services/IdleTerminalNotificationService");
      const windowTitleModule = await import("../../../electron/window/windowTitle");
      const schemaModule = await import("../../../electron/schemas/agent");
      const sleepModule = await import("../../../electron/services/SystemSleepService");

      return {
        store: storeModule.store,
        events: eventsModule.events,
        agentNotificationService: agentModule.agentNotificationService,
        notificationService: notificationModule.notificationService,
        getIdleTerminalNotificationService: idleModule.getIdleTerminalNotificationService,
        composeWindowTitle: windowTitleModule.composeWindowTitle,
        agentStateChangedSchema: schemaModule.AgentStateChangedSchema,
        getSystemSleepService: sleepModule.getSystemSleepService,
        storePath,
      };
    })();
  }
  return modulesPromise;
}

// --- Virtual clock -----------------------------------------------------------

interface ScheduledTimer {
  id: number;
  at: number;
  intervalMs?: number;
  fn: (...args: unknown[]) => void;
  args: unknown[];
}

interface VirtualTimerHandle {
  __virtualId: number;
  unref: () => VirtualTimerHandle;
  ref: () => VirtualTimerHandle;
  refresh: () => VirtualTimerHandle;
  hasRef: () => boolean;
  [Symbol.toPrimitive]: () => number;
}

/**
 * Patches `Date.now` and the global timer functions with a deterministic
 * scheduler, so a 3-minute escalation and a 5-minute idle sweep resolve in
 * microseconds and every count is reproducible.
 *
 * `performance.now` is deliberately left alone — unlike the copy in
 * `agentAnalysisSim`, which patches it because its subject reads it for
 * hysteresis. Nothing in the notification path reads `performance.now`, and
 * patching it would destroy the very measurement these scenarios take.
 *
 * Always pair `install()` with `uninstall()` in a finally: a leaked patch would
 * corrupt every later scenario in the process.
 */
export class NotificationClock {
  private nowMs: number;
  private nextId = 1;
  private timers = new Map<number, ScheduledTimer>();
  private originals:
    | {
        dateNow: () => number;
        setTimeout: typeof globalThis.setTimeout;
        clearTimeout: typeof globalThis.clearTimeout;
        setInterval: typeof globalThis.setInterval;
        clearInterval: typeof globalThis.clearInterval;
      }
    | undefined;

  constructor(startMs = 1_800_000_000_000) {
    this.nowMs = startMs;
  }

  now(): number {
    return this.nowMs;
  }

  /** Timers still armed. A scenario reads this to prove it left none behind. */
  pendingTimers(): number {
    return this.timers.size;
  }

  install(): void {
    if (this.originals) return;
    const g = globalThis as Record<string, unknown>;
    this.originals = {
      dateNow: Date.now,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    };
    Date.now = () => this.nowMs;
    g.setTimeout = ((fn: (...a: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      this.schedule(fn, delay ?? 0, undefined, args)) as unknown as typeof globalThis.setTimeout;
    g.setInterval = ((fn: (...a: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      this.schedule(
        fn,
        delay ?? 0,
        Math.max(1, delay ?? 1),
        args
      )) as unknown as typeof globalThis.setInterval;
    g.clearTimeout = ((handle: unknown) =>
      this.cancel(handle)) as unknown as typeof globalThis.clearTimeout;
    g.clearInterval = ((handle: unknown) =>
      this.cancel(handle)) as unknown as typeof globalThis.clearInterval;
  }

  uninstall(): void {
    if (!this.originals) return;
    Date.now = this.originals.dateNow;
    globalThis.setTimeout = this.originals.setTimeout;
    globalThis.clearTimeout = this.originals.clearTimeout;
    globalThis.setInterval = this.originals.setInterval;
    globalThis.clearInterval = this.originals.clearInterval;
    this.originals = undefined;
    this.timers.clear();
  }

  private schedule(
    fn: (...a: unknown[]) => void,
    delayMs: number,
    intervalMs: number | undefined,
    args: unknown[]
  ): VirtualTimerHandle {
    const id = this.nextId++;
    const timer: ScheduledTimer = {
      id,
      at: this.nowMs + Math.max(0, delayMs),
      intervalMs,
      fn,
      args,
    };
    this.timers.set(id, timer);
    const handle: VirtualTimerHandle = {
      __virtualId: id,
      unref: () => handle,
      ref: () => handle,
      refresh: () => {
        timer.at = this.nowMs + Math.max(0, delayMs);
        this.timers.set(id, timer);
        return handle;
      },
      hasRef: () => true,
      [Symbol.toPrimitive]: () => id,
    };
    return handle;
  }

  private cancel(handle: unknown): void {
    if (handle == null) return;
    const id =
      typeof handle === "number"
        ? handle
        : typeof handle === "object" && "__virtualId" in handle
          ? (handle as VirtualTimerHandle).__virtualId
          : undefined;
    if (id !== undefined) this.timers.delete(id);
  }

  /**
   * Advance virtual time, firing due timers in timestamp order. Ties fire in
   * creation order, which is what Node does for same-millisecond timers and is
   * load-bearing here: the completion burst's 0ms flush is scheduled after the
   * debounce timers it collects from.
   */
  async tick(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      let earliest: ScheduledTimer | undefined;
      for (const timer of this.timers.values()) {
        if (timer.at <= target && (!earliest || timer.at < earliest.at)) earliest = timer;
      }
      if (!earliest) break;
      this.nowMs = Math.max(this.nowMs, earliest.at);
      if (earliest.intervalMs !== undefined) earliest.at = this.nowMs + earliest.intervalMs;
      else this.timers.delete(earliest.id);
      earliest.fn(...earliest.args);
      await flushMicrotasks();
    }
    this.nowMs = target;
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

// --- Fleet corpus ------------------------------------------------------------

export interface FleetTerminal {
  id: string;
  agentId: string;
  worktreeId: string;
  title: string;
  location: "grid" | "dock";
  /** Whether a renderer has this panel in its watched set. */
  watched: boolean;
}

/**
 * A fleet the size a real multi-worktree session reaches. Half the panels are
 * watched, because the unwatched half is what the "notify about everything"
 * direction of every predicate here is graded against.
 */
export function buildFleet(size: number): FleetTerminal[] {
  return Array.from({ length: size }, (_, i) => ({
    id: `panel-${i}`,
    agentId: i % 3 === 0 ? "claude" : i % 3 === 1 ? "codex" : "gemini",
    worktreeId: `wt-${i % 8}`,
    title: `agent ${i} — feature/some-reasonably-long-branch-name-${i}`,
    // Half docked, arranged so each of watched/unwatched appears in both
    // locations — escalation is gated on the dock and NOT on the watch set, so
    // a fleet without an unwatched docked panel could not grade that pair.
    location: i % 4 <= 1 ? "dock" : ("grid" as const),
    watched: i % 2 === 0,
  }));
}

/**
 * The `appState` shape `handleStateChanged` reads on EVERY transition. Written
 * through the real store, so the per-decision cost includes the product's own
 * cached-read `structuredClone` of the whole snapshot.
 */
export function appStateForFleet(
  fleet: readonly FleetTerminal[],
  agentState: string
): StoreSchema["appState"] {
  return {
    sidebarWidth: 350,
    focusMode: false,
    activeWorktreeId: "wt-0",
    hasSeenWelcome: true,
    panelGridConfig: { strategy: "automatic", value: 3 },
    terminals: fleet.map((terminal) => ({
      id: terminal.id,
      kind: "terminal" as const,
      title: terminal.title,
      cwd: `/Users/perf/code/repo/${terminal.worktreeId}`,
      worktreeId: terminal.worktreeId,
      location: terminal.location,
      command: "claude --dangerously-skip-permissions",
      agentState,
      lastStateChange: 1_800_000_000_000,
    })),
  } as StoreSchema["appState"];
}

// --- State-change events -----------------------------------------------------

export interface StateChangeInput {
  terminalId: string;
  agentId?: string;
  worktreeId?: string;
  state: AgentState;
  previousState: AgentState;
  waitingReason?: WaitingReason;
}

/**
 * Emit one transition on the real bus, after validating it against the
 * product's own `AgentStateChangedSchema`.
 *
 * The validation is the point: a fixture that fed a shape `AgentStateService`
 * never emits would measure routing over inputs the product cannot receive.
 * Returns false when the payload was rejected, which the scenario counts.
 */
export function emitStateChange(
  modules: NotificationModules,
  clock: NotificationClock,
  input: StateChangeInput
): boolean {
  const payload = {
    terminalId: input.terminalId,
    agentId: input.agentId,
    worktreeId: input.worktreeId,
    state: input.state,
    previousState: input.previousState,
    timestamp: clock.now(),
    trigger: "heuristic" as const,
    confidence: 0.9,
    cwd: "/Users/perf/code/repo",
    ...(input.waitingReason ? { waitingReason: input.waitingReason } : {}),
  };
  if (!modules.agentStateChangedSchema.safeParse(payload).success) return false;
  modules.events.emit("agent:state-changed", payload);
  return true;
}

// --- The routing expectation table -------------------------------------------

export interface ExpectedNotification {
  title: string;
  body: string;
}

export interface RoutingCase {
  label: string;
  input: StateChangeInput;
  /** Null when the transition must produce no OS notification at all. */
  expected: ExpectedNotification | null;
  reason: string;
}

/**
 * Independent restatement of the waiting copy.
 *
 * Deliberately NOT `describeWaiting` from `shared/utils/waitingReasonDisplay`:
 * an oracle that calls the same function the subject calls agrees with itself
 * by construction and grades nothing.
 */
function expectedWaitingBody(subject: string, reason: WaitingReason | undefined): string {
  if (reason === "approval") return `${subject} is waiting for approval`;
  if (reason === "question") return `${subject} asked a question`;
  if (reason === "error") return `${subject} is blocked by an error`;
  return `${subject} is waiting for input`;
}

/**
 * The waiting reason each terminal's wait carries, fixed by index.
 *
 * Strided by two because only the even-indexed panels are watched, and a plain
 * `index % 4` would hand every graded panel one of two reasons — leaving the
 * `question` and `prompt` copy paths declared but never checked.
 */
export function waitingReasonFor(index: number): WaitingReason {
  const reasons: WaitingReason[] = ["approval", "question", "error", "prompt"];
  return reasons[Math.floor(index / 2) % reasons.length]!;
}

/**
 * Eight transitions per terminal, and what each one must produce.
 *
 * Both directions are declared. A watched panel entering `waiting` or settling
 * into `completed`/`exited` MUST produce exactly one OS notification with the
 * copy named here; every other transition, and every transition of an unwatched
 * panel, MUST produce none. A service that notifies nothing satisfies the
 * second half and fails the first; a service that notifies on everything
 * satisfies the first half and fails the second.
 *
 * Escalation and the working pulse are deliberately configured off for this
 * table — they are timer-driven, so they would land in the middle of a later
 * case and make per-transition attribution meaningless. PERF-322 owns them.
 */
export function buildRoutingScript(fleet: readonly FleetTerminal[]): RoutingCase[] {
  const cases: RoutingCase[] = [];
  fleet.forEach((terminal, index) => {
    const reason = waitingReasonFor(index);
    const base = {
      terminalId: terminal.id,
      agentId: terminal.agentId,
      worktreeId: terminal.worktreeId,
    };
    const waitingExpected: ExpectedNotification | null = terminal.watched
      ? { title: "Agent waiting", body: expectedWaitingBody(terminal.agentId, reason) }
      : null;
    const completedExpected: ExpectedNotification | null = terminal.watched
      ? { title: "Agent completed", body: `${terminal.agentId} finished its task` }
      : null;
    const watchNote = terminal.watched ? "watched panel" : "no renderer watches this panel";

    cases.push(
      {
        label: `${terminal.id}:idle->working`,
        input: { ...base, state: "working", previousState: "idle" },
        expected: null,
        reason: "working is not a notified state — it arms the pulse, never a notification",
      },
      {
        label: `${terminal.id}:working->waiting`,
        input: { ...base, state: "waiting", previousState: "working", waitingReason: reason },
        expected: waitingExpected,
        reason: `${watchNote}; waiting is the transition that blocks the user`,
      },
      {
        label: `${terminal.id}:waiting->working`,
        input: { ...base, state: "working", previousState: "waiting" },
        expected: null,
        reason: "leaving waiting cancels escalation and notifies nothing",
      },
      {
        label: `${terminal.id}:working->completed`,
        input: { ...base, state: "completed", previousState: "working" },
        expected: completedExpected,
        reason: `${watchNote}; a settled agent is the other notified state`,
      },
      {
        label: `${terminal.id}:completed->completed`,
        input: { ...base, state: "completed", previousState: "completed" },
        expected: null,
        reason: "a same-state event returns before any routing decision",
      },
      {
        label: `${terminal.id}:completed->working`,
        input: { ...base, state: "working", previousState: "completed" },
        expected: null,
        reason: "leaving completed cancels the debounce timer and notifies nothing",
      },
      {
        label: `${terminal.id}:working->exited`,
        input: { ...base, state: "exited", previousState: "working" },
        expected: completedExpected,
        reason: `${watchNote}; exited routes through the completion path`,
      },
      {
        label: `${terminal.id}:exited->idle`,
        input: { ...base, state: "idle", previousState: "exited" },
        expected: null,
        reason: "returning to idle is not a user-visible event",
      }
    );
  });
  return cases;
}

export interface RoutingGrade {
  /** Expected a notification, got none — the notify-nothing direction. */
  missed: number;
  /** Got a notification that must have been suppressed — the notify-everything direction. */
  spurious: number;
  /** Right decision, wrong copy: the body named the wrong subject or reason. */
  bodyMismatch: number;
}

/**
 * Grade one case against what the subject actually showed.
 *
 * `observed` is the slice of notifications produced while this case, and only
 * this case, was in flight — every routing case is flushed to completion before
 * the next is emitted, so attribution is exact.
 */
export function gradeRoutingCase(
  expected: ExpectedNotification | null,
  observed: readonly StubNativeNotification[]
): RoutingGrade {
  if (expected === null) {
    return { missed: 0, spurious: observed.length, bodyMismatch: 0 };
  }
  if (observed.length === 0) return { missed: 1, spurious: 0, bodyMismatch: 0 };
  const first = observed[0]!;
  const bodyMismatch = first.title === expected.title && first.body === expected.body ? 0 : 1;
  return { missed: 0, spurious: observed.length - 1, bodyMismatch };
}

// --- Window fleet ------------------------------------------------------------

export interface PerfWindow {
  windowId: number;
  /** The view this window is showing — the one a focus event zeroes. */
  webContentsId: number;
  /** Every view hosted by this window, active first: one renderer per project. */
  viewWebContentsIds: number[];
  projectId: string;
  projectName: string;
  /** Every title the product wrote to this window, in order. */
  titles: string[];
  destroyed: boolean;
  webContents: StubWebContents;
  emitFocus: () => void;
  emitBlur: () => void;
  destroy: () => void;
}

export interface PerfWindowFleet {
  registry: WindowRegistry;
  windows: PerfWindow[];
  lookup: (projectId: string) => { name: string; status: "active" } | null;
}

/**
 * A stand-in window fleet for `NotificationService`.
 *
 * `WindowRegistry`, `BrowserWindow` and `ProjectViewManager` cannot exist in a
 * plain Node process, so these are duck-typed objects driven through exactly the
 * surface the service reads. Titles and badge counts are recorded rather than
 * painted; the composition of both is the product's own.
 */
export function createWindowFleet(count: number, viewsPerWindow = 1): PerfWindowFleet {
  const windows: PerfWindow[] = [];
  const contexts: unknown[] = [];
  const bus = notificationBus();

  for (let i = 0; i < count; i += 1) {
    const windowId = 1 + i;
    const webContentsId = 100 + i * 100;
    const projectId = `project-${i}`;
    const focusHandlers: Array<() => void> = [];
    const blurHandlers: Array<() => void> = [];

    const perfWindow: PerfWindow = {
      windowId,
      webContentsId,
      viewWebContentsIds: Array.from({ length: viewsPerWindow }, (_, v) => webContentsId + v),
      projectId,
      projectName: `Project ${i}`,
      titles: [],
      destroyed: false,
      webContents: {
        id: webContentsId,
        isDestroyed: () => perfWindow.destroyed,
        send: (channel, payload) => {
          bus.rendererSends.push({ channel, payload, targetId: webContentsId });
        },
        __perfWindow: null,
      },
      emitFocus: () => {
        for (const handler of [...focusHandlers]) handler();
      },
      emitBlur: () => {
        for (const handler of [...blurHandlers]) handler();
      },
      destroy: () => {
        perfWindow.destroyed = true;
      },
    };

    const browserWindow = {
      __perfWebContents: perfWindow.webContents,
      isDestroyed: () => perfWindow.destroyed,
      isFocused: () => false,
      isMinimized: () => false,
      restore: () => undefined,
      show: () => undefined,
      focus: () => undefined,
      setTitle: (title: string) => {
        perfWindow.titles.push(title);
      },
      on: (event: string, handler: () => void) => {
        if (event === "focus") focusHandlers.push(handler);
        if (event === "blur") blurHandlers.push(handler);
      },
      off: (event: string, handler: () => void) => {
        const list = event === "focus" ? focusHandlers : blurHandlers;
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      },
    };

    perfWindow.webContents.__perfWindow = browserWindow;
    bus.webContentsById.set(webContentsId, perfWindow.webContents);

    contexts.push({
      windowId,
      browserWindow,
      services: {
        projectViewManager: {
          getActiveProjectId: () => projectId,
          getOutgoingBridgeProjectId: () => null,
        },
      },
    });
    windows.push(perfWindow);
  }

  // Every view a window hosts resolves to that window: one window shows an
  // active project view plus any number of cached ones, each its own renderer
  // with its own waiting count.
  const byWebContentsId = new Map<number, unknown>();
  windows.forEach((perfWindow, index) => {
    for (const viewId of perfWindow.viewWebContentsIds) {
      byWebContentsId.set(viewId, contexts[index]);
    }
  });

  const registry = {
    all: () => contexts,
    getPrimary: () => contexts[0],
    getByWebContentsId: (id: number) => byWebContentsId.get(id),
  } as unknown as WindowRegistry;

  const names = new Map(windows.map((w) => [w.projectId, w.projectName]));

  return {
    registry,
    windows,
    lookup: (projectId: string) => {
      const name = names.get(projectId);
      return name ? { name, status: "active" as const } : null;
    },
  };
}

/** Drop the fleet's webContents from the stub registry between iterations. */
export function disposeWindowFleet(fleet: PerfWindowFleet): void {
  const bus = notificationBus();
  for (const perfWindow of fleet.windows) bus.webContentsById.delete(perfWindow.webContentsId);
}

// --- Idle-terminal corpus ----------------------------------------------------

/** Why a project is or is not expected in the idle broadcast. */
export type IdleProjectKind =
  | "eligible"
  | "on-screen"
  | "active-agent"
  | "recently-active"
  | "no-terminals"
  | "pty-less"
  | "unknown-activity"
  | "dismissed";

export interface IdleProjectCase {
  projectId: string;
  projectName: string;
  kind: IdleProjectKind;
  /** The first real sweep's expectation. */
  expectNotified: boolean;
  reason: string;
}

const IDLE_KIND_ORDER: readonly IdleProjectKind[] = [
  "eligible",
  "on-screen",
  "active-agent",
  "recently-active",
  "no-terminals",
  "pty-less",
  "unknown-activity",
  "dismissed",
];

const IDLE_KIND_REASON: Record<IdleProjectKind, string> = {
  eligible: "every terminal idle past the threshold, nothing on screen, no cooldown",
  "on-screen": "foreground in a window — a project the user is looking at is never nudged",
  "active-agent": "an agent is working, so the terminals are not idle",
  "recently-active": "output inside the threshold window",
  "no-terminals": "nothing to close",
  "pty-less": "its only terminals have no PTY, so they do not count as terminals",
  "unknown-activity": "no activity timestamps at all — the sweep is conservative",
  dismissed: "the user muted this project inside the cooldown",
};

export interface IdleTerminalRow {
  id: string;
  projectId: string;
  cwd: string;
  spawnedAt: number;
  hasPty?: boolean;
  agentState?: AgentState;
  lastInputTime?: number;
  lastOutputTime?: number;
}

export interface IdleCorpus {
  cases: IdleProjectCase[];
  terminals: IdleTerminalRow[];
  /** Project ids on screen in some window — the visibility half of the gate. */
  onScreenProjectIds: string[];
  /** Project ids to seed into `idleTerminalDismissals`. */
  dismissedProjectIds: string[];
  expectedNotifiedIds: string[];
  terminalCount: number;
}

/**
 * `projectCount` projects × `terminalsPerProject` terminals, cycling through
 * every reason the sweep can reach a verdict, so one run grades both directions:
 * the eligible projects MUST appear in the broadcast, and every other kind MUST
 * NOT — a sweep that broadcasts everything is as wrong as one that broadcasts
 * nothing, and faster than the real one either way.
 */
export function buildIdleCorpus(
  projectCount: number,
  terminalsPerProject: number,
  nowMs: number,
  thresholdMinutes: number
): IdleCorpus {
  const thresholdMs = thresholdMinutes * 60_000;
  const idleAt = nowMs - thresholdMs - 5 * 60_000;
  const recentAt = nowMs - 60_000;
  const cases: IdleProjectCase[] = [];
  const terminals: IdleTerminalRow[] = [];
  const onScreenProjectIds: string[] = [];
  const dismissedProjectIds: string[] = [];

  for (let i = 0; i < projectCount; i += 1) {
    const kind = IDLE_KIND_ORDER[i % IDLE_KIND_ORDER.length]!;
    const projectId = `idle-project-${i}`;
    cases.push({
      projectId,
      projectName: `Idle Project ${i}`,
      kind,
      expectNotified: kind === "eligible",
      reason: IDLE_KIND_REASON[kind],
    });

    if (kind === "on-screen") onScreenProjectIds.push(projectId);
    if (kind === "dismissed") dismissedProjectIds.push(projectId);
    if (kind === "no-terminals") continue;

    for (let t = 0; t < terminalsPerProject; t += 1) {
      const row: IdleTerminalRow = {
        id: `${projectId}-term-${t}`,
        projectId,
        cwd: `/Users/perf/code/${projectId}`,
        spawnedAt: idleAt,
        hasPty: kind !== "pty-less",
        lastInputTime: idleAt,
        lastOutputTime: idleAt,
      };
      if (kind === "active-agent" && t === 0) row.agentState = "working";
      if (kind === "recently-active" && t === 0) row.lastOutputTime = recentAt;
      if (kind === "unknown-activity") {
        delete row.lastInputTime;
        delete row.lastOutputTime;
      }
      terminals.push(row);
    }
  }

  return {
    cases,
    terminals,
    onScreenProjectIds,
    dismissedProjectIds,
    expectedNotifiedIds: cases.filter((c) => c.expectNotified).map((c) => c.projectId),
    terminalCount: terminals.length,
  };
}

/** The `PtyClient` surface the idle sweep reads: one call, one list. */
export function idlePtyClientStub(rows: readonly IdleTerminalRow[]): {
  getAllTerminalsAsync: () => Promise<readonly IdleTerminalRow[]>;
} {
  return { getAllTerminalsAsync: async () => rows };
}

/** A `ProjectViewManagersProvider` over a fixed set of foreground projects. */
export function onScreenProvider(projectIds: readonly string[]): ProjectViewManagersProvider {
  const managers = projectIds.map((projectId) => ({
    getActiveProjectId: () => projectId,
    getOutgoingBridgeProjectId: () => null,
  }));
  return () => managers as unknown as ReturnType<ProjectViewManagersProvider>;
}

/**
 * Grade one broadcast against the corpus, in both directions at once.
 * `notified` is the set of project ids the sweep actually broadcast.
 */
export function gradeIdleSweep(
  expectedIds: readonly string[],
  notified: ReadonlySet<string>
): { missed: number; spurious: number } {
  const expected = new Set(expectedIds);
  let missed = 0;
  for (const id of expected) if (!notified.has(id)) missed += 1;
  let spurious = 0;
  for (const id of notified) if (!expected.has(id)) spurious += 1;
  return { missed, spurious };
}
