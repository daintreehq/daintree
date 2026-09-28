import { bridgeAnswers } from "./labelsBadgesShims";
import { Component, StrictMode, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { DndContext } from "@dnd-kit/core";
import { Settings, Terminal as TerminalIcon, Puzzle } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import type { LoadedPluginInfo, PluginManifest, ProjectPluginInfo } from "@shared/types/plugin";
import type { PtyPanelData } from "@shared/types/panel";
import type { WorktreeState } from "@shared/types/worktree";
import type { StagingFileEntry } from "@shared/types/git";
import type { TerminalInfoPayload } from "@shared/types/ipc/terminal";
import type { DevPreviewDiagnosticsResult } from "@shared/types/ipc/devPreview";
import type { PaneNotifyState } from "@shared/types/terminalNotify";
import type { Project, TerminalRecipe } from "@shared/types";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { actionService } from "@/services/ActionService";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { usePanelStore } from "@/store/panelStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useProjectStore } from "@/store/projectStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { usePluginRuntimeStatusStore } from "@/store/pluginRuntimeStatusStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { usePluginManagerStore } from "@/store/pluginManagerStore";
import { usePluginMcpConfirmStore } from "@/store/pluginMcpConfirmStore";
import { usePluginArchiveInstallStore } from "@/store/pluginArchiveInstallStore";
import { usePluginConfirmStore } from "@/store/pluginConfirmStore";
import { usePluginCapabilityConfirmStore } from "@/store/pluginCapabilityConfirmStore";
import { useMcpConfirmStore } from "@/store/mcpConfirmStore";
import { useNotificationStore } from "@/store/notificationStore";
import {
  useNotificationHistoryStore,
  type NotificationHistoryEntry,
} from "@/store/slices/notificationHistorySlice";
import { flushConsoleCaptureBuffer, useConsoleCaptureStore } from "@/store/consoleCaptureStore";
import { usePluginPanelBadgeStore } from "@/store/pluginPanelBadgeStore";
import { useRateLimitObservationStore } from "@/store/rateLimitObservationStore";
import { useTerminalAdoptionStore } from "@/store/terminalAdoptionStore";
import { useWorktreeSelectionStore, type DeletedWorktree } from "@/store/worktreeStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { PluginDetailPane } from "@/components/Plugin/PluginDetailPane";
import {
  ProjectPluginDetailPane,
  ProjectPluginSection,
} from "@/components/Plugin/ProjectPluginSection";
import { PluginDatabasesSection } from "@/components/Plugin/PluginDatabasesSection";
import { PluginCatalog } from "@/components/Plugin/PluginCatalog";
import { PluginManagerView } from "@/components/Plugin/PluginManagerView";
import { PluginMcpConfirmDialog } from "@/components/Plugin/PluginMcpConfirmDialog";
import { PluginArchiveInstallConfirmDialog } from "@/components/Plugin/PluginArchiveInstallConfirmDialog";
import { PluginConfirmDialog } from "@/components/Plugin/PluginConfirmDialog";
import { PluginCapabilityConfirmDialog } from "@/components/Plugin/PluginCapabilityConfirmDialog";
import { McpConfirmDialog } from "@/components/McpConfirmDialog";
import { TerminalInfoDialog } from "@/components/Terminal/TerminalInfoDialog";
import { ImportEnvDialog } from "@/components/Settings/ImportEnvDialog";
import {
  CommitRows,
  PreviewFrame,
  PreviewNote,
  PreviewSectionHeading,
  PreviewSummary,
  RefChip,
  SummaryRow,
} from "@/components/Git/GitOperationPreview";
import { CommitPanel } from "@/components/Worktree/ReviewHub/CommitPanel";
import { NotificationCenter } from "@/components/Notifications/NotificationCenter";
import { NotificationCenterEntry } from "@/components/Notifications/NotificationCenterEntry";
import { Toaster } from "@/components/ui/toaster";
import { RecipeRunnerList } from "@/components/Terminal/RecipeRunner/RecipeRunnerList";
import { buildRecipeSections } from "@/components/Terminal/RecipeRunner/recipeRunnerUtils";
import { ConsolePanel } from "@/components/DevPreview/ConsolePanel";
import { DiagnosticsPanel } from "@/components/DevPreview/DiagnosticsPanel";
import { CONSOLE_FIXTURES } from "@/components/DevPreview/__preview__/consoleFixtures";
import { LogLevelPalette } from "@/components/LogLevelPalette";
import { NavGroup, NavItem } from "@/components/Settings/SettingsDialog";
import { WorktreeDetails } from "@/components/Worktree/WorktreeDetails";
import { AgentCard } from "@/components/agents/AgentCard";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { FileSection } from "@/components/Worktree/ReviewHub/FileSection";
import {
  DEFAULT_SECTION_STATE,
  type SectionViewState,
} from "@/components/Worktree/ReviewHub/reviewHubUtils";
import { DeletedWorktreeCard } from "@/components/Sidebar/DeletedWorktreeCard";
import { PluginPanelBadges } from "@/components/Panel/PluginPanelBadges";
import { TerminalRateLimitBadge } from "@/components/Terminal/TerminalRateLimitBadge";
import { TerminalDrivenByBadge } from "@/components/Terminal/TerminalHandOver";
import { TerminalNotifyChip } from "@/components/Terminal/TerminalNotifyChip";
import { WelcomeScreen } from "@/components/Project/WelcomeScreen";
import "@/index.css";

/**
 * Visual-review harness for the app's three small-type vocabularies: uppercase
 * section labels / eyebrows, status badges and chips, and count pills.
 *
 * Every item is the REAL component, fed realistic props or seeded stores, never a
 * copy of its markup — so the sheet keeps telling the truth when the components'
 * classes change. The small plain captions under each item are harness chrome, set
 * in sentence case and muted so they cannot be mistaken for a product label.
 *
 * Inline surfaces share a contact sheet per area. Surfaces that portal a full-window
 * layer (confirm dialogs, the Plugin Manager, palettes, toasts) get a fixture each,
 * because two open modals on one page photograph as one on top of the other.
 *
 * Query parameters:
 *   ?theme=<id>       built-in theme id
 *   ?fixture=<name>   one of FIXTURE_NAMES below
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureName = params.get("fixture") ?? "plugins";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";
// `index.css` pins the document to the window; a contact sheet is taller than any
// viewport, and a full-page capture of a pinned document drops everything below it.
for (const el of [document.documentElement, document.body]) {
  el.style.height = "auto";
  el.style.minHeight = "100vh";
  el.style.overflow = "visible";
}

const noop = () => {};
const asyncNoop = async () => {};
const NOW = Date.now();

// ---------------------------------------------------------------------------------
// Harness chrome
// ---------------------------------------------------------------------------------

class ItemBoundary extends Component<{ name: string; children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) {
    if (!(error instanceof Error)) return { error: String(error) };
    // The top frames name the component that threw, which the message alone does not.
    const frames = (error.stack ?? "").split("\n").slice(1, 4).join(" ← ");
    return { error: `${error.message} @ ${frames}` };
  }
  render() {
    if (this.state.error) {
      return (
        <div data-preview-error className="text-xs text-status-danger">
          {this.props.name} failed to render: {this.state.error}
        </div>
      );
    }
    return this.props.children;
  }
}

/** One captioned item on a sheet. The caption is harness chrome, not product type. */
function Item({
  name,
  width,
  children,
}: {
  name: string;
  width?: number | string;
  children: ReactNode;
}) {
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1.5" style={{ width }}>
      <div className="min-w-0 rounded-[var(--radius-md)] border border-dashed border-border-subtle p-3">
        <ItemBoundary name={name}>{children}</ItemBoundary>
      </div>
      <figcaption className="text-xs normal-case tracking-normal text-text-muted">
        {name}
      </figcaption>
    </figure>
  );
}

