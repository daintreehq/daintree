import "@/components/Panel/__preview__/installShims";
import { StrictMode, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { CrossWorktreeFile } from "@shared/types/ipc/git";
import type { DiffChangeSetEntry, FileChangeDetail, StagingFileEntry } from "@shared/types/git";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { FileTreeView } from "@/panels/file-browser/FileTreeView";
import type { FlatTreeRow } from "@/panels/file-browser/fileBrowserTree";
import { buildFileBrowserGitStatusIndex } from "@/panels/file-browser/fileBrowserGitStatus";
import { DiffFileSidebar } from "@/components/FileViewer/DiffFileSidebar";
import { FileChangeList } from "../FileChangeList";
import { FileStageRow } from "../ReviewHub/FileStageRow";
import { BaseBranchFileRow } from "../ReviewHub/BaseBranchFileRow";
import "@/index.css";

/**
 * Standalone visual-review harness for the file-list row family: the file
 * browser tree, the diff file shelf, the worktree card's change list, and the
 * Review Hub's staging and base-branch rows. They all answer the same three
 * questions — which row is selected, which row is under the pointer, which row
 * a context menu targets — and are only judgeable side by side.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

// The plugin menu contributions arrive over IPC in the app; the harness has none.
usePluginContextMenuItemsStore.setState({ entries: [], init: () => {} });

const ROOT = "/Users/dev/daintree";
const noop = () => {};

function treeRow(
  path: string,
  depth: number,
  isDirectory: boolean,
  posInSet: number,
  setSize: number,
  isExpanded = false
): FlatTreeRow {
  return {
    path,
    name: path.split("/").pop()!,
    isDirectory,
    depth,
    isExpanded,
    isLoading: false,
    posInSet,
    setSize,
  };
}

const TREE_ROWS: FlatTreeRow[] = [
  treeRow("src", 0, true, 1, 4, true),
  treeRow("src/components", 1, true, 1, 4),
  treeRow("src/hooks", 1, true, 2, 4),
  treeRow("src/index.css", 1, false, 3, 4),
  treeRow("src/main.tsx", 1, false, 4, 4),
  treeRow("docs", 0, true, 2, 4),
  treeRow("package.json", 0, false, 3, 4),
  treeRow("README.md", 0, false, 4, 4),
];

const TREE_STATUS = buildFileBrowserGitStatusIndex([
  { relativePath: "src/index.css", status: "modified" },
  { relativePath: "src/main.tsx", status: "added" },
  { relativePath: "package.json", status: "modified" },
]);

function TreeSurface() {
  const [cursor, setCursor] = useState<string | null>("src/index.css");
  return (
    <FileTreeView
      rows={TREE_ROWS}
      cursorPath={cursor}
      openPath="src/index.css"
      onSelect={(path) => setCursor(path)}
      onToggleExpanded={noop}
      rowContextMenu={() => (
        <>
          <ContextMenuItem>Open</ContextMenuItem>
          <ContextMenuItem>Copy path</ContextMenuItem>
        </>
      )}
      basePath={ROOT}
      label="Files"
      gitStatusIndex={TREE_STATUS}
    />
  );
}

const DIFF_FILES: DiffChangeSetEntry[] = [
  { path: "package.json", status: "modified", insertions: 2, deletions: 1, viewedKey: "p" },
  { path: "src/index.css", status: "modified", insertions: 14, deletions: 6, viewedKey: "a" },
  { path: "src/main.tsx", status: "added", insertions: 42, deletions: 0, viewedKey: "b" },
  {
    path: "src/components/FileRow.tsx",
    status: "modified",
    insertions: 9,
    deletions: 12,
    viewedKey: "c",
  },
  {
    path: "src/components/old.ts",
    status: "deleted",
    insertions: 0,
    deletions: 30,
    viewedKey: "d",
  },
];

function DiffSurface() {
  const [current, setCurrent] = useState(1);
  return (
    <div className="flex h-[340px]">
      <DiffFileSidebar
        files={DIFF_FILES}
        currentIndex={current}
        worktreePath={ROOT}
        onSelect={setCurrent}
      />
    </div>
  );
}

const CHANGES: FileChangeDetail[] = [
  { path: "src/index.css", status: "modified", insertions: 14, deletions: 6 },
  { path: "src/main.tsx", status: "added", insertions: 42, deletions: 0 },
  { path: "src/components/FileRow.tsx", status: "modified", insertions: 9, deletions: 12 },
  { path: "package.json", status: "modified", insertions: 2, deletions: 1 },
];

function ChangesSurface() {
  return (
    <div className="w-60 rounded-[var(--radius-lg)] bg-surface-sidebar p-3">
      <FileChangeList changes={CHANGES} rootPath={ROOT} />
    </div>
  );
}

const STAGED: StagingFileEntry[] = [
  { path: "src/index.css", status: "modified", insertions: 14, deletions: 6 },
  { path: "src/main.tsx", status: "added", insertions: 42, deletions: 0 },
];
const UNSTAGED: StagingFileEntry[] = [
  { path: "src/components/FileRow.tsx", status: "modified", insertions: 9, deletions: 12 },
  { path: "package.json", status: "modified", insertions: 2, deletions: 1 },
  { path: "src/components/old.ts", status: "deleted", insertions: 0, deletions: 30 },
];
const BASE: CrossWorktreeFile[] = [
  { path: "src/lib/utils.ts", status: "M", insertions: 3, deletions: 1 },
  { path: "docs/README.md", status: "A", insertions: 20, deletions: 0 },
];

function StageSurface() {
  return (
    <div className="w-96 space-y-3 rounded-[var(--radius-lg)] bg-surface-panel p-3">
      <SectionLabel>Staged</SectionLabel>
      <div role="listbox" aria-label="Staged" aria-multiselectable="true">
        {STAGED.map((file, i) => (
          <FileStageRow
            key={file.path}
            file={file}
            section="staged"
            isStaged
            isSelected={i === 0}
            onToggle={noop}
            onRowClick={noop}
            viewed={false}
            onViewedChange={noop}
            renderRowMenu={() => <ContextMenuItem>Open file</ContextMenuItem>}
          />
        ))}
      </div>
      <SectionLabel>Changes</SectionLabel>
      <div role="listbox" aria-label="Changes" aria-multiselectable="true">
        {UNSTAGED.map((file, i) => (
          <FileStageRow
            key={file.path}
            file={file}
            section="unstaged"
            isStaged={false}
            isSelected={false}
            isFocused={i === 1}
            onToggle={noop}
            onRowClick={noop}
            viewed={i === 2}
            onViewedChange={noop}
            renderRowMenu={() => <ContextMenuItem>Open file</ContextMenuItem>}
          />
        ))}
      </div>
      <SectionLabel>Against base</SectionLabel>
      <div>
        {BASE.map((file) => (
          <BaseBranchFileRow key={file.path} file={file} onClick={noop} />
        ))}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-2xs font-medium text-text-secondary">{children}</div>;
}

function Column({ slug, children }: { slug: string; children: ReactNode }) {
  return (
    <section data-surface={slug} className="w-fit">
      <div className="mb-2 font-mono text-3xs text-text-muted">{slug}</div>
      {children}
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <div data-preview-frame className="flex items-start gap-8 p-6">
        <Column slug="tree">
          <div className="h-[260px] w-56 rounded-[var(--radius-lg)] bg-surface-sidebar p-1">
            <TreeSurface />
          </div>
        </Column>
        <Column slug="diff">
          <DiffSurface />
        </Column>
        <Column slug="changes">
          <ChangesSurface />
        </Column>
        <Column slug="stage">
          <StageSurface />
        </Column>
      </div>
    </TooltipProvider>
  </StrictMode>
);
