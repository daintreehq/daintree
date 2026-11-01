import { beforeAll, describe, expect, it } from "vitest";
import { fc, test } from "@fast-check/vitest";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import type {
  BrowserPanelData,
  DevPreviewPanelData,
  FilePanelData,
  FileBrowserPanelData,
  DiffPanelData,
  PanelExitBehavior,
  PanelInstance,
} from "@shared/types/panel";
import type { BrowserHistory } from "@shared/types/browser";
import type { AddPanelOptions, DevPreviewPanelOptions } from "@shared/types/addPanelOptions";
import { getDeserializer } from "@/config/panelKindSerialisers";
import type { SavedTerminalData } from "@/utils/stateHydration/statePatcher";
import { initBuiltInPanelKinds } from "../registry";
import type { PtySerializeInput } from "../terminal/serializer";
import { serializeDevPreview, type DevPreviewSerializeInput } from "../dev-preview/serializer";
import { createDevPreviewDefaults } from "../dev-preview/defaults";

// Field-coverage meta-test. Every persisted field listed below must be
// referenced by both the serializer and the deserializer, so a rename or
// removal on one side surfaces as a loud test failure rather than silent
// data loss on restore.
//
// Each per-kind map uses `satisfies Record<keyof T, boolean>` — the same
// additive-safe pattern proven in `shared/types/project.ts:368`. Every field
// of the type MUST appear in the map, so a newly added field on the source
// type fails at compile time until it is classified here as persisted (true)
// or runtime-only (false). This closes the gap where `satisfies readonly
// (keyof T)[]` caught renames/removals but silently allowed new fields.
//
// Asymmetries:
//  - terminal has no getDeserializer() entry — agent-running terminals restore
//    through buildArgsForRespawn / buildArgsForBackendTerminal using backend
//    PTY state. Serializer coverage only.
//  - dev-preview `cwd` and `exitBehavior` are injected by
//    buildArgsForNonPtyRecreation's base args, not the registry deserializer.
//    Excluded from the deserializer-side check for that kind.

// ── Terminal (PTY) field classification ──────────────────────────────

const PTY_FIELD_CLASSIFICATION = {
  // BasePanelData — persisted by the base serialization layer, not here
  id: false,
  kind: false,
  title: false,
  titleMode: false,
  location: false,
  backgroundRestoreLocation: false,
  // Boot-time dock stopgap (#13907) — written by the base serialization layer.
  pendingDockWorktreeId: false,
  worktreeId: false,
  isVisible: false,
  extensionState: false,
  extensionStateVersion: false,
  pluginId: false,
  pluginPanelKindId: false,
  // PtyPanelData persisted fields
  launchAgentId: true,
  cwd: true,
  command: true,
  exitBehavior: true,
  agentSessionId: true,
  agentLaunchFlags: true,
  callerLaunchFlags: true,
  // Runtime only (#14096): a restored pane relaunches as an ordinary agent.
  requiredPluginTools: false,
  agentModelId: true,
  agentPresetId: true,
  agentPresetColor: true,
  originalPresetId: true,
  // Captured launch env replayed on restore so a session keeps its provider
  // environment (#10922); sanitized on the serialize/restore boundary.
  env: true,
  isUsingFallback: true,
  fallbackChainIndex: true,
  agentState: true,
  lastStateChange: true,
  // Conversation origin and the recovery hold (#12434) — a held pane must stay
  // held across a restart instead of launching fresh.
  conversationCwd: true,
  restoreRecovery: true,
  // How restore last rebuilt the pane and the plugin hold (#14017) — a pane
  // held across restarts keeps the state last seen before the first of them.
  restoreProvenance: true,
  lastAgentObservation: true,
  launchedByPluginId: true,
  holdOnRestart: true,
  // The terminal's own notes (#12835) — persisted so they outlive a restart.
  scratchpad: true,
  // What the run was first asked (#14592) — persisted so Review Hub still
  // shows it after a restart.
  firstPrompt: true,
  // PtyPanelData runtime-only fields
  pid: false,
  hasPty: false,
  lastObservedTitle: false,
  cols: false,
  rows: false,
  stateChangeTrigger: false,
  stateChangeConfidence: false,
  waitingReason: false,
  error: false,
  sessionCost: false,
  sessionTokens: false,
  spawnError: false,
  spawnStatus: false,
  // Live-only render hint for single-launch eager xterm mount; never persisted.
  eagerAttach: false,
  activityHeadline: false,
  activityStatus: false,
  activityType: false,
  lastCommand: false,
  restartKey: false,
  isRestarting: false,
  // Transient restore-time signal (#9802) — drives the "Session no longer
  // reachable" banner; must never be persisted or it resurfaces every restart.
  sessionLostOnRestore: false,
  // Live offer to reopen an ended launch's conversation (#13226) — a prompt
  // about a process that no longer exists after a restart.
  agentResumeOffer: false,
  restartError: false,
  reconnectError: false,
  scrollbackRestoreError: false,
  // Renderer attach failure (#11776) — a live signal about the CURRENT xterm
  // instance. A restart builds a fresh one, so persisting it would resurrect a
  // banner for a failure that no longer exists.
  attachError: false,
  flowStatus: false,
  runtimeStatus: false,
  flowStatusTimestamp: false,
  isInputLocked: false,
  // Cross-worktree move prompt (#11853) — NOT persisted: it asks the user to
  // say something to a running agent, and that agent is gone after a restart.
  worktreeMoveNotice: false,
  browserUrl: false,
  browserHistory: false,
  browserZoom: false,
  devCommand: false,
  devServerStatus: false,
  devServerPhaseLabel: false,
  devServerUrl: false,
  devServerError: false,
  devServerTerminalId: false,
  devPreviewConsoleOpen: false,
  devPreviewConsoleTab: false,
  detectedProcessId: false,
  runtimeIdentity: false,
  everDetectedAgent: false,
  detectedAgentId: false,
  spawnedBy: true,
  // Written only beside `spawnedBy: "schedule"` (#15977), as the fixture has it.
  scheduledRun: true,
  focusPolicy: false,
  excludeFromPersistence: false,
  removeOnExit: false,
  startedAt: false,
  // Written only while the pane shows a natural exit (#15941), so a reload
  // restores the exit instead of a new process.
  exitCode: true,
  // Session-preserving teardown mark (#13841) — describes the exit that just
  // happened; the restored pane gets a new process, so nothing to persist.
  sessionPreservingExit: false,
  // Parsed check result (#10682) — live signal from agent:state-changed,
  // cleared on restart; intentionally not persisted by the PTY serializer.
  lastCheckResult: false,
  // Handback marker (#12488) — same live-only lifecycle as lastCheckResult.
  lastHandback: false,
  // Observed respawn count (#12535) — a live reading of the running pty that
  // the host re-derives from zero for every new one, so persisting it would
  // restore a session count for a session that no longer exists.
  agentIncarnation: false,
  // BasePanelData carrier-bookkeeping timestamps — written by the base
  // serialization layer in panelToSnapshot, not the PTY serializer.
  createdAt: false,
  lastActiveAt: false,
  // Held-duration gauge — observational, sampled by the host's
  // `pause-duration-gauge` reliability metric; not part of the
  // persistent terminal snapshot.
  heldDurationMs: false,
} as const satisfies Record<keyof PtySerializeInput, boolean>;

