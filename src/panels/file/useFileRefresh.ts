import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileViewMode } from "@shared/types/panel";
import type { BasePanelProps } from "@/components/Panel/ContentPanel";
import type { WorktreeChangedDirs } from "@/store/createWorktreeStore";
import type { DiffSubject } from "@/panels/diff/diffContentCache";
import { usePanelStore } from "@/store/panelStore";
import { useFileChangeCount } from "@/hooks/useFileChangeCount";
import { useProjectViewRevealed } from "@/hooks/useProjectViewRevealed";
import { useRetryOnControl } from "@/components/FileViewer/hostFileActions";
import type { FileLoadIntent, FilePaneErrorCode, LoadState } from "./useFileLoad";

/**
 * Every moment the pane re-reads its file without a new identity: the toolbar's
 * Refresh, control returning to this window, leaving Diff, a worktree or
 * filesystem tick that could have touched the file, focus regain, and coming
 * back to this project. Each one picks the load intent that sets its policy.
 */
export function useFileRefresh({
  panelId,
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
}: {
  panelId: string;
  location: BasePanelProps["location"];
  isFocused: boolean;
  filePath: string | undefined;
  effectiveRootPath: string;
  diffWorktreePath: string;
  relativeFilePath: string;
  isMarkdown: boolean;
  viewMode: FileViewMode;
  changeTick: number | undefined;
  worktreeChangeTick: number | undefined;
  gitChangeTick: number | undefined;
  changedDirs: WorktreeChangedDirs | undefined;
  loadState: LoadState;
  errorCode: FilePaneErrorCode | null;
  canonicalFilePath: string | null;
  loadFile: (intent: FileLoadIntent) => void;
  diffSubject: DiffSubject | null;
  diffContent: unknown;
  retryDiff: () => void;
}): { refreshing: boolean; handleToolbarRefresh: () => void } {
  // A preview the host refused to a watching window loads once this one has control.
  useRetryOnControl(loadState === "error" && errorCode === "DRIVEN_ELSEWHERE", () =>
    loadFile("explicit")
  );

  // Which surface a toolbar Refresh press is currently spinning for (or null).
  // The mode is captured at click so a mode switch mid-refresh doesn't settle
  // the spin against the wrong signal. Drives the shared SpinningIcon.
  const [refreshingMode, setRefreshingMode] = useState<FileViewMode | null>(null);

  // Toolbar Refresh: spin the icon until the refreshed surface settles. Capture
  // the mode at press time so switching source⇄diff mid-refresh can't clear the
  // spin against the wrong signal. A synchronous branch (image/svg, or an
  // already-loaded diff) settles the same tick — SpinningIcon still guarantees a
  // full rotation from the single active render.
  const handleToolbarRefresh = useCallback(() => {
    setRefreshingMode(viewMode);
    if (viewMode === "diff") retryDiff();
    else loadFile("explicit");
  }, [viewMode, retryDiff, loadFile]);

  useEffect(() => {
    if (refreshingMode === null) return;
    // The refreshed surface is no longer on screen (mode switched, or diff mode
    // clamped away when the change vanished) → the spin is moot, disarm it. This
    // also covers an abandoned diff: `diffSubject` going null leaves diffContent
    // `undefined` forever, which would otherwise strand the spin on "diff".
    const settled =
      refreshingMode !== viewMode ||
      (refreshingMode === "diff"
        ? diffSubject === null || diffContent !== undefined
        : loadState !== "loading");
    if (settled) setRefreshingMode(null);
  }, [refreshingMode, viewMode, diffSubject, diffContent, loadState]);

  // Leaving Diff — by choice or because the change vanished — lands on source
  // cached before the edit that prompted the diff in the first place. Re-read it
  // silently, so a file deleted mid-view can't keep reading as present.
  const wasDiffModeRef = useRef(viewMode === "diff");
  useEffect(() => {
    if (wasDiffModeRef.current && viewMode !== "diff") loadFile("ambient");
    wasDiffModeRef.current = viewMode === "diff";
  }, [viewMode, loadFile]);

  // Agents rewrite files while the user watches, and the pane stays focused the
  // whole time — so focus regain alone can't be the only live signal. Re-read
  // silently whenever the containing worktree reports a change.
  //
  // Identity travels with the tick so only a genuine disk write triggers this: a
  // path or root switch changes the tick too, but already has its own explicit
  // load, and firing here as well would read the same file twice.
  //
  // And only a tick that could have touched this file: every write anywhere in
  // the worktree moves the tick, so without the changed-directory check each
  // open pane re-reads on all of them. A failed read keeps taking every tick —
  // that is how one that raced a half-written file recovers.
  const fileChangeCount = useFileChangeCount(
    changeTick,
    useMemo(
      () => ({ tick: worktreeChangeTick, gitTick: gitChangeTick, changedDirs }),
      [worktreeChangeTick, gitChangeTick, changedDirs]
    ),
    relativeFilePath || null,
    // Markdown opts out for the same reason it opts out of the bytes-changed
    // gate: an embedded image elsewhere in the worktree is the change, and only
    // a read bumps the cache token that refetches it.
    !isMarkdown &&
      canonicalFilePath !== null &&
      canonicalFilePath === filePath &&
      loadState !== "error"
  );
  const lastChangeSignalRef = useRef({
    filePath,
    readRoot: effectiveRootPath,
    watchRoot: diffWorktreePath,
    tick: fileChangeCount,
    viewMode,
  });
  useEffect(() => {
    const previous = lastChangeSignalRef.current;
    lastChangeSignalRef.current = {
      filePath,
      readRoot: effectiveRootPath,
      watchRoot: diffWorktreePath,
      tick: fileChangeCount,
      viewMode,
    };
    // Diff owns its own freshness — useDiffContent subscribes to the same store
    // and raises a stale banner — and leaving Diff already re-reads source, so a
    // tick on either side of that transition would only duplicate the work.
    if (viewMode === "diff" || previous.viewMode === "diff") return;
    // No `diffWorktreePath` requirement: a file outside every worktree now has
    // a tick of its own, and demanding a containing worktree here is exactly
    // what left those files frozen at whatever they read when opened (#11590).
    if (!filePath || changeTick === undefined) return;
    // What the pane reads, versus what it watches. Only a change to the former
    // implies an explicit load already happened — `loadFile` is keyed on those
    // two alone, so acquiring a watcher moves `watchRoot` while leaving the read
    // identity untouched, and nothing else would re-read.
    if (previous.filePath !== filePath || previous.readRoot !== effectiveRootPath) return;
    // A newly resolved worktree counts as a signal in its own right: whatever
    // happened to the file before anything was watching it is exactly what the
    // pane cannot otherwise know about.
    if (previous.watchRoot === diffWorktreePath && previous.tick === fileChangeCount) return;
    loadFile("ambient");
  }, [
    filePath,
    effectiveRootPath,
    diffWorktreePath,
    changeTick,
    fileChangeCount,
    viewMode,
    loadFile,
  ]);

  // Which surfaces a background re-read may replace. Images and inlined SVG join
  // "loaded" because both are cheap to re-request and show nothing but the file.
  // Video, audio and PDF are deliberately absent: their reload key only moves on
  // an explicit load, so a silent pass here would be inert for them anyway, and
  // widening it would reset playback or a reader's page on an unrelated write.
  const reloadsSilently = loadState === "loaded" || loadState === "image" || loadState === "svg";

  // Focus regain also retries a failure. A background re-read that raced a
  // half-written file lands on an error the ticks can no longer clear — the one
  // that reported the last write of a burst is the one that failed — so without
  // this the pane sits on "File not found" for a file that exists until someone
  // presses Refresh. A file that is genuinely gone just re-errors immediately
  // through the permanent-code branch.
  const refetchesOnFocus = reloadsSilently || loadState === "error";

  // Still worth re-reading on focus regain: a write that landed while no watcher
  // covered the file (opened outside every known worktree) has no tick at all.
  const wasFocusedRef = useRef(isFocused);
  useEffect(() => {
    if (isFocused && !wasFocusedRef.current && refetchesOnFocus) {
      loadFile("ambient");
    }
    wasFocusedRef.current = isFocused;
  }, [isFocused, refetchesOnFocus, loadFile]);

  useEffect(() => {
    if (!refetchesOnFocus) return;
    const handleWindowFocus = () => loadFile("ambient");
    window.addEventListener("focus", handleWindowFocus);
    return () => window.removeEventListener("focus", handleWindowFocus);
  }, [refetchesOnFocus, loadFile]);

  // Coming back to a project the user left is the one moment nothing else
  // covers. A view swap is not a page load and produces no window focus event,
  // and `document.visibilityState` never moved — a cached child WebContentsView
  // reports "visible" the whole time it is away (`viewCacheState`). So the
  // worktree tick is the only live signal, and it deliberately cannot reach
  // video, audio or PDF: their reload key stays put on an ambient pass so an
  // unrelated write can't reset playback or a reader's page. Those are exactly
  // the surfaces that come back stale.
  //
  // Deliberately its own trigger rather than a branch of the change-tick effect
  // above: that one is gated on read-versus-watch root identity, which a reveal
  // has no opinion about, and folding this in would let a watch-root quirk
  // swallow it.
  //
  // No `reloadsSilently` gate either — that predicate exists to skip surfaces a
  // background re-read would be inert for, which is the opposite of what this
  // needs. Diff is skipped though: it owns its own freshness (`useDiffContent`
  // raises a stale banner) and leaving it already re-reads source, so re-reading
  // here would only replace review content nobody asked to move.
  const isDockParked = usePanelStore(
    useCallback(
      (state) => location === "dock" && state.activeDockTerminalId !== panelId,
      [location, panelId]
    )
  );
  useProjectViewRevealed(
    () => {
      if (viewMode !== "diff") loadFile("revealed");
    },
    { enabled: !isDockParked }
  );

  return { refreshing: refreshingMode !== null, handleToolbarRefresh };
}
