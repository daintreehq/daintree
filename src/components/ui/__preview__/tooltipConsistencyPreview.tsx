// First, so the bridge shim (with the toolbar's project / MCP / onboarding answers)
// and the platform override exist before any store module evaluates.
import { PREVIEW_PROJECT } from "@/components/Layout/__preview__/toolbarShims";
import {
  StrictMode,
  useEffect,
  useId,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { PanelLeft, Pin, RefreshCw, X } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import type { AgentAvailabilityState } from "@shared/types/ipc/system";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import type { AgentSettings, CliAvailability } from "@shared/types";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import type { DaintreeMcpTier, Project, ProjectSettings } from "@shared/types/project";
import type { LoadedPluginInfo, ProjectPluginInfo } from "@shared/types/plugin";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import type { Issue, Page } from "@shared/types/forge";
import type { AgentPreset } from "@/config/agents";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { UI_TOOLTIP_DELAY_DURATION, UI_TOOLTIP_SKIP_DELAY_DURATION } from "@/lib/animationUtils";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useAppThemeStore } from "@/store/appThemeStore";
import { useVoiceRecordingStore } from "@/store";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";
import { useHostMemoryPauseStore } from "@/store/hostMemoryPauseStore";
import { usePluginManagerStore } from "@/store/pluginManagerStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import type { TrashedTerminal } from "@/store/slices";
import { useProjectSwitcherPalette } from "@/hooks/useProjectSwitcherPalette";
import { HelpSessionTabs, type HelpSessionTab } from "@/components/HelpPanel/HelpSessionTabs";
import { TurnOutcomePip } from "@/components/HelpPanel/TurnOutcomePip";
import { VoiceInputButton } from "@/components/Terminal/VoiceInputButton";
import { BannerOverflowMenu } from "@/components/Terminal/BannerOverflowMenu";
import { DevServerDashboard } from "@/components/Portal/DevServerDashboard";
import { EnvVarEditor } from "@/components/Settings/EnvVarEditor";
import { PresetColorPicker } from "@/components/Settings/PresetColorPicker";
import { SettingsGroup } from "@/components/Settings/SettingsGroup";
import { CustomPresetChrome } from "@/components/Settings/AgentScopeEditor/CustomPresetChrome";
import { FallbackChainEditor } from "@/components/Settings/AgentScopeEditor/FallbackChainEditor";
import { DiffNoteCard } from "@/components/Worktree/DiffNoteWidgets";
import type { DiffNote } from "@/components/Worktree/diffNotes";
import { RunningTaskList } from "@/components/Project/RunningTaskList";
import { GeneralTab } from "@/components/Project/GeneralTab";
import { SavedFleetQuickRecall } from "@/components/Fleet/SavedFleetQuickRecall";
import { PluginManagerView } from "@/components/Plugin/PluginManagerView";
import { ProjectPluginSection } from "@/components/Plugin/ProjectPluginSection";
import { PRDetectionPausedIndicator } from "@/components/Layout/PRDetectionPausedIndicator";
import { HostMemoryPauseIndicator } from "@/components/Layout/HostMemoryPauseIndicator";
import { VoiceRecordingToolbarButton } from "@/components/Layout/VoiceRecordingToolbarButton";
import { TrashContainer } from "@/components/Layout/TrashContainer";
import { Toolbar } from "@/components/Layout/Toolbar";
import { UpdateCwdDialog } from "@/components/Terminal/UpdateCwdDialog";
import "@/index.css";