/** A group of items; the spec settles and measures every group. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section data-preview-surface className="flex flex-col gap-3">
      <p className="text-sm normal-case tracking-normal text-text-secondary">{title}</p>
      <div className="flex flex-wrap items-start gap-4">{children}</div>
    </section>
  );
}

/** Background note for fixtures whose subject is a full-window layer. */
function LayerNote({ what }: { what: string }) {
  return (
    <p className="p-4 text-xs normal-case tracking-normal text-text-muted">
      Harness page — the open layer is {what}.
    </p>
  );
}

// ---------------------------------------------------------------------------------
// Plugin fixtures
// ---------------------------------------------------------------------------------

const EMPTY_CONTRIBUTES: PluginManifest["contributes"] = {
  panels: [],
  toolbarButtons: [],
  menuItems: [],
  commands: [],
  views: [],
  mcpServers: [],
  skills: [],
  keybindings: [],
  contextMenus: [],
  forgeProviders: [],
  fileDecorationProviders: [],
  fileEditors: [],
  agents: [],
  processTools: [],
  recipes: [],
};

function makePlugin(
  name: string,
  manifest: Partial<PluginManifest>,
  over: Partial<LoadedPluginInfo> = {}
): LoadedPluginInfo {
  return {
    instanceId: name,
    origin: "global",
    projectId: null,
    manifest: {
      name,
      version: "2.4.1",
      ...manifest,
      contributes: { ...EMPTY_CONTRIBUTES, ...(manifest.contributes ?? {}) },
    } as PluginManifest,
    dir: `/Users/dev/.daintree/plugins/${name}`,
    loadedAt: NOW - 3_600_000,
    isBuiltin: false,
    disabled: false,
    pendingRestart: false,
    source: "url",
    installedAt: NOW - 86_400_000 * 12,
    updatedAt: NOW - 86_400_000 * 2,
    archiveHash: "9f2c4e1a7b3d",
    originalUrl: `https://plugins.acme-platform.dev/releases/${name}-2.4.1.dntr`,
    loadError: null,
    updateAvailable: null,
    devMode: false,
    pluginDanger: "safe",
    blocklisted: false,
    ...over,
  };
}

const RICH_PLUGIN = makePlugin(
  "acme.release-orchestrator",
  {
    displayName: "Acme Release Orchestrator for Monorepos",
    description:
      "Coordinates staged releases across every package in the workspace, drafts changelogs and hands deploy approvals to your agents.",
    category: "workspace",
    capabilities: ["network:fetch", "fs:project-read", "shell:exec"],
    authors: [
      { name: "Ada Lovelace", role: "maintainer" },
      { name: "Grace Hopper", url: "https://acme-platform.dev" },
    ],
    contributes: {
      ...EMPTY_CONTRIBUTES,
      commands: [
        {
          id: "acme.release.draft",
          title: "Draft release notes for the current branch",
          description: "Summarises merged work since the last tag.",
          category: "Release",
          kind: "command",
          danger: "safe",
        },
        {
          id: "acme.release.status",
          title: "Show release train status",
          description: "Which packages are waiting on which gate.",
          category: "Release",
          kind: "query",
          danger: "safe",
        },
      ],
      panels: [
        {
          id: "acme.release.board",
          name: "Release board",
          iconId: "rocket",
          color: "#7c9cff",
          hasPty: false,
          canRestart: false,
          canConvert: false,
          showInPalette: true,
        },
      ],
      agents: [
        {
          id: "acme-release-agent",
          name: "Release Captain",
          command: "release-captain",
          color: "#f5a524",
          iconId: "anchor",
        },
      ],
      databases: [
        {
          id: "ledger",
          description: "Release history",
          location: "local",
          journalMode: "wal",
        },
        { id: "notes", location: "project", path: "data/notes.db", journalMode: "delete" },
      ],
      settings: [
        { id: "apiKey", type: "string", label: "Deploy API key", required: true },
        { id: "mode", type: "enum", options: ["fast", "safe"], label: "Release mode" },
      ],
    },
  },
  { pluginDanger: "confirm", source: "catalog" }
);

const BLOCKED_PLUGIN = makePlugin(
  "acme.telemetry-exporter",
  {
    displayName: "Telemetry Exporter",
    description: "Streams agent session metrics to an external dashboard.",
    category: "ai",
  },
  {
    blocklisted: true,
    blocklistReason: "Exfiltrates prompt bodies to a third-party host (advisory DSA-2026-014)",
    source: "sideload",
    originalUrl: null,
  }
);