// ── Browser field classification ─────────────────────────────────────

const BROWSER_FIELD_CLASSIFICATION = {
  // BasePanelData — persisted by the base serialization layer
  id: false,
  kind: false,
  title: false,
  titleMode: false,
  location: false,
  backgroundRestoreLocation: false,
  // Boot-time dock stopgap (#13907) — written by the base serialization layer.
  pendingDockWorktreeId: false,
  worktreeId: false,
  isVisible: false,
  extensionState: false,
  extensionStateVersion: false,
  pluginId: false,
  pluginPanelKindId: false,
  // BrowserPanelData persisted fields
  browserUrl: true,
  browserHistory: true,
  browserZoom: true,
  browserConsoleOpen: true,
  // BasePanelData carrier-bookkeeping timestamps — written by the base
  // serialization layer in panelToSnapshot, not per-kind serializers.
  createdAt: false,
  lastActiveAt: false,
  // Ephemerality flag: consumed by the persistence filter to decide whether a
  // panel is written at all, so it is never part of a snapshot's payload.
  excludeFromPersistence: false,
} as const satisfies Record<keyof BrowserPanelData, boolean>;

// ── Dev-preview field classification ─────────────────────────────────

const DEV_PREVIEW_FIELD_CLASSIFICATION = {
  // BasePanelData — persisted by the base serialization layer
  id: false,
  kind: false,
  title: false,
  titleMode: false,
  location: false,
  backgroundRestoreLocation: false,
  // Boot-time dock stopgap (#13907) — written by the base serialization layer.
  pendingDockWorktreeId: false,
  worktreeId: false,
  isVisible: false,
  extensionState: false,
  extensionStateVersion: false,
  pluginId: false,
  pluginPanelKindId: false,
  // DevPreviewPanelData persisted fields
  cwd: true,
  devCommand: true,
  browserUrl: true,
  browserHistory: true,
  browserZoom: true,
  devPreviewConsoleOpen: true,
  devPreviewConsoleTab: true,
  exitBehavior: true,
  viewportPreset: true,
  viewportRotated: true,
  viewportDpr: true,
  viewportFit: true,
  devPreviewScrollPosition: true,
  previewsResourceEndpoint: true,
  // DevPreviewPanelData runtime-only fields
  devServerStatus: false,
  devServerPhaseLabel: false,
  devServerUrl: false,
  devServerError: false,
  devServerTerminalId: false,
  // BasePanelData carrier-bookkeeping timestamps — written by the base
  // serialization layer in panelToSnapshot, not per-kind serializers.
  createdAt: false,
  lastActiveAt: false,
  // Ephemerality flag: consumed by the persistence filter to decide whether a
  // panel is written at all, so it is never part of a snapshot's payload.
  excludeFromPersistence: false,
} as const satisfies Record<keyof DevPreviewSerializeInput, boolean>;

// ── File field classification ────────────────────────────────────────

const FILE_FIELD_CLASSIFICATION = {
  // BasePanelData — persisted by the base serialization layer
  id: false,
  kind: false,
  title: false,
  titleMode: false,
  location: false,
  backgroundRestoreLocation: false,
  // Boot-time dock stopgap (#13907) — written by the base serialization layer.
  pendingDockWorktreeId: false,
  worktreeId: false,
  isVisible: false,
  extensionState: false,
  extensionStateVersion: false,
  pluginId: false,
  pluginPanelKindId: false,
  // FilePanelData persisted fields
  filePath: true,
  fileViewMode: true,
  // BasePanelData carrier-bookkeeping timestamps — written by the base
  // serialization layer in panelToSnapshot, not per-kind serializers.
  createdAt: false,
  lastActiveAt: false,
  // Ephemerality flag: consumed by the persistence filter to decide whether a
  // panel is written at all, so it is never part of a snapshot's payload.
  excludeFromPersistence: false,
  // Open-time scroll hint only — deliberately unserialized so a restored panel
  // opens at the top rather than at a stale position.
  initialLine: false,
  // Open-time containment root pinned by a link from untrusted Markdown; a
  // restored panel infers its root again rather than reviving a stale pin.
  fileContainmentRoot: false,
  // Open-time editor pick (#13811); a restored panel opens in Source, where
  // the pick has nothing to choose.
  fileEditorChoice: false,
} as const satisfies Record<keyof FilePanelData, boolean>;

// ── Diff field classification ────────────────────────────────────────

