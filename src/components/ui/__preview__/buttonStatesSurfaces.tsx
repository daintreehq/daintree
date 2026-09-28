import { useState } from "react";
import type { CliAvailability, WorktreeState } from "@shared/types";
import type { PendingCrash } from "@shared/types/ipc/crashRecovery";
import type { LoadedPluginInfo } from "@shared/types/plugin";
import type { PanelInstance } from "@shared/types/panel";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import { usePanelStore } from "@/store/panelStore";
import { useDiagnosticsReviewStore } from "@/store/diagnosticsReviewStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import type { BackgroundedTerminal } from "@/store/slices";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { HostCrashBanner } from "@/components/Recovery/HostCrashBanner";
import { CrashRecoveryDialog } from "@/components/Recovery/CrashRecoveryDialog";
import { AgentSetupWizard } from "@/components/Setup/AgentSetupWizard";
import { AgentCliStep } from "@/components/Setup/AgentCliStep";
import { SystemRequirementsSection } from "@/components/Setup/SystemRequirementsSection";
import { MissingCliGate } from "@/components/Terminal/MissingCliGate";
import {
  WorktreeDeleteErrorBanner,
  WorktreeDetailsSection,
  WorktreeIssueErrorBanner,
} from "@/components/Worktree/WorktreeCard/WorktreeDetailsSection";
import { QuickStateArmButton } from "@/components/Worktree/QuickStateArmButton";
import { BackgroundContainer } from "@/components/Layout/BackgroundContainer";
import { AgentButton } from "@/components/Layout/AgentButton";
import {
  PreviewFrame,
  PreviewNotice,
  PreviewSummary,
  SummaryRow,
  RefChip,
} from "@/components/Git/GitOperationPreview";
import { PluginDetailPane } from "@/components/Plugin/PluginDetailPane";
import { NotificationCenterEntry } from "@/components/Notifications/NotificationCenterEntry";
import { FROZEN_NOW, held, setPreviewCliAvailability } from "./buttonStatesBootstrap";
import { Block, fixture, never, noop, noopAsync, type Fixture } from "./buttonStatesFrame";
import type { ActionId } from "@shared/types/actions";
import { stubAction } from "./buttonStatesReviewSettings";

// ---------------------------------------------------------------------------
// E. Recovery
// ---------------------------------------------------------------------------

const CRASH: PendingCrash = {
  logPath: "/Users/greg/Library/Logs/Daintree/crash-2025-11-24.json",
  hasBackup: true,
  backupTimestamp: FROZEN_NOW - 60_000,
  crashCount: 1,
  entry: {
    id: "crash-1",
    timestamp: FROZEN_NOW - 60_000,
    appVersion: "0.14.0",
    platform: "darwin",
    osVersion: "25.4.0",
    arch: "arm64",
    errorMessage: "Renderer process gone: oom",
    errorStack:
      "Error: Renderer process gone: oom\n    at WebContents.<anonymous> (main.js:4120:17)\n    at WebContents.emit (node:events:519:28)",
    sessionDurationMs: 3_600_000,
    electronVersion: "42.0.0",
    panelCount: 4,
  },
  panels: [
    {
      id: "p-1",
      kind: "terminal",
      title: "Claude",
      location: "grid",
      isSuspect: false,
      worktreeId: "wt-main",
    },
    {
      id: "p-2",
      kind: "terminal",
      title: "npm run dev",
      location: "dock",
      isSuspect: true,
      suspectReason: "crash-window",
    },
    { id: "p-3", kind: "browser", title: "localhost:5173", location: "grid", isSuspect: false },
  ],
};

// ---------------------------------------------------------------------------
// F. Setup
// ---------------------------------------------------------------------------

const ALL_READY = fixture<CliAvailability>({
  claude: "ready",
  codex: "ready",
  gemini: "ready",
});
const TO_INSTALL = fixture<CliAvailability>({
  claude: "missing",
  codex: "missing",
  gemini: "ready",
});

