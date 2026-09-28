import { use, useState, type ReactNode } from "react";
import { DndContext } from "@dnd-kit/core";
import type { PtyPanelData } from "@shared/types/panel";
import type { WorktreeSnapshot, WorktreeState } from "@shared/types";
import type { BrowserNavigationHistorySnapshot } from "@shared/types/browser";
import type { MarkdownFontSize } from "@/store/preferencesStore";
import { WorktreeStoreContext, WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { usePanelStore } from "@/store/panelStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { useDiffNotesStore } from "@/store/diffNotesStore";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { BrowserToolbar } from "@/components/Browser/BrowserToolbar";
import { MarkdownTextSizeControl } from "@/components/Markdown/MarkdownTextSizeControl";
import { WorktreeCard } from "@/components/Worktree/WorktreeCard";
import { DiffNotesSendMenu } from "@/panels/diff/DiffNotesSendMenu";
import { FileBrowserViewOptions } from "@/panels/file-browser/FileBrowserViewOptions";
import type { FileBrowserSortOrder } from "@/panels/file-browser/fileBrowserTree";
import type { DiffNote } from "@/components/Worktree/diffNotes";

/**
 * Scenes for the menus the existing preview pages never reach: each mounts the
 * REAL component with the props its host pane hands it, inside a stand-in
 * strip that puts the trigger where the host puts it (top toolbar, bottom
 * footer, right edge) so the menu opens to the side it opens to in the app.
 */

const noop = () => {};
const NOW = Date.now();
const WORKTREE_PATH = "/Users/greg/Projects/daintree-worktrees/design-menus";

/** A pane header strip: title on the left, controls on the right. */
function HeaderStrip({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-9 items-center justify-between border-b border-divider px-2 surface-toolbar">
      <span className="px-1 text-xs text-text-secondary" aria-hidden="true">
        {title}
      </span>
      <div className="flex items-center gap-0.5">{children}</div>
    </div>
  );
}

function Pane({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  return (
    <div
      className="flex flex-col overflow-hidden rounded-[var(--radius-md)] border border-divider bg-surface-panel"
      style={{ width, height }}
    >
      {children}
    </div>
  );
}

// ---- browser toolbar: back/forward history ------------------------------------------

const NAV_SNAPSHOT: BrowserNavigationHistorySnapshot = {
  entries: [
    { index: 0, url: "http://localhost:5173/", title: "Orchid Studio" },
    { index: 1, url: "http://localhost:5173/dashboard", title: "Dashboard · Orchid Studio" },
    {
      index: 2,
      url: "http://localhost:5173/dashboard/projects/orchid-studio/settings?tab=billing",
      title: "Billing settings · Orchid Studio",
    },
    { index: 3, url: "http://localhost:5173/pricing", title: "Pricing · Orchid Studio" },
    { index: 4, url: "http://localhost:5173/docs", title: "Docs · Orchid Studio" },
  ],
  activeIndex: 3,
  canGoBack: true,
  canGoForward: true,
};

function BrowserScene() {
  return (
    <Pane width={900} height={420}>
      <BrowserToolbar
        terminalId="menus-browser"
        url="http://localhost:5173/pricing"
        canGoBack
        canGoForward
        backEntry={NAV_SNAPSHOT.entries[2]}
        forwardEntry={NAV_SNAPSHOT.entries[4]}
        navSnapshot={NAV_SNAPSHOT}
        isLoading={false}
        isWebviewReady
        canOpenExternal
        onNavigate={noop}
        onBack={noop}
        onForward={noop}
        onGoToHistoryIndex={noop}
        onReload={noop}
        onOpenExternal={noop}
      />
      <div className="flex-1 bg-surface-canvas" aria-hidden="true" />
    </Pane>
  );
}

// ---- diff pane: send notes ----------------------------------------------------------

function note(id: string, filePath: string, body: string): DiffNote {
  return {
    id,
    worktreePath: WORKTREE_PATH,
    filePath,
    anchor: { kind: "file" },
    body,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function agentPanel(id: string, agentId: "claude" | "codex", title: string): PtyPanelData {
  return {
    id,
    title,
    kind: "terminal",
    cwd: WORKTREE_PATH,
    cols: 120,
    rows: 40,
    worktreeId: "wt-menus",
    location: "grid",
    hasPty: true,
    launchAgentId: agentId,
    detectedAgentId: agentId,
    agentState: "idle",
    runtimeStatus: "running",
  } as PtyPanelData;
}

function seedDiffNotes(): void {
  useDiffNotesStore.setState({
    notes: {
      n1: note(
        "n1",
        "src/components/ui/dropdown-menu.tsx",
        "Row padding differs from context menu"
      ),
      n2: note("n2", "src/components/ui/dropdown-menu.tsx", "Check separator inset"),
      n3: note("n3", "src/components/ui/popover.tsx", "sideOffset should match menus"),
    },
  });
  const panels = [
    agentPanel("p-claude", "claude", "Claude"),
    agentPanel("p-codex", "codex", "Codex"),
  ];
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
  });
}

function DiffNotesScene() {
  // The diff pane's footer, where the send button lives; the menu opens upward.
  return (
    <Pane width={640} height={420}>
      <div className="flex-1 bg-surface-canvas" aria-hidden="true" />
      <div className="flex h-9 items-center justify-end border-t border-divider px-2 surface-toolbar">
        <DiffNotesSendMenu
          worktreePath={WORKTREE_PATH}
          filePath="src/components/ui/dropdown-menu.tsx"
          onResult={noop}
        />
      </div>
    </Pane>
  );
}

// ---- file browser: view options -----------------------------------------------------

function FileBrowserOptionsScene() {
  const [sort, setSort] = useState<FileBrowserSortOrder>({ key: "name", direction: "asc" });
  const [hideDotfiles, setHideDotfiles] = useState(true);
  return (
    <Pane width={420} height={420}>
      <HeaderStrip title="design-menus">
        <FileBrowserViewOptions
          sort={sort}
          onSortChange={setSort}
          hideDotfiles={hideDotfiles}
          onHideDotfilesChange={setHideDotfiles}
          hiddenCounts={{ dotfiles: 4, alwaysHidden: 1 }}
          onRefresh={noop}
          isRefreshing={false}
          onCollapseAll={noop}
          canCollapseAll
          data-testid="menus-file-browser-options"
        />
      </HeaderStrip>
      <div className="flex-1 bg-surface-canvas" aria-hidden="true" />
    </Pane>
  );
}

// ---- markdown: text size ------------------------------------------------------------

function MarkdownTextSizeScene() {
  const [value, setValue] = useState<MarkdownFontSize>("sm");
  return (
    <Pane width={520} height={320}>
      <HeaderStrip title="README.md">
        <MarkdownTextSizeControl
          value={value}
          onValueChange={setValue}
          data-testid="menus-markdown-text-size"
        />
      </HeaderStrip>
      <div className="flex-1 bg-surface-canvas" aria-hidden="true" />
    </Pane>
  );
}

// ---- worktree card: resource actions ------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture: only the fields the card reads
const RESOURCE_WORKTREE = {
  id: "wt-menus",
  worktreeId: "wt-menus",
  path: WORKTREE_PATH,
  name: "design-menus",
  branch: "design/menus-popovers",
  isCurrent: true,
  isMainWorktree: false,
  aheadCount: 2,
  behindCount: 0,
  baseBranchName: "develop",
  lastActivityTimestamp: NOW - 4 * 60_000,
  createdAt: NOW - 86_400_000,
  hasResourceConfig: true,
  hasPauseCommand: true,
  hasStatusCommand: true,
  hasTeardownCommand: true,
  resourceConnectCommand: "ssh dev-box",
  resourceStatus: { lastStatus: "running" },
  worktreeChanges: {
    worktreeId: "wt-menus",
    rootPath: WORKTREE_PATH,
    changes: [],
    changedFileCount: 0,
    insertions: 0,
    deletions: 0,
    lastCommitMessage: "Align menu row paddings",
    lastCommitTimestampMs: NOW - 20 * 60_000,
    tracking: "origin/design/menus-popovers",
  },
} as unknown as WorktreeSnapshot;

function SeedWorktree({ children }: { children: ReactNode }) {
  const store = use(WorktreeStoreContext);
  const [ready] = useState(() => {
    store?.setState({
      worktrees: new Map([[RESOURCE_WORKTREE.id, RESOURCE_WORKTREE]]),
      isLoading: false,
      isInitialized: true,
    });
    return true;
  });
  return ready ? children : null;
}

function WorktreeResourceScene() {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the card's own prop shape
  const state = {
    ...RESOURCE_WORKTREE,
    worktreeChanges: RESOURCE_WORKTREE.worktreeChanges ?? null,
    lastActivityTimestamp: RESOURCE_WORKTREE.lastActivityTimestamp ?? null,
  } as unknown as WorktreeState;
  return (
    <DndContext>
      <WorktreeStoreProvider>
        <SeedWorktree>
          <div data-preview-sidebar className="w-[340px] bg-surface-sidebar">
            <WorktreeCard
              worktree={state}
              isActive
              isFocused={false}
              onSelect={noop}
              onOpenEditor={noop}
            />
          </div>
        </SeedWorktree>
      </WorktreeStoreProvider>
    </DndContext>
  );
}

export type GalleryScene =
  | "browser-toolbar"
  | "diff-notes"
  | "file-browser-options"
  | "markdown-text-size"
  | "worktree-resource";

export const GALLERY_SCENES: readonly GalleryScene[] = [
  "browser-toolbar",
  "diff-notes",
  "file-browser-options",
  "markdown-text-size",
  "worktree-resource",
];

/** Seeds the stores one scene reads. Called before the first render, never from a body. */
export function seedGalleryScene(scene: GalleryScene): void {
  usePluginContextMenuItemsStore.setState({ entries: [], init: () => {} });
  useWorktreeFilterStore.setState({ hideMainWorktree: false });
  if (scene === "diff-notes") seedDiffNotes();
}

export function GallerySceneView({ scene }: { scene: GalleryScene }) {
  switch (scene) {
    case "browser-toolbar":
      return <BrowserScene />;
    case "diff-notes":
      return <DiffNotesScene />;
    case "file-browser-options":
      return <FileBrowserOptionsScene />;
    case "markdown-text-size":
      return <MarkdownTextSizeScene />;
    case "worktree-resource":
      return <WorktreeResourceScene />;
  }
}
