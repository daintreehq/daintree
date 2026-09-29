import "@/lib/trustedTypesPolicy";
import { StrictMode, use, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { Project } from "@shared/types/project";
import type { WorktreeSnapshot } from "@shared/types";
import type { PaneNotifyState } from "@shared/types/terminalNotify";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";
import {
  FIXTURES as RESUME_FIXTURES,
  PROJECT as RESUME_PROJECT,
  WORKTREES as RESUME_WORKTREES,
} from "@/components/Terminal/__preview__/resumeSessionFixtures";
import {
  COMMITS_FIXTURES,
  listCommitsFrom,
  listPushCommitsFrom,
} from "@/components/Layout/__preview__/localCommitsFixtures";
import { QuickRunToggle } from "@/components/Project/QuickRun";
import { DockPopoverResizeHandle } from "@/components/Layout/DockPopoverResizeHandle";
import "@/index.css";

/**
 * Focus-ring visual-review gallery.
 *
 * Every target is a REAL component, fed fixture props or seeded stores the way
 * its sibling harnesses feed it, so the ring the capture shows is the ring the
 * app paints. Each target sits in a `[data-shot="<site-id>"]` wrapper with 24px
 * of padding so an outset ring is never clipped by the harness itself; a target
 * that lives inside a scroll container in the app (list rows, popover lists) is
 * put inside an `overflow:auto` box with the list's real padding, so clipping
 * shows exactly as it would in the app.
 *
 * Driven by `e2e/screenshots/focus-rings-review.spec.ts`, which focuses each
 * target by role/label/testid/text (never by class, since classes are what a
 * reviewer is about to change) and records the computed focus style.
 *
 * Not mounted:
 *   browser-example-chip   — BrowserPane is a webview host (guest process, navigation
 *                            controller, panel store lifecycle); its empty state is not
 *                            reachable without a real webContents.
 *   markdown-saveas-input  — MarkdownEditorView is a plugin view bound to the plugin host
 *                            bridge and a CodeMirror document; the save-as field only
 *                            appears mid-save through that host.
 *
 * Proxy stand-ins (the class is only ever applied through a component that is mounted):
 *   footer-item      — the real HelpPanelFooter's diverged-worktree button (FOOTER_ITEM_CLASS).
 *   header-chip      — the real TerminalNotifyChip trigger (HEADER_CHIP_FOCUS_CLASS).
 *   composer-control — the real VoiceInputButton (COMPOSER_CONTROL_FOCUS_CLASS), inside a
 *                      shell that sets --ib-* from the same resolveInputBarColors the
 *                      HybridInputBar uses.
 *
 * Query parameters:
 *   ?theme=<built-in theme id>
 *   ?fixture=launcher|recipes|review|controls|overlays|tour
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixture = params.get("fixture") ?? "controls";

const isHarness = !Reflect.get(window, "electron");

function answering(impl: Record<string, unknown>): unknown {
  return new Proxy(impl, {
    get: (target, key) =>
      key in target
        ? Reflect.get(target, key)
        : () => Object.assign(() => undefined, { then: (r: (v: unknown) => void) => r(undefined) }),
  });
}

const NOTIFY_TERMINAL_ID = "pane-notify";
const notifyState: PaneNotifyState = {
  terminalId: NOTIFY_TERMINAL_ID,
  pendingCount: 2,
  readyCount: 0,
  delivery: { status: "idle" },
  revision: 1,
};
const commits = COMMITS_FIXTURES.few!;

// Installed before any component module is imported (every one below is a
// dynamic import), so a store that reads the bridge at evaluation time finds it.
installPreviewShims({
  onboarding: answering({
    get: async () => ({
      seenAgentIds: LAUNCHABLE_AGENT_IDS.slice(),
      availabilityFirstSeen: {},
      welcomeCardDismissed: true,
      setupBannerDismissed: true,
      tours: {},
      tourMuted: true,
    }),
  }),
  agentSessionHistory: answering({
    list: () => Promise.resolve(RESUME_FIXTURES.populated.sessions),
  }),
  forge: answering({
    getChecks: () =>
      Promise.resolve({
        checks: [
          { name: "lint", status: "completed", conclusion: "success", required: true },
          { name: "test", status: "completed", conclusion: "failure", required: true },
        ],
      }),
  }),
  git: answering({
    listCommits: listCommitsFrom(commits),
    listPushCommits: listPushCommitsFrom(commits),
  }),
  mcpServer: answering({
    getPaneNotifyState: () => Promise.resolve(notifyState),
    getAuditRecords: () => Promise.resolve([]),
  }),
});

if (isHarness) {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // Storage can be unavailable; the harness renders without it.
  }
}

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const noop = () => {};

/** 24px of breathing room so an outset ring is never clipped by the harness. */
function Shot({
  id,
  children,
  surface = "canvas",
  width,
}: {
  id: string;
  children: ReactNode;
  surface?: "canvas" | "panel" | "sidebar";
  width?: number;
}) {
  const bg =
    surface === "panel"
      ? "var(--color-surface-panel)"
      : surface === "sidebar"
        ? "var(--color-surface-sidebar)"
        : "var(--color-surface-canvas)";
  return (
    <div className="flex flex-col gap-1">
      <span className="px-1 font-mono text-3xs text-text-muted">{id}</span>
      <div
        data-shot={id}
        style={{ padding: 24, background: bg, width, boxSizing: "border-box" }}
        className="border border-dashed border-border-subtle"
      >
        {children}
      </div>
    </div>
  );
}

/** A scroll container like the one the component lives in, with its real padding. */
function Scroller({
  children,
  className,
  maxHeight = 180,
}: {
  children: ReactNode;
  className?: string;
  maxHeight?: number;
}) {
  return (
    <div className={className} style={{ overflow: "auto", maxHeight }}>
      {children}
    </div>
  );
}

type Loader = () => Promise<() => ReactNode>;

const PROJECT: Project = {
  id: "preview-project",
  path: "/Users/dev/helios-dashboard",
  name: "helios-dashboard",
  emoji: "🌻",
  lastOpened: 1_764_000_000_000,
};

const loadLauncher: Loader = async () => {
  const [
    { ProjectPulseStrip },
    { LauncherQuickActions },
    { ResumeSessionLine },
    { WorktreeStoreContext, WorktreeStoreProvider },
    { useProjectStore },
    { useCliAvailabilityStore },
    { useAgentSettingsStore },
    { useToolbarPreferencesStore },
    { initBuiltInPanelKinds },
  ] = await Promise.all([
    import("@/components/Pulse/ProjectPulseStrip"),
    import("@/components/Terminal/LauncherQuickActions"),
    import("@/components/Terminal/ResumeSessionLine"),
    import("@/contexts/WorktreeStoreContext"),
    import("@/store/projectStore"),
    import("@/store/cliAvailabilityStore"),
    import("@/store/agentSettingsStore"),
    import("@/store/toolbarPreferencesStore"),
    import("@/panels/registry"),
  ]);

  initBuiltInPanelKinds();
  const pinned = ["claude", "codex", "gemini"] as const;
  useCliAvailabilityStore.setState({
    availability: Object.fromEntries(pinned.map((id) => [id, "ready"])),
    hasRealData: true,
  });
  useAgentSettingsStore.setState({
    settings: { agents: Object.fromEntries(pinned.map((id) => [id, { pinned: true }])) },
  } as Partial<ReturnType<typeof useAgentSettingsStore.getState>>);
  const layout = useToolbarPreferencesStore.getState().layout;
  useToolbarPreferencesStore.setState({
    layout: {
      ...layout,
      leftButtons: [
        ...pinned,
        ...layout.leftButtons.filter((id) => !(pinned as readonly string[]).includes(id)),
      ],
    },
  });
  useProjectStore.setState({ currentProject: RESUME_PROJECT });

  function SeedWorktrees({ children }: { children: ReactNode }) {
    const store = use(WorktreeStoreContext);
    const [ready] = useState(() => {
      store?.setState({
        worktrees: new Map<string, WorktreeSnapshot>(RESUME_WORKTREES.map((wt) => [wt.id, wt])),
      });
      return true;
    });
    return ready ? children : null;
  }

  // The launcher column: `@container/launcher` at the canvas home's measure.
  const column = "@container/launcher flex w-[38rem] max-w-full flex-col items-center gap-2";

  return () => (
    <WorktreeStoreProvider>
      <SeedWorktrees>
        <div className="flex flex-col gap-4">
          <Shot id="pulse-row">
            <div className={column}>
              <ProjectPulseStrip worktreeId="wt-pulse-row" />
            </div>
          </Shot>
          <Shot id="pulse-collapse">
            <div className={column}>
              <ProjectPulseStrip worktreeId="wt-pulse-collapse" />
            </div>
          </Shot>
          <Shot id="launcher-quick-action">
            <div className={column}>
              <LauncherQuickActions />
            </div>
          </Shot>
          <Shot id="resume-line">
            <div className={column}>
              <ResumeSessionLine />
            </div>
          </Shot>
          <Shot id="resume-launcher">
            <div className={column}>
              <ResumeSessionLine />
            </div>
          </Shot>
        </div>
      </SeedWorktrees>
    </WorktreeStoreProvider>
  );
};

const loadRecipes: Loader = async () => {
  const [
    { RecipeRunner },
    { RecipeRunnerList },
    { RecipeRunnerEmpty },
    { buildRecipeSections },
    { useRecipeStore },
    { useProjectStore },
    { WorktreeStoreProvider },
  ] = await Promise.all([
    import("@/components/Terminal/RecipeRunner/RecipeRunner"),
    import("@/components/Terminal/RecipeRunner/RecipeRunnerList"),
    import("@/components/Terminal/RecipeRunner/RecipeRunnerEmpty"),
    import("@/components/Terminal/RecipeRunner/recipeRunnerUtils"),
    import("@/store/recipeStore"),
    import("@/store/projectStore"),
    import("@/contexts/WorktreeStoreContext"),
  ]);
  type Recipe = import("@/types").TerminalRecipe;
  type RunCommand = import("@/types").RunCommand;

  const recipe = (id: string, name: string, extra: Partial<Recipe> = {}): Recipe =>
    ({
      id,
      name,
      terminals: [
        { type: "claude", title: name, env: {} },
        { type: "terminal", title: "Shell", command: "npm test", env: {} },
      ],
      createdAt: 1_760_000_000_000,
      ...extra,
    }) as Recipe;

  const three = [
    recipe("r-work", "Work an issue", { showInEmptyState: true }),
    recipe("r-review", "Design review"),
    recipe("r-shell", "Scratch shell"),
  ];
  useRecipeStore.setState({
    globalRecipes: three,
    pluginRecipes: [],
    inRepoRecipes: [],
    projectRecipes: [],
    recipes: three,
    currentProjectId: PROJECT.id,
    isLoading: false,
  } as Partial<ReturnType<typeof useRecipeStore.getState>>);
  useProjectStore.setState({ currentProject: PROJECT });

  const many = Array.from({ length: 8 }, (_, i) =>
    recipe(`r-many-${i}`, `Project task ${i + 1}`, {
      ...(i < 2 ? { showInEmptyState: true } : {}),
      ...(i % 3 === 0 ? { lastUsedAt: 1_763_900_000_000 - i * 1000 } : {}),
    })
  );
  const sections = buildRecipeSections(many);
  const suggestions = [
    { id: "npm-dev", name: "dev", command: "npm run dev" },
    { id: "npm-test", name: "test", command: "npm test" },
  ] as RunCommand[];

  const grid = (
    <div className="@container/launcher flex w-full flex-col items-center">
      <RecipeRunner activeWorktreeId="wt-main" defaultCwd={PROJECT.path} />
    </div>
  );
  // The canvas home scrolls; the band sits inside that scroller.
  const list = (
    <Scroller maxHeight={260}>
      <div className="@container/launcher flex w-full flex-col items-center">
        <div className="w-full">
          <RecipeRunnerList
            sections={sections}
            searchQuery=""
            searchResults={[]}
            focusedIndex={0}
            focusedItemId={`recipe-option-${many[0]!.id}`}
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
        </div>
      </div>
    </Scroller>
  );
  const empty = (
    <div className="@container/launcher flex w-full flex-col items-center">
      <RecipeRunnerEmpty onCreate={noop} suggestions={suggestions} onRunSuggestion={noop} />
    </div>
  );

  return () => (
    <WorktreeStoreProvider>
      <div className="flex flex-col gap-4">
        {["recipe-item-card", "recipe-grid-create", "recipe-manage"].map((id) => (
          <Shot key={id} id={id} width={660}>
            {grid}
          </Shot>
        ))}
        {["recipe-item-row", "recipe-list-manage", "recipe-list-create"].map((id) => (
          <Shot key={id} id={id} width={660}>
            {list}
          </Shot>
        ))}
        {["recipe-empty-create", "recipe-empty-suggestion"].map((id) => (
          <Shot key={id} id={id} width={660}>
            {empty}
          </Shot>
        ))}
      </div>
    </WorktreeStoreProvider>
  );
};

const loadReview: Loader = async () => {
  const [
    { BaseBranchFileRow },
    { FileStageRow },
    { PrStatusChip },
    { FileDecorationBadge },
    { FileChangeList },
    { DiffFileSidebar },
    { WorktreeStoreProvider },
    { TooltipProvider },
    { usePluginContextMenuItemsStore },
  ] = await Promise.all([
    import("@/components/Worktree/ReviewHub/BaseBranchFileRow"),
    import("@/components/Worktree/ReviewHub/FileStageRow"),
    import("@/components/Worktree/ReviewHub/PrStatusChip"),
    import("@/components/Plugin/FileDecorationBadge"),
    import("@/components/Worktree/FileChangeList"),
    import("@/components/FileViewer/DiffFileSidebar"),
    import("@/contexts/WorktreeStoreContext"),
    import("@/components/ui/tooltip"),
    import("@/store/pluginContextMenuItemsStore"),
  ]);
  // The shared file-row menu reads plugin contributions; none in the harness.
  usePluginContextMenuItemsStore.setState({ entries: [], init: () => {} } as Partial<
    ReturnType<typeof usePluginContextMenuItemsStore.getState>
  >);
  const root = "/Users/dev/helios-dashboard";
  const decoration = {
    badge: "2",
    tooltip: "2 unresolved review comments",
    url: "https://github.com/helios/dashboard/pull/4830/files",
  };
  const changes = [
    { path: "src/components/charts/Legend.tsx", status: "modified", insertions: 42, deletions: 7 },
    { path: "src/components/charts/Axis.tsx", status: "modified", insertions: 3, deletions: 1 },
    { path: "src/lib/format.ts", status: "added", insertions: 18, deletions: 0 },
    { path: "README.md", status: "modified", insertions: 2, deletions: 2 },
  ] as const;

  return () => (
    <TooltipProvider>
      <WorktreeStoreProvider>
        <div className="flex flex-col gap-4">
          <Shot id="basebranch-row" surface="panel" width={460}>
            <Scroller className="px-2 py-1 flex flex-col gap-0.5">
              <BaseBranchFileRow
                file={{
                  path: "src/components/charts/Legend.tsx",
                  status: "M",
                  insertions: 42,
                  deletions: 7,
                }}
                onClick={noop}
                unresolvedDecoration={decoration}
                onBadgeClick={noop}
              />
            </Scroller>
          </Shot>
          <Shot id="basebranch-badge" surface="panel" width={460}>
            <Scroller className="px-2 py-1 flex flex-col gap-0.5">
              <BaseBranchFileRow
                file={{
                  path: "src/components/charts/Legend.tsx",
                  status: "M",
                  insertions: 42,
                  deletions: 7,
                }}
                onClick={noop}
                unresolvedDecoration={decoration}
                onBadgeClick={noop}
              />
            </Scroller>
          </Shot>
          <Shot id="filestage-row" surface="panel" width={460}>
            <Scroller className="px-2 py-1">
              <div role="listbox" aria-label="Unstaged changes" className="flex flex-col">
                <FileStageRow
                  file={changes[0]}
                  section="unstaged"
                  isStaged={false}
                  isSelected={false}
                  onToggle={noop}
                  onRowClick={noop}
                />
                <FileStageRow
                  file={changes[1]}
                  section="unstaged"
                  isStaged={false}
                  isSelected={false}
                  onToggle={noop}
                  onRowClick={noop}
                />
              </div>
            </Scroller>
          </Shot>
          <Shot id="prchecks-trigger" surface="panel" width={460}>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-text-primary">Review & commit</h2>
              <PrStatusChip
                hasRemote
                worktreePR={{
                  prNumber: 4830,
                  prUrl: "https://github.com/helios/dashboard/pull/4830",
                  prState: "open",
                  prCiStatus: {
                    state: "failure",
                    total: 2,
                    passed: 1,
                    failed: 1,
                    pending: 0,
                    rawData: {},
                  },
                }}
                worktreePath={root}
                onOpenExternal={noop}
              />
            </div>
          </Shot>
          <Shot id="file-decoration-badge" surface="panel" width={460}>
            <div className="flex items-center gap-2 text-xs font-mono text-text-secondary">
              <span className="truncate">src/components/charts/Legend.tsx</span>
              <FileDecorationBadge decoration={decoration} />
            </div>
          </Shot>
          <Shot id="filechange-row" surface="panel" width={460}>
            <Scroller>
              <FileChangeList
                changes={changes.map((c) => ({ ...c }))}
                rootPath={root}
                maxVisible={8}
                className="rounded-[var(--radius-md)] bg-surface-inset p-2"
              />
            </Scroller>
          </Shot>
          <Shot id="diff-sidebar-row" surface="panel">
            <div className="flex" style={{ height: 260 }}>
              <DiffFileSidebar
                files={changes.map((c) => ({ ...c, viewedKey: `${c.status}:${c.path}` }))}
                currentIndex={0}
                worktreePath={root}
                worktreeId={null}
                onSelect={noop}
              />
            </div>
          </Shot>
        </div>
      </WorktreeStoreProvider>
    </TooltipProvider>
  );
};

const loadControls: Loader = async () => {
  const [
    { PresetColorPicker },
    { ScrollPill },
    { SegmentedRadioGroup },
    { Button },
    { HelpPanelFooter },
    { getAgentConfig },
    { TerminalNotifyChip },
    { VoiceInputButton },
    { useTerminalColorSchemeStore, selectEffectiveTheme },
    { resolveInputBarColors },
    { TooltipProvider },
    { useVoiceRecordingStore },
  ] = await Promise.all([
    import("@/components/Settings/PresetColorPicker"),
    import("@/components/ui/ScrollPill"),
    import("@/components/ui/SegmentedRadioGroup"),
    import("@/components/ui/button"),
    import("@/components/HelpPanel/HelpPanelFooter"),
    import("@/config/agents"),
    import("@/components/Terminal/TerminalNotifyChip"),
    import("@/components/Terminal/VoiceInputButton"),
    import("@/store/terminalColorSchemeStore"),
    import("@/utils/terminalTheme"),
    import("@/components/ui/tooltip"),
    import("@/store/voiceRecordingStore"),
  ]);
  // The mic only renders once voice input is configured.
  useVoiceRecordingStore.setState({ isConfigured: true });

  function ComposerShell({ children }: { children: ReactNode }) {
    const theme = useTerminalColorSchemeStore(selectEffectiveTheme);
    const c = resolveInputBarColors(theme);
    const vars: CSSProperties & Record<`--${string}`, string> = {
      "--ib-bg": c.shellBg,
      "--ib-border": c.shellBorder,
      "--ib-fg": c.foreground,
      "--ib-accent": c.accent,
    };
    return (
      <div
        style={vars}
        className="flex w-72 items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--ib-border)] bg-[var(--ib-bg)] px-2 py-1.5"
      >
        <span className="flex-1 font-mono text-xs text-[var(--ib-fg)] opacity-60">
          Ask the agent…
        </span>
        {children}
      </div>
    );
  }

  function Segmented() {
    const [value, setValue] = useState<"auto" | "light" | "dark">("light");
    return (
      <SegmentedRadioGroup
        aria-label="Appearance"
        options={[
          { value: "auto", label: "Auto" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
        value={value}
        onChange={setValue}
      />
    );
  }

  const claude = getAgentConfig("claude")!;

  return () => (
    <TooltipProvider>
      <div className="flex flex-col gap-4">
        <Shot id="canonical-button">
          <Button>Save changes</Button>
        </Shot>
        <Shot id="raw-button">
          <button type="button">Plain button</button>
        </Shot>
        <Shot id="raw-input">
          <input aria-label="Plain input" defaultValue="plain input" />
        </Shot>
        <Shot id="segmented" surface="panel">
          <Segmented />
        </Shot>
        <Shot id="dock-resize-handle" surface="panel">
          <div className="relative h-24 w-72 overflow-hidden rounded-[var(--radius-md)] border border-border-default bg-surface-panel-elevated">
            <DockPopoverResizeHandle
              isResizing={false}
              handleProps={{
                label: "Resize docked panel",
                value: 320,
                min: 200,
                max: 600,
                "data-testid": "dock-popover-resize-handle",
                onMouseDown: () => {},
                onKeyDown: () => {},
                onReset: () => {},
              }}
            />
          </div>
        </Shot>
        <Shot id="quick-run-toggle" surface="panel">
          <div className="flex h-7 w-72 items-stretch overflow-hidden border-t border-border-default">
            <QuickRunToggle expanded={false} onToggle={() => {}} />
          </div>
        </Shot>
        <Shot id="scroll-pill">
          <div className="relative flex h-16 w-72 items-end justify-center">
            <ScrollPill
              isVisible
              translateDirection="down"
              className="flex items-center gap-1.5 px-3 py-1 text-xs"
              aria-label="Scroll to bottom"
            >
              Scroll to bottom
            </ScrollPill>
          </div>
        </Shot>
        <Shot id="preset-color-trigger" surface="panel">
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <PresetColorPicker color={undefined} onChange={noop} agentColor="#d97757" />
            <span>Preset colour</span>
          </div>
        </Shot>
        <Shot id="preset-color-swatch" surface="panel">
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <PresetColorPicker color={undefined} onChange={noop} agentColor="#d97757" />
            <span>Preset colour (popover)</span>
          </div>
        </Shot>
        <Shot id="footer-item" surface="panel" width={420}>
          <HelpPanelFooter
            sessionId="preview-session"
            activity={null}
            outcomeAlert={null}
            onDismissOutcome={noop}
            terminalId={null}
            pinnedContext={{
              worktreeId: "wt-2",
              worktreeName: "daintree",
              worktreeBranch: "feature/assistant-footer",
              terminalId: "t-1",
            }}
            isPinnedWorktreeDiverged
            onReturnToPinnedWorktree={noop}
            agentId="claude"
            agentConfig={claude}
            launchedModelLabel={null}
          />
        </Shot>
        <Shot id="header-chip" surface="panel">
          <div className="flex h-8 items-center gap-2 text-xs text-text-secondary">
            <span className="font-medium text-text-primary">Claude</span>
            <TerminalNotifyChip terminalId={NOTIFY_TERMINAL_ID} />
          </div>
        </Shot>
        <Shot id="composer-control" surface="panel">
          <ComposerShell>
            <VoiceInputButton panelId="pane-composer" panelTitle="Claude" />
          </ComposerShell>
        </Shot>
      </div>
    </TooltipProvider>
  );
};

const loadOverlays: Loader = async () => {
  const [
    { EnvironmentPopover },
    { LocalCommitsDropdown },
    { GitHubListItem },
    { StatusContainer },
    { STATE_ICONS },
    { WorktreeFilterPopover },
    { emptyChipCounts },
    { useWorktreeFilterStore },
    { WorktreeStoreProvider },
    { TooltipProvider },
  ] = await Promise.all([
    import("@/components/Worktree/WorktreeCard/EnvironmentPopover"),
    import("@/components/Layout/LocalCommitsDropdown"),
    import("../../../../plugins/builtin/github/renderer/components/GitHubListItem"),
    import("@/components/Layout/StatusContainer"),
    import("@/components/Worktree/terminalStateConfig"),
    import("@/components/Worktree/WorktreeFilterPopover"),
    import("@/lib/worktreeFilters"),
    import("@/store/worktreeFilterStore"),
    import("@/contexts/WorktreeStoreContext"),
    import("@/components/ui/tooltip"),
  ]);
  type PtyPanelData = import("@shared/types/panel").PtyPanelData;
  type Issue = import("@shared/types/forge").Issue;

  const filters = useWorktreeFilterStore.getState();
  filters.clearAll();
  filters.setOrderBy("recent");
  filters.setGroupByType(false);
  const counts = emptyChipCounts();
  counts.status = { active: 0, dirty: 2, stale: 0, idle: 4 };
  counts.branchType.main = 1;
  counts.branchType.other = 5;
  Object.assign(counts.branchType, { feature: 7, bugfix: 3, chore: 2, docs: 1, deps: 4, wip: 1 });

  const terminals: PtyPanelData[] = [
    {
      id: "t-err-1",
      kind: "terminal",
      title: "Claude — refactor legend",
      location: "grid",
      cwd: PROJECT.path,
      cols: 120,
      rows: 40,
      launchAgentId: "claude",
      detectedAgentId: "claude",
      agentState: "exited",
      exitCode: 1,
    },
    {
      id: "t-err-2",
      kind: "terminal",
      title: "Codex — axis fixes",
      location: "dock",
      cwd: PROJECT.path,
      cols: 120,
      rows: 40,
      launchAgentId: "codex",
      detectedAgentId: "codex",
      agentState: "exited",
      exitCode: 1,
    },
  ];

  const issue: Issue = {
    number: 1287,
    title: "Chart legend overflows its container when series names are long",
    body: "",
    state: "open",
    rawState: "OPEN",
    url: "https://github.com/helios/dashboard/issues/1287",
    author: { login: "gpriday", rawData: {} },
    assignees: [],
    labels: [],
    commentCount: 3,
    createdAt: Date.now() - 3 * 86_400_000,
    updatedAt: Date.now() - 3_600_000,
    rawData: {},
  } as Issue;

  const statusConfig = {
    icon: STATE_ICONS.exited,
    iconColor: "text-status-error",
    headerLabel: "Errored agents",
    buttonLabel: "Errors",
    statusAriaLabel: "Exited with error",
    contentAriaLabel: "Errored terminals",
    contentId: "errors-container-popover",
  };

  return () => (
    <TooltipProvider>
      <WorktreeStoreProvider>
        <div className="flex flex-col gap-4">
          {["filter-chip", "filter-showall"].map((id) => (
            <Shot key={id} id={id} surface="sidebar" width={340}>
              <div className="flex items-stretch gap-1.5">
                <div className="h-7 flex-1 rounded-[var(--radius-md)] border border-border-default" />
                <WorktreeFilterPopover appearance="field" hideSearchInput chipCounts={counts} />
              </div>
            </Shot>
          ))}
          <Shot id="github-list-title" surface="panel" width={500}>
            <Scroller>
              <div role="grid" aria-label="Issues" className="flex flex-col">
                <GitHubListItem item={issue} type="issue" onOpenExternalUrl={noop} />
              </div>
            </Scroller>
          </Shot>
          <Shot id="local-commits-copy" surface="panel">
            <div className="w-fit rounded-[var(--radius-lg)] border border-border-default bg-surface-panel">
              <LocalCommitsDropdown cwd={PROJECT.path} branch="develop" open initialCount={5} />
            </div>
          </Shot>
          <div style={{ height: 320 }} />
          <Shot id="env-popover-content" surface="panel">
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <EnvironmentPopover
                worktreeMode="docker"
                environmentIcon={undefined}
                isLifecycleRunning={false}
                resourceStatusLabel="running"
                resourceStatusColor="green"
                reportedStatus="running"
                resourceLastOutput="container helios-api up 2 hours"
                resourceEndpoint="http://localhost:3000"
                resourceLastCheckedAt={Date.now() - 60_000}
                onCheckResourceStatus={noop}
              />
              <span>helios-dashboard</span>
            </div>
          </Shot>
          <Shot id="status-dock-row" surface="panel">
            <div className="flex justify-end">
              <StatusContainer config={statusConfig} terminals={terminals} />
            </div>
          </Shot>
        </div>
      </WorktreeStoreProvider>
    </TooltipProvider>
  );
};

const loadTour: Loader = async () => {
  const [{ TourDialog }, { DAINTREE_TOUR }, { TooltipProvider }] = await Promise.all([
    import("@/components/Tour/TourDialog"),
    import("@/components/Tour/daintreeTour"),
    import("@/components/ui/tooltip"),
  ]);
  return () => (
    <TooltipProvider>
      <div data-shot="tour-dialog" />
      <TourDialog
        isOpen
        tour={DAINTREE_TOUR}
        onClose={noop}
        initialChapter={1}
        initialMuted
        onChapterReached={noop}
        onCompleted={noop}
        onMutedChange={noop}
        onPlayer={(player) => {
          player.pause();
          player.seek(2);
        }}
      />
    </TooltipProvider>
  );
};

const LOADERS: Record<string, Loader> = {
  launcher: loadLauncher,
  recipes: loadRecipes,
  review: loadReview,
  controls: loadControls,
  overlays: loadOverlays,
  tour: loadTour,
};

function Ready({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.dataset.previewReady = "true";
  }, []);
  return <>{children}</>;
}

async function boot() {
  const loader = LOADERS[fixture];
  if (!loader) throw new Error(`unknown fixture "${fixture}" — one of ${Object.keys(LOADERS)}`);
  const [Fixture, { TooltipProvider }] = await Promise.all([
    loader(),
    import("@/components/ui/tooltip"),
  ]);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <TooltipProvider>
        <Ready>
          <div className="min-h-screen bg-surface-canvas p-6">
            <Fixture />
          </div>
        </Ready>
      </TooltipProvider>
    </StrictMode>
  );
}

void boot();