function seedAgents(availability: CliAvailability) {
  setPreviewCliAvailability(availability);
  useCliAvailabilityStore.setState({
    availability,
    hasRealData: true,
    isLoading: false,
    isRefreshing: false,
  });
  useAgentSettingsStore.setState({
    settings: { agents: { claude: { pinned: true }, codex: { pinned: true } } },
  });
}

// ---------------------------------------------------------------------------
// G. Worktree
// ---------------------------------------------------------------------------

function worktreeFixture(fields: Partial<WorktreeState>): WorktreeState {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture
  return {
    id: "wt-buttons",
    worktreeId: "wt-buttons",
    path: "/Users/greg/Projects/daintree-worktrees/design-button-states",
    name: "design-button-states",
    branch: "design/button-states",
    isCurrent: false,
    worktreeChanges: {
      worktreeId: "wt-buttons",
      rootPath: "/Users/greg/Projects/daintree-worktrees/design-button-states",
      changes: [],
      changedFileCount: 0,
      lastCommitMessage: "Unify button loading states",
      lastCommitTimestampMs: FROZEN_NOW - 21 * 60_000,
    },
    lastActivityTimestamp: FROZEN_NOW - 21 * 60_000,
    ...fields,
  } as unknown as WorktreeState;
}

function Details({
  worktree,
  resourceStatus,
}: {
  worktree: WorktreeState;
  resourceStatus?: string;
}) {
  return (
    <WorktreeDetailsSection
      worktree={worktree}
      isExpanded={false}
      hasChanges={false}
      computedSubtitle={{ text: "No changes", tone: "muted" }}
      worktreeErrors={[]}
      isFocused={false}
      onToggleExpand={noop}
      onPathClick={noop}
      onDismissError={noop}
      onRetryError={noopAsync}
      hasResourceConfig={resourceStatus !== undefined}
      resourceStatus={resourceStatus}
      onResourceResume={noop}
      onResourcePause={noop}
      onResourceConnect={noop}
      onResourceStatus={noop}
    />
  );
}

const SETUP_FAILED = worktreeFixture({
  lifecycleStatus: {
    phase: "setup",
    state: "failed",
    startedAt: FROZEN_NOW - 120_000,
    completedAt: FROZEN_NOW - 100_000,
    error: "npm ci exited with code 1",
    output: "npm ERR! code ERESOLVE\nnpm ERR! Could not resolve dependency",
  },
});

function WorktreeDetailsFixture() {
  return (
    <div className="flex flex-col gap-4">
      <Block caption="WorktreeDetailsSection — resource paused (Resume)" surface="sidebar">
        <Details worktree={worktreeFixture({})} resourceStatus="paused" />
      </Block>
      <Block
        caption="WorktreeDetailsSection — resource running (Pause / Connect)"
        surface="sidebar"
      >
        <Details worktree={worktreeFixture({})} resourceStatus="running" />
      </Block>
      <Block caption="WorktreeDetailsSection — setup failed (Retry setup)" surface="sidebar">
        <div data-preview-retry-setup>
          <Details worktree={SETUP_FAILED} />
        </div>
      </Block>
      <Block
        caption="WorktreeDetailsSection — command approval (Review commands)"
        surface="sidebar"
      >
        <Details worktree={worktreeFixture({ lifecycleCommandsNeedApproval: true })} />
      </Block>
    </div>
  );
}

// ---------------------------------------------------------------------------
// H. Layout — background dock group
// ---------------------------------------------------------------------------

const BG_WORKTREES: WorktreeSnapshot[] = [
  {
    id: "wt-buttons",
    worktreeId: "wt-buttons",
    path: "/Users/greg/Projects/daintree-worktrees/design-button-states",
    name: "design-button-states",
    branch: "design/button-states",
    isCurrent: true,
  },
  {
    id: "wt-main",
    worktreeId: "wt-main",
    path: "/Users/greg/Projects/daintree",
    name: "main",
    branch: "develop",
    isCurrent: false,
    isMainWorktree: true,
  },
];

const bgWorktreeStore = createWorktreeStore();