const DEV_PLUGIN = makePlugin(
  "acme.forge-gitea",
  {
    displayName: "Gitea Forge Provider (local checkout)",
    description: "Pull requests, issues and CI status from a self-hosted Gitea instance.",
    category: "forge",
  },
  {
    disabled: true,
    devMode: true,
    pendingRestart: true,
    source: "sideload",
    originalUrl: null,
    dir: "/Users/dev/Projects/daintree-plugin-gitea",
    loadError: { message: "activate() threw: Cannot find module './dist/index.js'", at: NOW },
    updateAvailable: { version: "2.5.0", channel: "manual" },
  } as Partial<LoadedPluginInfo>
);

const CATALOG_PLUGINS: LoadedPluginInfo[] = [
  RICH_PLUGIN,
  makePlugin(
    "acme.linear",
    {
      displayName: "Linear Issues",
      tagline: "Issues and cycles beside the grid",
      category: "forge",
    },
    { source: "catalog" }
  ),
  makePlugin(
    "acme.review-bot",
    { displayName: "Review Bot", tagline: "Second-opinion review agent", category: "ai" },
    { disabled: true }
  ),
  makePlugin(
    "acme.scratchpad",
    { displayName: "Scratchpad", tagline: "Per-worktree notes", category: "workspace" },
    { updateAvailable: { version: "3.0.0", channel: "manual" } } as Partial<LoadedPluginInfo>
  ),
  BLOCKED_PLUGIN,
];

const PROJECT_PLUGINS: ProjectPluginInfo[] = [
  {
    projectId: "proj-acme",
    id: "acme.dashboard",
    displayName: "Acme Deploy Dashboard",
    version: "1.2.0",
    description: "Live deploy status for the acme-platform monorepo.",
    capabilities: ["network:fetch"],
    databases: [
      { id: "deploys", location: "project", path: "data/deploys.db", journalMode: "wal" },
    ],
    dirName: "dashboard",
    muted: false,
    collidesWithGlobal: false,
    state: "active",
  } as ProjectPluginInfo,
  {
    projectId: "proj-acme",
    id: "acme.migrations",
    displayName: "Schema Migrations Helper",
    version: "0.4.0",
    capabilities: [],
    dirName: "migrations",
    muted: false,
    collidesWithGlobal: false,
    state: "staged",
  } as ProjectPluginInfo,
  {
    projectId: "proj-acme",
    id: "acme.release-orchestrator",
    displayName: "Release Orchestrator (project copy)",
    version: "2.0.0",
    capabilities: [],
    dirName: "release",
    muted: false,
    collidesWithGlobal: true,
    state: "active",
    loadError: { message: "activate() threw: no such module 'release-core'", at: NOW },
  } as ProjectPluginInfo,
];

function seedPluginStores() {
  usePluginRuntimeStatusStore.setState({
    statusById: new Map([
      [
        DEV_PLUGIN.instanceId,
        {
          pluginId: DEV_PLUGIN.instanceId,
          viewGeneration: 3,
          worker: null,
          dev: { reloadCount: 2, watcher: "degraded", detail: null },
        },
      ],
    ]),
  });
  useProjectPluginStore.setState({
    plugins: PROJECT_PLUGINS,
    trust: { projectId: "proj-acme", decision: "enabled", enabled: true, persisted: true },
    reloading: false,
    deciding: null,
    error: null,
    activating: new Set(),
  });
  bridgeAnswers["plugin.list"] = CATALOG_PLUGINS.concat(DEV_PLUGIN);
  bridgeAnswers["plugin.settingValues"] = { mode: "safe" };
}

function PluginsSheet() {
  const [selected, setSelected] = useState<string | null>("acme.dashboard");
  const detail = {
    checkingUpdate: false,
    upToDate: false,
    onToggle: noop,
    onRetry: noop,
    onUninstall: noop,
    onCheckForUpdate: noop,
  };
  return (
    <>
      <Group title="Plugin detail pane">
        <Item name="PluginDetailPane — installed, category + source badges, overview" width={520}>
          <PluginDetailPane plugin={RICH_PLUGIN} {...detail} />
        </Item>
        <Item name="PluginDetailPane — settings tab (settingsRequest)" width={520}>
          <PluginDetailPane plugin={RICH_PLUGIN} {...detail} settingsRequest={{ nonce: 1 }} />
        </Item>
        <Item name="PluginDetailPane — blocklisted" width={520}>
          <PluginDetailPane plugin={BLOCKED_PLUGIN} {...detail} />
        </Item>
        <Item
          name="PluginDetailPane — disabled dev plugin, load error, restart, update"
          width={520}
        >
          <PluginDetailPane plugin={DEV_PLUGIN} {...detail} />
        </Item>
      </Group>
      <Group title="Project plugins">
        <Item name="ProjectPluginSection — list with count, staged, error, id clash" width={320}>
          <ProjectPluginSection
            plugins={PROJECT_PLUGINS}
            selectedId={selected}
            onSelect={setSelected}
          />
        </Item>
        <Item name="ProjectPluginDetailPane — active" width={520}>
          <ProjectPluginDetailPane plugin={PROJECT_PLUGINS[0]!} />
        </Item>
        <Item name="ProjectPluginDetailPane — loadError + id clash" width={520}>
          <ProjectPluginDetailPane plugin={PROJECT_PLUGINS[2]!} />
        </Item>
      </Group>
      <Group title="Databases and catalog">
        <Item name="PluginDatabasesSection — global origin" width={420}>
          <PluginDatabasesSection
            databases={RICH_PLUGIN.manifest.contributes.databases ?? []}
            origin="global"
          />
        </Item>
        <Item name="PluginDatabasesSection — project origin" width={420}>
          <PluginDatabasesSection
            databases={PROJECT_PLUGINS[0]!.databases ?? []}
            origin="project"
          />
        </Item>
        <Item name="PluginCatalog — sections, one disabled, blocked, update" width={1000}>
          <PluginCatalog plugins={CATALOG_PLUGINS} onSelect={noop} />
        </Item>
      </Group>
    </>
  );
}

function seedPluginManager() {
  usePluginManagerStore.setState({ isOpen: true });
}

