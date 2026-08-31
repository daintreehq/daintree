/**
 * The real electron-store migration chain, driven end to end.
 *
 * PERF-080 used to reimplement all sixteen v0→v17 migrations inside the
 * scenario file. That benchmark could not regress when the product did: it
 * measured a hand-written copy of the chain, so the only thing its oracle
 * proved was that the copy still ran. This fixture drives the shipped
 * `MigrationRunner` over the shipped `migrations` barrel (v0→v27), against a
 * real `config.json` on disk opened through the product's own
 * `initializeStore()` — the same call `globalServicesInit` makes at boot.
 *
 * ## How the main-process graph loads outside Electron
 *
 * `migrations/index.ts` reaches `electron.app` at module scope (ProjectStore in
 * migration 003, DiskSpaceMonitor under StoreMigrations), so the graph is
 * esbuild-bundled with the bare `electron` specifier remapped to an inert
 * stand-in — the same technique `worktreeSidebarFixture.ts` uses for the
 * renderer store. A Node loader hook would have worked under `tsx` but not
 * under Vitest, where Vite resolves imports itself; bundling behaves
 * identically in both, which matters because `__tests__/scenarioMatrix.test.ts`
 * executes PERF-080's `run()`.
 *
 * Nothing in the product graph is stubbed except `electron` itself.
 * `better-sqlite3` is left external (native addon) and resolves from the repo's
 * own `node_modules`, which is why the bundle is written under `.tmp/`.
 *
 * ## Scope limits
 *
 * - There is no Electron: `app.getPath` and friends are stand-ins, so nothing
 *   here prices Electron's own store bootstrap or the boot-critical path the
 *   chain actually runs on. What is real is every byte the chain reads, writes
 *   and rewrites — including electron-store's whole-file atomic write per
 *   `set`, which is what makes this scenario expensive.
 * - The chain's ~40 `console.log` lines are silenced inside the timed bracket.
 *   Console cost depends on whether stdout is a TTY or a pipe, which is a
 *   property of the harness, not of the migrations; the counts are reported as
 *   `chainLogLines` so a chain that suddenly starts shouting is still visible.
 * - Migration 003 needs a current project. One is seeded into the real
 *   `projects`/`app_state` tables of a real SQLite database at harness load, so
 *   003 runs its real path (500 recipes converted and written through
 *   `ProjectFileStore` to `projects/<id>/recipes.json`) instead of taking its
 *   "no current project" early return.
 *
 * ## The fixture corpus
 *
 * `createHeavyMigrationFixture()` is a worst-case union, not a historically
 * reachable v0 snapshot: it carries every legacy key the chain targets at once
 * so that no migration silently no-ops and every migration's output is
 * gradeable. That intent predates this rewrite — the corpus already mixed v0
 * terminals with post-012 `pinned` agent entries — and is stated here because
 * the predicate is derived from the counts, not from what the chain reports
 * about itself.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StoreSchema } from "../../../electron/store";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

/** One ring-buffer record as the migrations see it: an opaque object with an id. */
type RingRecord = { id: string; [key: string]: unknown };

/**
 * The store as it looked at schema version 0, plus every legacy key a later
 * migration is written to consume.
 *
 * Annotating the fixture as `StoreSchema` would assert the migrations had
 * already run: v0 terminals carry no `location` (002 adds it), notification
 * sound config is still one `soundFile` (008 splits it into three), agent
 * entries still hold `selected`/`enabled` (012/013 rewrite them) and
 * `flavorId` (016 renames it), onboarding has no checklist (005 adds it),
 * telemetry consent is still its own top-level block (014 folds it into
 * `privacy`), and the audit rings still live in `config.json` (022/023 move
 * them out). Only the slices those migrations touch are relaxed — every other
 * field is still held to the product type, so drift outside the migrated
 * surface stays a type error.
 */
type LegacyStoreV0 = Omit<
  StoreSchema,
  | "appState"
  | "notificationSettings"
  | "agentSettings"
  | "onboarding"
  | "privacy"
  | "mcpServer"
  | "plugins"
  | "forgeAudit"
  | "runHistory"
  | "pluginMcpAudit"