const DIFF_FIELD_CLASSIFICATION = {
  // BasePanelData — persisted by the base serialization layer
  id: false,
  kind: false,
  title: false,
  titleMode: false,
  location: false,
  backgroundRestoreLocation: false,
  // Boot-time dock stopgap (#13907) — written by the base serialization layer.
  pendingDockWorktreeId: false,
  worktreeId: false,
  isVisible: false,
  extensionState: false,
  extensionStateVersion: false,
  pluginId: false,
  pluginPanelKindId: false,
  // DiffPanelData persisted fields — the reconstruction recipe, not the content
  filePath: true,
  fileStatus: true,
  diffSource: true,
  baseBranch: true,
  // BasePanelData carrier-bookkeeping timestamps — written by the base
  // serialization layer in panelToSnapshot, not per-kind serializers.
  createdAt: false,
  lastActiveAt: false,
  // Ephemerality flag: consumed by the persistence filter to decide whether a
  // panel is written at all, so it is never part of a snapshot's payload.
  excludeFromPersistence: false,
  // Rebuilt live by whichever surface owns the review, so a restored panel
  // never replays a change set whose files have since been committed.
  changeSet: false,
  // Cursor into that runtime set — meaningless without it, so it dies with it.
  viewedKey: false,
} as const satisfies Record<keyof DiffPanelData, boolean>;

// ── File browser field classification ────────────────────────────────

const FILE_BROWSER_FIELD_CLASSIFICATION = {
  // BasePanelData — persisted by the base serialization layer
  id: false,
  kind: false,
  title: false,
  titleMode: false,
  location: false,
  backgroundRestoreLocation: false,
  // Boot-time dock stopgap (#13907) — written by the base serialization layer.
  pendingDockWorktreeId: false,
  worktreeId: false,
  isVisible: false,
  extensionState: false,
  extensionStateVersion: false,
  pluginId: false,
  pluginPanelKindId: false,
  // FileBrowserPanelData persisted fields — all user intent (where they are in
  // the tree and how it's laid out), which is exactly what a pinned panel keeps.
  browserSelectedPath: true,
  browserExpandedPaths: true,
  browserHideDotfiles: true,
  browserRootPath: true,
  browserSidebarCollapsed: true,
  browserViewerCollapsed: true,
  // The one derived persisted field: the last-known tree snapshot (#11367)
  // must ride the panel record because nothing renderer-side survives LRU
  // eviction.
  browserTreeSnapshot: true,
  browserSidebarWidth: true,
  // Which folder the panel browses. Derivable from an absent `worktreeId` only
  // at creation — a promoted panel carries an adopted placement id by save time
  // (#11489) — so it has to ride the record like any other user intent.
  browserWorkspaceRooted: true,
  // What the tree and the folder listing are ordered by (#11620). User intent,
  // chosen from the toolbar menu, so it rides the record — only a non-default
  // value is written, which keeps a never-sorted panel sparse.
  browserSortKey: true,
  browserSortDirection: true,
  // BasePanelData carrier-bookkeeping timestamps — written by the base
  // serialization layer in panelToSnapshot, not per-kind serializers.
  createdAt: false,
  lastActiveAt: false,
  // Ephemerality flag: consumed by the persistence filter to decide whether a
  // panel is written at all, so it is never part of a snapshot's payload.
  excludeFromPersistence: false,
} as const satisfies Record<keyof FileBrowserPanelData, boolean>;

// ── Helpers ──────────────────────────────────────────────────────────

/** Extract the keys classified as `true` from a field-classification map. */
function persistedKeys<T extends Record<string, boolean>>(map: T): (keyof T)[] {
  return (Object.keys(map) as (keyof T)[]).filter((k) => map[k]);
}

// Carrier-boundary pin retired. The renderer carrier is now
// `Record<string, PanelInstance>` (#8957 step 5) and the `TerminalInstance`
// interface only exists as the persistence Tolerant Reader. New fields must be
// added to the appropriate `PanelInstance` variant; the discriminated union
// itself enforces coverage at every consumer.

const browserHistoryFixture: BrowserHistory = {
  past: ["https://prev.example"],
  present: "https://example.com",
  future: [],
};