function seedPluginMcpConfirm() {
  usePluginMcpConfirmStore.setState({
    current: {
      requestId: "req-1",
      pluginId: "acme.release-orchestrator",
      serverId: "release-orchestrator-mcp",
      toolName: "deploy_branch_to_staging_environment",
      pluginDisplayName: "Acme Release Orchestrator",
      descriptionDisplay:
        "Deploys the current branch to the shared staging environment and posts the URL.",
      argsSummary: '{ "branch": "feature/billing-reconciliation-worker", "env": "staging" }',
      dangerTier: "D2",
      declaredCapabilities: ["network:fetch", "shell:exec", "fs:project-read"],
      reason: "first-use",
      enqueuedAt: NOW,
    },
    queue: [],
  });
}

function seedPluginArchiveConfirm() {
  usePluginArchiveInstallStore.setState({
    current: {
      intentId: "i1",
      archivePath: "/Users/dev/Downloads/acme-release-orchestrator-2.4.1.dntr",
      archiveFileName: "acme-release-orchestrator-2.4.1.dntr",
      manifest: {
        name: "acme.release-orchestrator",
        displayName: "Acme Release Orchestrator",
        version: "2.4.1",
        category: "workspace",
        authors: [{ name: "Ada Lovelace", role: "maintainer" }],
        capabilities: ["fs:project-read", "network:fetch", "shell:exec"],
        recipes: { count: 2, names: ["Release train", "Hotfix lane"] },
      },
      enqueuedAt: NOW,
    },
    queue: [],
  });
}

function seedPluginConfirm() {
  usePluginRuntimeStore.setState({
    pluginMetaById: new Map([
      ["acme.release-orchestrator", { devMode: false, displayName: "Acme Release Orchestrator" }],
    ]),
  });
  usePluginConfirmStore.setState({
    current: {
      requestId: "r1",
      pluginId: "acme.release-orchestrator",
      actionId: "acme.release.deploy",
      actionTitle: "Deploy branch to staging",
      actionDescription: "Pushes the current branch to the shared staging environment.",
      effectiveDanger: "confirm",
      argsSummary: '{ "branch": "feature/billing-reconciliation-worker" }',
      enqueuedAt: NOW,
    },
    queue: [],
  });
}

function seedPluginCapabilityConfirm() {
  usePluginCapabilityConfirmStore.setState({
    current: {
      requestId: "c1",
      pluginId: "acme.release-orchestrator",
      pluginDisplayName: "Acme Release Orchestrator",
      capability: "shell:exec",
      declaredCapabilities: ["shell:exec", "fs:project-write", "network:fetch"],
      enqueuedAt: NOW,
    },
    queue: [],
  });
}

// ---------------------------------------------------------------------------------
// Dialog fixtures
// ---------------------------------------------------------------------------------

function DialogsSheet() {
  return (
    <Group title="Git operation preview primitives (push / pull / worktree confirms)">
      <Item name="PreviewFrame — summary rows, ref chips, section heading with count" width={560}>
        <PreviewFrame>
          <PreviewSummary>
            <SummaryRow label="Branch">
              <RefChip value="feature/billing-reconciliation-worker" />
            </SummaryRow>
            <SummaryRow label="Remote" aside="tracking">
              <RefChip value="origin/feature/billing-reconciliation-worker" />
            </SummaryRow>
          </PreviewSummary>
          <PreviewSectionHeading label="Commits to push" refName="origin" count={14} />
          <CommitRows
            commits={[
              { hash: "9f2c4e1a7b3d", message: "Add retry jitter to the push loop", author: "Ada" },
              {
                hash: "4b1d9e0c2a77",
                message: "Reconcile ledger rows per tenant",
                author: "Grace",
              },
              { hash: "1e5a7c3f9d02", message: "Handle empty invoices", author: "Ada" },
            ]}
            total={14}
            label="Commits to push"
          />
          <PreviewNote>Pushing sets upstream on first push.</PreviewNote>
        </PreviewFrame>
      </Item>
    </Group>
  );
}

function seedMcpConfirm() {
  useMcpConfirmStore.setState({
    current: {
      requestId: "req-1",
      actionId: "terminal.killMany",
      actionTitle: "Kill terminals",
      actionDescription: "Kill the selected terminals.",
      argsSummary: '{"ids":["t-claude-api","t-zsh"]}',
      danger: "confirm",
      enqueuedAt: NOW + 1_000_000_000,
      dangerRationale: "Ends the processes; unsaved agent work is lost.",
      sessionOrigin: "external",
      callerInfo: { token4LastChars: "a1b2", userAgent: "claude-code/2.1" },
      selectionConfirmLabel: { verb: "Kill", one: "terminal", many: "terminals" },
      selectableTargets: [
        {
          id: "t-claude-api",
          name: "Claude · billing reconciliation worker",
          worktree: "feature/billing-reconciliation-worker",
          kindLabel: "Claude",
          agentRunning: true,
        },
        {
          id: "t-zsh",
          name: "zsh",
          worktree: "feature/billing-reconciliation-worker",
          kindLabel: "Terminal",
          agentRunning: false,
        },
      ],
    },
    queue: [],
  });
}

const TERMINAL_INFO: TerminalInfoPayload = {
  id: "t-claude-api",
  cwd: "/Users/dev/acme-platform-worktrees/feature-billing-reconciliation-worker",
  spawnedAt: NOW - 3_600_000,
  lastInputTime: NOW - 5_000,
  lastOutputTime: NOW - 3_000,
  activityTier: "focused",
  outputBufferSize: 18_342,
  semanticBufferLines: 412,
  restartCount: 1,
  hasPty: true,
  analysisEnabled: true,
  kind: "terminal",
  shell: "/bin/zsh",
  ptyCols: 120,
  ptyRows: 40,
  ptyPid: 48_213,
  ptyForegroundProcess: "claude",
  ptyTty: "/dev/ttys004",
  spawnArgs: ["-l"],
  launchAgentId: "claude",
  agentLaunchFlags: ["--model", "opus", "--dangerously-skip-permissions"],
  agentModelId: "opus",
  detectedAgentId: "claude",
  agentState: "working",
} as TerminalInfoPayload;

function seedTerminalInfo() {
  bridgeAnswers["terminal.getInfo"] = TERMINAL_INFO;
  actionService.register({
    id: "terminal.info.get",
    title: "Get terminal info",
    description: "Harness answer for the terminal info dialog.",
    category: "terminal",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    run: async () => TERMINAL_INFO,
  });
}