/**
 * Standalone visual-review harness for tooltip consistency across icon and action
 * buttons.
 *
 * Every cell mounts the REAL component against seeded stores and the real theme
 * tokens, inside the same `TooltipProvider` configuration `App.tsx` uses (delay,
 * skip-delay, `disableHoverableContent`). The capture spec
 * (`tooltip-consistency-review.spec.ts`) hovers or keyboard-focuses each trigger and
 * photographs what a user gets: the shared styled `Tooltip` if there is one, or an
 * injected annotation naming the native `title=` the OS would show instead.
 *
 * Nothing here is a copy of product markup except the `reference` cell, which is
 * the canonical control the others are judged against. Harness-only wrappers carry
 * `data-harness-*` attributes and never a `title`.
 *
 * Query parameters:
 *   ?theme=<built-in theme id>
 *   ?mode=grid|plugin-manager|update-cwd|update-cwd-long
 *                               the plugin manager and the change-directory dialog
 *                               are full-window portals, so each gets a page of its
 *                               own. The dialog's suggestions come from the project
 *                               root plus the nearest surviving ancestor, so it can
 *                               only ever show two chips: `update-cwd` makes them
 *                               share a basename, `update-cwd-long` makes one clip.
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const PAGE_MODES = ["grid", "plugin-manager", "update-cwd", "update-cwd-long"] as const;
type PageMode = (typeof PAGE_MODES)[number];
const mode: PageMode = PAGE_MODES.find((m) => m === params.get("mode")) ?? "grid";
const isCwdMode = mode === "update-cwd" || mode === "update-cwd-long";

const NOW = Date.now();

// ── Bridge answers ────────────────────────────────────────────────────────────

const PROJECT: Project = {
  ...PREVIEW_PROJECT,
  path: "/Users/greg/Projects/clients/helios/platform/helios-analytics-dashboard-platform",
  name: "helios-analytics-dashboard-platform",
  emoji: "☀️",
};

/** The change-directory pages' project, whose root is one of the suggestions. */
const CWD_PROJECT_ROOT = "/Users/greg/repos/app";
const CWD_LONG_BASENAME =
  "helios-analytics-dashboard-platform-issue-12383-menu-rows-show-keyboard-focus-ring";
const CWD_FIXTURE =
  mode === "update-cwd-long"
    ? {
        missing: `/Users/greg/worktrees/${CWD_LONG_BASENAME}/packages/ingest`,
        existing: [CWD_PROJECT_ROOT, `/Users/greg/worktrees/${CWD_LONG_BASENAME}`],
      }
    : {
        missing: "/Users/greg/worktrees/app/packages/ingest",
        existing: [CWD_PROJECT_ROOT, "/Users/greg/worktrees/app"],
      };
const ACTIVE_PROJECT: Project = isCwdMode
  ? { ...PROJECT, path: CWD_PROJECT_ROOT, name: "app" }
  : PROJECT;

function issue(number: number, title: string, extra: Partial<Issue> = {}): Issue {
  return {
    number,
    title,
    body: "",
    state: "open",
    rawState: "OPEN",
    url: `https://github.com/acme/helios/issues/${number}`,
    author: { login: "gpriday", rawData: null },
    assignees: [],
    labels: [],
    commentCount: 0,
    createdAt: NOW - number * 3_600_000,
    updatedAt: NOW - number * 600_000,
    closedAt: null,
    rawData: null,
    ...extra,
  };
}

const ISSUES: Issue[] = [
  issue(12383, "Menu rows show a keyboard focus ring on mouse hover", {
    labels: [{ name: "bug", color: "d73a4a" }],
    commentCount: 4,
  }),
  issue(12377, "Worktree sidebar rail overflows at narrow widths"),
  issue(12371, "Import budget ratchet double-counts type-only imports", {
    labels: [{ name: "tooling", color: "0e8a16" }],
  }),
  issue(12366, "Dev preview console loses scroll position after a reload"),
];

const ISSUE_PAGE: Page<Issue> = { items: ISSUES, nextCursor: null, hasMore: false };

const DEV_SESSIONS: DevPreviewSessionState[] = [
  {
    panelId: "dp-1",
    projectId: PROJECT.id,
    worktreeId: "wt-main",
    status: "running",
    url: "http://localhost:5173/",
    predictedUrl: null,
    error: null,
    terminalId: "term-dp-1",
    isRestarting: false,
    generation: 1,
    updatedAt: NOW,
    lastOutput: "  VITE v8.0.14  ready in 412 ms  ➜  Local:   http://localhost:5173/",
  },
  {
    panelId: "dp-2",
    projectId: PROJECT.id,
    worktreeId: "wt-12383",
    status: "error",
    url: null,
    predictedUrl: "http://localhost:5174/",
    error: {
      type: "port-conflict",
      message: "Port 5174 is already in use",
      port: "5174",
    },
    terminalId: null,
    isRestarting: false,
    generation: 2,
    updatedAt: NOW,
    lastOutput: "Error: listen EADDRINUSE: address already in use :::5174",
  },
];

