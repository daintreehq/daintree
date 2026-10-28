import { Suspense, lazy, useCallback, useEffect, useMemo, useRef } from "react";
import { FileText } from "lucide-react";
import type { FileViewMode } from "@shared/types/panel";
import { isFilePanel } from "@shared/types/panel";
import type { GitStatus } from "@shared/types/git";
import { normalize, resolveWorktreePathScope, toWorktreeRelative } from "@shared/utils/path";
import type { BasePanelProps } from "@/components/Panel/ContentPanel";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import { FolderTree } from "@/components/icons";
import type { TabInfo } from "@/components/Panel/TabButton";
import { MarkdownViewer, type MarkdownViewerHandle } from "@/components/Markdown/MarkdownViewer";
import { isMarkdownFilePath } from "@/components/Markdown/isMarkdownFile";
import { isProseFilePath } from "@/components/FileViewer/isProseFile";
import { useRemoteFileContext } from "@/components/FileViewer/hostFileActions";
import { saveHostFile } from "@/services/hostFileSave";
import { HtmlViewer } from "@/components/Html/HtmlViewer";
import { isHtmlFilePath } from "@/components/Html/isHtmlFile";
import { CodeViewer, type CodeViewerHandle } from "@/components/FileViewer/CodeViewer";
import { FileSourceMetadataStrip } from "@/components/FileViewer/FileSourceMetadataStrip";
import { revealCopy } from "@/components/FileViewer/revealCopy";
import { FileImagePreview } from "@/components/FileViewer/FileImagePreview";
import { FileVideoPreview } from "@/components/FileViewer/FileVideoPreview";
import { FileAudioPreview } from "@/components/FileViewer/FileAudioPreview";
import { FilePdfPreview } from "@/components/FileViewer/FilePdfPreview";
import { useDiffContent } from "@/panels/diff/useDiffContent";
import type { DiffSubject } from "@/panels/diff/diffContentCache";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton, SkeletonBone, SkeletonHint, SkeletonText } from "@/components/ui/Skeleton";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { NO_WATCHED_PATHS, useExternalChangeTick } from "@/hooks/useExternalChangeTick";
import { copyWithToast } from "@/lib/copyWithToast";
import { lookupLocalChangeStatus } from "./localChangeStatus";
import { useHeightHold } from "./useHeightHold";
import type { ProjectSurfaceChoice } from "@shared/types/plugin";
import { useFileEditLock } from "@/hooks/useFileEditLock";
import { useFileDocumentDraftText, useFileDocumentFlags } from "@/store/fileDocumentStore";
import { FilePanePicker } from "./FilePanePicker";
import { useFileRowMenuItems } from "@/hooks/useFileRowMenuItems";
import { FileContentContextMenu } from "@/components/FileViewer/FileContentContextMenu";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { previewErrorCode, useFileLoad } from "./useFileLoad";
import { useFileRefresh } from "./useFileRefresh";
import { useFileEditorChoice, useFileEditorPicker } from "./useFileEditorChoice";
import { useFileExternalOpen } from "./useFileExternalOpen";
import { FilePaneToolbar } from "./FilePaneToolbar";
import { FilePaneUnavailable } from "./FilePaneUnavailable";

export interface FilePaneProps extends BasePanelProps {
  tabs?: TabInfo[];
  onTabClick?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabRename?: (tabId: string, newTitle: string) => void;
  onAddTab?: () => void;
}

// Kept out of the file panel's chunk: it pulls react-diff-view, the tokenizer
// and the diff stylesheet, none of which a plain file view needs. Mirrors how
// the panel registry splits the panes themselves.
const LazyDiffViewer = lazy(() =>
  import("@/components/Worktree/DiffViewer").then((m) => ({ default: m.DiffViewer }))
);

// A plugin's file editor (#13809) pulls the plugin view loader and the host
// document controller; neither belongs on the first render of a plain file.
const LazyPluginFileEditorHost = lazy(() => import("./PluginFileEditorHost"));

const MODE_LABELS: Record<FileViewMode, string> = {
  source: "Source",
  rendered: "Rendered",
  diff: "Diff",
  edit: "Edit",
};

// Shared by the fetch wait and the editor's lazy-chunk wait, like the diff
// skeleton below: the editor view is a lazy builtin slot (#12323), and the
// first mount pays for its chunk.
function EditorLoadingSkeleton() {
  return (
    <div className="p-4 space-y-3">
      <Skeleton label="Loading editor">
        <SkeletonBone className="h-5 w-1/3" />
        <SkeletonText lines={12} />
      </Skeleton>
      <SkeletonHint />
    </div>
  );
}

// Shared by the fetch wait and the lazy-chunk wait so the two are
// indistinguishable on screen. `Skeleton` carries the 400ms anti-flicker gate.
function DiffLoadingSkeleton() {
  return (
    <div className="p-4 space-y-3">
      <Skeleton label="Loading diff">
        <SkeletonBone className="h-7 w-3/4" />
        <SkeletonText lines={8} />
      </Skeleton>
      {/* Sibling, never nested: the wrapper's aria-busy silences mutations
          inside its own subtree. */}
      <SkeletonHint />
    </div>
  );
}