function CommitPushFixture() {
  const [message, setMessage] = useState(
    "fix(billing): reconcile ledger rows per tenant before invoicing"
  );
  return (
    <div className="w-[520px] p-4">
      <CommitPanel
        stagedCount={3}
        isDetachedHead={false}
        hasConflicts={false}
        hasRemote
        pushDestination={{ remote: "origin", branch: "feature/billing-reconciliation-worker" }}
        worktreePath="/Users/dev/acme-platform-worktrees/feature-billing-reconciliation-worker"
        currentBranch="feature/billing-reconciliation-worker"
        commitMessage={message}
        onCommitMessageChange={setMessage}
        onCommit={asyncNoop}
        onCommitAndPush={asyncNoop}
        isPushing={false}
        pushProgress={new Map()}
        pushTargetBranch={null}
        skipPushConfirm={false}
        onSetSkipPushConfirm={noop}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------
// List fixtures
// ---------------------------------------------------------------------------------

function historyEntry(over: Partial<NotificationHistoryEntry>): NotificationHistoryEntry {
  return {
    id: crypto.randomUUID(),
    type: "info",
    message: "",
    timestamp: NOW,
    seenAsToast: true,
    summarized: false,
    countable: true,
    archivedAt: null,
    ...over,
  };
}

const HISTORY: NotificationHistoryEntry[] = [
  ...[0, 1, 2].map((i) =>
    historyEntry({
      correlationId: "build",
      type: "error",
      title: "Build failed on feature/billing-reconciliation-worker",
      message: `tsc exited 2 — ${4 - i} errors in src/billing/ledger.ts`,
      timestamp: NOW - 60_000 * (i + 1),
      seenAsToast: false,
    })
  ),
  ...[0, 1].map((i) =>
    historyEntry({
      correlationId: "sync",
      message: `Synced 12 worktrees with origin in ${1.4 + i}s`,
      timestamp: NOW - 600_000 * (i + 2),
    })
  ),
  historyEntry({
    type: "success",
    title: "Claude finished",
    message: "Refactored the invoice exporter and all tests pass.",
    timestamp: NOW - 3_600_000,
  }),
];

function seedLists() {
  usePluginContextMenuItemsStore.setState({ entries: [], init: noop });
  useNotificationHistoryStore.setState({
    entries: HISTORY,
    unreadCount: HISTORY.filter((e) => !e.seenAsToast).length,
  });
  const { addStructuredMessage } = useConsoleCaptureStore.getState();
  CONSOLE_FIXTURES["session-collapsed"].rows.forEach((row, i) => {
    addStructuredMessage({
      ...row,
      id: i + 1,
      paneId: "labels-console",
      groupDepth: 0,
      navigationGeneration: 0,
      timestamp: NOW - 60_000 + i * 1_437,
    });
  });
  flushConsoleCaptureBuffer();
  const diagnostics: DevPreviewDiagnosticsResult = {
    session: {
      panelId: "labels-dev-preview",
      projectId: "proj-acme",
      status: "running",
      generation: 2,
      updatedAt: NOW,
      allocatedPort: 5173,
      detectedUrl: "http://localhost:5173",
      upstream: { kind: "ok", port: 5173, isHttps: false },
      crashLoop: { count: 0, stopped: false, backoffPending: false },
      restoredFromManifest: false,
      events: [
        {
          type: "proxy-502",
          at: NOW - 30_000,
          seq: 0,
          generation: 1,
          cause: "upstream-refused",
          count: 7,
        },
        {
          type: "url-detected",
          at: NOW - 20_000,
          seq: 1,
          generation: 1,
          url: "http://localhost:5173",
        },
      ],
    },
    proxy: { port: 43_000, usedPortFallback: false },
  };
  bridgeAnswers["devPreview.getDiagnostics"] = diagnostics;
}

const RECIPES: TerminalRecipe[] = [
  {
    id: "r1",
    name: "Full-stack dev (web + api + worker)",
    showInEmptyState: true,
    lastUsedAt: NOW - 60_000,
  },
  { id: "r2", name: "Claude + Codex review pair", showInEmptyState: true },
  { id: "r3", name: "Storybook", lastUsedAt: NOW - 3_600_000 },
  { id: "r4", name: "Database migrations dry run" },
  { id: "r5", name: "E2E smoke (Chromium)" },
].map(
  (r) => ({ terminals: [{ type: "terminal", env: {} }], createdAt: 0, ...r }) as TerminalRecipe
);

const WORKTREE: WorktreeState = {
  id: "wt-billing",
  worktreeId: "wt-billing",
  path: "/Users/dev/acme-platform-worktrees/feature-billing-reconciliation-worker",
  name: "feature-billing-reconciliation-worker",
  branch: "feature/billing-reconciliation-worker",
  isCurrent: false,
  isMainWorktree: false,
  lastActivityTimestamp: NOW - 120_000,
  worktreeChanges: {
    worktreeId: "wt-billing",
    changedFileCount: 4,
    insertions: 128,
    deletions: 31,
    changes: [],
    rootPath: "",
    lastCommitTimestampMs: NOW - 120_000,
    lastCommitAuthor: { name: "Ada Lovelace", email: "ada@acme-platform.dev" },
    lastCommitMessage: "fix(billing): reconcile ledger rows per tenant before invoicing",
  },
};

function worktreeDetails(extra: Partial<Parameters<typeof WorktreeDetails>[0]>) {
  return (
    <WorktreeDetails
      worktree={WORKTREE}
      worktreeErrors={[]}
      hasChanges
      isFocused={false}
      onPathClick={noop}
      onDismissError={noop}
      onRetryError={asyncNoop}
      homeDir="/Users/dev"
      {...extra}
    />
  );
}

function ListsSheet() {
  const [centerOpen] = useState(true);
  const build = HISTORY[0]!;
  const sync = HISTORY[3]!;
  return (
    <>
      <Group title="Notifications">
        <Item name="NotificationCenter — open, grouped threads with counts" width={380}>
          <div className="relative w-[360px] border border-border-default">
            <NotificationCenter open={centerOpen} onClose={noop} />
          </div>
        </Item>
        <Item name="NotificationCenterEntry — titled, threadCount 3" width={380}>
          <NotificationCenterEntry entry={build} threadCount={3} displayType="error" isNew />
        </Item>
        <Item name="NotificationCenterEntry — untitled, threadCount 2" width={380}>
          <NotificationCenterEntry entry={sync} threadCount={2} />
        </Item>
        <Item name="NotificationCenterEntry — titled, threadCount 128 (99+)" width={380}>
          <NotificationCenterEntry entry={build} threadCount={128} displayType="error" />
        </Item>
      </Group>
      <Group title="Recipes, console, diagnostics">
        <Item name="RecipeRunnerList — Pinned / Recent / All" width={360}>
          <RecipeRunnerList
            sections={buildRecipeSections(RECIPES)}
            searchQuery=""
            searchResults={[]}
            focusedIndex={0}
            focusedItemId={undefined}
            showSearch
            onSearchChange={noop}
            onKeyDown={noop}
            onRun={noop}
            onEdit={noop}
            onDuplicate={noop}
            onPin={noop}
            onUnpin={noop}
            onDelete={noop}
            onCreate={noop}
            onManage={noop}
          />
        </Item>
        <Item name="ConsolePanel — header label + level counts" width={620}>
          <div className="flex h-[300px] flex-col">
            <ConsolePanel paneId="labels-console" webContentsId={1} />
          </div>
        </Item>
        <Item name="DiagnosticsPanel — event with count 7" width={520}>
          <DiagnosticsPanel paneId="labels-dev-preview" projectId="proj-acme" status="running" />
        </Item>
      </Group>
      <Group title="Settings search and worktree narrative">
        <Item name="SettingsDialog NavItem — MatchBadge (3 / 12)" width={240}>
          <div role="tablist" aria-orientation="vertical">
            <NavGroup label="General">
              <NavItem
                tab="general"
                icon={<Settings className="h-4 w-4" />}
                label="General"
                activeTab="general"
                isSearching
                matchCount={3}
                onSelect={noop}
              />
              <NavItem
                tab="terminal"
                icon={<TerminalIcon className="h-4 w-4" />}
                label="Terminal"
                activeTab="general"
                isSearching
                matchCount={12}
                onSelect={noop}
              />
              <NavItem
                tab="plugins"
                icon={<Puzzle className="h-4 w-4" />}
                label="Plugins"
                activeTab="general"
                isSearching
                onSelect={noop}
              />
            </NavGroup>
          </div>
        </Item>
        <Item name="WorktreeDetails — AI note label" width={340}>
          {worktreeDetails({
            effectiveNote: "Waiting on the ledger schema review before merging.",
          })}
        </Item>
        <Item name="WorktreeDetails — Summary label" width={340}>
          {worktreeDetails({
            effectiveSummary: "Reconciles ledger rows per tenant; adds retry jitter to pushes.",
          })}
        </Item>
        <Item name="WorktreeDetails — Last commit label" width={340}>
          {worktreeDetails({ showLastCommit: true, effectiveSummary: null })}
        </Item>
      </Group>
    </>
  );
}

function seedToasts() {
  useNotificationStore.setState({
    notifications: [
      {
        id: "t1",
        type: "error",
        priority: "high",
        title: "Build failed on feature/billing-reconciliation-worker",
        message: "tsc exited 2 — 3 errors in src/billing/ledger.ts",
        count: 5,
      },
      {
        id: "t2",
        type: "info",
        priority: "high",
        message: "Codex finished reviewing the invoice exporter",
        count: 3,
      },
      {
        id: "t3",
        type: "success",
        priority: "high",
        title: "Pushed",
        message: "origin/feature/billing-reconciliation-worker is up to date",
      },
    ],
  });
}

function seedLogLevels() {
  bridgeAnswers["logs.levelOverrides"] = {
    "*": "debug",
    "main:Main": "warn",
    "pty-host:*": "off",
  };
}

// ---------------------------------------------------------------------------------
// Chip fixtures
// ---------------------------------------------------------------------------------

function ptyPanel(id: string, title: string, extra: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    title,
    kind: "terminal",
    cwd: "/Users/dev/acme-platform",
    cols: 120,
    rows: 40,
    location: "grid",
    hasPty: true,
    runtimeStatus: "running",
    ...extra,
  } as PtyPanelData;
}

const DELETED: DeletedWorktree = {
  id: "/Users/dev/acme-platform-worktrees/feature-billing-reconciliation-worker",
  title: "feature/billing-reconciliation-worker",
  path: "/Users/dev/acme-platform-worktrees/feature-billing-reconciliation-worker",
  deletedAt: NOW - 5_000,
  expiresAt: NOW + 42_500,
  holdReason: "agent",
  pinnedBeforeWorktreeId: null,
};

const DELETED_PLAIN: DeletedWorktree = {
  id: "/Users/dev/acme-platform-worktrees/fix-retry-backoff-jitter",
  title: "fix/retry-backoff-jitter",
  path: "/Users/dev/acme-platform-worktrees/fix-retry-backoff-jitter",
  deletedAt: NOW - 8_000,
  expiresAt: NOW + 27_500,
  holdReason: null,
  pinnedBeforeWorktreeId: null,
};

const NOTIFY: Record<string, PaneNotifyState> = {
  "t-notify-held": {
    terminalId: "t-notify-held",
    pendingCount: 2,
    readyCount: 0,
    revision: 1,
    delivery: { status: "held", reason: "typing" },
  } as PaneNotifyState,
  "t-notify-blocked": {
    terminalId: "t-notify-blocked",
    pendingCount: 4,
    readyCount: 0,
    revision: 1,
    delivery: { status: "blocked", reason: "approval" },
  } as PaneNotifyState,
};

function seedChips() {
  initBuiltInPanelKinds();
  const panels = [
    ptyPanel("t-orch", "Claude"),
    ptyPanel("t-driven", "Codex", { launchAgentId: "codex", detectedAgentId: "codex" }),
    ptyPanel("t-del-claude", "Claude", {
      worktreeId: DELETED.id,
      launchAgentId: "claude",
      detectedAgentId: "claude",
      agentState: "working",
    }),
    ptyPanel("t-del-shell", "npm run dev", { worktreeId: DELETED.id, location: "dock" }),
    ptyPanel("t-del2-codex", "Codex", {
      worktreeId: DELETED_PLAIN.id,
      launchAgentId: "codex",
      detectedAgentId: "codex",
      agentState: "waiting",
    }),
  ];
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
    panelIdsByWorktreeId: {
      [DELETED.id]: ["t-del-claude", "t-del-shell"],
      [DELETED_PLAIN.id]: ["t-del2-codex"],
    },
  });
  usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 60 });
  useWorktreeSelectionStore.setState({ activeWorktreeId: null });
  usePluginContextMenuItemsStore.setState({ entries: [], init: noop });
  usePluginPanelBadgeStore.setState({
    badgesByPanelId: {
      "panel-badges": {
        "a-default": { kind: "label", text: "12", color: "default", tooltip: "12 open" },
        "b-success": { kind: "label", text: "Pass", color: "success" },
        "c-warning": { kind: "label", text: "Stale", color: "warning" },
        "d-error": { kind: "label", text: "Fail", color: "error" },
        "e-dot": { kind: "dot", color: "warning", tooltip: "Needs attention" },
      },
    },
  });
  usePluginRuntimeStore.setState({
    pluginMetaById: new Map(
      ["a-default", "b-success", "c-warning", "d-error", "e-dot"].map((id) => [
        id,
        { devMode: false, displayName: "Release board", previewToolIds: new Set() },
      ])
    ),
  });
  useRateLimitObservationStore.setState({
    observedAtByTerminalId: { "t-rate": NOW - 3 * 60_000 },
  });
  useTerminalAdoptionStore.setState({
    adoptionsByTerminalId: {
      "t-driven": { terminalId: "t-driven", orchestratorPaneId: "t-orch", adoptedAt: NOW },
    },
  });
  bridgeAnswers["mcpServer.paneNotify"] = new Map(Object.entries(NOTIFY));
}

