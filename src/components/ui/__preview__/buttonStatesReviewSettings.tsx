import { useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { StagingFileEntry, StagingStatus } from "@shared/types";
import type { PushProgressEvent } from "@shared/types/ipc/gitPush";
import type { Project } from "@shared/types";
import { Button, type ButtonProps } from "@/components/ui/button";
import { getAgentConfig } from "@/config/agents";
import { useProjectStore } from "@/store/projectStore";
import { useDiagnosticsReviewStore } from "@/store/diagnosticsReviewStore";
import { CommitPanel } from "@/components/Worktree/ReviewHub/CommitPanel";
import { ConflictPanel } from "@/components/Worktree/ReviewHub/ConflictPanel";
import { FileSection } from "@/components/Worktree/ReviewHub/FileSection";
import { ReadinessRail } from "@/components/Worktree/ReviewHub/ReadinessRail";
import {
  DEFAULT_SECTION_STATE,
  type SectionViewState,
} from "@/components/Worktree/ReviewHub/reviewHubUtils";
import type { ReviewReadinessSummary } from "@/components/Worktree/ReviewHub/reviewReadiness";
import { TroubleshootingTab } from "@/components/Settings/TroubleshootingTab";
import { EditorIntegrationTab } from "@/components/Settings/EditorIntegrationTab";
import { EnvironmentSettingsTab } from "@/components/Settings/EnvironmentSettingsTab";
import { ImageViewerTab } from "@/components/Settings/ImageViewerTab";
import { WorktreeSettingsTab } from "@/components/Settings/WorktreeSettingsTab";
import {
  AgentInventorySection,
  type InventoryAgent,
} from "@/components/Settings/AgentInventorySection";
import { PrivacyDataTab } from "@/components/Settings/PrivacyDataTab";
import { McpServerSettingsTab } from "@/components/Settings/McpServerSettingsTab";
import { GeneralTab } from "@/components/Project/GeneralTab";
import { EnvironmentVariablesEditor } from "@/components/Project/EnvironmentVariablesEditor";
import type { EnvVar } from "@/components/Project/projectSettingsDirty";
import { actionService } from "@/services/ActionService";
import type { ActionId } from "@shared/types/actions";
import { held } from "./buttonStatesBootstrap";
import { Block, never, noop, type Fixture } from "./buttonStatesFrame";

export const PREVIEW_PROJECT: Project = {
  id: "proj-daintree",
  path: "/Users/greg/Projects/daintree",
  name: "Daintree",
  emoji: "\u{1F333}",
  lastOpened: 1_764_000_000_000,
};

const WORKTREE_PATH = "/Users/greg/Projects/daintree-worktrees/design-button-states";

/** Registers a stand-in action once; a harness page never has the real registry. */
export function stubAction(id: string, run: () => Promise<unknown>): void {
  const actionId = id as ActionId;
  if (actionService.has(actionId)) return;
  actionService.register({
    id: actionId,
    title: id,
    description: `Harness stand-in for ${id}.`,
    category: "preview",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run,
  });
}

// ---------------------------------------------------------------------------
// A. The primitive
// ---------------------------------------------------------------------------

const SIZES = ["default", "sm", "xs", "lg"] as const;
const VARIANTS = [
  "default",
  "outline",
  "ghost",
  "contrast",
  "destructive",
  "ghost-danger",
] as const;
const ICON_SIZES = ["icon", "icon-sm", "icon-xs"] as const;

function SpecimenButton(props: ButtonProps & { label: string }) {
  const { label, ...rest } = props;
  return (
    <Button {...rest}>
      <Plus aria-hidden="true" />
      {label}
    </Button>
  );
}

function PrimitiveSheet() {
  return (
    <div className="flex flex-col gap-4">
      {VARIANTS.map((variant) => (
        <Block key={variant} caption={`variant=${variant} · rest / loading / disabled per size`}>
          <div className="grid grid-cols-[3rem_repeat(3,max-content)] items-center gap-x-4 gap-y-2">
            {SIZES.map((size) => (
              <div key={size} className="contents">
                <span className="font-mono text-3xs text-text-muted" data-harness-decoration>
                  {size}
                </span>
                <SpecimenButton variant={variant} size={size} label="Commit" />
                <SpecimenButton variant={variant} size={size} label="Commit" loading />
                <SpecimenButton variant={variant} size={size} label="Commit" disabled />
              </div>
            ))}
          </div>
        </Block>
      ))}
      <Block caption="icon sizes · rest / loading / disabled per variant">
        <div className="grid grid-cols-[6rem_repeat(9,max-content)] items-center gap-x-2 gap-y-2">
          {VARIANTS.map((variant) => (
            <div key={variant} className="contents">
              <span className="font-mono text-3xs text-text-muted" data-harness-decoration>
                {variant}
              </span>
              {ICON_SIZES.map((size) => (
                <div key={size} className="contents">
                  <Button variant={variant} size={size} aria-label="Delete">
                    <Trash2 />
                  </Button>
                  <Button variant={variant} size={size} aria-label="Delete" loading>
                    <Trash2 />
                  </Button>
                  <Button variant={variant} size={size} aria-label="Delete" disabled>
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Block>
    </div>
  );
}

// ---------------------------------------------------------------------------
// B. Review Hub
// ---------------------------------------------------------------------------

function file(path: string, status: StagingFileEntry["status"], ins: number, del: number) {
  return { path, status, insertions: ins, deletions: del } satisfies StagingFileEntry;
}

const STAGED: StagingFileEntry[] = [
  file("src/components/ui/button.tsx", "modified", 24, 9),
  file("src/components/Worktree/ReviewHub/CommitPanel.tsx", "modified", 6, 6),
  file("src/components/ui/__preview__/buttonStatesPreview.tsx", "added", 412, 0),
];

const UNSTAGED: StagingFileEntry[] = [
  file("src/components/Settings/TroubleshootingTab.tsx", "modified", 3, 3),
  file("docs/design/buttons.md", "modified", 18, 2),
];

function CommitPanelFixture({ pushing }: { pushing: boolean }) {
  const [message, setMessage] = useState("Unify button loading states");
  const progress = new Map<string, PushProgressEvent>(
    pushing
      ? [
          [
            "writing",
            {
              cwd: WORKTREE_PATH,
              stage: "writing",
              progress: 64,
              processed: 16,
              total: 25,
              targetBranch: "design/button-states",
            },
          ],
        ]
      : []
  );
  return (
    <Block caption="Worktree/ReviewHub/CommitPanel.tsx — Commit / Commit & push">
      <CommitPanel
        stagedCount={STAGED.length}
        isDetachedHead={false}
        hasConflicts={false}
        hasRemote
        pushDestination={{ remote: "origin", branch: "design/button-states" }}
        worktreePath={WORKTREE_PATH}
        currentBranch="design/button-states"
        commitMessage={message}
        onCommitMessageChange={setMessage}
        onCommit={never}
        onCommitAndPush={never}
        isPushing={pushing}
        pushProgress={progress}
        pushTargetBranch={pushing ? "design/button-states" : null}
        skipPushConfirm
        onSetSkipPushConfirm={noop}
      />
    </Block>
  );
}

const CONFLICT_STATUS: StagingStatus = {
  staged: [file("src/components/ui/button.tsx", "modified", 4, 1)],
  unstaged: [],
  conflicted: ["src/components/ui/button.tsx", "src/index.css"],
  conflictedFiles: [
    { path: "src/components/Settings/TroubleshootingTab.tsx", xy: "UU", label: "both modified" },
    { path: "src/index.css", xy: "UU", label: "both modified" },
  ],
  isDetachedHead: false,
  currentBranch: "design/button-states",
  hasRemote: true,
  pushDestination: { remote: "origin", branch: "design/button-states" },
  pullSource: { remote: "origin", branch: "develop" },
  repoState: "MERGING",
  rebaseStep: null,
  rebaseTotalSteps: null,
  rebaseSequence: null,
};

function ConflictPanelFixture() {
  return (
    <Block caption="Worktree/ReviewHub/ConflictPanel.tsx — Open / Mark resolved / more">
      <ConflictPanel
        status={CONFLICT_STATUS}
        worktreePath={WORKTREE_PATH}
        onMarkResolved={never}
        onOpenInEditor={noop}
        onCheckoutOursTheirs={never}
        onAbort={never}
        onContinue={never}
      />
    </Block>
  );
}

function FileSectionFixture() {
  const [stagedView, setStagedView] = useState<SectionViewState>(DEFAULT_SECTION_STATE);
  const [unstagedView, setUnstagedView] = useState<SectionViewState>(DEFAULT_SECTION_STATE);
  const stagedInput = useRef<HTMLInputElement>(null);
  const unstagedInput = useRef<HTMLInputElement>(null);
  const common = {
    focusedIndex: -1,
    selectionSection: null,
    selectedPaths: new Set<string>(),
    hasSelection: false,
    setFilterQuery: noop,
    clearFilter: noop,
    onToggle: noop,
    onRowClick: noop,
    onBulkAction: noop,
    viewedFiles: new Set<string>(),
    onViewedChange: noop,
    renderRowMenu: () => null,
  };
  return (
    <Block caption="Worktree/ReviewHub/FileSection.tsx — section header bulk action" pad={false}>
      <FileSection
        {...common}
        isStaged
        files={STAGED}
        allFiles={STAGED}
        indexOffset={0}
        view={stagedView}
        setView={setStagedView}
        inputRef={stagedInput}
      />
      <FileSection
        {...common}
        isStaged={false}
        files={UNSTAGED}
        allFiles={UNSTAGED}
        indexOffset={STAGED.length}
        view={unstagedView}
        setView={setUnstagedView}
        inputRef={unstagedInput}
      />
    </Block>
  );
}

const READINESS: ReviewReadinessSummary = {
  level: "blocked",
  commitReady: false,
  pushReady: false,
  prReady: "unknown",
  blockers: [
    {
      id: "conflicts",
      severity: "blocker",
      label: "2 conflicted files",
      action: { kind: "focus-conflicts" },
    },
  ],
  warnings: [
    {
      id: "behind-remote",
      severity: "warning",
      label: "3 commits behind origin/develop",
      action: { kind: "pull-rebase" },
    },
    { id: "ci-failing", severity: "warning", label: "CI failing on the open PR" },
  ],
  infos: [{ id: "generated-only", severity: "info", label: "Only generated files changed" }],
  nextActions: [],
};

// ---------------------------------------------------------------------------
// C. Settings
// ---------------------------------------------------------------------------

function inventoryAgents(): InventoryAgent[] {
  return ["claude", "codex", "gemini", "opencode"].flatMap((id) => {
    const config = getAgentConfig(id);
    return config ? [{ id, name: config.name, color: config.color, Icon: config.icon }] : [];
  });
}

const AVAILABILITY = {
  claude: "ready",
  codex: "ready",
  gemini: "missing",
  opencode: "blocked",
} as const;

function seedProject() {
  useProjectStore.setState({ currentProject: PREVIEW_PROJECT });
}

// ---------------------------------------------------------------------------
// D. Project settings
// ---------------------------------------------------------------------------

const PROJECT_ENV: EnvVar[] = [
  { id: "env-1", key: "DATABASE_URL", value: "postgres://localhost:5432/daintree" },
  { id: "env-2", key: "LOG_LEVEL", value: "debug" },
];

function GeneralTabFixture() {
  return (
    <GeneralTab
      currentProject={{ ...PREVIEW_PROJECT, inRepoSettings: false }}
      name={PREVIEW_PROJECT.name}
      onNameChange={noop}
      emoji={PREVIEW_PROJECT.emoji ?? ""}
      onEmojiChange={noop}
      color={undefined}
      onColorChange={noop}
      devServerCommand="npm run dev"
      onDevServerCommandChange={noop}
      devServerLoadTimeout={undefined}
      onDevServerLoadTimeoutChange={noop}
      turbopackEnabled={false}
      onTurbopackEnabledChange={noop}
      daintreeMcpTier="core"
      onDaintreeMcpTierChange={noop}
      daintreeMcpSkipConfirmations={false}
      onDaintreeMcpSkipConfirmationsChange={noop}
      projectIconSvg={undefined}
      onProjectIconSvgChange={noop}
      enableInRepoSettings={never}
      disableInRepoSettings={never}
      projectId={PREVIEW_PROJECT.id}
      isOpen
    />
  );
}

export const REVIEW_SETTINGS_FIXTURES: Record<string, Fixture> = {
  primitive: {
    what: "Button primitive: every size × rest/loading/disabled per variant, plus icon sizes",
    width: 760,
    render: () => <PrimitiveSheet />,
  },
  "commit-panel": {
    what: "CommitPanel with three staged files and a message; the spec clicks Commit to hold it busy",
    width: 420,
    render: () => <CommitPanelFixture pushing={false} />,
  },
  "commit-panel-pushing": {
    what: "CommitPanel while a push is in flight (isPushing)",
    width: 420,
    render: () => <CommitPanelFixture pushing />,
  },
  "conflict-panel": {
    what: "ConflictPanel mid-merge with two conflicted files; the spec holds Mark resolved busy",
    width: 560,
    render: () => <ConflictPanelFixture />,
  },
  "file-section": {
    what: "FileSection headers for Staged and Changes with their bulk actions",
    width: 560,
    render: () => <FileSectionFixture />,
  },
  "readiness-rail": {
    what: "ReadinessRail leading with a blocker and an 'N more' overflow",
    width: 620,
    render: () => (
      <Block caption="Worktree/ReviewHub/ReadinessRail.tsx — CTA + N more" pad={false}>
        <ReadinessRail summary={READINESS} onCta={noop} />
      </Block>
    ),
  },
  "settings-troubleshooting": {
    what: "TroubleshootingTab rows: health check, diagnostics, CPU profile, logs",
    width: 720,
    seed: () => {
      // Without it the tab shows its read-failure row, which is not the state under review.
      stubAction("logs.getVerbose", () => Promise.resolve({ verbose: false }));
      if (new URLSearchParams(window.location.search).get("collecting") === "1") {
        useDiagnosticsReviewStore.setState({ isCollecting: true });
      }
    },
    render: () => <TroubleshootingTab />,
  },
  "settings-editor": {
    what: "EditorIntegrationTab with a saved editor — Test saved editor / Save",
    width: 720,
    seed: seedProject,
    render: () => <EditorIntegrationTab />,
  },
  "settings-environment": {
    what: "EnvironmentSettingsTab (global env vars) — Discard / Save",
    width: 720,
    render: () => <EnvironmentSettingsTab />,
  },
  "settings-image-viewer": {
    what: "ImageViewerTab — Save",
    width: 720,
    seed: seedProject,
    render: () => <ImageViewerTab />,
  },
  "settings-worktree": {
    what: "WorktreeSettingsTab path pattern — Discard / Save",
    width: 720,
    seed: () => {
      stubAction("worktreeConfig.get", () =>
        Promise.resolve({ pathPattern: "{parent-dir}/{base-folder}-worktrees/{branch-slug}" })
      );
      stubAction("worktreeConfig.setPattern", () => held(undefined));
    },
    render: () => <WorktreeSettingsTab />,
  },
  "settings-agents": {
    what: "AgentInventorySection header Re-check, at rest and while re-checking",
    width: 720,
    render: () => (
      <div className="flex flex-col gap-4">
        <Block caption="Settings/AgentInventorySection.tsx — rest">
          <AgentInventorySection
            agents={inventoryAgents()}
            availability={AVAILABILITY}
            isLoading={false}
            error={null}
            isRefreshing={false}
            onRefresh={noop}
            onOpenAgent={noop}
            onRunSetupWizard={noop}
          />
        </Block>
        <Block caption="Settings/AgentInventorySection.tsx — isRefreshing">
          <AgentInventorySection
            agents={inventoryAgents()}
            availability={AVAILABILITY}
            isLoading={false}
            error={null}
            isRefreshing
            onRefresh={noop}
            onOpenAgent={noop}
            onRunSetupWizard={noop}
          />
        </Block>
      </div>
    ),
  },
  "settings-privacy": {
    what: "PrivacyDataTab storage subtab — Clear cache",
    width: 720,
    render: () => <PrivacyDataTab activeSubtab="storage" onSubtabChange={noop} />,
  },
  "settings-mcp": {
    what: "McpServerSettingsTab external clients — Disconnect",
    width: 720,
    seed: seedProject,
    render: () => <McpServerSettingsTab />,
  },
  "project-general": {
    what: "Project GeneralTab in-repository settings — Cancel / Confirm and enable",
    width: 720,
    seed: seedProject,
    render: () => <GeneralTabFixture />,
  },
  "project-env": {
    what: "Project EnvironmentVariablesEditor — Discard / Save",
    width: 720,
    render: () => (
      <EnvironmentVariablesEditor
        environmentVariables={PROJECT_ENV}
        onEnvironmentVariablesChange={noop}
        settings={null}
        isOpen
        onFlush={never}
        projectLabel="Daintree"
      />
    ),
  },
};