const NO_CONTRIBUTIONS: LoadedPluginInfo["manifest"]["contributes"] = {
  panels: [],
  toolbarButtons: [],
  menuItems: [],
  keybindings: [],
  contextMenus: [],
  commands: [],
  views: [],
  mcpServers: [],
  skills: [],
  forgeProviders: [],
  fileDecorationProviders: [],
  fileEditors: [],
  agents: [],
  processTools: [],
  recipes: [],
};

function plugin(
  name: string,
  displayName: string,
  extra: Partial<LoadedPluginInfo> = {}
): LoadedPluginInfo {
  return {
    manifest: {
      name,
      version: "2.4.1-alpha.3",
      displayName,
      tagline: "Streams workspace activity to your compliance archive",
      contributes: NO_CONTRIBUTIONS,
    },
    instanceId: name,
    origin: "global",
    projectId: null,
    dir: `/Users/greg/.daintree/plugins/${name}`,
    loadedAt: NOW,
    isBuiltin: false,
    source: "catalog",
    installedAt: NOW - 86_400_000,
    archiveHash: null,
    originalUrl: null,
    loadError: null,
    disabled: false,
    updateAvailable: null,
    devMode: false,
    pluginDanger: "safe",
    blocklisted: false,
    ...extra,
  };
}

const PLUGINS: LoadedPluginInfo[] = [
  plugin(
    "acme.enterprise-compliance-audit-trail-exporter",
    "Enterprise Compliance Audit Trail Exporter for Regulated Workspaces"
  ),
  plugin("acme.linear", "Linear", {
    manifest: {
      name: "acme.linear",
      version: "1.2.0",
      displayName: "Linear",
      tagline: "Issues and cycles",
      contributes: NO_CONTRIBUTIONS,
    },
  }),
];

const PROJECT_PLUGINS: ProjectPluginInfo[] = [
  {
    projectId: PROJECT.id,
    id: "helios.release-checklist",
    instanceId: `project__${PROJECT.id}__helios.release-checklist`,
    displayName: "Release checklist for the analytics dashboard platform",
    version: "0.3.0",
    capabilities: [],
    dirName: "release-checklist",
    state: "active",
    muted: false,
    collidesWithGlobal: false,
  },
];

/** Like `namespace`, but unanswered names fall through to the shim's own answer. */
function layered(name: string, answers: Record<string, unknown>): unknown {
  const base: unknown = Reflect.get(baseBridge, name);
  return new Proxy(answers, {
    get: (target, key) =>
      key in target
        ? Reflect.get(target, key)
        : base && typeof base === "object"
          ? Reflect.get(base, key)
          : () => inert(),
  });
}

/** A thenable function: awaitable as a request, callable as an unsubscribe. */
function inert(value?: unknown): unknown {
  const settled = Promise.resolve(value);
  return Object.assign(() => undefined, {
    then: settled.then.bind(settled),
    catch: settled.catch.bind(settled),
    finally: settled.finally.bind(settled),
  });
}

function namespace(answers: Record<string, unknown>): unknown {
  return new Proxy(answers, {
    get: (target, key) => (key in target ? Reflect.get(target, key) : () => inert()),
  });
}

// `toolbarShims` has already installed the inert bridge with its own answers; this
// layers the few namespaces these cells need answered for real on top of it.
const baseBridge: object = Reflect.get(window, "electron") ?? {};
const OVERRIDES: Record<string, unknown> = {
  devPreview: namespace({
    getAllSessions: () => Promise.resolve(DEV_SESSIONS),
    onAllSessionsChanged: () => () => {},
  }),
  plugin: namespace({
    list: () => Promise.resolve(PLUGINS),
  }),
  project: namespace({
    getAll: async () => [ACTIVE_PROJECT],
    getCurrent: async () => ACTIVE_PROJECT,
    onSwitch: () => () => {},
  }),
  // The GitHub list self-initializes its token state, then fetches its first page.
  forge: layered("forge", {
    getCredentialStatus: async () => ({ hasCredential: true }),
    listIssues: async () => ISSUE_PAGE,
    getIssueUrl: async () => "https://github.com/acme/helios/issues/1",
  }),
  // The change-directory dialog's suggestions are the folders this confirms.
  system: layered("system", {
    checkDirectory: async (dir: string) => CWD_FIXTURE.existing.includes(dir),
  }),
};
Reflect.set(
  window,
  "electron",
  new Proxy(OVERRIDES, {
    get: (target, key) => (key in target ? Reflect.get(target, key) : Reflect.get(baseBridge, key)),
  })
);