function bgPane(id: string, title: string, extra: Record<string, unknown> = {}): PanelInstance {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture
  return {
    id,
    title,
    kind: "terminal",
    cwd: "/Users/greg/Projects/daintree",
    cols: 120,
    rows: 40,
    worktreeId: "wt-buttons",
    projectId: "proj-daintree",
    location: "background",
    hasPty: true,
    lastStateChange: FROZEN_NOW - 5 * 60_000,
    ...extra,
  } as unknown as PanelInstance;
}

function seedBackground() {
  bgWorktreeStore.setState({ worktrees: new Map(BG_WORKTREES.map((w) => [w.id, w])) });
  setCurrentViewStore(bgWorktreeStore);
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-buttons" });
  const panels = [
    bgPane("bg-g1", "npm test"),
    bgPane("bg-g2", "npm run lint"),
    bgPane("bg-claude", "Claude", {
      launchAgentId: "claude",
      detectedAgentId: "claude",
      agentState: "working",
      lastObservedTitle: "Audit button loading states",
    }),
    bgPane("bg-dev", "npm run storybook", { worktreeId: "wt-main" }),
  ];
  const groupMetadata = {
    panelIds: ["bg-g1", "bg-g2"],
    activeTabId: "bg-g1",
    location: "dock" as const,
    worktreeId: "wt-buttons",
  };
  const backgrounded = new Map<string, BackgroundedTerminal>([
    ["bg-g1", { id: "bg-g1", originalLocation: "dock", groupRestoreId: "grp-1", groupMetadata }],
    ["bg-g2", { id: "bg-g2", originalLocation: "dock", groupRestoreId: "grp-1", groupMetadata }],
    ["bg-claude", { id: "bg-claude", originalLocation: "grid" }],
    ["bg-dev", { id: "bg-dev", originalLocation: "dock" }],
  ]);
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
    backgroundedTerminals: backgrounded,
  });
}

// ---------------------------------------------------------------------------
// J. Misc
// ---------------------------------------------------------------------------

const PLUGIN = fixture<LoadedPluginInfo>({
  instanceId: "acme.markdown-tools",
  origin: "global",
  projectId: null,
  manifest: {
    name: "acme.markdown-tools",
    version: "1.4.0",
    displayName: "Markdown Tools",
    description: "Table formatting and link checking for Markdown files.",
    publisher: "Acme",
    capabilities: ["files:read"],
    contributes: {
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
    },
  },
  dir: "/Users/greg/Library/Application Support/Daintree/plugins/acme.markdown-tools",
  loadedAt: FROZEN_NOW - 3_600_000,
  isBuiltin: false,
  disabled: false,
  pendingRestart: false,
  source: "catalog",
  installedAt: FROZEN_NOW - 86_400_000,
  archiveHash: null,
  originalUrl: null,
  loadError: null,
  updateAvailable: null,
  devMode: false,
  pluginDanger: "safe",
  blocklisted: false,
});

function notification(
  id: string,
  type: NotificationHistoryEntry["type"],
  title: string,
  message: string,
  actions: NotificationHistoryEntry["actions"]
): NotificationHistoryEntry {
  return {
    id,
    type,
    title,
    message,
    timestamp: FROZEN_NOW - 4 * 60_000,
    seenAsToast: false,
    summarized: false,
    countable: true,
    archivedAt: null,
    actions,
  };
}

function QuickStateArmFixture() {
  const [armed, setArmed] = useState(0);
  return (
    <div className="flex flex-col gap-4">
      <Block caption="Worktree/QuickStateArmButton.tsx — enabled" surface="sidebar">
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <span>Waiting (3)</span>
          <QuickStateArmButton
            label="Arm the 3 waiting agents"
            disabled={false}
            onArm={() => setArmed((n) => n + 1)}
          />
          {armed > 0 && <span data-harness-decoration>armed</span>}
        </div>
      </Block>
      <Block caption="Worktree/QuickStateArmButton.tsx — disabled" surface="sidebar">
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <span>Waiting (0)</span>
          <QuickStateArmButton label="No waiting agents to arm" disabled onArm={noop} />
        </div>
      </Block>
    </div>
  );
}