> & {
  appState: Omit<StoreSchema["appState"], "terminals"> & {
    terminals: Array<Omit<StoreSchema["appState"]["terminals"][number], "location">>;
    /** Retired by migration 019. */
    fleetDeckOpen: boolean;
  };
  notificationSettings: Omit<
    StoreSchema["notificationSettings"],
    | "completedSoundFile"
    | "waitingSoundFile"
    | "escalationSoundFile"
    | "workingPulseEnabled"
    | "workingPulseSoundFile"
    | "uiFeedbackSoundEnabled"
    | "quietHoursEnabled"
    | "quietHoursStartMin"
    | "quietHoursEndMin"
    | "quietHoursWeekdays"
  > & { soundFile: string };
  agentSettings: Omit<StoreSchema["agentSettings"], "agents"> & {
    agents: Record<string, Record<string, unknown>>;
  };
  /** Migration 005 introduces `checklist`; a true v0 store has none. */
  onboarding: Omit<StoreSchema["onboarding"], "checklist">;
  /** Migration 014 seeds both fields from the legacy `telemetry` block. */
  privacy: Omit<StoreSchema["privacy"], "telemetryLevel" | "hasSeenPrompt">;
  /** Retired by migration 014. */
  telemetry: { enabled: boolean; hasSeenPrompt: boolean };
  mcpServer: Omit<StoreSchema["mcpServer"], "auditLog" | "turnOutcomeLog"> & {
    auditLog: RingRecord[];
    turnOutcomeLog: RingRecord[];
    /** Retired by migration 026. */
    fullToolSurface: boolean;
  };
  plugins: Omit<StoreSchema["plugins"], "auditLog" | "disabledBuiltins"> & {
    auditLog: RingRecord[];
    /** Merged into `disabled` by migration 021. */
    disabledBuiltins: string[];
  };
  forgeAudit: Omit<StoreSchema["forgeAudit"], "auditLog"> & { auditLog: RingRecord[] };
  runHistory: { records: RingRecord[] };
  pluginMcpAudit: Omit<StoreSchema["pluginMcpAudit"], "auditLog"> & { auditLog: RingRecord[] };
};

/**
 * Every cardinality the correctness predicate derives its expectations from.
 *
 * The oracle never asks the chain how much work it did — it recomputes what
 * the chain owed from these numbers and diffs against what landed on disk.
 */
export const HEAVY_FIXTURE_COUNTS = {
  terminals: 10_000,
  recipes: 500,
  /** Half carry legacy `selected`/`enabled` (012), half are phantom pins (013). */
  agents: 200,
  /** The 100 phantom pins are deleted by 013; the even-indexed half survives. */
  survivingAgents: 100,
  worktrees: 100,
  pendingErrors: 100,
  envVars: 100,
  disabledBuiltins: 6,
  disabledPlugins: 2,
  mcpAuditRecords: 300,
  mcpTurnOutcomeRecords: 150,
  pluginAuditRecords: 200,
  forgeAuditRecords: 200,
  runHistoryRecords: 200,
  pluginMcpAuditRecords: 200,
} as const;

/** The legacy window geometry migration 009 must carry into `windowStates`. */
export const LEGACY_WINDOW_STATE = { x: 120, y: 64, width: 1440, height: 900 } as const;

/** The legacy GitHub token migration 024 must move into `forgeCredentials`. */
export const LEGACY_GITHUB_TOKEN = "ghp_perf_fixture_legacy_token";

/**
 * The `forgeCredentials` key migration 024 writes the token under. Spelled out
 * rather than imported from `BUILTIN_GITHUB_PROVIDER_ID` on the same reasoning
 * the migration itself gives for duplicating `recordHasCredential`: the oracle
 * should assert what schema v24 committed to, not track whatever the live
 * constant becomes.
 */
export const BUILTIN_GITHUB_CREDENTIAL_KEY = "daintree.github.github";

/** The project id migration 003 writes its converted recipes under. */
export const FIXTURE_PROJECT_ID = "a".repeat(64);

function ring(prefix: string, count: number): RingRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    at: 1_700_000_000_000 + i * 1000,
    actor: `${prefix}-actor-${i % 12}`,
    outcome: i % 7 === 0 ? "denied" : "allowed",
    detail: `${prefix} record ${i} recorded by the perf fixture`,
  }));
}