// ── Store fixtures ────────────────────────────────────────────────────────────

const WORKTREES: WorktreeSnapshot[] = [
  {
    id: "wt-main",
    worktreeId: "wt-main",
    path: PROJECT.path,
    name: "main",
    branch: "fix/11958-worktree-sidebar-rail-overflow-at-narrow-widths",
    isCurrent: true,
    isMainWorktree: true,
  },
  {
    id: "wt-12383",
    worktreeId: "wt-12383",
    path: "/Users/greg/Projects/daintree-worktrees/issue-12383",
    name: "issue-12383",
    branch: "bugfix/issue-12383-menu-rows-show-keyboard-focus",
    isCurrent: false,
  },
];

function pane(id: string, title: string, extra: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    title,
    kind: "terminal",
    cwd: PROJECT.path,
    cols: 120,
    rows: 40,
    worktreeId: "wt-main",
    location: "grid",
    hasPty: true,
    runtimeStatus: "running",
    ...extra,
  };
}

const LONG_COMMAND =
  "npm run test:integration -- --project=analytics-ingest --reporter=verbose --shard=3/8 --retries=2";

const TRASHED_PANES: PanelInstance[] = [
  pane("trash-1", "codex · stop menu rows ringing on hover", {
    location: "trash",
    detectedAgentId: "codex",
  }),
  pane("trash-2", "zsh", { location: "trash" }),
];

const TRASH_ENTRIES: Array<{ terminal: PanelInstance; trashedInfo: TrashedTerminal }> =
  TRASHED_PANES.map((terminal, i) => ({
    terminal,
    trashedInfo: {
      id: terminal.id,
      // Well past the capture's length, so no row expires mid-sweep.
      expiresAt: NOW + 3_600_000 + i * 1000,
      originalLocation: "grid",
    },
  }));

const PANELS: PanelInstance[] = [
  pane("t-1", "claude · menu rows focus ring", {
    detectedAgentId: "claude",
    agentState: "working",
  }),
  pane("t-2", "codex · import budget ratchet", { detectedAgentId: "codex", agentState: "idle" }),
  pane("t-3", "gemini · worktree card PR number", {
    detectedAgentId: "gemini",
    agentState: "waiting",
  }),
  pane("task-1", LONG_COMMAND, {
    spawnedBy: "quickrun",
    command: LONG_COMMAND,
    startedAt: NOW - 65_000,
  }),
  ...TRASHED_PANES,
];

const SAVED_SCOPES: ProjectSettings["fleetSavedScopes"] = [
  {
    kind: "snapshot",
    id: "s-short",
    name: "Bugfix pair",
    terminalIds: ["t-1", "t-2"],
    createdAt: NOW - 86_400_000,
    lastUsedAt: NOW - 3_600_000,
  },
  {
    kind: "snapshot",
    id: "s-long",
    name: "Release train — changelog, notes and the flaky pty-host follow-up",
    terminalIds: ["t-1", "t-2", "t-3"],
    createdAt: NOW - 2 * 86_400_000,
    lastUsedAt: NOW - 6 * 3_600_000,
  },
];

let worktreeStore = createWorktreeStore();
let agentAvailability: CliAvailability = {};
const agentSettings: AgentSettings = { agents: {} } as AgentSettings;