const toForwardSlashes = (p: string) => p.replace(/\\/g, "/");

function parentDirectory(filePath: string): string {
  const fwd = toForwardSlashes(filePath);
  const idx = fwd.lastIndexOf("/");
  return idx > 0 ? fwd.slice(0, idx) : "/";
}

function isUnderRoot(filePath: string, rootPath: string): boolean {
  if (!rootPath) return false;
  const root = toForwardSlashes(rootPath).replace(/\/$/, "") + "/";
  return toForwardSlashes(filePath).startsWith(root);
}

export function FilePane({
  id,
  title,
  isFocused,
  isMaximized,
  location,
  isMultiPanelGrid,
  onFocus,
  onClose,
  onToggleMaximize,
  onTitleChange,
  onMinimize,
  onRestore,
  showRestoreControl,
  tabs,
  onTabClick,
  onTabClose,
  onTabRename,
  onAddTab,
}: FilePaneProps) {
  const panel = usePanelStore(
    useCallback(
      (state) => {
        const candidate = state.panelsById[id];
        return candidate && isFilePanel(candidate) ? candidate : undefined;
      },
      [id]
    )
  );
  const setFileViewMode = usePanelStore((state) => state.setFileViewMode);
  const setFilePanelPath = usePanelStore((state) => state.setFilePanelPath);
  const markdownWrapLines = usePreferencesStore((state) => state.markdownWrapLines);
  // Global, like wrap: a reading size that reset per panel or per file would
  // make paging through documents feel unstable (#12134).
  const markdownFontSize = usePreferencesStore((state) => state.markdownFontSize);
  // Shared with the diff panel so a user's split/unified and wrap choices carry
  // across every surface that shows a diff.
  const diffViewType = usePreferencesStore((state) => state.diffViewType);
  const diffWrapLines = usePreferencesStore((state) => state.diffWrapLines);

  const heightHold = useHeightHold();

  const filePath = panel?.filePath;
  const isMarkdown = filePath !== undefined && isMarkdownFilePath(filePath);
  // `null` means auto — prose wraps, code doesn't. Resolved during render so a
  // `.md` diff is already wrapped on first paint, and separate from
  // `markdownWrapLines`, which owns Source view only (#12170).
  const effectiveDiffWrapLines =
    diffWrapLines ?? (filePath !== undefined && isProseFilePath(filePath));
  const isHtml = filePath !== undefined && isHtmlFilePath(filePath);
  // Markdown and HTML get a Rendered mode; every other file is source-only.
  const isRenderable = isMarkdown || isHtml;

  const worktreeId = panel?.worktreeId;
  const worktreePath = useWorktreeStore(
    useCallback(
      (state) => (worktreeId ? (state.worktrees.get(worktreeId)?.path ?? "") : ""),
      [worktreeId]
    )
  );

  // Whether a file has local changes is a git fact about where it physically
  // lives, not about the panel's binding: `file.openPanel` resolves an explicit
  // rootPath but still stamps the *active* worktree id, so `panel.worktreeId`
  // can name a worktree the file isn't in. Resolve by containment instead, with
  // the deepest root winning so a nested worktree beats its parent. "" = the
  // file is in no known worktree, so there's nothing to diff it against.
  const diffWorktreePath = useWorktreeStore(
    useCallback(
      (state): string =>
        filePath
          ? (resolveWorktreePathScope(filePath, state.worktrees.values())?.worktreePath ?? "")
          : "",
      [filePath]
    )
  );

  // The same containment answer, as an id — what `worktree.openFileBrowser`
  // needs to scope the tree it opens. A second scalar selector rather than one
  // object-returning selector: an object is a fresh reference on every store
  // write, which would re-render this pane on every git-status poll.
  const revealWorktreeId = useWorktreeStore(
    useCallback(
      (state): string =>
        filePath
          ? (resolveWorktreePathScope(filePath, state.worktrees.values())?.worktreeId ?? "")
          : "",
      [filePath]
    )
  );

  const relativeFilePath = useMemo(
    () => (filePath && diffWorktreePath ? toWorktreeRelative(filePath, diffWorktreePath) : ""),
    [filePath, diffWorktreePath]
  );

  // The containing worktree's "something moved on disk" signal, resolved off the
  // same containment path as the diff subject rather than `panel.worktreeId`.
  // Two ticks, because neither is sufficient alone: `worktreeChanges.lastUpdated`
  // misses writes into gitignored folders (git status never moves), and the raw
  // filesystem tick misses nothing but says nothing about git. Whichever moved
  // most recently wins, matching FileBrowserPane (#11330). Scalar for the same
  // reason as `localChangeStatus` — an object would re-render on every poll.
  // `undefined` when the file is in no known worktree — `externalChangeTick`
  // below is what covers that case.
  const worktreeChangeTick = useWorktreeStore(
    useCallback(
      (state): number | undefined => {
        if (!diffWorktreePath) return undefined;
        for (const worktree of state.worktrees.values()) {
          if (normalize(worktree.path) !== normalize(diffWorktreePath)) continue;
          return (
            Math.max(
              worktree.worktreeChanges?.lastUpdated ?? 0,
              state.workingTreeChangedAtById.get(worktree.id) ?? 0
            ) || undefined
          );
        }
        return undefined;
      },
      [diffWorktreePath]
    )
  );

  // What moved behind that tick, read off the same containing worktree, so a
  // write elsewhere in it can skip the re-read (#12244's directories, applied
  // to one file instead of a tree).
  const gitChangeTick = useWorktreeStore(
    useCallback(
      (state): number | undefined =>
        revealWorktreeId
          ? state.worktrees.get(revealWorktreeId)?.worktreeChanges?.lastUpdated
          : undefined,
      [revealWorktreeId]
    )
  );
  const changedDirs = useWorktreeStore(
    useCallback(
      (state) =>
        revealWorktreeId ? state.workingTreeChangedDirsById.get(revealWorktreeId) : undefined,
      [revealWorktreeId]
    )
  );

  // Scalar status, never the change entry: `changes` is rebuilt wholesale every
  // poll tick, so returning the object would re-render the pane on each tick —
  // the same Object.is bail-out `selectDiffFreshnessKey` relies on (#8635).
  const localChangeStatus = useWorktreeStore(
    useCallback(
      (state): GitStatus | undefined => {
        if (!diffWorktreePath || !relativeFilePath) return undefined;
        for (const worktree of state.worktrees.values()) {
          if (normalize(worktree.path) !== normalize(diffWorktreePath)) continue;
          return lookupLocalChangeStatus(
            worktree.worktreeChanges?.changes,
            worktree.path,
            relativeFilePath
          );
        }
        return undefined;
      },
      [diffWorktreePath, relativeFilePath]
    )
  );

  const projectPath = useProjectStore((state) => state.currentProject?.path ?? "");
  const projectId = useProjectStore((state) => state.currentProject?.id ?? "");

  // Containment root for files.read / daintree-file://: the worktree or
  // project that contains the file, else its parent directory (same
  // outside-root fallback as FileViewerModal).
  // The worktree that physically contains the file is a root too: a file in a
  // linked worktree outside the project directory is governed by that
  // worktree, not by its parent directory (#12323).
  // A root the opener pinned wins outright. The parent-directory fallback is
  // the file's own directory, so a link through a directory symlink would
  // otherwise be contained by the symlink's target and read anyway.
  const containmentRoot = panel?.fileContainmentRoot;
  const effectiveRootPath = useMemo(() => {
    if (containmentRoot) return containmentRoot;
    if (!filePath) return worktreePath || projectPath;
    return (
      [worktreePath, diffWorktreePath, projectPath].find((root) => isUnderRoot(filePath, root)) ??
      parentDirectory(filePath)
    );
  }, [containmentRoot, filePath, worktreePath, diffWorktreePath, projectPath]);
  // Whether that root is a project or worktree, as opposed to the parent-
  // directory fallback for a file no project owns. Edit is only offered inside
  // a root the host actually governs (#12323).
  const isInsideGovernedRoot =
    filePath !== undefined &&
    ((worktreePath !== "" && isUnderRoot(filePath, worktreePath)) ||
      (diffWorktreePath !== "" && isUnderRoot(filePath, diffWorktreePath)) ||
      (projectPath !== "" && isUnderRoot(filePath, projectPath)));

  const {
    content,
    sourceText,
    loadState,
    sanitizedSvg,
    errorCode,
    errorMessage,
    htmlPreviewUrl,
    reloadNonce,
    byteFacts,
    canonicalFilePath,
    loadFile,
    handleMediaPlayingChange,
    failPreview,
  } = useFileLoad(filePath, effectiveRootPath);

  const contentBytes = useMemo(
    () => (content === null ? 0 : new TextEncoder().encode(content).byteLength),
    [content]
  );
  // The editor plugin's projection of this panel's document (#12323): the
  // draft Rendered previews, the dirty flag the chrome shows in every mode,
  // and the Save / Discard operations the close prompt calls back into.
  const draftText = useFileDocumentDraftText(id);
  const { dirty: isDirty, conflict: hasConflict } = useFileDocumentFlags(id);

  const pinnedEditor = panel?.fileEditorChoice;
  const editorChoice = useFileEditorChoice({
    panelId: id,
    filePath,
    effectiveRootPath,
    pluginEditorsAllowed: location !== "dialog" && isInsideGovernedRoot,
    isRenderable,
    loadedBytes: loadState === "loaded" ? contentBytes : null,
    pinnedEditor,
  });
  const { fileDefault, editOptions, builtinEditor, pluginEditor, pluginViewer, setEditorChoice } =
    editorChoice;

  // Edit joins the toggle for a file an editor claims, inside a governed
  // root, and only in the panel (the file viewer dialog stays read-only).
  // Offered once the reader loaded it as text under the editor's byte ceiling
  // — and kept while Edit is the mode already asked for or a draft is
  // standing, so a file that is deleted, or a recovered draft whose file is
  // missing, still reaches the editor's own unavailable state rather than a
  // read-only error that hides the draft. The editor refuses what it cannot
  // edit (binary, oversized, undecodable) itself.
  // While another screen drives the project, only what is already open keeps
  // it (see useFileEditLock).
  const requestedMode = panel?.fileViewMode ?? "source";
  const canEdit =
    (builtinEditor !== null || pluginEditor !== null) &&
    location !== "dialog" &&
    isInsideGovernedRoot &&
    (loadState === "loaded" || requestedMode === "edit" || isDirty);
  const { lockedBy: editLockedBy, mayEdit } = useFileEditLock(
    canEdit && requestedMode === "edit",
    isDirty
  );
  const isEditable = canEdit && mayEdit;
  // A plugin viewer fills Rendered for a type the host can't render.
  const hasPluginRendered = pluginViewer !== null;

  // Rendered, Diff and Edit are independent capabilities. One derived list
  // drives both the toggle and the clamp, so a persisted mode whose capability
  // is gone falls back to Source — never written back, since a poll that
  // transiently drops the change (or a plugin toggled off) must not erase what
  // the user picked.
  const availableModes = useMemo<FileViewMode[]>(
    () => [
      "source",
      ...(isRenderable || hasPluginRendered ? (["rendered"] as const) : []),
      ...(localChangeStatus !== undefined ? (["diff"] as const) : []),
      ...(isEditable ? (["edit"] as const) : []),
    ],
    [isRenderable, hasPluginRendered, localChangeStatus, isEditable]
  );
  const viewMode: FileViewMode = availableModes.includes(requestedMode) ? requestedMode : "source";
  const showPluginViewer = viewMode === "rendered" && !isRenderable && pluginViewer !== null;

  const editorPicker = useFileEditorPicker(filePath, viewMode, showPluginViewer, editorChoice);
  // A mode a plugin fills carries the plugin's name, so it is never mistaken
  // for the host's own (#13809).
  const editPluginName = pluginEditor?.pluginName ?? null;
  const renderedPluginName = !isRenderable ? (pluginViewer?.pluginName ?? null) : null;
  const toggleOptions = useMemo(
    () =>
      availableModes.map((mode) => {
        const pluginName =
          mode === "edit" ? editPluginName : mode === "rendered" ? renderedPluginName : null;
        return {
          value: mode,
          label: pluginName ? `${MODE_LABELS[mode]} · ${pluginName}` : MODE_LABELS[mode],
        };
      }),
    [availableModes, editPluginName, renderedPluginName]
  );

  // A dialog host sizes to its content every frame, so swapping markdown source
  // for the rendered chunk's skeleton collapses the dialog and expands it again
  // once the document lands. Pin the source height before the swap; the
  // rendered document releases it on its first commit (#11255). Measured here,
  // synchronously, because a layout effect only runs once the box has already
  // shrunk. Only this direction can collapse — source renders at its own height
  // immediately, so the reverse just drops any stale pin.
  const handleViewModeChange = useCallback(
    (mode: FileViewMode) => {
      // Diff collapses the same way: it swaps the document for an async
      // skeleton. Its first content commit is the release signal, in place of
      // the rendered document's onRendered.
      const collapsesOnEntry = mode === "diff" || (mode === "rendered" && isMarkdown);
      if (location === "dialog" && viewMode === "source" && collapsesOnEntry) {
        heightHold.hold();
      } else {
        heightHold.cancel();
      }
      setFileViewMode(id, mode);
    },
    [location, isMarkdown, viewMode, heightHold, setFileViewMode, id]
  );

  // A file swapped underneath an active pin would hold the new document at the
  // old one's height, and a pane promoted out of the dialog would carry a
  // content-sized floor into a layout-sized host.
  useEffect(() => {
    heightHold.cancel();
  }, [filePath, location, heightHold]);

  // Only fetch while Diff is the live mode; a null subject also invalidates any
  // response still in flight from a mode the user has since left.
  const diffSubject = useMemo<DiffSubject | null>(
    () =>
      viewMode === "diff" && diffWorktreePath && relativeFilePath && localChangeStatus !== undefined
        ? {
            source: "working-tree",
            worktreePath: diffWorktreePath,
            filePath: relativeFilePath,
            status: localChangeStatus,
          }
        : null,
    [viewMode, diffWorktreePath, relativeFilePath, localChangeStatus]
  );
  // No `nextSubject`: there's no file to step to from a single-file viewer.
  const { content: diffContent, stale: diffStale, retry: retryDiff } = useDiffContent(diffSubject);

  // The diff has no onRendered of its own; its first content commit (including
  // the ERROR sentinel) is the equivalent signal for releasing a dialog pin.
  useEffect(() => {
    if (viewMode === "diff" && diffContent !== undefined) heightHold.handleRendered();
  }, [viewMode, diffContent, heightHold]);

  // The live signal for a file no worktree contains: a scratch folder, a
  // worktree-less project, a path picked from anywhere else on disk. Polled
  // from main rather than watched, and only while this view is visible, so the
  // cost is one stat every couple of seconds per visible pane (#11590). Rooted
  // at the same path the pane reads through, which for a file outside every
  // project is its own parent directory.
  const watchedPaths = useMemo(() => (filePath ? [filePath] : NO_WATCHED_PATHS), [filePath]);
  const externalChangeTick = useExternalChangeTick(
    effectiveRootPath,
    watchedPaths,
    Boolean(filePath) && !diffWorktreePath
  );

  // One tick contract for the effect below, whichever side supplied it. The
  // worktree store stays authoritative wherever it has an answer — its tick
  // rides the host's recursive watcher, which is finer and cheaper than a poll,
  // so the external signal only ever fills the gap where there is no worktree.
  const changeTick = worktreeChangeTick ?? externalChangeTick;

  const markdownViewerRef = useRef<MarkdownViewerHandle>(null);
  const codeViewerRef = useRef<CodeViewerHandle>(null);

  useEffect(() => {
    loadFile("explicit");
  }, [loadFile]);

  const { refreshing, handleToolbarRefresh } = useFileRefresh({
    panelId: id,
    location,
    isFocused,
    filePath,
    effectiveRootPath,
    diffWorktreePath,
    relativeFilePath,
    isMarkdown,
    viewMode,
    changeTick,
    worktreeChangeTick,
    gitChangeTick,
    changedDirs,
    loadState,
    errorCode,
    canonicalFilePath,
    loadFile,
    diffSubject,
    diffContent,
    retryDiff,
  });

  const remoteFile = useRemoteFileContext();

  // Route Cmd+F to the source view's find bar while this pane is focused
  // (no-op in rendered markdown, matching the dialog).
  useEffect(() => {
    if (!isFocused) return;
    const handleFindInPanel = () => {
      markdownViewerRef.current?.openSearch();
      codeViewerRef.current?.openSearch();
    };
    window.addEventListener("daintree:find-in-panel", handleFindInPanel);
    return () => window.removeEventListener("daintree:find-in-panel", handleFindInPanel);
  }, [isFocused]);

  // Rendered HTML opens in the browser; every other view opens in the editor.
  // Reveal is a third, always-present target that sits alongside this one.
  const openTarget: "browser" | "editor" = isHtml && viewMode === "rendered" ? "browser" : "editor";

  const externalOpen = useFileExternalOpen({
    panelId: id,
    filePath,
    relativeFilePath,
    revealWorktreeId,
  });
  const { handleOpenExternal } = externalOpen;

  // A browser here can't open a page on an ssh host: a copy saved here stands in for it.
  const savesPageInstead = openTarget === "browser" && remoteFile?.saveTarget != null;
  const runOpenTarget = () => {
    if (savesPageInstead) {
      if (filePath) void saveHostFile(filePath);
      return;
    }
    void handleOpenExternal(openTarget);
  };

  const pickerRoot = worktreePath || projectPath;

  const fileName = filePath ? filePath.split(/[/\\]/).filter(Boolean).pop() : undefined;
  // A user-locked rename outranks the derived file name (title layering: the
  // user rung always wins); otherwise the file name is the live title.
  const displayTitle = panel?.titleMode === "user" ? title : (fileName ?? title);
  const displayPath =
    filePath && isUnderRoot(filePath, pickerRoot)
      ? toForwardSlashes(filePath).slice(toForwardSlashes(pickerRoot).replace(/\/$/, "").length + 1)
      : filePath && toForwardSlashes(filePath);
  const reveal = revealCopy();

  // Leaving Edit unmounts the editor, and with it whatever had keyboard focus;
  // the mode toggle is the control the user is conceptually holding, so focus
  // lands on its active segment rather than falling to <body> (#12323).
  const modeToggleRef = useRef<HTMLDivElement>(null);
  const wasEditModeRef = useRef(viewMode === "edit");
  // The HTML fallback's View source button unmounts with the view it leaves,
  // so it hands off the same way; ringed only when it was keyboard-activated.
  const sourceFocusRef = useRef<{ focusVisible: boolean } | null>(null);
  useEffect(() => {
    // Only when the editor's unmount actually dropped focus: a mode that
    // vanished under a pane nobody was typing in (the plugin toggled off, a
    // background reload) must not pull focus across the window.
    const focusLost = document.activeElement === null || document.activeElement === document.body;
    const sourceFocus = sourceFocusRef.current;
    sourceFocusRef.current = null;
    if (((wasEditModeRef.current && viewMode !== "edit") || sourceFocus) && focusLost) {
      const toggle = modeToggleRef.current;
      const active =
        toggle?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]') ??
        toggle?.querySelector<HTMLButtonElement>("button");
      active?.focus({ preventScroll: true, focusVisible: sourceFocus?.focusVisible });
    }
    wasEditModeRef.current = viewMode === "edit";
  }, [viewMode]);

  // Answering about a default is about this file too: "Use Daintree's" leaves
  // the default's editor for Source here, not only in panels opened next, and
  // the effect above then hands focus to the toggle. Either way the notice is
  // gone, so focus that fell with it lands on the toggle.
  const handleDefaultAnswered = (choice: ProjectSurfaceChoice) => {
    if (
      choice === "stock" &&
      viewMode === "edit" &&
      fileDefault !== null &&
      pluginEditor?.choiceId === fileDefault.choiceId
    ) {
      handleViewModeChange("source");
      return;
    }
    if (document.activeElement === null || document.activeElement === document.body) {
      modeToggleRef.current
        ?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')
        ?.focus({ preventScroll: true });
    }
  };

  // The dirty mark in the panel chrome, shown in every mode while a draft
  // exists. A conflict is the same dot with a different name: it says the
  // draft is standing on a file that moved, which is the one fact the chrome
  // should carry — the editor's banner carries the rest.
  const dirtyIndicator = isDirty ? (
    <span
      role="img"
      aria-label={hasConflict ? "Unsaved changes, file changed on disk" : "Unsaved changes"}
      title={hasConflict ? "Unsaved changes — file changed on disk" : "Unsaved changes"}
      data-testid="file-pane-dirty"
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-text-secondary"
    />
  ) : undefined;

  const copyableContents = loadState === "loaded" ? content : null;
  const toolbar = filePath ? (
    <FilePaneToolbar
      panelId={id}
      filePath={filePath}
      fileName={fileName}
      displayPath={displayPath || ""}
      isMarkdown={isMarkdown}
      viewMode={viewMode}
      toggleOptions={toggleOptions}
      modeToggleRef={modeToggleRef}
      onViewModeChange={handleViewModeChange}
      editorPicker={editorPicker}
      pinnedEditor={pinnedEditor}
      setEditorChoice={setEditorChoice}
      effectiveDiffWrapLines={effectiveDiffWrapLines}
      refreshing={refreshing}
      onRefresh={handleToolbarRefresh}
      copyableContents={copyableContents}
      revealWorktreeId={revealWorktreeId}
      reveal={reveal}
      openTarget={openTarget}
      savesPageInstead={savesPageInstead}
      onRunOpenTarget={runOpenTarget}
      externalOpen={externalOpen}
      defaultNoticeSlot={
        fileDefault !== null &&
        fileDefault.choice === null &&
        editOptions.includes(fileDefault.choiceId)
          ? fileDefault.slot
          : null
      }
      onDefaultAnswered={handleDefaultAnswered}
      editorBannerContent={
        location !== "dialog" &&
        isInsideGovernedRoot &&
        editLockedBy === null &&
        viewMode !== "edit" &&
        loadState === "loaded"
          ? content
          : null
      }
      showDiffStale={viewMode === "diff" && diffStale && diffContent !== undefined}
      onRetryDiff={retryDiff}
    />
  ) : undefined;

  // The file's menu on its content (#13423) — the shared file-row core, scoped
  // by containment like the diff and the reveal, never by the panel's stamped
  // worktree. CopyTree source omitted: the run-source enum has no entry for
  // this panel, and borrowing the nearest one would misfile its history.
  const { renderItems: renderFileMenuItems } = useFileRowMenuItems({
    worktreePath: diffWorktreePath,
    worktreeId: revealWorktreeId || null,
  });
  const fileMenuItems = filePath ? (
    <>
      {/* The pane's own prefix: the route back to the tree, offered under the
          same condition as the toolbar's button. */}
      {revealWorktreeId && (
        <>
          <ContextMenuItem onSelect={() => void handleOpenExternal("file-browser")}>
            <FolderTree className="w-3.5 h-3.5 mr-2" />
            Show in file browser
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      {renderFileMenuItems(
        {
          absolutePath: filePath,
          // Worktree-relative when a worktree contains the file; otherwise the
          // project-relative path the header shows, so the copy still names
          // something shorter than the absolute path.
          relativePath: relativeFilePath || displayPath || filePath,
          name: fileName ?? filePath,
          isDirectory: false,
          status: localChangeStatus ?? null,
        },
        {
          hasChanges: localChangeStatus !== undefined,
          // This pane's own Diff mode, the same one the toggle switches to,
          // rather than a second diff panel.
          onOpenDiff: () => handleViewModeChange("diff"),
          // The toolbar's reveal: it takes the guarded fallback for a file
          // outside every project root, which this pane deliberately displays.
          onReveal: () => void handleOpenExternal("reveal"),
          // The text already on screen, as the toolbar copies it — `file.read`
          // would refuse a file outside every project root. Unset while
          // nothing is loaded, leaving the shared read to answer.
          ...(copyableContents !== null && {
            onCopyFileContents: () => copyWithToast("File contents", copyableContents),
          }),
        }
      )}
    </>
  ) : null;

  return (
    <ContentPanel
      id={id}
      title={displayTitle}
      kind="file"
      isFocused={isFocused}
      isMaximized={isMaximized}
      location={location}
      isMultiPanelGrid={isMultiPanelGrid}
      onFocus={onFocus}
      onClose={onClose}
      onToggleMaximize={onToggleMaximize}
      onTitleChange={onTitleChange}
      onMinimize={onMinimize}
      onRestore={onRestore}
      showRestoreControl={showRestoreControl}
      toolbar={toolbar}
      headerContent={dirtyIndicator}
      tabs={tabs}
      onTabClick={onTabClick}
      onTabClose={onTabClose}
      onTabRename={onTabRename}
      onAddTab={onAddTab}
    >
      <FileContentContextMenu items={fileMenuItems}>
        <div
          ref={heightHold.bodyRef}
          className={`flex-1 min-h-0 overflow-auto bg-surface-canvas${
            viewMode === "diff" ? " diff-scroll-root" : ""
          }`}
          data-testid="file-pane-body"
        >
          {/* Ahead of every load-state branch on purpose: a deleted file fails
            files.read, and images/binaries never load as text, yet their diff is
            exactly what the user asked to see. */}
          {filePath && viewMode === "diff" && (
            <Suspense fallback={<DiffLoadingSkeleton />}>
              {diffContent === undefined ? (
                <DiffLoadingSkeleton />
              ) : (
                <LazyDiffViewer
                  diff={diffContent}
                  viewType={diffViewType}
                  // The diff's paths are relative to the worktree the file
                  // physically lives in, not the one the panel is stamped with,
                  // so open-in-editor has to join against the same root the
                  // relative paths were derived from.
                  rootPath={diffWorktreePath}
                  wrapLines={effectiveDiffWrapLines}
                  onRetry={retryDiff}
                />
              )}
            </Suspense>
          )}

          {!filePath && (
            // Auto margins on the end children rather than `justify-center`:
            // `h-full` pins this box to the scrollport, and centred overflow
            // spills at BOTH ends, so the empty state's icon and title become
            // unreachable in a short pane once the result list fills. Auto
            // margins split the free space the same way and collapse to zero when
            // there is none. Same fix as `ContentGridEmptyState`.
            //
            // A size container, because a short pane is the case that matters:
            // there the introduction gives its height to the results rather than
            // pushing them below the fold.
            <div className="flex h-full w-full flex-col items-center gap-4 p-6 [container-type:size] [container-name:file-picker] [&>*:first-child]:mt-auto [&>*:last-child]:mb-auto">
              <EmptyState
                className="[@container_file-picker_(max-height:22.5rem)]:hidden"
                variant="zero-data"
                scale="canvas"
                icon={<FileText className="h-6 w-6" />}
                title="Open a file"
                description={
                  pickerRoot
                    ? "Search the project's files, or click a file path in any terminal."
                    : "Open a project, then search its files here."
                }
              />
              {pickerRoot && (
                <FilePanePicker
                  rootPath={pickerRoot}
                  onOpen={(absolutePath) => setFilePanelPath(id, absolutePath)}
                />
              )}
            </div>
          )}

          {filePath &&
            !showPluginViewer &&
            viewMode !== "diff" &&
            viewMode !== "edit" &&
            loadState === "loading" && (
              <div className="p-4 space-y-3">
                <Skeleton label="Loading file">
                  <SkeletonBone className="h-5 w-1/3" />
                  <SkeletonText lines={12} />
                </Skeleton>
              </div>
            )}

          {filePath &&
            !showPluginViewer &&
            viewMode !== "diff" &&
            viewMode !== "edit" &&
            loadState === "error" &&
            errorCode && (
              <FilePaneUnavailable
                errorCode={errorCode}
                errorMessage={errorMessage}
                filePath={filePath}
                fileName={fileName ?? filePath}
                revealLabel={reveal.label}
                openTarget={openTarget}
                canOpenInDefaultApp={isInsideGovernedRoot}
                remote={remoteFile}
                onRetry={() => loadFile("explicit")}
                onExternal={(target) => void handleOpenExternal(target)}
              />
            )}

          {filePath &&
            !showPluginViewer &&
            viewMode !== "diff" &&
            (loadState === "image" || loadState === "svg") && (
              <FileImagePreview
                filePath={filePath}
                rootPath={effectiveRootPath}
                alt={fileName ?? filePath}
                sanitizedSvg={loadState === "svg" ? sanitizedSvg : null}
                cacheBust={String(reloadNonce)}
                onError={(error) => {
                  failPreview(previewErrorCode(error, "NOT_FOUND"));
                }}
                maxHeightClassName="max-h-full"
              />
            )}

          {filePath && !showPluginViewer && viewMode !== "diff" && loadState === "video" && (
            <FileVideoPreview
              filePath={filePath}
              rootPath={effectiveRootPath}
              label={fileName ?? filePath}
              reloadKey={reloadNonce}
              onPlayingChange={handleMediaPlayingChange}
              onError={(error) => {
                // An allowlisted container can still hold a codec Chromium lacks;
                // name that instead of implying the file is missing.
                failPreview(
                  previewErrorCode(error, "BINARY_FILE"),
                  error?.title ?? "This video couldn't be played"
                );
              }}
              maxHeightClassName="max-h-full"
            />
          )}

          {filePath && !showPluginViewer && viewMode !== "diff" && loadState === "audio" && (
            <FileAudioPreview
              filePath={filePath}
              rootPath={effectiveRootPath}
              label={fileName ?? filePath}
              reloadKey={reloadNonce}
              onPlayingChange={handleMediaPlayingChange}
              onError={(error) => {
                // An allowlisted extension can still hold a codec Chromium lacks;
                // name that instead of implying the file is missing.
                failPreview(
                  previewErrorCode(error, "BINARY_FILE"),
                  error?.title ?? "This audio file couldn't be played"
                );
              }}
            />
          )}

          {filePath && !showPluginViewer && viewMode !== "diff" && loadState === "pdf" && (
            <FilePdfPreview
              filePath={filePath}
              rootPath={effectiveRootPath}
              label={fileName ?? filePath}
              reloadKey={reloadNonce}
              onError={(error) => {
                failPreview(previewErrorCode(error, "BINARY_FILE"), error.title);
              }}
            />
          )}

          {filePath && viewMode === "edit" && pluginEditor && (
            <Suspense fallback={<EditorLoadingSkeleton />}>
              <LazyPluginFileEditorHost
                key={`${pluginEditor.choiceId}\u0000${filePath}`}
                panelId={id}
                projectId={projectId}
                filePath={filePath}
                fileName={fileName ?? filePath}
                rootPath={effectiveRootPath}
                candidate={pluginEditor}
                changeTick={changeTick}
              />
            </Suspense>
          )}

          {filePath && showPluginViewer && pluginViewer && (
            <Suspense fallback={<EditorLoadingSkeleton />}>
              <LazyPluginFileEditorHost
                key={`${pluginViewer.choiceId}\u0000${filePath}`}
                panelId={id}
                projectId={projectId}
                filePath={filePath}
                fileName={fileName ?? filePath}
                rootPath={effectiveRootPath}
                candidate={pluginViewer}
                changeTick={changeTick}
              />
            </Suspense>
          )}

          {filePath && viewMode === "edit" && builtinEditor && (
            <Suspense fallback={<EditorLoadingSkeleton />}>
              <builtinEditor.Component
                panelId={id}
                filePath={filePath}
                fileName={fileName ?? filePath}
                rootPath={effectiveRootPath}
                // The worktree that physically contains the file, by containment,
                // not the one the panel is stamped with (see diffWorktreePath).
                worktreePath={diffWorktreePath || null}
                projectId={projectId}
                wrapLines={markdownWrapLines}
                isFocused={isFocused}
                changeTick={changeTick}
                onOpenExternalEditor={() => void handleOpenExternal("editor")}
              />
            </Suspense>
          )}

          {filePath &&
            viewMode !== "diff" &&
            viewMode !== "edit" &&
            !showPluginViewer &&
            loadState === "loaded" &&
            content !== null &&
            (viewMode === "rendered" && isMarkdown ? (
              <MarkdownViewer
                ref={markdownViewerRef}
                // The draft is document state, so Rendered previews it while one
                // exists and the disk text otherwise (#12323).
                content={draftText ?? content}
                filePath={filePath}
                rootPath={effectiveRootPath}
                viewMode="rendered"
                wrapLines={markdownWrapLines}
                fontSize={markdownFontSize}
                cacheBust={String(reloadNonce)}
                onRendered={heightHold.handleRendered}
              />
            ) : viewMode === "rendered" && isHtml ? (
              // Rendered HTML fills the pane in a sandboxed iframe rather than the
              // min-h-full source column; the frame owns its own scrolling.
              <HtmlViewer
                previewUrl={htmlPreviewUrl}
                reloadNonce={reloadNonce}
                title={fileName ?? "HTML preview"}
                onShowSource={(event) => {
                  sourceFocusRef.current = { focusVisible: event.detail === 0 };
                  handleViewModeChange("source");
                }}
                className="min-h-full"
              />
            ) : (
              // min-h-full column (mirrors FileViewerModal): the editor surface
              // stretches to the bottom of the pane even for files shorter than it.
              <div className="flex min-h-full flex-col">
                {/* Source mode always carries the metadata bar, markdown included —
                  it describes the bytes on disk, which is exactly what source
                  mode shows. Rendered mode omits it (the document is the view). */}
                <FileSourceMetadataStrip
                  content={content}
                  filePath={filePath}
                  encoding={byteFacts.encoding}
                  byteLength={byteFacts.byteLength}
                />
                {isMarkdown ? (
                  <MarkdownViewer
                    ref={markdownViewerRef}
                    content={sourceText ?? content}
                    filePath={filePath}
                    rootPath={effectiveRootPath}
                    viewMode="source"
                    initialLine={panel?.initialLine}
                    wrapLines={markdownWrapLines}
                    className="flex-1"
                  />
                ) : (
                  <CodeViewer
                    ref={codeViewerRef}
                    content={sourceText ?? content}
                    filePath={filePath}
                    initialLine={panel?.initialLine}
                    className="flex-1"
                  />
                )}
              </div>
            ))}
        </div>
      </FileContentContextMenu>
    </ContentPanel>
  );
}