const STAGED_ALL: StagingFileEntry[] = [
  { path: "src/billing/ledger.ts", status: "modified", insertions: 42, deletions: 11 },
  { path: "src/billing/reconcile.ts", status: "added", insertions: 118, deletions: 0 },
  {
    path: "src/billing/__tests__/ledger.test.ts",
    status: "modified",
    insertions: 36,
    deletions: 4,
  },
  { path: "src/billing/legacyExporter.ts", status: "deleted", insertions: 0, deletions: 212 },
] as StagingFileEntry[];

function FileSectionItem({ narrowed }: { narrowed: boolean }) {
  const [view, setView] = useState<SectionViewState>(
    narrowed
      ? { ...DEFAULT_SECTION_STATE, filterQuery: "ledger", density: "compact" }
      : DEFAULT_SECTION_STATE
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const files = narrowed ? STAGED_ALL.filter((f) => f.path.includes("ledger")) : STAGED_ALL;
  return (
    <FileSection
      isStaged={!narrowed}
      files={files}
      allFiles={STAGED_ALL}
      indexOffset={0}
      focusedIndex={-1}
      selectionSection={null}
      selectedPaths={new Set()}
      hasSelection={false}
      view={view}
      setView={setView}
      inputRef={inputRef}
      setFilterQuery={(q) => setView((v) => ({ ...v, filterQuery: q }))}
      clearFilter={() => setView((v) => ({ ...v, filterQuery: "" }))}
      onToggle={noop}
      onRowClick={noop}
      onBulkAction={noop}
      viewedFiles={new Set()}
      onViewedChange={noop}
      renderRowMenu={() => null}
    />
  );
}

function ChipsSheet() {
  return (
    <>
      <Group title="Agent cards and settings sections">
        <Item name="AgentCard — installed, presetCount > 1" width={340}>
          <AgentCard
            mode="onboarding"
            agentId="mistral"
            availability={{ mistral: "ready" }}
            isChecked
            isSaving={false}
            onToggle={noop}
          />
        </Item>
        <Item name="AgentCard — not installed, presetCount > 1" width={340}>
          <AgentCard
            mode="onboarding"
            agentId="mistral"
            availability={{ mistral: "missing" }}
            isChecked={false}
            isSaving={false}
            onToggle={noop}
          />
        </Item>
        <Item name="AgentCard — installed, no presets" width={340}>
          <AgentCard
            mode="onboarding"
            agentId="claude"
            availability={{ claude: "ready" }}
            isChecked
            isSaving={false}
            onToggle={noop}
          />
        </Item>
        <Item name="SettingsSection — with badge" width={420}>
          <SettingsSection
            title="Scrollback"
            badge="New terminals"
            description="Lines kept per terminal once it scrolls off screen."
          >
            {null}
          </SettingsSection>
        </Item>
      </Group>
      <Group title="Review hub file sections">
        <Item name="FileSection — staged, full list (count chip + churn)" width={480}>
          <FileSectionItem narrowed={false} />
        </Item>
        <Item name="FileSection — filtered to 'ledger' (N shown chip + view pip)" width={480}>
          <FileSectionItem narrowed />
        </Item>
      </Group>
      <Group title="Deleted worktree cards">
        <Item name="DeletedWorktreeCard — Deleted + agent hold" width={340}>
          <DndContext>
            <DeletedWorktreeCard worktree={DELETED} />
          </DndContext>
        </Item>
        <Item name="DeletedWorktreeCard — Deleted + countdown" width={340}>
          <DndContext>
            <DeletedWorktreeCard worktree={DELETED_PLAIN} />
          </DndContext>
        </Item>
      </Group>
      <Group title="Pane header chips">
        <Item name="PluginPanelBadges — default / success / warning / error + dot">
          <div className="flex items-center">
            <PluginPanelBadges panelId="panel-badges" />
          </div>
        </Item>
        <Item name="TerminalRateLimitBadge">
          <TerminalRateLimitBadge terminalId="t-rate" />
        </Item>
        <Item name="TerminalDrivenByBadge">
          <TerminalDrivenByBadge terminalId="t-driven" />
        </Item>
        <Item name="TerminalNotifyChip — held (quiet)">
          <TerminalNotifyChip terminalId="t-notify-held" />
        </Item>
        <Item name="TerminalNotifyChip — blocked (warning)">
          <TerminalNotifyChip terminalId="t-notify-blocked" />
        </Item>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------------
// Welcome
// ---------------------------------------------------------------------------------

const PROJECTS: Project[] = [
  ["acme-platform", "Acme Platform", "\u{1F680}"],
  ["billing-reconciliation-service", "Billing Reconciliation Service", "\u{1F4B8}"],
  ["daintree", "Daintree", "\u{1F333}"],
  ["design-system", "Design System", "\u{1F3A8}"],
  ["infra-terraform-modules", "Infra Terraform Modules", "\u{1F3D7}"],
].map(([slug, name, emoji], i) => ({
  id: `proj-${slug}`,
  path: `/Users/dev/Projects/${slug}`,
  name: name!,
  emoji: emoji!,
  lastOpened: NOW - (i + 1) * 3_600_000,
}));

function seedWelcome() {
  useProjectStore.setState({ projects: PROJECTS });
  bridgeAnswers["onboarding.get"] = {
    seenAgentIds: [],
    availabilityFirstSeen: {},
    welcomeCardDismissed: true,
    setupBannerDismissed: true,
  };
}

const gettingStarted = (checklist: boolean) => ({
  visible: checklist,
  collapsed: false,
  checklist: checklist
    ? {
        dismissed: false,
        celebrationShown: false,
        items: {
          openedProject: true,
          launchedAgent: true,
          createdWorktree: false,
          ranSecondParallelAgent: false,
        },
      }
    : null,
  dismiss: noop,
  toggleCollapse: noop,
  notifyOnboardingComplete: noop,
  markItem: noop,
});

function WelcomeSheet() {
  return (
    <>
      <Group title="Welcome screen — with getting-started checklist">
        <Item name="WelcomeScreen — Your projects, Quick actions, Getting started" width={1000}>
          <div className="relative h-[760px] overflow-hidden">
            <WelcomeScreen gettingStarted={gettingStarted(true)} />
          </div>
        </Item>
      </Group>
      <Group title="Welcome screen — checklist done (keyboard shortcuts)">
        <Item name="WelcomeScreen — Your projects, Quick actions, Keyboard shortcuts" width={1000}>
          <div className="relative h-[760px] overflow-hidden">
            <WelcomeScreen gettingStarted={gettingStarted(false)} />
          </div>
        </Item>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------------
// Fixture table
// ---------------------------------------------------------------------------------

interface Fixture {
  seed?: () => void;
  render: () => ReactNode;
}

const FIXTURES: Record<string, Fixture> = {
  plugins: { seed: seedPluginStores, render: () => <PluginsSheet /> },
  "plugin-manager": {
    seed: () => {
      seedPluginStores();
      seedPluginManager();
    },
    render: () => (
      <>
        <LayerNote what="PluginManagerView" />
        <PluginManagerView />
      </>
    ),
  },
  "plugin-mcp-confirm": {
    seed: seedPluginMcpConfirm,
    render: () => (
      <>
        <LayerNote what="PluginMcpConfirmDialog (D2 tier badge)" />
        <PluginMcpConfirmDialog />
      </>
    ),
  },
  "plugin-archive-confirm": {
    seed: seedPluginArchiveConfirm,
    render: () => (
      <>
        <LayerNote what="PluginArchiveInstallConfirmDialog" />
        <PluginArchiveInstallConfirmDialog />
      </>
    ),
  },
  "plugin-confirm": {
    seed: seedPluginConfirm,
    render: () => (
      <>
        <LayerNote what="PluginConfirmDialog" />
        <PluginConfirmDialog />
      </>
    ),
  },
  "plugin-capability-confirm": {
    seed: seedPluginCapabilityConfirm,
    render: () => (
      <>
        <LayerNote what="PluginCapabilityConfirmDialog" />
        <PluginCapabilityConfirmDialog />
      </>
    ),
  },
  dialogs: { render: () => <DialogsSheet /> },
  "mcp-confirm": {
    seed: seedMcpConfirm,
    render: () => (
      <>
        <LayerNote what="McpConfirmDialog (target with agentRunning)" />
        <McpConfirmDialog />
      </>
    ),
  },
  "terminal-info": {
    seed: seedTerminalInfo,
    render: () => (
      <>
        <LayerNote what="TerminalInfoDialog" />
        <TerminalInfoDialog isOpen onClose={noop} terminalId="t-claude-api" />
      </>
    ),
  },
  "import-env": {
    render: () => (
      <>
        <LayerNote what="ImportEnvDialog (conflicts step, driven by the spec)" />
        <ImportEnvDialog
          isOpen
          onClose={noop}
          onImport={noop}
          env={{
            ANTHROPIC_API_KEY: "sk-ant-api03-old-9f2c4e1a",
            ANTHROPIC_BASE_URL: "https://api.anthropic.com",
            NODE_ENV: "development",
            DATABASE_URL: "postgres://dev@localhost:5432/acme_billing",
          }}
        />
      </>
    ),
  },
  "commit-push": {
    render: () => (
      <>
        <LayerNote what="CommitPanel push confirm (opened by the spec)" />
        <CommitPushFixture />
      </>
    ),
  },
  lists: { seed: seedLists, render: () => <ListsSheet /> },
  toasts: {
    seed: seedToasts,
    render: () => (
      <>
        <LayerNote what="Toaster (coalesced toasts with count badges)" />
        <Toaster />
      </>
    ),
  },
  "log-level-palette": {
    seed: seedLogLevels,
    render: () => (
      <>
        <LayerNote what="LogLevelPalette (rows with the current badge)" />
        <LogLevelPalette isOpen onClose={noop} />
      </>
    ),
  },
  chips: { seed: seedChips, render: () => <ChipsSheet /> },
  welcome: { seed: seedWelcome, render: () => <WelcomeSheet /> },
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

const fixture = FIXTURES[fixtureName];
if (!fixture) {
  throw new Error(`unknown fixture "${fixtureName}" — one of ${FIXTURE_NAMES.join(", ")}`);
}

// Seed before mounting: the components read on first render.
fixture.seed?.();

function Preview() {
  useEffect(() => {
    document.documentElement.dataset.previewReady = "true";
  }, []);
  return (
    <div data-fixture={fixtureName} className="flex flex-col gap-8 bg-surface-canvas p-6">
      {fixture!.render()}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Preview />
    </TooltipProvider>
  </StrictMode>
);