export function createHeavyMigrationFixture(): LegacyStoreV0 {
  const {
    terminals: terminalCount,
    recipes: recipeCount,
    agents: agentCount,
    worktrees: worktreeCount,
    pendingErrors: pendingErrorCount,
    envVars: envVarCount,
  } = HEAVY_FIXTURE_COUNTS;

  const terminals: LegacyStoreV0["appState"]["terminals"] = Array.from(
    { length: terminalCount },
    (_, i) => ({
      id: `term-${i}`,
      title: `Terminal ${i}`,
      cwd: `/repo/worktrees/wt-${i % worktreeCount}/src`,
      worktreeId: `wt-${i % worktreeCount}`,
      // v0 schema — no `location` field (migration 002 adds it)
    })
  );

  const recipes: StoreSchema["appState"]["recipes"] = Array.from(
    { length: recipeCount },
    (_, i) => ({
      id: `recipe-${i}`,
      name: `Recipe ${i}`,
      worktreeId: i % 2 === 0 ? `wt-${i % worktreeCount}` : undefined,
      terminals: Array.from({ length: 3 }, (_, j) => ({
        type: "terminal" as const,
        title: `Tab ${j}`,
        command: `echo ${i}-${j}`,
      })),
      createdAt: 1_700_000_000_000 - i * 1000,
      showInEmptyState: i < 10,
      lastUsedAt: i % 5 === 0 ? 1_700_000_000_000 - i * 5000 : undefined,
    })
  );

  const agents: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < agentCount; i++) {
    if (i % 2 === 0) {
      // Migration 012's target: legacy selected/enabled, no `pinned`. Carries
      // 016's rename targets too, so the surviving half exercises both.
      agents[`agent-${i}`] = {
        selected: i % 3 !== 0,
        enabled: true,
        customFlag: `value-${i}`,
        flavorId: `preset-${i}`,
        customFlavors: [`custom-${i}`],
      };
    } else {
      // Migration 013's phantom-pin target: deleted outright.
      agents[`agent-${i}`] = { pinned: true };
    }
  }

  const worktreeIssueMap: StoreSchema["worktreeIssueMap"] = {};
  for (let i = 0; i < worktreeCount; i++) {
    worktreeIssueMap[`wt-${i}`] = {
      issueNumber: 1000 + i,
      issueTitle: `Perf fixture issue ${1000 + i} in org/repo`,
    };
  }

  const globalEnvironmentVariables: Record<string, string> = {};
  for (let i = 0; i < envVarCount; i++) {
    globalEnvironmentVariables[`PERF_VAR_${i}`] = `value-${i}`;
  }

  const pendingErrors: StoreSchema["pendingErrors"] = Array.from(
    { length: pendingErrorCount },
    (_, i) => ({
      id: `perf-error-${i}`,
      message: `Error ${i}: something went wrong in module-${i % 20}`,
      details: `at module${i % 20} (line ${i}): error in perf fixture`,
      timestamp: 1_700_000_000_000 - i * 60000,
      type: i % 5 === 0 ? ("filesystem" as const) : ("process" as const),
      retryability: i % 5 === 0 ? ("none" as const) : ("auto" as const),
      dismissed: false,
      source: `module-${i % 20}`,
      correlationId: `ERR_${i}`,
    })
  );

  return {
    _schemaVersion: 0,
    windowState: { ...LEGACY_WINDOW_STATE, isMaximized: false },
    terminalConfig: {
      scrollbackLines: 2500,
      performanceMode: false,
    },
    hibernation: { enabled: false, inactiveThresholdHours: 24 },
    idleTerminalNotify: { enabled: true, thresholdMinutes: 60 },
    idleTerminalDismissals: {},
    idleTerminalNotifiedAt: {},
    parkedRuns: {},
    snoozedRuns: {},
    idleBackgroundAutoClose: { enabled: false, thresholdMinutes: 15 },
    pluginBackgroundUpdateCheck: { enabled: false, lastCheckedAt: null },
    appState: {
      activeWorktreeId: "wt-0",
      sidebarWidth: 350,
      focusMode: false,
      terminals,
      recipes,
      hasSeenWelcome: true,
      panelGridConfig: { strategy: "automatic" as const, value: 3 },
      fleetDeckOpen: true,
    },
    userConfig: { githubToken: LEGACY_GITHUB_TOKEN },
    worktreeConfig: {
      pathPattern: "{parent-dir}/{base-folder}-worktrees/{branch-slug}",
    },
    agentSettings: {
      agents,
    },
    notificationSettings: {
      enabled: true,
      completedEnabled: false,
      waitingEnabled: false,
      soundEnabled: true,
      soundFile: "ping.wav",
      waitingEscalationEnabled: true,
      waitingEscalationDelayMs: 180_000,
    },
    userAgentRegistry: {},
    agentUpdateSettings: {
      autoCheck: true,
      checkFrequencyHours: 24,
      lastAutoCheck: null,
    },
    keybindingOverrides: { overrides: {} },
    projectEnv: {},
    globalEnvironmentVariables,
    appAgentConfig: {} as StoreSchema["appAgentConfig"],
    windowStates: {},
    worktreeIssueMap,
    wslGitByWorktree: {},
    rosettaWarningDismissed: false,
    appTheme: { colorSchemeId: "daintree" },
    telemetry: { enabled: true, hasSeenPrompt: true },
    privacy: {
      logRetentionDays: 30,
    },
    agentSessionHistory: { retentionDays: 30 },
    voiceInput: {
      enabled: true,
      openaiApiKey: "",
      deepgramApiKey: "",
      language: "en",
      customDictionary: [],
      transcriptionProvider: "deepgram",
      transcriptionModel: "nova-3",
      correctionEnabled: false,
      correctionModel: "gpt-5-nano",
      correctionCustomInstructions: "",
      paragraphingStrategy: "spoken-command",
      resolveFileLinks: false,
      deviceId: "",
      organizationId: "",
      projectId: "",
      recordingMode: "push-to-talk",
      suggestedDictionary: [],
      learnFromCorrections: false,
    },
    mcpServer: {
      enabled: false,
      port: 45454,
      apiKey: "",
      auditEnabled: false,
      auditMaxRecords: 500,
      abusePolicyEnabled: false,
      abusePolicyMaxDenials: 5,
      abusePolicyWindowMs: 60_000,
      fullToolSurface: true,
      auditLog: ring("mcp-audit", HEAVY_FIXTURE_COUNTS.mcpAuditRecords),
      turnOutcomeLog: ring("mcp-turn", HEAVY_FIXTURE_COUNTS.mcpTurnOutcomeRecords),
    },
    helpAssistant: {
      docSearch: true,
      daintreeControl: false,
      tier: "workbench",
      bypassPermissions: false,
      auditRetention: 30,
    },
    pendingErrors,
    errorFingerprints: {},
    gpu: { hardwareAccelerationDisabled: false },
    crashRecovery: { autoRestoreOnCrash: false },
    onboarding: {
      schemaVersion: 0,
      completed: true,
      currentStep: null,
      agentSetupIds: [],
      firstRunToastSeen: false,
      newsletterPromptSeen: false,
      waitingNudgeSeen: false,
      seenAgentIds: [],
      availabilityFirstSeen: {},
      welcomeCardDismissed: false,
      setupBannerDismissed: false,
    },
    orchestrationMilestones: {},
    shortcutHintCounts: {},
    updateChannel: "stable",
    logLevelOverrides: {},
    plugins: {
      disabled: Array.from({ length: HEAVY_FIXTURE_COUNTS.disabledPlugins }, (_, i) => `user-${i}`),
      disabledBuiltins: Array.from(
        { length: HEAVY_FIXTURE_COUNTS.disabledBuiltins },
        (_, i) => `builtin-${i}`
      ),
      auditEnabled: true,
      auditMaxRecords: 500,
      installed: {},
      auditLog: ring("plugin-audit", HEAVY_FIXTURE_COUNTS.pluginAuditRecords),
    },
    forgeAudit: {
      auditEnabled: true,
      auditMaxRecords: 500,
      auditLog: ring("forge-audit", HEAVY_FIXTURE_COUNTS.forgeAuditRecords),
    },
    runHistory: { records: ring("run-history", HEAVY_FIXTURE_COUNTS.runHistoryRecords) },
    pluginMcpAudit: {
      auditEnabled: true,
      auditMaxRecords: 500,
      auditLog: ring("plugin-mcp-audit", HEAVY_FIXTURE_COUNTS.pluginMcpAuditRecords),
    },
    pluginMcpConsent: {},
    pluginMcpConfig: { maxToolsPerSession: 64 },
    pluginCapabilityConsent: {},
  };
}