/** Seeded before the first render — the harness photographs a state, not an arrival. */
function seedStores(): void {
  initBuiltInPanelKinds();
  useAppThemeStore.setState({ selectedSchemeId: themeId });

  worktreeStore = createWorktreeStore();
  worktreeStore.setState({ worktrees: new Map(WORKTREES.map((w) => [w.id, w])) });
  setCurrentViewStore(worktreeStore);
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-main" });
  useProjectStore.setState({ currentProject: ACTIVE_PROJECT });

  const availability: Record<string, AgentAvailabilityState> = {
    claude: "ready",
    codex: "ready",
    gemini: "ready",
  };
  agentAvailability = availability as CliAvailability;
  useCliAvailabilityStore.setState({ availability, hasRealData: true });
  useAgentSettingsStore.setState({ settings: agentSettings });

  usePanelStore.setState({
    panelsById: Object.fromEntries(PANELS.map((p) => [p.id, p])),
    panelIds: PANELS.map((p) => p.id),
    panelIdsByWorktreeId: { "wt-main": PANELS.map((p) => p.id) },
  });
  useProjectSettingsStore.setState({
    settings: { runCommands: [], fleetSavedScopes: SAVED_SCOPES },
  });

  // Configured and idle for this cell's panel; the toolbar button needs a live
  // session, so one is parked (paused — no RAF loop) on a different panel.
  useVoiceRecordingStore.setState({
    isConfigured: true,
    status: "paused",
    elapsedSeconds: 42,
    activeTarget: {
      panelId: "voice-elsewhere",
      panelTitle: "claude · release notes",
      projectName: PROJECT.name,
      worktreeLabel: "main",
    },
  });
  usePRCircuitBreakerStore.setState({ tripped: true });
  useHostMemoryPauseStore.setState({
    visible: true,
    snapshot: { active: true, paused: true, stalled: false },
  });

  useProjectPluginStore.setState({ plugins: PROJECT_PLUGINS });
  if (mode === "plugin-manager") usePluginManagerStore.setState({ isOpen: true });
}

seedStores();

// ── Cells ─────────────────────────────────────────────────────────────────────

function Cell({
  shot,
  title,
  wide,
  children,
}: {
  shot: string;
  title: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      data-shot={shot}
      className="flex flex-col rounded-[var(--radius-lg)] border border-border-default bg-surface-canvas"
      style={wide ? { gridColumn: "1 / -1" } : undefined}
    >
      <header className="flex items-baseline gap-2 border-b border-divider px-3 py-1.5">
        <span className="font-mono text-2xs uppercase tracking-wide text-text-secondary">
          {shot}
        </span>
        <span className="text-2xs text-text-muted">{title}</span>
      </header>
      <div
        data-harness-stage=""
        className="flex flex-col justify-center px-6"
        style={{ paddingTop: 150, paddingBottom: 180 }}
      >
        {children}
      </div>
    </section>
  );
}

/** A quiet panel surface for components that sit on one in the app. */
function Surface({ children, width }: { children: ReactNode; width?: number }) {
  return (
    <div
      data-harness-surface=""
      className="rounded-[var(--radius-md)] border border-border-subtle bg-surface-panel"
      style={width ? { width } : undefined}
    >
      {children}
    </div>
  );
}

function HelpTabs({ canOpenSession }: { canOpenSession: boolean }) {
  const idBase = useId();
  const [active, setActive] = useState(0);
  const tabs: HelpSessionTab[] = [
    {
      slot: 0,
      label: "Fix the flaky pty-host reconnect test on…",
      fullTitle:
        "Fix the flaky pty-host reconnect test on Windows CI where the second attach races the resize",
      agentState: "working",
    },
    { slot: 1, label: "Session 2", agentState: null },
    { slot: 2, label: "Session 3", agentState: "waiting" },
  ];
  return (
    <Surface width={380}>
      <HelpSessionTabs
        tabs={tabs}
        activeSlot={active}
        onSelect={setActive}
        onClose={() => {}}
        canOpenSession={canOpenSession}
        onOpenSession={() => {}}
        idBase={idBase}
        panelId={`${idBase}-body`}
      />
      <div id={`${idBase}-body`} className="h-8" aria-hidden="true" />
    </Surface>
  );
}

const AGENT_COLOR = "#d97757";

const PRESETS: AgentPreset[] = [
  { id: "p-main", name: "Plan first — Sonnet via Bedrock", color: "#5b8def" },
  { id: "p-a", name: "Fast" },
  { id: "p-mid", name: "Opus via Vertex (eu-west)" },
  { id: "p-c", name: "Local proxy" },
];