function assertCovers(
  label: string,
  output: Record<string, unknown>,
  expectedFields: readonly string[],
  renames: Record<string, string> = {},
  excluded: readonly string[] = []
): void {
  const keys = Object.keys(output);
  for (const field of expectedFields) {
    if (excluded.includes(field)) continue;
    const outputKey = renames[field] ?? field;
    expect(
      keys,
      `${label} missing persisted field "${field}"` +
        (outputKey === field ? "" : ` (output key "${outputKey}")`) +
        `; keys=${keys.join(",")}`
    ).toContain(outputKey);
    // Reject stub implementations that emit the key with an `undefined` value.
    // All fixtures below supply defined, non-undefined values for every field,
    // so a real serializer/deserializer must propagate them.
    expect(
      output[outputKey],
      `${label} persisted field "${field}" was present but undefined — stub implementation?`
    ).not.toBeUndefined();
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────
// Fully-populated fixtures — every persisted field set to a truthy,
// non-empty, non-null value so every conditional spread in the serializers
// emits its key.

const terminalFixture: PtySerializeInput = {
  id: "panel-terminal",
  title: "Panel",
  location: "grid",
  kind: "terminal",
  launchAgentId: "claude",
  titleMode: "default",
  cwd: "/home/project",
  cols: 80,
  rows: 24,
  command: "npm start",
  exitBehavior: "keep" satisfies PanelExitBehavior,
  agentSessionId: "session-abc",
  agentLaunchFlags: ["--resume", "--effort", "high"],
  callerLaunchFlags: ["--effort", "high"],
  agentModelId: "claude-3-5-sonnet",
  spawnedBy: "schedule",
  scheduledRun: { scheduleId: "schedule-1", runId: "run-1" },
  agentPresetId: "blue-provider",
  agentPresetColor: "#3366ff",
  originalPresetId: "primary-provider",
  env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" },
  isUsingFallback: true,
  fallbackChainIndex: 1,
  agentState: "idle",
  lastStateChange: 1_700_000_000_000,
  conversationCwd: "/home/origin",
  restoreProvenance: {
    at: 1_700_000_000_002,
    disposition: "resume",
    lastSeen: { agentState: "idle", at: 1_699_999_999_000 },
  },
  lastAgentObservation: { agentState: "idle", at: 1_700_000_000_003 },
  launchedByPluginId: "acme.orchestrator",
  holdOnRestart: true,
  scratchpad: { content: "- check CI", collapsed: true, width: 320 },
  firstPrompt: { text: "Fix the flaky test", via: "launch", at: 1_700_000_000_004 },
  worktreeMoveNotice: { destinationWorktreeId: "wt-feature" },
  runtimeStatus: "exited",
  exitCode: 3,
  createdAt: 1_700_000_000_000,
  lastActiveAt: 1_700_000_000_001,
};

const browserFixture: BrowserPanelData = {
  id: "panel-browser",
  title: "Panel",
  location: "grid",
  kind: "browser",
  browserUrl: "https://example.com",
  browserHistory: browserHistoryFixture,
  browserZoom: 1.5,
  // `false` is deliberate — the browser serializer uses `!== undefined`, so
  // falsy-but-defined values must still emit the key.
  browserConsoleOpen: false,
};

const devPreviewFixture: DevPreviewSerializeInput = {
  id: "panel-dev-preview",
  title: "Panel",
  location: "grid",
  kind: "dev-preview",
  cwd: "/home/project",
  devCommand: "npm run dev",
  browserUrl: "http://localhost:3000",
  browserHistory: browserHistoryFixture,
  browserZoom: 1,
  devPreviewConsoleOpen: false,
  devPreviewConsoleTab: "console",
  devPreviewScrollPosition: { url: "http://localhost:3000", scrollY: 250 },
  viewportPreset: "iphone",
  viewportRotated: false,
  viewportDpr: 2,
  viewportFit: true,
  previewsResourceEndpoint: true,
  exitBehavior: "keep",
  createdAt: 1_700_000_000_000,
};

const savedBrowser: SavedTerminalData = {
  id: "panel-browser",
  kind: "browser",
  browserUrl: "https://example.com",
  browserHistory: browserHistoryFixture,
  browserZoom: 1.5,
  browserConsoleOpen: false,
};

const fileFixture: FilePanelData = {
  id: "panel-file",
  title: "Panel",
  location: "grid",
  kind: "file",
  filePath: "/home/project/docs/spec.md",
  fileViewMode: "source",
};

const savedFile: SavedTerminalData = {
  id: "panel-file",
  kind: "file",
  filePath: "/home/project/docs/spec.md",
  fileViewMode: "source",
};

const browserTreeSnapshotFixture = {
  worktreeId: "wt-1",
  rootPath: "src",
  listings: [
    {
      dirPath: "src",
      nodes: [{ name: "app.ts", path: "src/app.ts", isDirectory: false }],
    },
  ],
};

const fileBrowserFixture: FileBrowserPanelData = {
  id: "panel-file-browser",
  title: "Panel",
  location: "grid",
  kind: "file-browser",
  browserSelectedPath: "src/app.ts",
  browserExpandedPaths: ["src"],
  browserHideDotfiles: true,
  browserRootPath: "src",
  // Both collapse bits, which is not a state the UI can reach but is exactly
  // what persistence must round-trip unaltered: the two fields are independent
  // on disk, and the pane resolves the pair at read time (#11496).
  browserSidebarCollapsed: true,
  browserViewerCollapsed: true,
  browserTreeSnapshot: browserTreeSnapshotFixture,
  // A non-default width (the serializer omits 288), so the coverage spread emits
  // the key instead of dropping it as a default.
  browserSidebarWidth: 360,
  browserWorkspaceRooted: true,
  // A non-default order for the same reason as the width above: the serializer
  // omits name/ascending, so a default fixture would drop both keys and the
  // coverage spread could not tell that from a missing implementation (#11620).
  browserSortKey: "size",
  browserSortDirection: "desc",
};

const savedFileBrowser: SavedTerminalData = {
  id: "panel-file-browser",
  kind: "file-browser",
  browserSelectedPath: "src/app.ts",
  browserExpandedPaths: ["src"],
  browserHideDotfiles: true,
  browserRootPath: "src",
  browserSidebarCollapsed: true,
  browserViewerCollapsed: true,
  browserTreeSnapshot: browserTreeSnapshotFixture,
  browserSidebarWidth: 360,
  browserWorkspaceRooted: true,
  browserSortKey: "size",
  browserSortDirection: "desc",
};

const diffFixture: DiffPanelData = {
  id: "panel-diff",
  title: "Panel",
  location: "grid",
  kind: "diff",
  filePath: "src/app.ts",
  fileStatus: "modified",
  diffSource: "base-branch",
  baseBranch: "develop",
};

const savedDiff: SavedTerminalData = {
  id: "panel-diff",
  kind: "diff",
  filePath: "src/app.ts",
  fileStatus: "modified",
  diffSource: "base-branch",
  baseBranch: "develop",
};

const savedDevPreview: SavedTerminalData = {
  id: "panel-dev-preview",
  kind: "dev-preview",
  devCommand: "npm run dev",
  browserUrl: "http://localhost:3000",
  browserHistory: browserHistoryFixture,
  browserZoom: 1,
  devPreviewConsoleOpen: false,
  devPreviewConsoleTab: "console",
  devPreviewScrollPosition: { url: "http://localhost:3000", scrollY: 250 },
  viewportPreset: "iphone",
  viewportRotated: false,
  viewportDpr: 2,
  viewportFit: true,
  previewsResourceEndpoint: true,
  exitBehavior: "keep",
  createdAt: 1_700_000_000_000,
};

// ── Setup ────────────────────────────────────────────────────────────

beforeAll(() => {
  initBuiltInPanelKinds();
});

// ── Serializer coverage ──────────────────────────────────────────────

describe("panel serializer field coverage", () => {
  it("terminal serializer covers every persisted PTY field", () => {
    const output = getPanelKindConfig("terminal")!.serialize!(terminalFixture) as Record<
      string,
      unknown
    >;
    // A held pane writes no process state, so the hold is covered by its own
    // fixture below rather than alongside a live session.
    assertCovers("terminal serializer", output, persistedKeys(PTY_FIELD_CLASSIFICATION), {}, [
      "restoreRecovery",
    ]);
  });

  it("terminal serializer persists a recovery hold without the process state it replaces (#12434)", () => {
    const heldFixture: PtySerializeInput = {
      ...terminalFixture,
      restoreRecovery: { reason: "sibling-owns-resume-latest-slot" },
    };
    const output = getPanelKindConfig("terminal")!.serialize!(heldFixture) as Record<
      string,
      unknown
    >;
    expect(output.restoreRecovery).toEqual({ reason: "sibling-owns-resume-latest-slot" });
    expect(output.conversationCwd).toBe("/home/origin");
    // What was last observed for the pane outlives its process (#14017).
    expect(output.restoreProvenance).toEqual(terminalFixture.restoreProvenance);
    expect(output.lastAgentObservation).toEqual(terminalFixture.lastAgentObservation);
    // So is what the run it holds was first asked (#14592).
    expect(output.firstPrompt).toEqual(terminalFixture.firstPrompt);
    expect(output).not.toHaveProperty("agentSessionId");
    expect(output).not.toHaveProperty("agentState");
    expect(output).not.toHaveProperty("lastStateChange");
    expect(output).not.toHaveProperty("exitCode");
  });

  it("browser serializer covers every persisted browser field", () => {
    const output = getPanelKindConfig("browser")!.serialize!(browserFixture) as Record<
      string,
      unknown
    >;
    assertCovers("browser serializer", output, persistedKeys(BROWSER_FIELD_CLASSIFICATION));
  });

  it("dev-preview serializer covers every persisted dev-preview field (devCommand → command)", () => {
    const output = getPanelKindConfig("dev-preview")!.serialize!(devPreviewFixture) as Record<
      string,
      unknown
    >;
    assertCovers(
      "dev-preview serializer",
      output,
      persistedKeys(DEV_PREVIEW_FIELD_CLASSIFICATION),
      {
        devCommand: "command",
      }
    );
  });

  it("file serializer covers every persisted file field", () => {
    const output = getPanelKindConfig("file")!.serialize!(fileFixture) as Record<string, unknown>;
    assertCovers("file serializer", output, persistedKeys(FILE_FIELD_CLASSIFICATION));
  });

  it("file browser serializer covers every persisted file browser field", () => {
    const output = getPanelKindConfig("file-browser")!.serialize!(fileBrowserFixture) as Record<
      string,
      unknown
    >;
    assertCovers(
      "file-browser serializer",
      output,
      persistedKeys(FILE_BROWSER_FIELD_CLASSIFICATION)
    );
  });

  it("file browser serializer keeps an explicit false for the dotfile toggle", () => {
    const withDotfilesShown: FileBrowserPanelData = {
      ...fileBrowserFixture,
      browserHideDotfiles: false,
    };
    const output = getPanelKindConfig("file-browser")!.serialize!(withDotfilesShown) as Record<
      string,
      unknown
    >;

    // Truthiness-based spreading would drop this, and the restored panel would
    // silently pick up whatever the default becomes.
    expect(output.browserHideDotfiles).toBe(false);
  });

  it("diff serializer covers every persisted diff field", () => {
    const output = getPanelKindConfig("diff")!.serialize!(diffFixture) as Record<string, unknown>;
    assertCovers("diff serializer", output, persistedKeys(DIFF_FIELD_CLASSIFICATION));
  });

  it("diff serializer omits the runtime change set and its cursor", () => {
    const withChangeSet: DiffPanelData = {
      ...diffFixture,
      changeSet: [{ path: "src/app.ts", status: "modified", viewedKey: "modified:src/app.ts" }],
      viewedKey: "modified:src/app.ts",
    };
    const output = getPanelKindConfig("diff")!.serialize!(withChangeSet) as Record<string, unknown>;
    expect(output).not.toHaveProperty("changeSet");
    // The cursor points into that set, so persisting it would resurrect a
    // position in a change set the restored panel no longer has.
    expect(output).not.toHaveProperty("viewedKey");
  });
});

// ── Deserializer coverage ────────────────────────────────────────────

describe("panel deserializer field coverage", () => {
  it("browser deserializer covers every persisted browser field", () => {
    const deserializer = getDeserializer("browser");
    expect(deserializer, "browser deserializer must be registered").toBeDefined();
    const output = deserializer!(savedBrowser) as Record<string, unknown>;
    assertCovers("browser deserializer", output, persistedKeys(BROWSER_FIELD_CLASSIFICATION));
  });

  it("dev-preview deserializer covers every persisted dev-preview field (cwd + exitBehavior via base args)", () => {
    const deserializer = getDeserializer("dev-preview");
    expect(deserializer, "dev-preview deserializer must be registered").toBeDefined();
    const output = deserializer!(savedDevPreview) as Record<string, unknown>;
    // `cwd` and `exitBehavior` are injected by buildArgsForNonPtyRecreation's
    // base args, not the dev-preview deserializer, so they are excluded here.
    assertCovers(
      "dev-preview deserializer",
      output,
      persistedKeys(DEV_PREVIEW_FIELD_CLASSIFICATION),
      {},
      ["cwd", "exitBehavior"]
    );
  });

  it("file browser deserializer covers every persisted file browser field", () => {
    const deserializer = getDeserializer("file-browser");
    expect(deserializer, "file-browser deserializer must be registered").toBeDefined();
    const output = deserializer!(savedFileBrowser) as Record<string, unknown>;
    assertCovers(
      "file-browser deserializer",
      output,
      persistedKeys(FILE_BROWSER_FIELD_CLASSIFICATION)
    );
  });

  it("file browser deserializer drops expanded paths that could escape the worktree root", () => {
    const deserializer = getDeserializer("file-browser")!;

    const output = deserializer({
      ...savedFileBrowser,
      browserExpandedPaths: ["src", "/etc", "../secrets", "a/../../b", 42],
    }) as Record<string, unknown>;

    // The list round-trips through JSON on disk, so a corrupted or hand-edited
    // snapshot can hold anything. Only the safe relative entry survives.
    expect(output.browserExpandedPaths).toEqual(["src"]);
  });

  it("file browser deserializer canonicalizes a non-canonical browse root", () => {
    const deserializer = getDeserializer("file-browser")!;

    // Tree row keys are canonical listing paths, so `src/` or `./src` would
    // never prefix-match an expansion beneath them; `.` means the worktree
    // root, which is represented by absence.
    for (const [saved, restored] of [
      ["src/", "src"],
      ["./src//panels", "src/panels"],
      [".", undefined],
    ] as const) {
      const output = deserializer({
        ...savedFileBrowser,
        browserRootPath: saved,
      }) as Record<string, unknown>;
      expect(output.browserRootPath).toBe(restored);
    }
  });

  it("file browser deserializer drops a non-boolean dotfile toggle rather than coercing it", () => {
    const deserializer = getDeserializer("file-browser")!;

    const output = deserializer({
      ...savedFileBrowser,
      browserHideDotfiles: "yes",
    }) as Record<string, unknown>;

    // Coercing would turn any stray on-disk string into "hide every dotfile",
    // which is the opposite of the safe default (dotfiles visible).
    expect(output.browserHideDotfiles).toBeUndefined();
  });

  it("terminal has no deserializer registry entry", () => {
    // PTY panels (including agent-running terminals) restore through
    // buildArgsForRespawn / buildArgsForBackendTerminal using BackendTerminalData,
    // not the getDeserializer() registry. Pinning this asymmetry so an
    // accidental registry entry forces a deliberate decision about the new
    // restore path.
    expect(getDeserializer("terminal")).toBeUndefined();
  });

  it("review has no deserializer registry entry", () => {
    // Review panels carry no kind-specific persisted fields — `worktreeId`
    // from BasePanelData is the sole binding, and the worktree path is
    // resolved fresh from the worktree store at render time.
    expect(getDeserializer("review")).toBeUndefined();
  });

  it("file deserializer covers every persisted file field", () => {
    const deserializer = getDeserializer("file");
    expect(deserializer, "file deserializer must be registered").toBeDefined();
    const output = deserializer!(savedFile) as Record<string, unknown>;
    assertCovers("file deserializer", output, persistedKeys(FILE_FIELD_CLASSIFICATION));
  });

  it("diff deserializer covers every persisted diff field", () => {
    const deserializer = getDeserializer("diff");
    expect(deserializer, "diff deserializer must be registered").toBeDefined();
    const output = deserializer!(savedDiff) as Record<string, unknown>;
    assertCovers("diff deserializer", output, persistedKeys(DIFF_FIELD_CLASSIFICATION));
  });

  it("diff deserializer drops unknown persisted status and source values", () => {
    const output = getDeserializer("diff")!({
      id: "panel-diff",
      kind: "diff",
      filePath: "src/app.ts",
      fileStatus: "not-a-status",
      diffSource: "not-a-source",
    }) as Record<string, unknown>;
    expect(output.fileStatus).toBeUndefined();
    expect(output.diffSource).toBeUndefined();
  });

  it("file deserializer drops unknown persisted view modes", () => {
    const deserializer = getDeserializer("file")!;
    const output = deserializer({
      id: "panel-file",
      kind: "file",
      filePath: "/home/project/docs/spec.md",
      fileViewMode: "sideways",
    });
    expect(output.fileViewMode).toBeUndefined();
    expect(output.filePath).toBe("/home/project/docs/spec.md");
  });

  // #11274: the sanitizer redeclares the mode union at runtime, so widening the
  // type alone would silently drop a restored diff selection.
  it("file deserializer restores a persisted diff view mode", () => {
    const deserializer = getDeserializer("file")!;
    const output = deserializer({
      id: "panel-file",
      kind: "file",
      filePath: "/home/project/src/index.ts",
      fileViewMode: "diff",
    });
    expect(output.fileViewMode).toBe("diff");
  });

  it("file deserializer reads legacy markdown panel fields", () => {
    const deserializer = getDeserializer("file")!;
    const output = deserializer({
      id: "panel-file",
      kind: "file",
      markdownFilePath: "/home/project/docs/spec.md",
      markdownViewMode: "rendered",
    });
    expect(output.filePath).toBe("/home/project/docs/spec.md");
    expect(output.fileViewMode).toBe("rendered");
  });
});

// ── Round-trip property tests ────────────────────────────────────────

type PtyData = Extract<PanelInstance, { kind: "terminal" }>;
type BrowserData = Extract<PanelInstance, { kind: "browser" }>;
type DevPreviewData = Extract<PanelInstance, { kind: "dev-preview" }>;

// Persisted-field union per kind. The arbitrary spec is bound via `satisfies`
// below; that catches type drift on the listed fields (renames, type changes,
// removals) as a TS error at the spec declaration. Adding a *new* persisted
// field still requires extending the union here by hand — this guard is a
// ratchet on the fields already enumerated, not a full exhaustiveness check.
//
// `createdAt` is intentionally absent from the pty and dev-preview unions: the
// serializers handle it as a legacy `TerminalInstance` fallback, but it isn't
// declared on `PtyPanelData` or `DevPreviewPanelData`. The literal-value round
// trip for dev-preview's `createdAt` is still exercised by the serialize-hook
// tests below.
type PersistedPtyFields =
  | "launchAgentId"
  | "cwd"
  | "command"
  | "exitBehavior"
  | "agentSessionId"
  | "agentLaunchFlags"
  | "agentModelId"
  | "agentState"
  | "lastStateChange";

type PersistedBrowserFields =
  "browserUrl" | "browserHistory" | "browserZoom" | "browserConsoleOpen";

type PersistedDevPreviewFields =
  | "cwd"
  | "devCommand"
  | "browserUrl"
  | "browserHistory"
  | "browserZoom"
  | "devPreviewConsoleOpen"
  | "devPreviewConsoleTab"
  | "devPreviewScrollPosition"
  | "previewsResourceEndpoint"
  | "exitBehavior";

const browserHistoryArb = fc.record({
  past: fc.array(fc.string()),
  present: fc.string(),
  future: fc.array(fc.string()),
});

const exitBehaviorArb = fc.constantFrom(
  "keep" as const,
  "trash" as const,
  "remove" as const,
  "restart" as const
);

const agentStateArb = fc.constantFrom(
  "idle" as const,
  "working" as const,
  "waiting" as const,
  "directing" as const,
  "completed" as const,
  "exited" as const
);

const zoomArb = fc.double({ min: 0.25, max: 5.0, noNaN: true, noDefaultInfinity: true });

const ptyArbSpec = {
  launchAgentId: fc.option(fc.string(), { nil: undefined }),
  cwd: fc.string(),
  command: fc.option(fc.string(), { nil: undefined }),
  exitBehavior: fc.option(exitBehaviorArb, { nil: undefined }),
  agentSessionId: fc.option(fc.string(), { nil: undefined }),
  agentLaunchFlags: fc.option(fc.array(fc.string()), { nil: undefined }),
  agentModelId: fc.option(fc.string(), { nil: undefined }),
  agentState: fc.option(agentStateArb, { nil: undefined }),
  lastStateChange: fc.option(fc.integer({ min: 0 }), { nil: undefined }),
} satisfies { [K in PersistedPtyFields]-?: fc.Arbitrary<PtyData[K]> };

const browserArbSpec = {
  browserUrl: fc.option(fc.string(), { nil: undefined }),
  browserHistory: fc.option(browserHistoryArb, { nil: undefined }),
  browserZoom: fc.option(zoomArb, { nil: undefined }),
  browserConsoleOpen: fc.option(fc.boolean(), { nil: undefined }),
} satisfies { [K in PersistedBrowserFields]-?: fc.Arbitrary<BrowserData[K]> };

const scrollPositionArb = fc.record({
  url: fc.string(),
  scrollY: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
});

const devPreviewArbSpec = {
  cwd: fc.string(),
  devCommand: fc.option(fc.string(), { nil: undefined }),
  browserUrl: fc.option(fc.string(), { nil: undefined }),
  browserHistory: fc.option(browserHistoryArb, { nil: undefined }),
  browserZoom: fc.option(zoomArb, { nil: undefined }),
  devPreviewConsoleOpen: fc.option(fc.boolean(), { nil: undefined }),
  devPreviewConsoleTab: fc.option(
    fc.constantFrom("output" as const, "console" as const, "diagnostics" as const),
    {
      nil: undefined,
    }
  ),
  devPreviewScrollPosition: fc.option(scrollPositionArb, { nil: undefined }),
  previewsResourceEndpoint: fc.option(fc.boolean(), { nil: undefined }),
  exitBehavior: fc.option(exitBehaviorArb, { nil: undefined }),
} satisfies { [K in PersistedDevPreviewFields]-?: fc.Arbitrary<DevPreviewData[K]> };

const ptyArb = fc.record(ptyArbSpec);
const browserArb = fc.record(browserArbSpec);
const devPreviewArb = fc.record(devPreviewArbSpec);

function basePanel(
  kind: PanelInstance["kind"]
): Pick<PanelInstance, "id" | "title" | "location" | "kind"> {
  return { id: "panel-id", title: "Panel", location: "grid", kind };
}

describe("panel serializer round-trip (property tests)", () => {
  describe("terminal", () => {
    // Terminal/agent have no getDeserializer entry — their restore path runs
    // through buildArgsForRespawn / buildArgsForBackendTerminal which involves
    // agent session resume and model-selection logic outside this file's scope.
    // Property test the serializer's output shape and trimming/omission rules.
    test.prop([ptyArb])("serializer output matches input under trim & omit rules", (fields) => {
      const input: PtyData = { ...basePanel("terminal"), cols: 80, rows: 24, ...fields } as PtyData;
      const result = getPanelKindConfig("terminal")!.serialize!(input);

      expect(result.launchAgentId).toBe(fields.launchAgentId);
      expect(result.cwd).toBe(fields.cwd);
      expect(result.command).toBe(fields.command?.trim() || undefined);

      if (fields.exitBehavior !== undefined) {
        expect(result.exitBehavior).toBe(fields.exitBehavior);
      } else {
        expect("exitBehavior" in result).toBe(false);
      }

      if (fields.lastStateChange !== undefined) {
        expect(result.lastStateChange).toBe(fields.lastStateChange);
      } else {
        expect("lastStateChange" in result).toBe(false);
      }

      if (fields.agentSessionId) {
        expect(result.agentSessionId).toBe(fields.agentSessionId);
      } else {
        expect("agentSessionId" in result).toBe(false);
      }

      if (fields.agentModelId) {
        expect(result.agentModelId).toBe(fields.agentModelId);
      } else {
        expect("agentModelId" in result).toBe(false);
      }

      if (fields.agentState && fields.agentState !== "directing") {
        expect(result.agentState).toBe(fields.agentState);
      } else {
        // "directing" is intentionally excluded from serialization (#5832).
        expect("agentState" in result).toBe(false);
      }

      if (fields.agentLaunchFlags?.length) {
        expect(result.agentLaunchFlags).toEqual(fields.agentLaunchFlags);
      } else {
        expect("agentLaunchFlags" in result).toBe(false);
      }
    });
  });

  describe("browser", () => {
    test.prop([browserArb])(
      "deserialize(serialize(x)) preserves all persisted fields",
      (fields) => {
        const input: BrowserData = { ...basePanel("browser"), ...fields } as BrowserData;
        const saved = getPanelKindConfig("browser")!.serialize!(input) as SavedTerminalData;
        const restored = getDeserializer("browser")!(saved);

        expect(restored.browserUrl).toBe(fields.browserUrl);
        expect(restored.browserHistory).toEqual(fields.browserHistory);
        expect(restored.browserZoom).toBe(fields.browserZoom);
        expect(restored.browserConsoleOpen).toBe(fields.browserConsoleOpen);
      }
    );
  });

  describe("dev-preview", () => {
    test.prop([devPreviewArb])(
      "deserialize(serialize(x)) preserves fields through devCommand↔command rename",
      (fields) => {
        const input: DevPreviewData = {
          ...basePanel("dev-preview"),
          ...fields,
        } as DevPreviewData;
        const saved = getPanelKindConfig("dev-preview")!.serialize!(input) as SavedTerminalData;
        const restored = getDeserializer("dev-preview")!(saved);

        // Serializer writes t.devCommand?.trim() into snapshot.command; deserializer
        // prefers snapshot.devCommand, then falls back to snapshot.command. Whitespace
        // and empty strings normalise to undefined.
        expect(restored.devCommand).toBe(fields.devCommand?.trim() || undefined);

        expect(restored.browserUrl).toBe(fields.browserUrl);
        expect(restored.browserHistory).toEqual(fields.browserHistory);
        expect(restored.browserZoom).toBe(fields.browserZoom);
        expect(restored.devPreviewConsoleOpen).toBe(fields.devPreviewConsoleOpen);
        expect(restored.devPreviewConsoleTab).toBe(fields.devPreviewConsoleTab);
        expect(restored.devPreviewScrollPosition).toEqual(fields.devPreviewScrollPosition);
        // Only an endpoint panel carries the flag; an ordinary one stays without it.
        expect(restored.previewsResourceEndpoint).toBe(
          fields.previewsResourceEndpoint || undefined
        );

        // exitBehavior is NOT returned by getDeserializer("dev-preview"); the real
        // restore path adds it via buildArgsForNonPtyRecreation's base args before
        // merging the deserializer result, so it is out of scope for this assertion.
      }
    );
  });
});

// ── Serialize hooks: exact snapshot shape ────────────────────────────

function makePanel(
  overrides: Partial<PanelInstance> & Record<string, unknown> = {}
): PanelInstance {
  return {
    id: "t1",
    title: "Test",
    location: "grid",
    kind: "terminal",
    cwd: "",
    cols: 80,
    rows: 24,
    ...overrides,
  } as PanelInstance;
}

function devPreviewPanel(overrides: Partial<DevPreviewPanelData> = {}): DevPreviewPanelData {
  return {
    id: "dp-1",
    kind: "dev-preview",
    title: "Dev Preview",
    location: "grid",
    cwd: "/tmp/project",
    ...overrides,
  } as DevPreviewPanelData;
}

describe("panelKindRegistry serialize hooks (co-located)", () => {
  describe("terminal", () => {
    it("serializes PTY fields", () => {
      const config = getPanelKindConfig("terminal");
      const result = config!.serialize!(
        makePanel({
          kind: "terminal",
          cwd: "/home",
          command: "  ls -la  ",
          createdAt: 100,
          exitBehavior: "keep",
        })
      );
      expect(result).toEqual({
        launchAgentId: undefined,
        cwd: "/home",
        command: "ls -la",
        exitBehavior: "keep",
      });
    });
  });

  describe("browser", () => {
    it("omits falsy browserUrl", () => {
      const config = getPanelKindConfig("browser");
      const result = config!.serialize!(makePanel({ kind: "browser" }));
      expect(result).toEqual({});
    });
  });

  describe("dev-preview", () => {
    it("serializes dev-preview fields with devCommand as command", () => {
      const config = getPanelKindConfig("dev-preview");
      const result = config!.serialize!(
        makePanel({
          kind: "dev-preview",
          cwd: "/project",
          devCommand: "  npm run dev  ",
          browserUrl: "http://localhost:5173",
          browserZoom: 1.0,
          devPreviewConsoleOpen: true,
          devPreviewConsoleTab: "console",
          createdAt: 100,
          exitBehavior: "keep",
        })
      );
      expect(result).toEqual({
        cwd: "/project",
        command: "npm run dev",
        browserUrl: "http://localhost:5173",
        browserZoom: 1.0,
        devPreviewConsoleOpen: true,
        devPreviewConsoleTab: "console",
        exitBehavior: "keep",
      });
    });

    it("omits viewport emulation fields when unset", () => {
      const snapshot = serializeDevPreview(devPreviewPanel());
      expect(snapshot).not.toHaveProperty("viewportRotated");
      expect(snapshot).not.toHaveProperty("viewportDpr");
      expect(snapshot).not.toHaveProperty("viewportFit");
    });

    it("persists explicit falsey defaults so a restored panel is not ambiguous", () => {
      const snapshot = serializeDevPreview(
        devPreviewPanel({ viewportRotated: false, viewportDpr: 1, viewportFit: false })
      );
      expect(snapshot.viewportRotated).toBe(false);
      expect(snapshot.viewportDpr).toBe(1);
      expect(snapshot.viewportFit).toBe(false);
    });
  });
});

// ── createDefaults hooks ─────────────────────────────────────────────

describe("panelKindRegistry createDefaults (co-located)", () => {
  it("browser factory returns browserUrl with default when not provided", () => {
    const config = getPanelKindConfig("browser")!;
    const result = config.createDefaults!({ kind: "browser" });
    expect(result.browserUrl).toBe("http://localhost:3000");
    expect(result.cwd).toBeUndefined();
    expect(result.cols).toBeUndefined();
    expect(result.rows).toBeUndefined();
  });

  it("browser factory preserves provided browserUrl", () => {
    const config = getPanelKindConfig("browser")!;
    const result = config.createDefaults!({
      kind: "browser",
      browserUrl: "https://example.com",
      browserZoom: 1.5,
      browserConsoleOpen: true,
    } as AddPanelOptions);
    expect(result.browserUrl).toBe("https://example.com");
    expect(result.browserZoom).toBe(1.5);
    expect(result.browserConsoleOpen).toBe(true);
  });

  it("dev-preview factory returns kind-specific fields", () => {
    const config = getPanelKindConfig("dev-preview")!;
    const result = config.createDefaults!({
      kind: "dev-preview",
      cwd: "/project",
      devCommand: "npm run dev",
      browserUrl: "http://localhost:3000",
    } as AddPanelOptions);
    expect(result.cwd).toBe("/project");
    expect(result.devCommand).toBe("npm run dev");
    expect(result.browserUrl).toBe("http://localhost:3000");
    expect(result.cols).toBeUndefined();
    expect(result.rows).toBeUndefined();
  });

  it("dev-preview defaults cwd to empty string", () => {
    const config = getPanelKindConfig("dev-preview")!;
    const result = config.createDefaults!({ kind: "dev-preview" } as AddPanelOptions);
    expect(result.cwd).toBe("");
  });

  it("dev-preview forwards devPreviewConsoleTab so the persisted tab survives restore", () => {
    const result = createDevPreviewDefaults({
      kind: "dev-preview",
      cwd: "/project",
      devPreviewConsoleOpen: true,
      devPreviewConsoleTab: "console",
    } as DevPreviewPanelOptions);
    expect(result.devPreviewConsoleOpen).toBe(true);
    expect(result.devPreviewConsoleTab).toBe("console");
  });

  it("review factory returns empty object (worktreeId carried by base)", () => {
    const config = getPanelKindConfig("review")!;
    const result = config.createDefaults!({
      kind: "review",
      worktreeId: "wt-1",
    } as AddPanelOptions);
    expect(Object.keys(result)).toHaveLength(0);
  });
});