/**
 * Returns the serialized byte size floor for the heavy fixture. A corpus that
 * shrinks below this no longer exercises the O(N) migration paths, and the
 * scenario refuses to report a number it would be measuring for the wrong
 * reason.
 */
export function getHeavyFixtureMinBytes(): number {
  return 1_000_000;
}

// --- The real chain ----------------------------------------------------------

/** Minimal shape of the electron-store instance the runner is handed. */
interface StoreLike {
  path: string;
  get: (key: string, defaultValue?: unknown) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
}

interface MigrationModule {
  MigrationRunner: new (store: unknown) => { runMigrations: (m: unknown[]) => Promise<void> };
  LATEST_SCHEMA_VERSION: number;
  migrations: unknown[];
  initializeStore: () => StoreLike;
  _resetStoreInstance: () => void;
  windowStatesStore: StoreLike;
  auditLogsStore: StoreLike;
  getSharedDb: () => unknown;
  schema: Record<string, unknown>;
}

/**
 * Inert `electron` stand-in. The export list is deliberately wider than the
 * graph needs today: a missing name is an esbuild link error rather than a
 * graceful undefined, so it is cheap insurance against a product import added
 * later.
 */
const ELECTRON_STUB = `
const bridge = globalThis.__daintreePerfMigrationElectron;
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

function buildElectronBridge(userData: string): Record<string, unknown> {
  const noop = (): void => {};
  return {
    app: {
      isPackaged: false,
      getPath: () => userData,
      getAppPath: () => repoRoot,
      getVersion: () => "0.0.0-perf",
      getName: () => "daintree-perf",
      on: noop,
      once: noop,
      setPath: noop,
      whenReady: () => Promise.resolve(),
      exit: noop,
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
    WebContentsView: class {},
    session: {
      defaultSession: { protocol: { handle: noop } },
      fromPartition: () => ({ protocol: { handle: noop } }),
    },
    webContents: { fromId: () => null, getAllWebContents: () => [] as unknown[] },
    ipcMain: { on: noop, once: noop, handle: noop, removeHandler: noop, removeAllListeners: noop },
    nativeTheme: { shouldUseDarkColors: true, on: noop },
    nativeImage: { createFromPath: () => ({}), createEmpty: () => ({}) },
    shell: { openExternal: () => Promise.resolve() },
    dialog: {},
    screen: { getAllDisplays: () => [] as unknown[], on: noop },
    powerMonitor: { on: noop },
    powerSaveBlocker: { start: () => 0, stop: noop },
    clipboard: { writeText: noop, readText: () => "" },
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
    protocol: { handle: noop, registerSchemesAsPrivileged: noop },
    net: { fetch: () => Promise.reject(new Error("net unavailable in perf harness")) },
    utilityProcess: { fork: () => ({}) },
    MessageChannelMain: class {},
    systemPreferences: { getMediaAccessStatus: () => "granted" },
    safeStorage: { isEncryptionAvailable: () => false },
    globalShortcut: { register: () => false, unregisterAll: noop },
    crashReporter: { start: noop },
    contextBridge: { exposeInMainWorld: noop },
    desktopCapturer: {},
    inAppPurchase: {},
  };
}

const tempRoots: string[] = [];
let exitHookInstalled = false;

function registerCleanup(dir: string): void {
  tempRoots.push(dir);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const root of tempRoots) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // The OS will get it eventually.
      }
    }
  });
}

async function buildMigrationBundle(userData: string): Promise<MigrationModule> {
  const esbuild = await import("esbuild");
  // The bundle leaves `better-sqlite3` external (native addon), so it has to
  // sit somewhere the repo's own node_modules resolves from — hence `.tmp/`
  // inside the repo rather than the OS temp root.
  mkdirSync(join(repoRoot, ".tmp"), { recursive: true });
  const outDir = mkdtempSync(join(repoRoot, ".tmp", "perf-migration-bundle-"));
  registerCleanup(outDir);

  const entryFile = join(outDir, "entry.ts");
  const src = (rel: string): string => JSON.stringify(join(repoRoot, rel));
  writeFileSync(
    entryFile,
    [
      `export { MigrationRunner, LATEST_SCHEMA_VERSION } from ${src("electron/services/StoreMigrations.ts")};`,
      `export { migrations } from ${src("electron/services/migrations/index.ts")};`,
      `export { initializeStore, _resetStoreInstance, windowStatesStore, auditLogsStore } from ${src("electron/store.ts")};`,
      `export { getSharedDb } from ${src("electron/services/persistence/db.ts")};`,
      `export * as schema from ${src("electron/services/persistence/schema.ts")};`,
      "",
    ].join("\n")
  );

  const outfile = join(outDir, "bundle.mjs");
  await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
    external: ["better-sqlite3"],
    alias: { "@shared": join(repoRoot, "shared") },
    plugins: [
      {
        name: "daintree-electron-stub",
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, () => ({
            path: "electron",
            namespace: "daintree-electron-stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "daintree-electron-stub" }, () => ({
            contents: ELECTRON_STUB,
            loader: "js",
          }));
        },
      },
    ],
  });

  (globalThis as Record<string, unknown>).__daintreePerfMigrationElectron =
    buildElectronBridge(userData);

  // `electron/store.ts` binds `storeOptions.cwd` from DAINTREE_USER_DATA at
  // module evaluation, so the variable has to be settled across the import and
  // is restored immediately after — every later read in this graph goes
  // through the stand-in `app.getPath`, which is bound to the same directory.
  const previous = process.env.DAINTREE_USER_DATA;
  process.env.DAINTREE_USER_DATA = userData;
  try {
    return (await import(pathToFileURL(outfile).href)) as unknown as MigrationModule;
  } finally {
    if (previous === undefined) delete process.env.DAINTREE_USER_DATA;
    else process.env.DAINTREE_USER_DATA = previous;
  }
}

/**
 * Per-migration miss accumulators. Every field reads 0 when the chain did its
 * work and rises with the number of things it failed to do; each is counted at
 * the check site rather than assigned a literal, so deleting a migration
 * cannot leave a term that still totals to the healthy value.
 */
export interface MigrationGrade {
  /** 002 — every terminal must carry `location: "grid"`. */
  terminalLocationMisses: number;
  /** 003 — the global recipe array is emptied and 500 land in the project file. */
  recipeMigrationMisses: number;
  /** 008/010/011/017 — the notification slice. */
  notificationMisses: number;
  /** 009/020 — the legacy window geometry reaches the window-states store. */
  windowStateMisses: number;
  /** 012 — every surviving agent entry is pinned-shaped. */
  agentPinMisses: number;
  /** 013 — the 100 phantom pins are gone and exactly 100 entries remain. */
  phantomPinMisses: number;
  /** 016 — flavorId/customFlavors renamed on every surviving entry. */
  agentPresetMisses: number;
  /** 018 — the legacy notes directory was archived, not left in place. */
  notesArchiveMisses: number;
  /** 022/023 — all six rings left config.json and landed in the audit store. */
  auditRingMisses: number;
  /** 004/005/007/014/015/019/021/024/025/026/027 — the O(1) rewrites. */
  scalarMigrationMisses: number;
  /** MigrationRunner's own pre-migration backup of the v0 store. */
  backupMisses: number;
  /** The runner stamped the chain's terminal version. */
  schemaVersionMisses: number;
  /** Sum of every accumulator above. */
  migrationMisses: number;
  // Reported alongside, not graded.
  terminalCount: number;
  recipeCount: number;
  agentCount: number;
  bytes: number;
  backupBytes: number;
  schemaVersion: number;
  chainLogLines: number;
}

export interface MigrationHarness {
  /** Absolute path of the benchmark user-data directory. */
  userData: string;
  /** The schema version the shipped chain terminates at. */
  latestSchemaVersion: number;
  /** Serialized byte size of the v0 corpus written before each iteration. */
  fixtureBytes: number;
  /** Reset the store to v0 on disk and open it through the product's own path. */
  prepareIteration: () => StoreLike;
  /** The timed bracket: the real MigrationRunner over the real barrel. */
  runChain: (store: StoreLike) => Promise<void>;
  /** Read the post-conditions back off disk. Never calls the subject. */
  grade: () => MigrationGrade;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ringLength(store: Record<string, unknown> | null, key: string): number {
  const value = store?.[key];
  return Array.isArray(value) ? value.length : -1;
}

let harnessPromise: Promise<MigrationHarness> | null = null;

export function loadMigrationHarness(): Promise<MigrationHarness> {
  if (!harnessPromise) harnessPromise = buildHarness();
  return harnessPromise;
}

async function buildHarness(): Promise<MigrationHarness> {
  const userData = mkdtempSync(join(tmpdir(), "daintree-perf-migrations-"));
  registerCleanup(userData);

  const mod = await buildMigrationBundle(userData);
  const fixture = createHeavyMigrationFixture();
  const fixtureJson = JSON.stringify(fixture);
  const configPath = join(userData, "config.json");
  const notesDir = join(userData, "notes");
  const archivedDir = join(userData, "notes_archived");
  const recipesPath = join(userData, "projects", FIXTURE_PROJECT_ID, "recipes.json");

  // Migration 003 reads the current project out of SQLite. Seed a real row in
  // the real database so it runs its real path instead of the "no current
  // project" early return that would leave 500 recipes untouched. Opening the
  // shared DB here also keeps drizzle's own migrate() out of iteration one.
  const db = mod.getSharedDb() as {
    insert: (t: unknown) => {
      values: (v: unknown) => {
        onConflictDoNothing: () => { run: () => void };
        onConflictDoUpdate: (c: unknown) => { run: () => void };
      };
    };
  };
  const schema = mod.schema as {
    projects: unknown;
    appState: { key: unknown };
  };
  db.insert(schema.projects)
    .values({
      id: FIXTURE_PROJECT_ID,
      path: join(userData, "repo"),
      name: "perf fixture project",
      emoji: "🌳",
      lastOpened: 1_700_000_000_000,
    })
    .onConflictDoNothing()
    .run();
  db.insert(schema.appState)
    .values({ key: "currentProjectId", value: FIXTURE_PROJECT_ID })
    .onConflictDoUpdate({
      target: schema.appState.key,
      set: { value: FIXTURE_PROJECT_ID },
    })
    .run();

  let chainLogLines = 0;
  // Size of config.json as the runner finds it, captured after the product's
  // own store construction has had its chance to rewrite the file. The backup
  // oracle compares against this rather than against the bytes written above,
  // so it asserts "the runner copied the store it was about to migrate".
  let preChainConfigBytes = 0;

  return {
    userData,
    latestSchemaVersion: mod.LATEST_SCHEMA_VERSION,
    fixtureBytes: fixtureJson.length,

    prepareIteration(): StoreLike {
      for (const entry of readdirSync(userData)) {
        if (entry.startsWith("config.json")) rmSync(join(userData, entry), { force: true });
      }
      rmSync(join(userData, "projects", FIXTURE_PROJECT_ID), { recursive: true, force: true });
      rmSync(archivedDir, { recursive: true, force: true });
      mkdirSync(notesDir, { recursive: true });
      writeFileSync(join(notesDir, "legacy-note.md"), "# a note from before #5616\n");
      // Both sidecar stores are process-wide singletons, so an iteration would
      // otherwise grade the rings the previous iteration moved.
      mod.windowStatesStore.set("windowStates", {});
      for (const key of [
        "mcpAuditLog",
        "mcpTurnOutcomeLog",
        "pluginAuditLog",
        "forgeAuditLog",
        "runHistoryRecords",
        "pluginMcpAuditLog",
      ]) {
        mod.auditLogsStore.set(key, []);
      }
      writeFileSync(configPath, fixtureJson);
      mod._resetStoreInstance();
      const store = mod.initializeStore();
      preChainConfigBytes = statSync(configPath).size;
      return store;
    },

    async runChain(store: StoreLike): Promise<void> {
      const runner = new mod.MigrationRunner(store);
      const real = { log: console.log, warn: console.warn, error: console.error };
      const count = (): void => {
        chainLogLines += 1;
      };
      console.log = count;
      console.warn = count;
      console.error = count;
      chainLogLines = 0;
      try {
        await runner.runMigrations(mod.migrations);
      } finally {
        console.log = real.log;
        console.warn = real.warn;
        console.error = real.error;
      }
    },

    grade(): MigrationGrade {
      const config = readJson(configPath) ?? {};
      const appState = asRecord(config.appState);
      const agents = asRecord(asRecord(config.agentSettings)?.agents) ?? {};
      const notifications = asRecord(config.notificationSettings);
      const windowStates = readJson(join(userData, "window-states.json"));
      const auditLogs = readJson(join(userData, "audit-logs.json"));
      const savedRecipes = readJson(recipesPath);

      // --- 002
      let terminalLocationMisses = 0;
      const terminals = Array.isArray(appState?.terminals)
        ? (appState.terminals as Array<Record<string, unknown>>)
        : [];
      terminalLocationMisses += Math.abs(terminals.length - HEAVY_FIXTURE_COUNTS.terminals);
      for (const terminal of terminals) {
        if (terminal?.location !== "grid") terminalLocationMisses += 1;
      }

      // --- 003
      let recipeMigrationMisses = 0;
      const leftInConfig = Array.isArray(appState?.recipes)
        ? (appState.recipes as unknown[]).length
        : -1;
      if (leftInConfig !== 0) recipeMigrationMisses += 1;
      const written = Array.isArray(savedRecipes?.recipes)
        ? (savedRecipes.recipes as Array<Record<string, unknown>>)
        : [];
      recipeMigrationMisses += Math.abs(written.length - HEAVY_FIXTURE_COUNTS.recipes);
      const writtenIds = new Set(written.map((recipe) => String(recipe.id)));
      for (let i = 0; i < HEAVY_FIXTURE_COUNTS.recipes; i += 1) {
        if (!writtenIds.has(`recipe-${i}`)) recipeMigrationMisses += 1;
      }
      for (const recipe of written) {
        if (recipe.projectId !== FIXTURE_PROJECT_ID) recipeMigrationMisses += 1;
      }

      // --- 008 / 010 / 011 / 017
      let notificationMisses = 0;
      const expectNotification: Array<[string, unknown]> = [
        ["soundFile", undefined],
        ["completedSoundFile", "ping.wav"],
        ["waitingSoundFile", "waiting.wav"],
        ["escalationSoundFile", "ping.wav"],
        ["workingPulseEnabled", false],
        ["workingPulseSoundFile", "pulse.wav"],
        ["waitingEnabled", true],
        ["waitingEscalationEnabled", false],
        ["quietHoursEnabled", false],
        ["quietHoursStartMin", 22 * 60],
        ["quietHoursEndMin", 8 * 60],
      ];
      for (const [key, expected] of expectNotification) {
        if (notifications?.[key] !== expected) notificationMisses += 1;
      }
      if (!Array.isArray(notifications?.quietHoursWeekdays)) notificationMisses += 1;

      // --- 009 / 020
      let windowStateMisses = 0;
      if (config.windowState !== undefined) windowStateMisses += 1;
      if (config.windowStates !== undefined) windowStateMisses += 1;
      const legacy = asRecord(asRecord(windowStates?.windowStates)?.__legacy__);
      if (!legacy) windowStateMisses += 1;
      else {
        for (const [key, expected] of Object.entries(LEGACY_WINDOW_STATE)) {
          if (legacy[key] !== expected) windowStateMisses += 1;
        }
      }

      // --- 012 / 013 / 016, all over the same surviving 100 entries
      let agentPinMisses = 0;
      let phantomPinMisses = 0;
      let agentPresetMisses = 0;
      phantomPinMisses += Math.abs(
        Object.keys(agents).length - HEAVY_FIXTURE_COUNTS.survivingAgents
      );
      for (let i = 1; i < HEAVY_FIXTURE_COUNTS.agents; i += 2) {
        if (agents[`agent-${i}`] !== undefined) phantomPinMisses += 1;
      }
      for (let i = 0; i < HEAVY_FIXTURE_COUNTS.agents; i += 2) {
        const entry = asRecord(agents[`agent-${i}`]);
        if (!entry) {
          agentPinMisses += 1;
          agentPresetMisses += 1;
          continue;
        }
        if (entry.pinned !== (i % 3 !== 0)) agentPinMisses += 1;
        if ("selected" in entry) agentPinMisses += 1;
        if ("enabled" in entry) agentPinMisses += 1;
        if (entry.presetId !== `preset-${i}`) agentPresetMisses += 1;
        if ("flavorId" in entry) agentPresetMisses += 1;
        if ("customFlavors" in entry) agentPresetMisses += 1;
        const presets = entry.customPresets;
        if (!Array.isArray(presets) || presets[0] !== `custom-${i}`) agentPresetMisses += 1;
      }

      // --- 018
      let notesArchiveMisses = 0;
      if (existsSync(notesDir)) notesArchiveMisses += 1;
      if (!existsSync(join(archivedDir, "legacy-note.md"))) notesArchiveMisses += 1;

      // --- 022 / 023
      let auditRingMisses = 0;
      const strippedRings: Array<[Record<string, unknown> | null, string]> = [
        [asRecord(config.mcpServer), "auditLog"],
        [asRecord(config.mcpServer), "turnOutcomeLog"],
        [asRecord(config.plugins), "auditLog"],
        [asRecord(config.forgeAudit), "auditLog"],
        [asRecord(config.runHistory), "records"],
        [asRecord(config.pluginMcpAudit), "auditLog"],
      ];
      for (const [slice, key] of strippedRings) {
        if (slice === null || key in slice) auditRingMisses += 1;
      }
      const movedRings: Array<[string, number]> = [
        ["mcpAuditLog", HEAVY_FIXTURE_COUNTS.mcpAuditRecords],
        ["mcpTurnOutcomeLog", HEAVY_FIXTURE_COUNTS.mcpTurnOutcomeRecords],
        ["pluginAuditLog", HEAVY_FIXTURE_COUNTS.pluginAuditRecords],
        ["forgeAuditLog", HEAVY_FIXTURE_COUNTS.forgeAuditRecords],
        ["runHistoryRecords", HEAVY_FIXTURE_COUNTS.runHistoryRecords],
        ["pluginMcpAuditLog", HEAVY_FIXTURE_COUNTS.pluginMcpAuditRecords],
      ];
      for (const [key, expected] of movedRings) {
        auditRingMisses += Math.abs(ringLength(auditLogs, key) - expected);
      }

      // --- 004 / 005 / 007 / 014 / 015 / 019 / 021 / 024 / 025 / 026 / 027
      let scalarMigrationMisses = 0;
      const voice = asRecord(config.voiceInput);
      if (voice?.correctionModel !== "gpt-5.6-luna") scalarMigrationMisses += 1;
      if (voice?.transcriptionModel !== "gpt-live-transcribe") scalarMigrationMisses += 1;
      if (asRecord(config.terminalConfig)?.scrollbackLines !== 1000) scalarMigrationMisses += 1;
      const checklist = asRecord(asRecord(config.onboarding)?.checklist);
      const checklistItems = asRecord(checklist?.items);
      if (checklist?.dismissed !== true) scalarMigrationMisses += 1;
      if (checklistItems?.openedProject !== true) scalarMigrationMisses += 1;
      if (checklistItems?.ranSecondParallelAgent !== false) scalarMigrationMisses += 1;
      if (config.telemetry !== undefined) scalarMigrationMisses += 1;
      const privacy = asRecord(config.privacy);
      if (privacy?.telemetryLevel !== "errors") scalarMigrationMisses += 1;
      if (privacy?.hasSeenPrompt !== true) scalarMigrationMisses += 1;
      if (appState !== null && "fleetDeckOpen" in appState) scalarMigrationMisses += 1;
      const plugins = asRecord(config.plugins);
      if (plugins === null || "disabledBuiltins" in plugins) scalarMigrationMisses += 1;
      const disabled = new Set(
        Array.isArray(plugins?.disabled) ? (plugins.disabled as unknown[]).map(String) : []
      );
      for (let i = 0; i < HEAVY_FIXTURE_COUNTS.disabledBuiltins; i += 1) {
        if (!disabled.has(`builtin-${i}`)) scalarMigrationMisses += 1;
      }
      for (let i = 0; i < HEAVY_FIXTURE_COUNTS.disabledPlugins; i += 1) {
        if (!disabled.has(`user-${i}`)) scalarMigrationMisses += 1;
      }
      if (asRecord(config.userConfig)?.githubToken !== undefined) scalarMigrationMisses += 1;
      const credentials = asRecord(config.forgeCredentials);
      const githubCredential = credentials?.[BUILTIN_GITHUB_CREDENTIAL_KEY];
      if (typeof githubCredential !== "string") scalarMigrationMisses += 1;
      else {
        const parsed = asRecord(JSON.parse(githubCredential) as unknown);
        if (parsed?.token !== LEGACY_GITHUB_TOKEN) scalarMigrationMisses += 1;
      }
      const mcpServer = asRecord(config.mcpServer);
      if (mcpServer === null || "fullToolSurface" in mcpServer) scalarMigrationMisses += 1;

      // --- MigrationRunner's own backup of the pre-migration store
      let backupMisses = 0;
      const backups = readdirSync(userData).filter((entry) =>
        entry.startsWith("config.json.backup-v0-")
      );
      backupMisses += Math.abs(backups.length - 1);
      let backupBytes = 0;
      if (backups[0] !== undefined) {
        backupBytes = statSync(join(userData, backups[0])).size;
        if (backupBytes !== preChainConfigBytes) backupMisses += 1;
      }

      const schemaVersion = typeof config._schemaVersion === "number" ? config._schemaVersion : -1;
      const schemaVersionMisses = Math.abs(schemaVersion - mod.LATEST_SCHEMA_VERSION);

      const migrationMisses =
        terminalLocationMisses +
        recipeMigrationMisses +
        notificationMisses +
        windowStateMisses +
        agentPinMisses +
        phantomPinMisses +
        agentPresetMisses +
        notesArchiveMisses +
        auditRingMisses +
        scalarMigrationMisses +
        backupMisses +
        schemaVersionMisses;

      return {
        terminalLocationMisses,
        recipeMigrationMisses,
        notificationMisses,
        windowStateMisses,
        agentPinMisses,
        phantomPinMisses,
        agentPresetMisses,
        notesArchiveMisses,
        auditRingMisses,
        scalarMigrationMisses,
        backupMisses,
        schemaVersionMisses,
        migrationMisses,
        terminalCount: terminals.length,
        recipeCount: written.length,
        agentCount: Object.keys(agents).length,
        bytes: existsSync(configPath) ? statSync(configPath).size : 0,
        backupBytes,
        schemaVersion,
        chainLogLines,
      };
    },
  };
}