function PresetChromeCell() {
  const [preset, setPreset] = useState<AgentPreset>(PRESETS[0]!);
  return (
    <SettingsGroup>
      <CustomPresetChrome
        selectedPreset={preset}
        agentColor={AGENT_COLOR}
        isEditing={false}
        editName={preset.name}
        onEditNameChange={() => {}}
        onCommitEdit={() => true}
        onCancelEdit={() => {}}
        renameError={null}
        onStartEdit={() => {}}
        onColorChange={(color) => setPreset((p) => ({ ...p, color }))}
        onDisplayTitleChange={(displayTitle) => setPreset((p) => ({ ...p, displayTitle }))}
        onDuplicate={() => {}}
      />
    </SettingsGroup>
  );
}

function FallbackChainCell() {
  const [presets, setPresets] = useState<AgentPreset[]>(() => [
    { ...PRESETS[0]!, fallbacks: ["p-a", "p-mid", "p-c"] },
    ...PRESETS.slice(1),
  ]);
  return (
    <SettingsGroup>
      <FallbackChainEditor
        selectedPreset={presets[0]!}
        allPresets={presets}
        onUpdatePreset={(id, patch) =>
          setPresets((all) => all.map((p) => (p.id === id ? { ...p, ...patch } : p)))
        }
      />
    </SettingsGroup>
  );
}

function EnvVarsCell() {
  // An own (non-inherited) row renders Delete rather than Revert; a secret-sounding
  // key with a key-shaped value renders the reveal eye.
  const [env, setEnv] = useState<Record<string, string>>({
    ANTHROPIC_MODEL: "claude-sonnet-4-5",
    OPENAI_API_KEY: "sk-proj-Q7vN2kLm9XbT4wRz8YcP1aHs6JdF3gE0uViO5nBq",
  });
  return (
    <SettingsGroup>
      <div className="p-3">
        <EnvVarEditor
          env={env}
          onChange={setEnv}
          contextKey="preset-p-main"
          inheritedEnv={{
            ANTHROPIC_MODEL: "claude-opus-4-1",
            ANTHROPIC_BASE_URL: "https://bedrock-runtime.us-east-1.amazonaws.com",
          }}
        />
      </div>
    </SettingsGroup>
  );
}

type ResourceListComponent = ComponentType<{ type: "issue" | "pr"; projectPath: string }>;

// Through a glob, as the forge-stats harness does: the plugin tree is outside the
// renderer's project graph, and only the grid page mounts it.
const githubListModules = import.meta.glob<{ GitHubResourceList: ResourceListComponent }>(
  "../../../../plugins/builtin/github/renderer/components/GitHubResourceList.tsx"
);
let GitHubResourceList: ResourceListComponent | null = null;
if (mode === "grid") {
  const load = Object.values(githubListModules)[0];
  if (!load) throw new Error("GitHubResourceList module not found");
  GitHubResourceList = (await load()).GitHubResourceList;
}

function GitHubListCell() {
  if (!GitHubResourceList) return null;
  return (
    <Surface>
      <GitHubResourceList type="issue" projectPath={PROJECT.path} />
    </Surface>
  );
}

const NOTE: DiffNote = {
  id: "note-1",
  worktreePath: PROJECT.path,
  filePath: "src/services/ingest/uploader.ts",
  anchor: { kind: "lines", side: "new", startLine: 42, endLine: 48, contentHash: "a1b2c3" },
  body: "Retry-After can be an HTTP date as well as seconds — parse both before backing off.",
  createdAt: NOW - 600_000,
  updatedAt: NOW - 600_000,
};

function ColorPickerCell() {
  const [color, setColor] = useState<string | undefined>("#5b8def");
  return (
    <div className="flex items-center gap-2 text-sm text-text-primary">
      <PresetColorPicker
        color={color}
        agentColor={AGENT_COLOR}
        onChange={setColor}
        ariaLabel="Preset color"
      />
      <span>Plan first</span>
    </div>
  );
}