export const SURFACE_FIXTURES: Record<string, Fixture> = {
  "host-crash": {
    what: "HostCrashBanner at rest (Restart service + Send diagnostics); the spec holds Restart busy",
    width: 900,
    seed: () => {
      usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "OUT_OF_MEMORY" });
      if (new URLSearchParams(window.location.search).get("collecting") === "1") {
        useDiagnosticsReviewStore.setState({ isCollecting: true });
      }
      stubAction("terminal.restartService", () => held(undefined));
      stubAction("diagnostics.openReview", () => held(undefined));
    },
    render: () => (
      <Block caption="Recovery/HostCrashBanner.tsx" surface="canvas" pad={false}>
        <HostCrashBanner />
      </Block>
    ),
  },
  "crash-dialog": {
    what: "CrashRecoveryDialog open; the spec expands details and the report preview",
    width: 760,
    render: () => (
      <CrashRecoveryDialog
        crash={CRASH}
        config={{ autoRestoreOnCrash: false }}
        onResolve={never}
        onUpdateConfig={noopAsync}
      />
    ),
  },
  "setup-wizard": {
    what: "AgentSetupWizard; ?first=1 opens on Appearance, otherwise on Agents",
    width: 900,
    seed: () => seedAgents(ALL_READY),
    render: () => {
      const q = new URLSearchParams(window.location.search);
      return (
        <AgentSetupWizard
          isOpen
          onClose={noop}
          initialAvailability={ALL_READY}
          isFirstRun={q.get("first") === "1"}
          hasWorkspace={q.get("workspace") !== "0"}
        />
      );
    },
  },
  "agent-cli-step": {
    what: "AgentCliStep with two agents to install; the spec holds the install busy",
    width: 560,
    seed: () => seedAgents(TO_INSTALL),
    render: () => (
      <Block caption="Setup/AgentCliStep.tsx — install primary">
        <AgentCliStep
          availability={TO_INSTALL}
          selections={{ claude: true, codex: true, gemini: false }}
        />
      </Block>
    ),
  },
  "system-requirements": {
    what: "SystemRequirementsSection; ?git=missing fails the fatal tool (Check again), else Re-check",
    width: 560,
    render: () => (
      <Block caption="Setup/SystemRequirementsSection.tsx">
        <SystemRequirementsSection onFatalFailureChange={noop} onCheckingChange={noop} />
      </Block>
    ),
  },
  "missing-cli-gate": {
    what: "MissingCliGate for a missing Claude CLI — Docs / Agent settings / Check again",
    width: 640,
    seed: () => seedAgents(TO_INSTALL),
    render: () => (
      <Block caption="Terminal/MissingCliGate.tsx" surface="canvas">
        <MissingCliGate
          agentId="claude"
          detail={{ state: "missing", resolvedPath: null, via: null }}
          onRunAnyway={noop}
          onAvailabilityReady={noop}
          onOpenAgentSettings={noop}
        />
      </Block>
    ),
  },
  "worktree-details": {
    what: "WorktreeDetailsSection rows: resource controls, Retry setup, Review commands",
    width: 340,
    seed: () => {
      stubAction("worktree.lifecycle.retrySetup", () => held(undefined));
    },
    render: () => <WorktreeDetailsFixture />,
  },
  "worktree-error-banners": {
    what: "WorktreeDeleteErrorBanner and WorktreeIssueErrorBanner — Retry / Dismiss",
    width: 340,
    render: () => (
      <div className="flex flex-col gap-4">
        <Block caption="WorktreeDeleteErrorBanner" surface="sidebar">
          <WorktreeDeleteErrorBanner
            message={
              "fatal: 'design-button-states' contains modified or untracked files, use --force to delete it"
            }
            onRetry={noop}
            onDismiss={noop}
          />
        </Block>
        <Block caption="WorktreeIssueErrorBanner" surface="sidebar">
          <WorktreeIssueErrorBanner
            message="GitHub returned 502 while linking #12941."
            mutationType="attach-issue"
            onRetry={noop}
            onDismiss={noop}
          />
        </Block>
      </div>
    ),
  },
  "quick-state-arm": {
    what: "QuickStateArmButton enabled and disabled",
    width: 340,
    render: () => <QuickStateArmFixture />,
  },
  "background-group": {
    what: "BackgroundContainer pill; the spec opens it to show a tab-group row beside single rows",
    width: 520,
    seed: seedBackground,
    render: () => (
      <WorktreeStoreContext.Provider value={bgWorktreeStore}>
        <Block caption="Layout/BackgroundContainer.tsx" surface="canvas">
          <BackgroundContainer />
        </Block>
      </WorktreeStoreContext.Provider>
    ),
  },
  "agent-button": {
    what: "AgentButton split chevron: launchable (enabled) and missing CLI (aria-disabled)",
    width: 360,
    seed: () => {
      bgWorktreeStore.setState({ worktrees: new Map(BG_WORKTREES.map((w) => [w.id, w])) });
      setCurrentViewStore(bgWorktreeStore);
      seedAgents(fixture<CliAvailability>({ claude: "ready", codex: "missing" }));
      // A named preset is what gives an agent button its split chevron.
      useProjectPresetsStore.setState({
        presetsByAgent: Object.fromEntries(
          ["claude", "codex"].map((id) => [
            id,
            [
              { id: `${id}-plan`, name: "Plan first" },
              { id: `${id}-fast`, name: "Fast" },
            ],
          ])
        ),
      });
    },
    render: () => (
      <WorktreeStoreContext.Provider value={bgWorktreeStore}>
        <div className="flex flex-col gap-4">
          <Block caption="Layout/AgentButton.tsx — ready" surface="canvas">
            <div className="flex items-center">
              <AgentButton type="claude" availability="ready" />
            </div>
          </Block>
          <Block caption="Layout/AgentButton.tsx — CLI missing (chevron disabled)" surface="canvas">
            <div className="flex items-center">
              <AgentButton type="codex" availability="missing" />
            </div>
          </Block>
        </div>
      </WorktreeStoreContext.Provider>
    ),
  },
  "git-operation-preview": {
    what: "GitOperationPreview notice with Retry",
    width: 460,
    render: () => (
      <Block caption="Git/GitOperationPreview.tsx — PreviewNotice Retry" surface="elevated">
        <PreviewFrame>
          <PreviewSummary>
            <SummaryRow label="Branch">
              <RefChip value="design/button-states" />
            </SummaryRow>
            <SummaryRow label="Remote">
              <RefChip value="origin" />
            </SummaryRow>
          </PreviewSummary>
          <PreviewNotice
            tone="error"
            title="Couldn't read the commits to push"
            command="git fetch origin"
            onRetry={noop}
          >
            The remote didn&apos;t answer in time.
          </PreviewNotice>
        </PreviewFrame>
      </Block>
    ),
  },
  "plugin-detail": {
    what: "PluginDetailPane header — update check and Uninstall",
    width: 640,
    render: () => (
      <Block caption="Plugin/PluginDetailPane.tsx" pad={false}>
        <PluginDetailPane
          plugin={PLUGIN}
          checkingUpdate={false}
          upToDate={false}
          onToggle={noop}
          onUninstall={noop}
          onCheckForUpdate={noop}
        />
      </Block>
    ),
  },
  "notification-entry": {
    what: "NotificationCenterEntry rows with actions — available and unavailable",
    width: 420,
    seed: () => {
      stubAction("worktree.openReviewHub", noopAsync);
      stubAction("terminal.restartService", noopAsync);
    },
    render: () => (
      <Block caption="Notifications/NotificationCenterEntry.tsx" surface="elevated" pad={false}>
        <NotificationCenterEntry
          entry={notification(
            "n-1",
            "error",
            "Push failed",
            "origin rejected the push: the branch has moved. Pull and rebase, then push again.",
            [
              { label: "Open Review Hub", actionId: fixture<ActionId>("worktree.openReviewHub") },
              {
                label: "Restart service",
                actionId: fixture<ActionId>("terminal.restartService"),
                variant: "secondary",
              },
            ]
          )}
        />
        <NotificationCenterEntry
          entry={notification(
            "n-2",
            "warning",
            "Agent needs approval",
            "Claude is waiting on a tool call in design-button-states.",
            [{ label: "Unavailable action", actionId: fixture<ActionId>("preview.unregistered") }]
          )}
        />
      </Block>
    ),
  },
};
