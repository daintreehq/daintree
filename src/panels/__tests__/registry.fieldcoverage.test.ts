import { beforeAll, describe, expect, it } from "vitest";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import type {
  BrowserPanelData,
  BuiltInPanelKind,
  FilePanelData,
  FileBrowserPanelData,
  DiffPanelData,
  PanelExitBehavior,
} from "@shared/types/panel";
import type { BrowserHistory } from "@shared/types/browser";
import { getDeserializer } from "@/config/panelKindSerialisers";
import type { SavedTerminalData } from "@/utils/stateHydration/statePatcher";
import { initBuiltInPanelKinds } from "../registry";
import type { PtySerializeInput } from "../terminal/serializer";
import type { DevPreviewSerializeInput } from "../dev-preview/serializer";

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
  worktreeId: false,
  isVisible: false,
  extensionState: false,
  pluginId: false,
  // PtyPanelData persisted fields
  launchAgentId: true,
  cwd: true,
  command: true,
  exitBehavior: true,
  agentSessionId: true,
  agentLaunchFlags: true,
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
  restartError: false,
  reconnectError: false,
  scrollbackRestoreError: false,
  flowStatus: false,
  runtimeStatus: false,
  flowStatusTimestamp: false,
  isInputLocked: false,
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
  spawnedBy: false,
  focusPolicy: false,
  excludeFromPersistence: false,
  removeOnExit: false,
  startedAt: false,
  exitCode: false,
  // Parsed check result (#10682) — live signal from agent:state-changed,
  // cleared on restart; intentionally not persisted by the PTY serializer.
  lastCheckResult: false,
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
  worktreeId: false,
  isVisible: false,
  extensionState: false,
  pluginId: false,
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
  worktreeId: false,
  isVisible: false,
  extensionState: false,
  pluginId: false,
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
  worktreeId: false,
  isVisible: false,
  extensionState: false,
  pluginId: false,
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
} as const satisfies Record<keyof FilePanelData, boolean>;

// ── Diff field classification ────────────────────────────────────────

const DIFF_FIELD_CLASSIFICATION = {
  // BasePanelData — persisted by the base serialization layer
  id: false,
  kind: false,
  title: false,
  titleMode: false,
  location: false,
  worktreeId: false,
  isVisible: false,
  extensionState: false,
  pluginId: false,
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
  worktreeId: false,
  isVisible: false,
  extensionState: false,
  pluginId: false,
  // FileBrowserPanelData persisted fields — all user intent (where they are in
  // the tree and how it's laid out), which is exactly what a pinned panel keeps.
  browserSelectedPath: true,
  browserExpandedPaths: true,
  browserHideDotfiles: true,
  browserRootPath: true,
  browserSidebarCollapsed: true,
  // BasePanelData carrier-bookkeeping timestamps — written by the base
  // serialization layer in panelToSnapshot, not per-kind serializers.
  createdAt: false,
  lastActiveAt: false,
  // Ephemerality flag: consumed by the persistence filter to decide whether a
  // panel is written at all, so it is never part of a snapshot's payload.
  excludeFromPersistence: false,
} as const satisfies Record<keyof FileBrowserPanelData, boolean>;

// ── Built-in kind exhaustiveness ─────────────────────────────────────

const BUILT_IN_KINDS = [
  "terminal",
  "browser",
  "dev-preview",
  "review",
  "file",
  "file-browser",
  "diff",
] as const satisfies readonly BuiltInPanelKind[];

// Compile-time exhaustiveness pin: if a new BuiltInPanelKind is added and not
// listed above, this assignment fails with a message naming the missing kind.
type _MissingBuiltInKinds = Exclude<BuiltInPanelKind, (typeof BUILT_IN_KINDS)[number]>;
const _builtInKindsExhaustive: [_MissingBuiltInKinds] extends [never]
  ? true
  : _MissingBuiltInKinds = true;
void _builtInKindsExhaustive;

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
  agentLaunchFlags: ["--resume"],
  agentModelId: "claude-3-5-sonnet",
  agentPresetId: "blue-provider",
  agentPresetColor: "#3366ff",
  originalPresetId: "primary-provider",
  env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" },
  isUsingFallback: true,
  fallbackChainIndex: 1,
  agentState: "idle",
  lastStateChange: 1_700_000_000_000,
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

const fileBrowserFixture: FileBrowserPanelData = {
  id: "panel-file-browser",
  title: "Panel",
  location: "grid",
  kind: "file-browser",
  browserSelectedPath: "src/app.ts",
  browserExpandedPaths: ["src"],
  browserHideDotfiles: true,
  browserRootPath: "src",
  browserSidebarCollapsed: true,
};

const savedFileBrowser: SavedTerminalData = {
  id: "panel-file-browser",
  kind: "file-browser",
  browserSelectedPath: "src/app.ts",
  browserExpandedPaths: ["src"],
  browserHideDotfiles: true,
  browserRootPath: "src",
  browserSidebarCollapsed: true,
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
  exitBehavior: "keep",
  createdAt: 1_700_000_000_000,
};

// ── Setup ────────────────────────────────────────────────────────────

beforeAll(() => {
  initBuiltInPanelKinds();
});

// ── Serializer coverage ──────────────────────────────────────────────

describe("panel serializer field coverage", () => {
  it("every built-in kind registers a serializer", () => {
    for (const kind of BUILT_IN_KINDS) {
      const config = getPanelKindConfig(kind);
      expect(config?.serialize, `kind "${kind}" missing serialize`).toBeTypeOf("function");
    }
  });

  it("terminal serializer covers every persisted PTY field", () => {
    const output = getPanelKindConfig("terminal")!.serialize!(terminalFixture) as Record<
      string,
      unknown
    >;
    assertCovers("terminal serializer", output, persistedKeys(PTY_FIELD_CLASSIFICATION));
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