function GeneralTabCell() {
  const [name, setName] = useState(PROJECT.name);
  const [emoji, setEmoji] = useState(PROJECT.emoji);
  const [color, setColor] = useState<string | undefined>(undefined);
  const [devServerCommand, setDevServerCommand] = useState("npm run dev");
  const [loadTimeout, setLoadTimeout] = useState<number | undefined>(undefined);
  const [turbopack, setTurbopack] = useState(false);
  const [tier, setTier] = useState<DaintreeMcpTier>("core");
  const [skipConfirm, setSkipConfirm] = useState(false);
  const [iconSvg, setIconSvg] = useState<string | undefined>(undefined);
  return (
    <div style={{ width: 640 }}>
      <GeneralTab
        currentProject={PROJECT}
        name={name}
        onNameChange={setName}
        emoji={emoji}
        onEmojiChange={setEmoji}
        color={color}
        onColorChange={setColor}
        devServerCommand={devServerCommand}
        onDevServerCommandChange={setDevServerCommand}
        devServerLoadTimeout={loadTimeout}
        onDevServerLoadTimeoutChange={setLoadTimeout}
        turbopackEnabled={turbopack}
        onTurbopackEnabledChange={setTurbopack}
        daintreeMcpTier={tier}
        onDaintreeMcpTierChange={setTier}
        daintreeMcpSkipConfirmations={skipConfirm}
        onDaintreeMcpSkipConfirmationsChange={setSkipConfirm}
        projectIconSvg={iconSvg}
        onProjectIconSvgChange={setIconSvg}
        enableInRepoSettings={async () => PROJECT}
        disableInRepoSettings={async () => PROJECT}
        projectId={PROJECT.id}
        isOpen
      />
    </div>
  );
}

function ToolbarCell() {
  // The real hook, so the pill is wired exactly as AppLayout wires it.
  const projectSwitcherPalette = useProjectSwitcherPalette();
  const noop = () => {};
  return (
    <div data-harness-toolbar-frame="" style={{ width: 1600 }}>
      <Toolbar
        onLaunchAgent={noop}
        onSettings={noop}
        hasWorkspace
        agentAvailability={agentAvailability}
        agentSettings={agentSettings}
        projectSwitcherPalette={projectSwitcherPalette}
      />
    </div>
  );
}

/** The canonical control the rest are judged against. */
function ReferenceCell() {
  return (
    <div className="flex items-center gap-6">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Close panel" data-tip-trigger="plain">
            <X aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Close panel</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle sidebar"
            data-tip-trigger="shortcut"
          >
            <PanelLeft aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {createTooltipContent("Toggle sidebar", "Cmd+B")}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function Grid() {
  return (
    <div
      data-preview-shell=""
      className="grid gap-4 p-4 text-text-primary"
      style={{ gridTemplateColumns: "repeat(2, 820px)", width: 1680 }}
    >
      <Cell shot="reference" title="Button ghost icon-sm + shared Tooltip (canonical)">
        <ReferenceCell />
      </Cell>
      <Cell shot="help-tabs" title="HelpSessionTabs — task tab active, lanes free">
        <HelpTabs canOpenSession />
      </Cell>
      <Cell shot="help-tabs-max" title="HelpSessionTabs — at the lane maximum">
        <HelpTabs canOpenSession={false} />
      </Cell>
      <Cell shot="voice-input" title="VoiceInputButton — configured, idle">
        <div
          className="flex h-10 w-[260px] items-center justify-end rounded-[var(--radius-md)] border border-border-default bg-surface-input px-2"
          style={{ ["--ib-fg" as string]: "var(--color-text-primary)" }}
        >
          <VoiceInputButton panelId="voice-panel" panelTitle="claude · release notes" />
        </div>
      </Cell>
      <Cell shot="dev-servers" title="DevServerDashboard — running + errored, hideable" wide>
        {/* The dashboard caps itself at 40% of the portal column it docks into, so
            it needs a column of real height to lay its rows out. */}
        <div
          data-harness-surface=""
          className="flex flex-col justify-end rounded-[var(--radius-md)] border border-border-subtle bg-surface-panel"
          style={{ width: 420, height: 520 }}
        >
          <DevServerDashboard onHide={() => {}} />
        </div>
      </Cell>
      <Cell shot="env-vars" title="EnvVarEditor — one inherited, one overridden">
        <EnvVarsCell />
      </Cell>
      <Cell shot="preset-chrome" title="CustomPresetChrome — selected preset">
        <PresetChromeCell />
      </Cell>
      <Cell shot="fallback-chain" title="FallbackChainEditor — three fallbacks">
        <FallbackChainCell />
      </Cell>
      <Cell shot="diff-note" title="DiffNoteCard — a line note">
        <Surface width={480}>
          <div className="p-2">
            <DiffNoteCard note={NOTE} />
          </div>
        </Surface>
      </Cell>
      <Cell shot="banner-overflow" title="BannerOverflowMenu — demoted banner actions">
        <div className="flex items-center gap-2">
          <BannerOverflowMenu
            actions={[
              { id: "retry", label: "Retry", icon: RefreshCw, onClick: () => {} },
              { id: "pin", label: "Keep this pane", icon: Pin, onClick: () => {} },
            ]}
          />
          <span className="text-xs text-text-secondary">Agent exited with code 1</span>
        </div>
      </Cell>
      <Cell shot="running-task" title="RunningTaskList — a truncating quick-run command">
        <Surface width={280}>
          <div className="p-1">
            <RunningTaskList worktreeId="wt-main" />
          </div>
        </Surface>
      </Cell>
      <Cell shot="saved-fleets" title="SavedFleetQuickRecall — short + truncating chips">
        <Surface width={520}>
          <div className="px-3 pb-2">
            <SavedFleetQuickRecall mode="replace" onRecalled={() => {}} onManage={() => {}} />
          </div>
        </Surface>
      </Cell>
      <Cell shot="color-picker" title="PresetColorPicker — swatch trigger">
        <ColorPickerCell />
      </Cell>
      <Cell shot="turn-outcome" title="TurnOutcomePip — reasoning-loop">
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <TurnOutcomePip outcome="reasoning-loop" onDismiss={() => {}} />
        </div>
      </Cell>
      <Cell shot="toolbar-indicators" title="PR paused · host memory pause · voice recording">
        <div className="flex h-12 items-center gap-1 surface-toolbar rounded-[var(--radius-md)] px-2">
          <span data-harness-slot="pr-paused" className="flex h-9 items-center">
            <PRDetectionPausedIndicator />
          </span>
          <span data-harness-slot="host-memory" className="flex items-center">
            <HostMemoryPauseIndicator />
          </span>
          <span data-harness-slot="voice-recording" className="flex items-center">
            <VoiceRecordingToolbarButton data-toolbar-item="" />
          </span>
        </div>
      </Cell>
      <Cell shot="trash" title="TrashContainer — two closed terminals">
        <div className="flex h-9 items-center justify-end border-t border-divider bg-surface-toolbar px-3">
          <TrashContainer trashedTerminals={TRASH_ENTRIES} />
        </div>
      </Cell>
      <Cell shot="project-plugin" title="ProjectPluginSection — a project plugin row">
        <Surface width={320}>
          <div className="p-2">
            <ProjectPluginSection plugins={PROJECT_PLUGINS} selectedId={null} onSelect={() => {}} />
          </div>
        </Surface>
      </Cell>
      <Cell shot="toolbar" title="Toolbar — project pill (long path) + Copy context" wide>
        <ToolbarCell />
      </Cell>
      <Cell shot="project-swatches" title="GeneralTab — project colour swatches" wide>
        <GeneralTabCell />
      </Cell>
      <Cell shot="github-list" title="GitHubResourceList — issues, header icon row">
        <GitHubListCell />
      </Cell>
    </div>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    // index.css pins html/body/#root to the viewport with overflow hidden; the grid
    // is taller than any viewport, so let the document scroll.
    for (const el of [document.documentElement, document.body, document.getElementById("root")]) {
      if (!el) continue;
      el.style.height = "auto";
      el.style.overflow = "visible";
    }
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    setReady(true);
  }, [scheme]);

  if (!ready) return null;

  return (
    <WorktreeStoreContext.Provider value={worktreeStore}>
      {mode === "plugin-manager" ? (
        <div data-preview-shell="" data-mode="plugin-manager">
          <PluginManagerView />
        </div>
      ) : isCwdMode ? (
        <div data-preview-shell="" data-mode={mode}>
          <UpdateCwdDialog
            isOpen
            terminalId="t-1"
            currentCwd={CWD_FIXTURE.missing}
            onClose={() => {}}
          />
        </div>
      ) : (
        <Grid />
      )}
    </WorktreeStoreContext.Provider>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <TooltipProvider
        delayDuration={UI_TOOLTIP_DELAY_DURATION}
        skipDelayDuration={UI_TOOLTIP_SKIP_DELAY_DURATION}
        disableHoverableContent
      >
        <App />
      </TooltipProvider>
    </StrictMode>
  );
}
