import { useEffect, useEffectEvent, useCallback, useState, useRef, useMemo } from "react";
import type { CSSProperties } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import type { RestoreFocusTarget } from "@/components/ui/AppDialog";
import { DiffViewer } from "@/components/Worktree/DiffViewer";
import { CodeViewer } from "./CodeViewer";
import type { CodeViewerHandle } from "./CodeViewer";
import { MarkdownViewer } from "@/components/Markdown/MarkdownViewer";
import { isMarkdownFilePath } from "@/components/Markdown/isMarkdownFile";
import { FILE_READ_ERROR_MESSAGES } from "./fileReadErrors";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { filesClient } from "@/clients/filesClient";
import { actionService } from "@/services/ActionService";
import {
  ExternalLink,
  Copy,
  Check,
  Image as ImageIcon,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Grid2x2Plus,
  PanelLeft,
  Pilcrow,
  Search,
  WrapText,
  X,
} from "lucide-react";
import { DiffFileSidebar } from "./DiffFileSidebar";
import type { DiffChangeSetEntry } from "./diffChangeSet";
import { useDiffViewedStore, selectViewedSet } from "@/store/diffViewedStore";
import { ImageDiffViewer, isImageDiffCandidate } from "./ImageDiffViewer";
import { Skeleton, SkeletonBone, SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/formatBytes";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FileReadErrorCode } from "@shared/types/ipc/files";
import type { GitStatus } from "@shared/types";
import { isClientAppError } from "@/utils/clientAppError";
import { sanitizeSvg } from "@shared/utils/svgSanitizer";
import { createTrustedHTML } from "@/lib/trustedTypesPolicy";
import { logError } from "@/utils/logger";
import { usePreferencesStore } from "@/store/preferencesStore";
import type { DiffFontSize, DiffViewType } from "@/store/preferencesStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";

export interface FileViewerModalProps {
  isOpen: boolean;
  filePath: string;
  rootPath: string;
  branch?: string;
  initialLine?: number;
  initialCol?: number;
  diff?: string;
  defaultMode?: "view" | "diff";
  /**
   * True when the diff's new side is the working-tree file this modal loads
   * (single-file working-tree diffs). Enables expand-context between hunks.
   */
  diffMatchesFile?: boolean;
  onRetryDiff?: () => void;
  onClose: () => void;
  /** Element to focus when the dialog closes and its trigger was unmounted. */
  restoreFocusTo?: RestoreFocusTarget;
  /** Zero-based position of the current file within the navigable set. */
  currentFileIndex?: number;
  /** Total number of files the user can step through. */
  totalFileCount?: number;
  /** Step to the previous (-1) or next (1) file in the set. */
  onNavigateFile?: (delta: -1 | 1) => void;
  /**
   * Full changeset this file belongs to, indexed identically to
   * `currentFileIndex`/`onSelectFile`. With more than one entry the modal
   * becomes a review workspace: changed-files sidebar, viewed markers, and
   * cross-file change navigation.
   */
  changeSet?: DiffChangeSetEntry[];
  /** Jump directly to a file in `changeSet`. */
  onSelectFile?: (index: number) => void;
  /**
   * Git status of the open file, when the opener knows it. Enables the image
   * compare view (HEAD vs working tree) for changed image files.
   */
  fileStatus?: GitStatus;
}

type ViewMode = "view" | "diff" | "rendered";

const DIFF_FONT_SIZE_PX: Record<DiffFontSize, string> = { s: "11px", m: "12px", l: "14px" };
const DIFF_FONT_SIZE_ORDER: DiffFontSize[] = ["s", "m", "l"];
const DIFF_FONT_SIZE_LABEL: Record<DiffFontSize, string> = {
  s: "Small",
  m: "Medium",
  l: "Large",
};
type LoadState = "loading" | "loaded" | "error" | "image" | "svg";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);
const SVG_EXTENSION = "svg";
const COPY_FEEDBACK_MS = 2000;

function isImageFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext) || ext === SVG_EXTENSION;
}

function isSvgFile(filePath: string): boolean {
  return filePath.split(".").pop()?.toLowerCase() === SVG_EXTENSION;
}

function buildDaintreeFileUrl(filePath: string, rootPath: string): string {
  return `daintree-file://load?path=${encodeURIComponent(filePath)}&root=${encodeURIComponent(rootPath)}`;
}

function IconToggle({
  pressed,
  label,
  onToggle,
  children,
}: {
  pressed: boolean;
  label: string;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={pressed}
          aria-label={label}
          className={cn(
            "p-1.5 rounded transition-colors",
            pressed
              ? "bg-daintree-border text-daintree-text"
              : "text-muted-foreground hover:text-daintree-text hover:bg-daintree-border"
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Horizontal reveal for search matches in the centered split view. Code cells
 * there are overflow: clip — deliberately unscrollable, so scrollIntoView's
 * inline axis can't desync one row from the shared offset. The reveal instead
 * rides the file's scrollbar strip, whose scrollLeft shifts every row in
 * lockstep. No-op outside centered split (unified/wrap scroll natively).
 */
function revealMatchInCenteredSplit(match: HTMLElement): void {
  const region = match.closest<HTMLElement>(".diff-file-centered");
  const cell = match.closest<HTMLElement>("td.diff-code");
  const bar = region?.querySelector<HTMLElement>(".diff-hscrollbar");
  if (!region || !cell || !bar) return;
  const cellRect = cell.getBoundingClientRect();
  const matchRect = match.getBoundingClientRect();
  if (cellRect.width <= 0) return;
  const fullyVisible = matchRect.left >= cellRect.left && matchRect.right <= cellRect.right;
  if (fullyVisible) return;
  // Column offset of the match within its unshifted line, then aim the shared
  // offset so the match lands a third of the way into the pane.
  const columnPx = matchRect.left - cellRect.left + bar.scrollLeft;
  const target = Math.max(0, columnPx - cellRect.width / 3);
  bar.scrollLeft = Math.min(target, bar.scrollWidth - bar.clientWidth);
}

export function FileViewerModal({
  isOpen,
  filePath,
  rootPath,
  branch,
  initialLine,
  initialCol,
  diff,
  defaultMode,
  diffMatchesFile = false,
  onRetryDiff,
  onClose,
  restoreFocusTo,
  currentFileIndex,
  totalFileCount,
  onNavigateFile,
  changeSet,
  onSelectFile,
  fileStatus,
}: FileViewerModalProps) {
  // If the file is outside the project root, use its parent directory as the
  // effective root so that the daintree-file:// protocol and files.read IPC
  // containment checks pass.
  const fwd = (p: string) => p.replace(/\\/g, "/");
  const fwdRoot = fwd(rootPath).replace(/\/$/, "") + "/";
  const effectiveRootPath = fwd(filePath).startsWith(fwdRoot)
    ? rootPath
    : filePath.substring(0, Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))) || "/";

  const hasDiff = Boolean(diff && diff.trim() && diff !== "NO_CHANGES" && diff !== "ERROR");
  const markdownFile = !isImageFile(filePath) && isMarkdownFilePath(filePath);
  const [mode, setMode] = useState<ViewMode>(() => {
    if (isImageFile(filePath)) return "view";
    if (defaultMode) return defaultMode;
    if (hasDiff && !initialLine) return "diff";
    // Markdown also opens as source; Rendered is an explicit step.
    return "view";
  });
  const [content, setContent] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [errorCode, setErrorCode] = useState<FileReadErrorCode | null>(null);
  // Renderer-local failures (SVG sanitization, image decode) that have no FileReadErrorCode
  const [displayErrorMessage, setDisplayErrorMessage] = useState<string | null>(null);
  const diffViewType = usePreferencesStore((s) => s.diffViewType);
  const setDiffViewType = usePreferencesStore((s) => s.setDiffViewType);
  const diffWrapLines = usePreferencesStore((s) => s.diffWrapLines);
  const setDiffWrapLines = usePreferencesStore((s) => s.setDiffWrapLines);
  const diffIgnoreWhitespace = usePreferencesStore((s) => s.diffIgnoreWhitespace);
  const setDiffIgnoreWhitespace = usePreferencesStore((s) => s.setDiffIgnoreWhitespace);
  const markdownWrapLines = usePreferencesStore((s) => s.markdownWrapLines);
  const setMarkdownWrapLines = usePreferencesStore((s) => s.setMarkdownWrapLines);
  const diffShowFileList = usePreferencesStore((s) => s.diffShowFileList);
  const setDiffShowFileList = usePreferencesStore((s) => s.setDiffShowFileList);
  const diffFontSize = usePreferencesStore((s) => s.diffFontSize);
  const setDiffFontSize = usePreferencesStore((s) => s.setDiffFontSize);
  const [diffCopied, setDiffCopied] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const [sanitizedSvg, setSanitizedSvg] = useState<string | null>(null);
  const requestRef = useRef(0);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const codeViewerRef = useRef<CodeViewerHandle>(null);
  const hasSwitchedToDiffRef = useRef(false);
  const diffViewerRef = useRef<HTMLDivElement>(null);
  // -1 sentinel: "no hunk navigated to yet". First `n` or `p` jumps to hunk 0.
  const currentHunkIndexRef = useRef<number>(-1);
  const [activeHunkIndex, setActiveHunkIndex] = useState<number>(-1);
  const [hunkCount, setHunkCount] = useState<number>(0);
  const [hunkMarkers, setHunkMarkers] = useState<
    { ratio: number; kind: "insert" | "delete" | "mixed" }[]
  >([]);
  // Bumped whenever a file's collapse state is toggled inside DiffViewer, so the
  // hunk-counting effect re-scans the DOM whose hunk rows just appeared (expand)
  // or disappeared (collapse). See #10013.
  const [collapseRevision, setCollapseRevision] = useState(0);
  const hunkRatiosRef = useRef<Map<number, number>>(new Map());
  const observerGenerationRef = useRef(0);
  const observerDisposedRef = useRef(false);

  // In-diff search. Match highlighting happens in DiffViewer's token pass
  // (.diff-search-match spans); this layer owns the find bar, scans the
  // rendered DOM for matches, and steps between them. tokensRevision bumps
  // after every token commit — the signal that the spans are scannable.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatchCount, setSearchMatchCount] = useState(0);
  const [searchMatchIndex, setSearchMatchIndex] = useState(-1);
  const [searchMarkers, setSearchMarkers] = useState<number[]>([]);
  const [tokensRevision, setTokensRevision] = useState(0);
  const searchMatchIndexRef = useRef(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastSearchQueryRef = useRef("");
  const viewportIndicatorRef = useRef<HTMLDivElement>(null);

  const imageFile = isImageFile(filePath);
  const svgFile = isSvgFile(filePath);

  // Worktree-relative path, when the file lives under rootPath. Feeds the
  // breadcrumb title (directory muted, basename strong — the Kaleidoscope
  // path-bar read), the image compare's git lookups, and the workspace-entry
  // identity guard below.
  const workspaceRelPath = useMemo(() => {
    const fwdPath = filePath.replace(/\\/g, "/");
    const fwdRootDir = rootPath.replace(/\\/g, "/").replace(/\/$/, "") + "/";
    return fwdPath.startsWith(fwdRootDir) ? fwdPath.slice(fwdRootDir.length) : null;
  }, [filePath, rootPath]);

  // Review-workspace mode: the opener supplied its full changeset, so the
  // modal grows a changed-files sidebar, viewed markers, and cross-file
  // change navigation. Single-file openers keep the classic layout.
  // Defense in depth on the entry: it must describe the OPEN file — an index
  // that drifted against a refreshed changeset (list re-sorted while the
  // modal is up) must never mark the wrong file's viewedKey.
  const isWorkspace = (changeSet?.length ?? 0) > 1;
  const rawWorkspaceEntry =
    changeSet && currentFileIndex !== undefined ? (changeSet[currentFileIndex] ?? null) : null;
  const workspaceEntry =
    rawWorkspaceEntry &&
    workspaceRelPath !== null &&
    rawWorkspaceEntry.path.replace(/\\/g, "/") === workspaceRelPath
      ? rawWorkspaceEntry
      : null;

  // Changed image files opened from a changeset get the HEAD-vs-working-tree
  // compare (Two-up / Swipe / Onion skin) instead of the static preview.
  // Declared before loadFile, which consults it to skip the working-tree read.
  const imageDiffEligible = Boolean(
    imageFile && fileStatus && workspaceRelPath && isImageDiffCandidate(filePath)
  );
  // Subscribe only to the OPEN file's viewed flag — subscribing to the whole
  // set would re-render the mounted diff tree on every sidebar checklist
  // toggle. markViewedAndAdvance reads the full set imperatively instead.
  const currentViewed = useDiffViewedStore(
    useCallback(
      (state) =>
        workspaceEntry ? selectViewedSet(state, rootPath).has(workspaceEntry.viewedKey) : false,
      [rootPath, workspaceEntry]
    )
  );
  const setViewed = useDiffViewedStore((state) => state.setViewed);
  const toggleViewed = useDiffViewedStore((state) => state.toggleViewed);
  // Cross-file hunk stepping: where to land in the next file once its hunks
  // render. Carries the expected file index (a manual jump elsewhere
  // invalidates the target) and the diff that was on screen when the step
  // was armed (the landing must wait for a different diff to commit).
  const pendingHunkTargetRef = useRef<{
    fileIndex: number;
    place: "first" | "last";
    armedDiff: string | undefined;
  } | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      if (pathCopyTimeoutRef.current) clearTimeout(pathCopyTimeoutRef.current);
    };
  }, []);

  // Non-reactive: reads defaultMode/hasDiff/initialLine/imageFile/svgFile at call
  // time so the effect only re-runs on isOpen/filePath/effectiveRootPath changes.
  const loadFile = useEffectEvent(() => {
    if (!isOpen) {
      setContent(null);
      setLoadState("loading");
      setErrorCode(null);
      setDisplayErrorMessage(null);
      setDiffCopied(false);
      setPathCopied(false);
      setSanitizedSvg(null);
      requestRef.current++;
      hasSwitchedToDiffRef.current = false;
      currentHunkIndexRef.current = -1;
      pendingHunkTargetRef.current = null;
      setSearchOpen(false);
      setSearchQuery("");
      const nextMode = defaultMode ?? (hasDiff && !initialLine ? "diff" : "view");
      setMode(nextMode);
      return;
    }

    const requestId = ++requestRef.current;
    setLoadState("loading");
    setErrorCode(null);
    setDisplayErrorMessage(null);
    hasSwitchedToDiffRef.current = false;
    currentHunkIndexRef.current = -1;

    // Stepping between files (onNavigateFile) keeps the modal open, so a mode
    // the new file can't render must be clamped: "rendered" is only valid for
    // markdown files.
    setMode((current) =>
      current === "rendered" && !markdownFile ? (hasDiff ? "diff" : "view") : current
    );

    // Image-compare-eligible files (including SVG) never need the working-tree
    // read — ImageDiffViewer fetches both sides itself, and a deleted image
    // has no working file to read anyway.
    if (imageFile && (!svgFile || imageDiffEligible)) {
      setLoadState("image");
      return;
    }

    filesClient
      .read({ path: filePath, rootPath: effectiveRootPath })
      .then(({ content: fileContent }) => {
        if (!isMountedRef.current || requestRef.current !== requestId) return;
        if (svgFile) {
          const sanitized = sanitizeSvg(fileContent);
          if (sanitized.ok) {
            setSanitizedSvg(sanitized.svg);
            setLoadState("svg");
          } else {
            setDisplayErrorMessage(sanitized.error);
            setLoadState("error");
          }
        } else {
          setContent(fileContent);
          setLoadState("loaded");
        }
      })
      .catch((error: unknown) => {
        if (!isMountedRef.current || requestRef.current !== requestId) return;
        const code = isClientAppError(error) ? (error.code as FileReadErrorCode) : "INVALID_PATH";
        setErrorCode(code);
        setLoadState("error");
      });
  });
  useEffect(() => {
    void isOpen;
    void filePath;
    void effectiveRootPath;
    loadFile();
  }, [isOpen, filePath, effectiveRootPath]);

  // When diff arrives after mount (FileDiffModal async pattern), switch to diff mode once
  useEffect(() => {
    if (hasDiff && defaultMode === "diff" && !hasSwitchedToDiffRef.current) {
      hasSwitchedToDiffRef.current = true;
      setMode("diff");
    }
  }, [hasDiff, defaultMode]);

  const handleOpenInEditor = useCallback(() => {
    actionService
      .dispatch(
        "file.openInEditor",
        { path: filePath, line: initialLine, col: initialCol },
        { source: "user" }
      )
      .catch((err) => logError("[FileViewerModal] openInEditor failed", err));
  }, [filePath, initialLine, initialCol]);

  const handleImageError = useCallback(() => {
    setDisplayErrorMessage("Unable to display image");
    setLoadState("error");
  }, []);

  const handleOpenInImageViewer = useCallback(() => {
    actionService
      .dispatch("file.openImageViewer", { path: filePath }, { source: "user" })
      .catch((err) => logError("[FileViewerModal] openImageViewer failed", err));
  }, [filePath]);

  const handleCopyPath = useCallback(() => {
    navigator.clipboard
      .writeText(filePath)
      .then(() => {
        if (!isMountedRef.current) return;
        useAnnouncerStore.getState().announce("Path copied");
        setPathCopied(true);
        if (pathCopyTimeoutRef.current) clearTimeout(pathCopyTimeoutRef.current);
        pathCopyTimeoutRef.current = setTimeout(() => {
          if (isMountedRef.current) setPathCopied(false);
        }, COPY_FEEDBACK_MS);
      })
      .catch((err) => logError("[FileViewerModal] copy path failed", err));
  }, [filePath]);

  const handleOpenAsPanel = useCallback(() => {
    actionService
      .dispatch(
        "file.openPanel",
        {
          path: filePath,
          rootPath: effectiveRootPath,
          // Carry the mode the user is already reading in into the panel.
          ...(markdownFile && { viewMode: mode === "rendered" ? "rendered" : "source" }),
        },
        { source: "user" }
      )
      .catch((err) => logError("[FileViewerModal] openAsPanel failed", err));
    onClose();
  }, [filePath, effectiveRootPath, markdownFile, mode, onClose]);

  const handleCopyDiff = useCallback(async () => {
    if (!hasDiff || !diff) return;
    try {
      await navigator.clipboard.writeText(diff);
      if (!isMountedRef.current) return;
      useAnnouncerStore.getState().announce("Diff copied");
      setDiffCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => {
        if (isMountedRef.current) setDiffCopied(false);
      }, COPY_FEEDBACK_MS);
    } catch {
      // Silently fail
    }
  }, [hasDiff, diff]);

  const fileName = filePath.split(/[/\\]/).filter(Boolean).pop() || filePath;

  const relDir = useMemo(() => {
    if (!workspaceRelPath) return null;
    const lastSlash = workspaceRelPath.lastIndexOf("/");
    return lastSlash > 0 ? workspaceRelPath.slice(0, lastSlash) : null;
  }, [workspaceRelPath]);

  const diffFontStyle: CSSProperties & Record<"--diff-font-size", string> = {
    "--diff-font-size": DIFF_FONT_SIZE_PX[diffFontSize],
  };

  const canShowView = loadState === "loaded" && content !== null;
  const isImageMode = loadState === "image" || loadState === "svg";

  const metadata = useMemo(() => {
    if (!canShowView || content === null) return null;
    const lineCount = content.split("\n").length;
    const byteSize = new TextEncoder().encode(content).byteLength;
    return { lineCount, sizeLabel: formatBytes(byteSize) };
  }, [canShowView, content]);

  // Route Cmd+F (daintree:find-in-panel) to CodeViewer's search in view mode
  // and the in-diff find bar in diff mode; Cmd+L (go to line) stays view-only.
  useEffect(() => {
    if (!isOpen || isImageMode) return;

    const handleFindInPanel = () => {
      if (mode === "view") {
        codeViewerRef.current?.openSearch();
      } else if (mode === "diff" && hasDiff) {
        setSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (mode !== "view") return;
      if ((e.metaKey || e.ctrlKey) && e.key === "l") {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        codeViewerRef.current?.openGotoLine();
      }
    };

    window.addEventListener("daintree:find-in-panel", handleFindInPanel);
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("daintree:find-in-panel", handleFindInPanel);
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [isOpen, isImageMode, mode, hasDiff]);

  // Reset hunk index whenever the diff content changes — covers refresh-after-
  // commit and any other in-place diff swap that leaves filePath unchanged.
  useEffect(() => {
    currentHunkIndexRef.current = -1;
  }, [diff]);

  // Hunk navigation in diff mode: `n` → next hunk, `p` → previous hunk, plus
  // the clickable footer stepper and overview-rail ticks — all funnel through
  // scrollToHunkIndex. react-diff-view renders each hunk as
  // <tbody class="diff-hunk">; scroll with native scrollIntoView (CSS
  // scroll-margin-top keeps the hunk header clear of the sticky chrome). Hunk
  // index lives in a ref so navigation does not re-render the heavy diff tree
  // on every keystroke.
  const scrollToHunkIndex = useCallback((index: number) => {
    const container = diffViewerRef.current;
    if (!container) return;
    const hunks = container.querySelectorAll<HTMLElement>("tbody.diff-hunk");
    if (hunks.length === 0) return;
    const next = Math.max(0, Math.min(index, hunks.length - 1));
    currentHunkIndexRef.current = next;
    setActiveHunkIndex(next);
    hunks[next]?.scrollIntoView({
      block: "start",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    useAnnouncerStore.getState().announce(`Hunk ${next + 1} of ${hunks.length}`);
  }, []);

  // File stepping state is needed by stepHunk's cross-file continuation, so
  // it is derived above the hunk navigation that consumes it.
  const canStepFiles = Boolean(onNavigateFile) && (totalFileCount ?? 0) > 1;
  const hasPrevFile = canStepFiles && (currentFileIndex ?? 0) > 0;
  const hasNextFile = canStepFiles && (currentFileIndex ?? 0) < (totalFileCount ?? 0) - 1;

  const fileStepAnnouncePendingRef = useRef(false);
  const navigateFile = useEffectEvent((delta: -1 | 1) => {
    if (delta === -1 && hasPrevFile) fileStepAnnouncePendingRef.current = true;
    if (delta === 1 && hasNextFile) fileStepAnnouncePendingRef.current = true;
    if (delta === -1 && hasPrevFile) onNavigateFile?.(-1);
    if (delta === 1 && hasNextFile) onNavigateFile?.(1);
  });

  const stepHunk = useCallback(
    (delta: -1 | 1) => {
      const count =
        diffViewerRef.current?.querySelectorAll<HTMLElement>("tbody.diff-hunk").length ?? 0;
      // Past either end of the file, the step flows into the neighboring file
      // of the changeset (Kaleidoscope-style continuous change navigation).
      // `onNavigateFile` is called directly (not via the `navigateFile`
      // effect event — those are effect-only) with the announce ref set so
      // the landed-on file is still read out. `armedDiff` records which diff
      // string was on screen when the step was armed: the landing only fires
      // once a DIFFERENT diff has committed, so the outgoing file's DOM can
      // never satisfy the target during the swap.
      const crossToFile = (fileDelta: -1 | 1, place: "first" | "last") => {
        pendingHunkTargetRef.current = {
          fileIndex: (currentFileIndex ?? 0) + fileDelta,
          place,
          armedDiff: diff,
        };
        fileStepAnnouncePendingRef.current = true;
        onNavigateFile?.(fileDelta);
      };
      if (count === 0) {
        // Hunkless file (binary, image, no changes): keep the flow continuous
        // instead of dead-ending mid-changeset.
        if (delta === 1 && hasNextFile) crossToFile(1, "first");
        else if (delta === -1 && hasPrevFile) crossToFile(-1, "last");
        return;
      }
      const current = currentHunkIndexRef.current;
      if (current < 0) {
        // Stepping from the initial sentinel (-1) lands on the first hunk so
        // the user gets feedback either way before they've started navigating.
        scrollToHunkIndex(0);
        return;
      }
      // Clamp before stepping: collapse/reveal can shrink the live hunk count
      // under a stale ref, and an unclamped `p` would otherwise read as "past
      // the end" and step forward.
      const next = Math.min(current, count - 1) + delta;
      if (next < 0) {
        if (hasPrevFile) crossToFile(-1, "last");
        return;
      }
      if (next >= count) {
        if (hasNextFile) crossToFile(1, "first");
        return;
      }
      scrollToHunkIndex(next);
    },
    [scrollToHunkIndex, hasPrevFile, hasNextFile, currentFileIndex, onNavigateFile, diff]
  );

  useEffect(() => {
    if (!isOpen || mode !== "diff") return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "n" && e.key !== "p") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (
        e.target instanceof HTMLElement &&
        (e.target.tagName === "INPUT" ||
          e.target.tagName === "TEXTAREA" ||
          e.target.tagName === "SELECT" ||
          e.target.isContentEditable)
      ) {
        return;
      }

      e.preventDefault();
      stepHunk(e.key === "n" ? 1 : -1);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, mode, stepHunk]);

  // File stepping in the worktree change set: `[` → previous file, `]` → next.
  // `n`/`p` are taken by hunk navigation and the arrow keys conflict with split-
  // diff horizontal scrolling, so brackets (the git-review convention) are the
  // free keys. The handler is a no-op unless the opener wired `onNavigateFile`.
  // (State derived above stepHunk, which needs it for cross-file continuation.)

  // Announce the landed-on file after a step swaps the dialog contents —
  // aria-labelledby title text changes are not announced by AT on their own.
  useEffect(() => {
    if (!isOpen || !fileStepAnnouncePendingRef.current) return;
    fileStepAnnouncePendingRef.current = false;
    const name = filePath.split(/[/\\]/).filter(Boolean).pop() || filePath;
    useAnnouncerStore
      .getState()
      .announce(`${name}, file ${(currentFileIndex ?? 0) + 1} of ${totalFileCount ?? 0}`);
  }, [isOpen, filePath, currentFileIndex, totalFileCount]);

  useEffect(() => {
    if (!isOpen || !canStepFiles) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "[" && e.key !== "]") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (
        e.target instanceof HTMLElement &&
        (e.target.tagName === "INPUT" ||
          e.target.tagName === "TEXTAREA" ||
          e.target.tagName === "SELECT" ||
          e.target.isContentEditable)
      ) {
        return;
      }

      e.preventDefault();
      navigateFile(e.key === "]" ? 1 : -1);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, canStepFiles]);

  // `v` — mark the open file viewed and advance to the next unviewed file
  // (wrapping), the GitHub-review muscle memory. Requires a matching
  // changeSet entry; only the footer button unmarks.
  const markViewedAndAdvance = useEffectEvent(() => {
    if (!workspaceEntry || !changeSet || currentFileIndex === undefined) return;
    const viewedSet = selectViewedSet(useDiffViewedStore.getState(), rootPath);
    const alreadyViewed = viewedSet.has(workspaceEntry.viewedKey);
    if (!alreadyViewed) {
      setViewed(rootPath, workspaceEntry.viewedKey, true);
      useAnnouncerStore.getState().announce("Marked viewed");
    }
    if (!onSelectFile) return;
    for (let step = 1; step < changeSet.length; step++) {
      const index = (currentFileIndex + step) % changeSet.length;
      const entry = changeSet[index];
      if (!entry || entry.viewedKey === workspaceEntry.viewedKey) continue;
      if (!viewedSet.has(entry.viewedKey)) {
        fileStepAnnouncePendingRef.current = true;
        onSelectFile(index);
        return;
      }
    }
  });

  useEffect(() => {
    // Gated on the entry (not multi-file workspace mode) so `v` also works
    // for a single-file changeset, where it marks the file and stays put.
    if (!isOpen || !workspaceEntry) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "v") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (
        e.target instanceof HTMLElement &&
        (e.target.tagName === "INPUT" ||
          e.target.tagName === "TEXTAREA" ||
          e.target.tagName === "SELECT" ||
          e.target.isContentEditable)
      ) {
        return;
      }

      e.preventDefault();
      markViewedAndAdvance();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, workspaceEntry]);

  // IntersectionObserver tracks the most-visible hunk during free scrolling.
  // Observes tr:first-child (not tbody — table-row-group collapses to 0 height
  // in Chromium and races with layout). The observer is keyed on diffViewType
  // so split/unified toggles re-observe the new DOM.
  useEffect(() => {
    if (!isOpen || mode !== "diff" || !diff) {
      // Destination diff observed loading: drop the armed-diff identity check
      // so a destination whose diff STRING happens to equal the source's
      // (sentinel pairs) can still land once it commits.
      const pendingWhileLoading = pendingHunkTargetRef.current;
      if (pendingWhileLoading && pendingWhileLoading.fileIndex === (currentFileIndex ?? -1)) {
        pendingWhileLoading.armedDiff = undefined;
      }
      setActiveHunkIndex(-1);
      setHunkCount(0);
      setHunkMarkers([]);
      return;
    }

    const container = diffViewerRef.current;
    if (!container) {
      setActiveHunkIndex(-1);
      setHunkCount(0);
      setHunkMarkers([]);
      return;
    }

    // The diff-viewer div sizes to content (no height constraint). The actual
    // scroll container is AppDialog.BodyScroll, its direct parent.
    const scrollRoot = container.parentElement;
    if (!scrollRoot) {
      setActiveHunkIndex(-1);
      setHunkCount(0);
      setHunkMarkers([]);
      return;
    }

    const hunks = container.querySelectorAll<HTMLElement>("tbody.diff-hunk");
    const count = hunks.length;
    setHunkCount(count);

    // Land a cross-file hunk step once the destination file's hunks exist.
    // A stale target (user jumped elsewhere meanwhile) is dropped instead,
    // and the outgoing file's still-rendered diff never satisfies the target
    // (`armedDiff` identity check) — the swap can commit the new index a
    // frame before the new diff arrives.
    const pending = pendingHunkTargetRef.current;
    if (pending) {
      if (pending.fileIndex !== (currentFileIndex ?? -1)) {
        pendingHunkTargetRef.current = null;
      } else if (count > 0 && diff !== pending.armedDiff) {
        pendingHunkTargetRef.current = null;
        const landingIndex = pending.place === "last" ? count - 1 : 0;
        requestAnimationFrame(() => scrollToHunkIndex(landingIndex));
      }
    }

    // Overview rail: one tick per hunk at its proportional scroll position,
    // colored by the hunk's dominant change kind.
    if (count > 1 && scrollRoot.scrollHeight > 0) {
      const rootTop = scrollRoot.getBoundingClientRect().top;
      const markers = Array.from(hunks).map((hunk) => {
        const top = hunk.getBoundingClientRect().top - rootTop + scrollRoot.scrollTop;
        const inserts = hunk.querySelectorAll(".diff-code-insert").length;
        const deletes = hunk.querySelectorAll(".diff-code-delete").length;
        return {
          ratio: Math.min(1, Math.max(0, top / scrollRoot.scrollHeight)),
          kind:
            inserts > 0 && deletes > 0
              ? ("mixed" as const)
              : deletes > 0
                ? ("delete" as const)
                : ("insert" as const),
        };
      });
      setHunkMarkers(markers);
    } else {
      setHunkMarkers([]);
    }

    if (count <= 1) {
      setActiveHunkIndex(-1);
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      return;
    }

    const generation = ++observerGenerationRef.current;
    observerDisposedRef.current = false;
    hunkRatiosRef.current = new Map();

    const observer = new IntersectionObserver(
      (entries) => {
        if (observerDisposedRef.current) return;
        if (generation !== observerGenerationRef.current) return;

        for (const entry of entries) {
          const target = entry.target;
          if (!(target instanceof HTMLElement)) continue;
          const idx = Number(target.dataset.hunkObserverIndex);
          if (Number.isNaN(idx)) continue;
          if (entry.intersectionRatio === 0) {
            hunkRatiosRef.current.delete(idx);
          } else {
            hunkRatiosRef.current.set(idx, entry.intersectionRatio);
          }
        }

        let bestIdx = -1;
        let bestRatio = -1;
        for (const [idx, ratio] of hunkRatiosRef.current) {
          if (ratio > bestRatio || (ratio === bestRatio && idx < bestIdx)) {
            bestRatio = ratio;
            bestIdx = idx;
          }
        }

        if (bestIdx >= 0) {
          setActiveHunkIndex(bestIdx);
          currentHunkIndexRef.current = bestIdx;
        }
      },
      { root: scrollRoot, threshold: [0, 0.2, 0.4, 0.6, 0.8, 1.0] }
    );

    hunks.forEach((hunk, index) => {
      const firstRow = hunk.querySelector("tr:first-child");
      if (firstRow instanceof HTMLElement) {
        firstRow.dataset.hunkObserverIndex = String(index);
        observer.observe(firstRow);
      }
    });

    return () => {
      observerDisposedRef.current = true;
      observer.disconnect();
    };
  }, [
    isOpen,
    mode,
    diff,
    diffViewType,
    diffWrapLines,
    collapseRevision,
    currentFileIndex,
    scrollToHunkIndex,
  ]);

  const handleDiffToggleCollapse = useCallback(() => {
    setCollapseRevision((r) => r + 1);
  }, []);

  const handleTokensRendered = useCallback(() => {
    setTokensRevision((r) => r + 1);
  }, []);

  const searchActive = searchOpen && mode === "diff" && hasDiff;

  // Re-scan rendered matches after every token commit. The active index lives
  // in a ref (stepping must not depend on stale state), mirrored to state for
  // the count display.
  useEffect(() => {
    if (!isOpen || !searchActive || !searchQuery) {
      searchMatchIndexRef.current = -1;
      setSearchMatchIndex(-1);
      setSearchMatchCount(0);
      setSearchMarkers([]);
      lastSearchQueryRef.current = searchQuery;
      return;
    }
    if (lastSearchQueryRef.current !== searchQuery) {
      lastSearchQueryRef.current = searchQuery;
      searchMatchIndexRef.current = -1;
      setSearchMatchIndex(-1);
    }
    const container = diffViewerRef.current;
    const scrollRoot = container?.parentElement;
    if (!container || !scrollRoot) return;
    const matches = container.querySelectorAll<HTMLElement>(".diff-search-match");
    setSearchMatchCount(matches.length);
    if (searchMatchIndexRef.current >= matches.length) {
      searchMatchIndexRef.current = -1;
      setSearchMatchIndex(-1);
    }
    if (matches.length > 0 && scrollRoot.scrollHeight > 0) {
      const rootTop = scrollRoot.getBoundingClientRect().top;
      const ratios: number[] = [];
      const limit = Math.min(matches.length, 200);
      for (let k = 0; k < limit; k++) {
        const el = matches[k];
        if (!el) break;
        const top = el.getBoundingClientRect().top - rootTop + scrollRoot.scrollTop;
        ratios.push(Math.min(1, Math.max(0, top / scrollRoot.scrollHeight)));
      }
      setSearchMarkers(ratios);
    } else {
      setSearchMarkers([]);
    }
  }, [isOpen, searchActive, searchQuery, tokensRevision, collapseRevision, diffViewType]);

  // The current match carries diff-search-current directly on the rendered
  // span; a token re-commit wipes it, and the tokensRevision dep re-applies.
  useEffect(() => {
    const container = diffViewerRef.current;
    if (!container) return;
    const matches = container.querySelectorAll<HTMLElement>(".diff-search-match");
    matches.forEach((el, k) => {
      el.classList.toggle("diff-search-current", k === searchMatchIndex);
    });
  }, [searchMatchIndex, tokensRevision, searchMatchCount]);

  const stepSearchMatch = useCallback((delta: -1 | 1) => {
    const container = diffViewerRef.current;
    if (!container) return;
    const matches = container.querySelectorAll<HTMLElement>(".diff-search-match");
    if (!matches.length) return;
    const current = searchMatchIndexRef.current;
    const next =
      current < 0
        ? delta === 1
          ? 0
          : matches.length - 1
        : (current + delta + matches.length) % matches.length;
    searchMatchIndexRef.current = next;
    setSearchMatchIndex(next);
    const match = matches[next];
    match?.scrollIntoView({
      block: "center",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    if (match) revealMatchInCenteredSplit(match);
    useAnnouncerStore.getState().announce(`Match ${next + 1} of ${matches.length}`);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        stepSearchMatch(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        // Claim the key so the dialog's escape stack doesn't also close the modal.
        e.preventDefault();
        e.stopPropagation();
        closeSearch();
      }
    },
    [stepSearchMatch, closeSearch]
  );

  // Overview-rail viewport indicator: a pointer-events-free thumb mirroring
  // the visible region. Written straight to the DOM from scroll events so
  // scrolling never re-renders the modal tree.
  useEffect(() => {
    if (!isOpen || mode !== "diff") return;
    const container = diffViewerRef.current;
    const indicator = viewportIndicatorRef.current;
    const scrollRoot = container?.parentElement;
    if (!container || !indicator || !scrollRoot) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const { scrollTop, scrollHeight, clientHeight } = scrollRoot;
      if (scrollHeight <= clientHeight + 1) {
        indicator.style.opacity = "0";
        return;
      }
      indicator.style.opacity = "1";
      indicator.style.top = `${(scrollTop / scrollHeight) * 100}%`;
      indicator.style.height = `${(clientHeight / scrollHeight) * 100}%`;
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    scrollRoot.addEventListener("scroll", schedule, { passive: true });
    const resizeObserver =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    resizeObserver?.observe(scrollRoot);
    return () => {
      scrollRoot.removeEventListener("scroll", schedule);
      resizeObserver?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [isOpen, mode, diff, hunkMarkers.length, searchMarkers.length, collapseRevision]);

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size={
        isWorkspace
          ? "workspace"
          : mode === "diff" && hasDiff && diffViewType === "split"
            ? "7xl"
            : "6xl"
      }
      /* Workspace mode holds a fixed frame (h-, not just max-h-): a short
         diff must not shrink-wrap the dialog mid-review — stepping files
         would otherwise resize the whole surface on every jump. */
      maxHeight={isWorkspace ? "h-[92vh] max-h-[92vh]" : "max-h-[90vh]"}
      restoreFocusTo={restoreFocusTo}
      data-testid="file-viewer-dialog"
    >
      <AppDialog.Header className="py-3">
        <div className="flex items-center gap-3 min-w-0">
          <Tooltip>
            <AppDialog.Title className="text-sm font-medium min-w-0">
              <TooltipTrigger asChild>
                <span className="truncate cursor-default text-daintree-text">
                  {relDir && <span className="text-daintree-text/45">{relDir}/</span>}
                  {fileName}
                </span>
              </TooltipTrigger>
            </AppDialog.Title>
            <TooltipContent side="bottom" className="max-w-lg break-all">
              {branch ? `${branch} — ${filePath}` : filePath}
            </TooltipContent>
          </Tooltip>

          {workspaceEntry &&
            ((workspaceEntry.insertions ?? 0) > 0 || (workspaceEntry.deletions ?? 0) > 0) && (
              <span className="flex shrink-0 items-center gap-1 font-mono text-[11px]">
                {(workspaceEntry.insertions ?? 0) > 0 && (
                  <span className="text-status-success">+{workspaceEntry.insertions}</span>
                )}
                {(workspaceEntry.deletions ?? 0) > 0 && (
                  <span className="text-status-error">-{workspaceEntry.deletions}</span>
                )}
              </span>
            )}

          {/* Mode toggle: markdown files get Rendered/Source (plus Diff when
              available); other files keep the original View/Diff pair. */}
          {(hasDiff || markdownFile) && !imageFile && (canShowView || loadState !== "loading") && (
            <SegmentedToggle
              options={[
                {
                  value: "view" as ViewMode,
                  label: markdownFile ? "Source" : "View",
                  disabled: !canShowView,
                },
                ...(markdownFile
                  ? [{ value: "rendered" as ViewMode, label: "Rendered", disabled: !canShowView }]
                  : []),
                ...(hasDiff ? [{ value: "diff" as ViewMode, label: "Diff" }] : []),
              ]}
              value={mode}
              onChange={setMode}
            />
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0 whitespace-nowrap">
          {/* Copy diff — only visible in diff mode */}
          {mode === "diff" && hasDiff && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleCopyDiff}
                  aria-label={diffCopied ? "Copied!" : "Copy diff to clipboard"}
                  className="p-1.5 rounded transition-colors text-muted-foreground hover:text-daintree-text hover:bg-daintree-border"
                >
                  {diffCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {diffCopied ? "Copied!" : "Copy diff to clipboard"}
              </TooltipContent>
            </Tooltip>
          )}

          {/* Copy path — agent workflows paste file paths back into prompts */}
          {!imageFile && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleCopyPath}
                  aria-label={pathCopied ? "Copied!" : "Copy file path"}
                  className="p-1.5 rounded transition-colors text-muted-foreground hover:text-daintree-text hover:bg-daintree-border"
                >
                  {pathCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {pathCopied ? "Copied!" : "Copy file path"}
              </TooltipContent>
            </Tooltip>
          )}

          {!imageFile && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleOpenAsPanel}
                  aria-label="Open as panel"
                  className="p-1.5 rounded transition-colors text-muted-foreground hover:text-daintree-text hover:bg-daintree-border"
                  data-testid="file-viewer-open-as-panel"
                >
                  <Grid2x2Plus className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Open as panel</TooltipContent>
            </Tooltip>
          )}

          {imageFile ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleOpenInImageViewer}
                  aria-label="Open in image viewer"
                  className="p-1.5 rounded transition-colors text-muted-foreground hover:text-daintree-text hover:bg-daintree-border"
                >
                  <ImageIcon className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Open in image viewer</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleOpenInEditor}
                  aria-label="Open in editor"
                  className="p-1.5 rounded transition-colors text-muted-foreground hover:text-daintree-text hover:bg-daintree-border"
                >
                  <ExternalLink className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Open in editor</TooltipContent>
            </Tooltip>
          )}
          <AppDialog.CloseButton />
        </div>
      </AppDialog.Header>

      <div className="flex flex-1 min-h-0">
        {isWorkspace && diffShowFileList && changeSet && onSelectFile && (
          <DiffFileSidebar
            files={changeSet}
            currentIndex={currentFileIndex ?? -1}
            worktreePath={rootPath}
            onSelect={(index) => {
              if (index === currentFileIndex) return;
              fileStepAnnouncePendingRef.current = true;
              onSelectFile(index);
            }}
          />
        )}
        <div className="relative flex-1 min-w-0 min-h-0 flex flex-col" style={diffFontStyle}>
          <AppDialog.BodyScroll className="p-0 diff-scroll-root">
            {isImageMode && imageDiffEligible && fileStatus && workspaceRelPath && (
              <div className="h-full min-h-[300px]">
                <ImageDiffViewer
                  relPath={workspaceRelPath}
                  worktreePath={rootPath}
                  status={fileStatus}
                />
              </div>
            )}

            {isImageMode && !imageDiffEligible && (
              <div className="flex items-center justify-center p-6 min-h-[300px]">
                {loadState === "image" && (
                  <img
                    key={filePath}
                    src={buildDaintreeFileUrl(filePath, effectiveRootPath)}
                    alt={fileName}
                    className="max-w-full max-h-[70vh] object-contain rounded"
                    draggable={false}
                    onError={handleImageError}
                  />
                )}
                {loadState === "svg" && sanitizedSvg && (
                  <div
                    className="max-w-full max-h-[70vh] overflow-auto [&>svg]:max-w-full [&>svg]:h-auto"
                    dangerouslySetInnerHTML={{ __html: createTrustedHTML(sanitizedSvg) }}
                  />
                )}
              </div>
            )}

            {!isImageMode && (mode === "view" || mode === "rendered") && (
              <>
                {loadState === "loading" && (
                  <div className="p-4 space-y-3">
                    <Skeleton label="Loading file">
                      <SkeletonBone className="h-5 w-1/3" />
                      <SkeletonText lines={15} />
                    </Skeleton>
                  </div>
                )}

                {loadState === "error" && (displayErrorMessage || errorCode) && (
                  <div className="flex flex-col items-center justify-center h-64 gap-3">
                    <p className="text-sm text-muted-foreground">
                      {displayErrorMessage ??
                        (errorCode ? FILE_READ_ERROR_MESSAGES[errorCode] : "")}
                    </p>
                    {imageFile ? (
                      <button
                        type="button"
                        onClick={handleOpenInImageViewer}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-daintree-text bg-daintree-border hover:bg-daintree-border/80 rounded transition-colors"
                      >
                        <ImageIcon className="w-3.5 h-3.5" />
                        Open in image viewer
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleOpenInEditor}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-daintree-text bg-daintree-border hover:bg-daintree-border/80 rounded transition-colors"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        Open in editor
                      </button>
                    )}
                  </div>
                )}

                {loadState === "loaded" &&
                  content !== null &&
                  (mode === "rendered" && markdownFile ? (
                    <MarkdownViewer
                      content={content}
                      filePath={filePath}
                      rootPath={effectiveRootPath}
                      viewMode="rendered"
                    />
                  ) : (
                    // min-h-full column: the editor surface stretches to the
                    // footer even for files shorter than the dialog body.
                    <div className="flex min-h-full flex-col">
                      {metadata && (
                        <div
                          data-testid="file-viewer-metadata"
                          className="px-3 py-1 border-b border-daintree-border text-xs text-muted-foreground font-mono shrink-0"
                        >
                          {metadata.lineCount} lines · {metadata.sizeLabel} · UTF-8
                        </div>
                      )}
                      <CodeViewer
                        ref={codeViewerRef}
                        content={content}
                        filePath={filePath}
                        initialLine={initialLine}
                        wrapLines={markdownFile && markdownWrapLines}
                        className="min-h-[300px] flex-1"
                      />
                    </div>
                  ))}
              </>
            )}

            {!isImageMode && mode === "diff" && diff && (
              <DiffViewer
                ref={diffViewerRef}
                diff={diff}
                viewType={diffViewType}
                rootPath={rootPath}
                wrapLines={diffWrapLines}
                searchQuery={searchActive ? searchQuery : undefined}
                // Expansion needs the diff's new side to byte-match the loaded
                // file; an ignore-whitespace diff can show old-side context lines.
                source={
                  diffMatchesFile && !diffIgnoreWhitespace && canShowView ? content : undefined
                }
                onRetry={onRetryDiff}
                onToggleCollapse={handleDiffToggleCollapse}
                onTokensRendered={handleTokensRendered}
              />
            )}

            {!isImageMode && mode === "diff" && !diff && (
              <div className="p-4 space-y-3">
                <Skeleton label="Loading diff">
                  <SkeletonBone className="h-7 w-3/4" />
                  <SkeletonText lines={8} />
                </Skeleton>
              </div>
            )}
          </AppDialog.BodyScroll>

          {/* In-diff find bar (Cmd+F in diff mode). Floats over the top-right of
            the diff; Enter / Shift+Enter cycle matches. */}
          {searchActive && (
            <div
              className="absolute top-2 right-7 z-20 flex items-center gap-1 pl-2 pr-1 py-1 rounded-md surface-overlay shadow-[var(--theme-shadow-floating)] focus-within:border-daintree-accent focus-within:ring-1 focus-within:ring-daintree-accent/20"
              data-testid="diff-search-bar"
            >
              <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Find in diff"
                aria-label="Find in diff"
                className="w-44 bg-transparent text-xs text-daintree-text placeholder:text-text-placeholder focus:outline-hidden"
              />
              <span
                className="text-xs text-muted-foreground tabular-nums shrink-0 min-w-0"
                data-testid="diff-search-count"
                aria-live="polite"
              >
                {searchQuery
                  ? searchMatchCount === 0
                    ? "No matches"
                    : searchMatchIndex >= 0
                      ? `${searchMatchIndex + 1} of ${searchMatchCount}`
                      : `${searchMatchCount} ${searchMatchCount === 1 ? "match" : "matches"}`
                  : ""}
              </span>
              <button
                type="button"
                onClick={() => stepSearchMatch(-1)}
                disabled={searchMatchCount === 0}
                aria-label="Previous match"
                className="p-1 rounded transition-colors text-muted-foreground hover:text-daintree-text hover:bg-overlay-medium disabled:opacity-40 disabled:pointer-events-none"
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => stepSearchMatch(1)}
                disabled={searchMatchCount === 0}
                aria-label="Next match"
                className="p-1 rounded transition-colors text-muted-foreground hover:text-daintree-text hover:bg-overlay-medium disabled:opacity-40 disabled:pointer-events-none"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={closeSearch}
                aria-label="Close search"
                className="p-1 rounded transition-colors text-muted-foreground hover:text-daintree-text hover:bg-overlay-medium"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Overview rail: one tick per hunk at its proportional position in the
            scroll run (plus search-match ticks and a viewport thumb); sits left
            of the body scrollbar. */}
          {mode === "diff" && (hunkMarkers.length > 1 || searchMarkers.length > 0) && (
            <div
              className="absolute right-2.5 top-1 bottom-1 w-2 z-10"
              data-testid="hunk-overview-rail"
            >
              <div
                ref={viewportIndicatorRef}
                data-testid="rail-viewport-indicator"
                className="absolute left-0 right-0 rounded-full bg-tint/10 pointer-events-none"
              />
              {hunkMarkers.map((marker, index) => (
                <button
                  key={index}
                  type="button"
                  aria-label={`Go to hunk ${index + 1} of ${hunkMarkers.length}`}
                  onClick={() => scrollToHunkIndex(index)}
                  style={{ top: `${marker.ratio * 100}%` }}
                  className={cn(
                    "absolute left-0 right-0 h-[3px] rounded-full transition-colors",
                    marker.kind === "insert" && "bg-status-success/60 hover:bg-status-success",
                    marker.kind === "delete" && "bg-status-danger/60 hover:bg-status-danger",
                    marker.kind === "mixed" &&
                      "bg-gradient-to-r from-status-success/60 to-status-danger/60",
                    index === activeHunkIndex && "h-[5px] opacity-100"
                  )}
                />
              ))}
              {searchMarkers.map((ratio, index) => (
                <div
                  key={`search-${index}`}
                  data-testid="rail-search-tick"
                  style={{ top: `${ratio * 100}%` }}
                  className="absolute right-0 w-1 h-[2px] rounded-full bg-text-muted pointer-events-none"
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Slim footer toolbar: navigation + diff display controls (Kaleidoscope-
          style bottom stepper). Rendered whenever there's something to put in
          it — file stepping in either mode, diff controls in diff mode. */}
      {(canStepFiles || (mode === "diff" && hasDiff) || (markdownFile && mode === "view")) && (
        <div className="flex items-center justify-between gap-3 px-4 py-1.5 border-t border-border-strong bg-surface-panel shrink-0">
          <div className="flex items-center gap-1 min-w-0">
            {isWorkspace && (
              <IconToggle
                pressed={diffShowFileList}
                label="Show file list"
                onToggle={() => setDiffShowFileList(!diffShowFileList)}
              >
                <PanelLeft className="w-4 h-4" />
              </IconToggle>
            )}
            {canStepFiles && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => {
                        fileStepAnnouncePendingRef.current = true;
                        onNavigateFile?.(-1);
                      }}
                      disabled={!hasPrevFile}
                      aria-label="Previous file"
                      className="p-1.5 rounded transition-colors text-muted-foreground hover:text-daintree-text hover:bg-daintree-border disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Previous file ([)</TooltipContent>
                </Tooltip>
                <span
                  data-testid="file-position-indicator"
                  className="text-xs text-muted-foreground tabular-nums"
                >
                  {(currentFileIndex ?? 0) + 1} of {totalFileCount}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => {
                        fileStepAnnouncePendingRef.current = true;
                        onNavigateFile?.(1);
                      }}
                      disabled={!hasNextFile}
                      aria-label="Next file"
                      className="p-1.5 rounded transition-colors text-muted-foreground hover:text-daintree-text hover:bg-daintree-border disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Next file (])</TooltipContent>
                </Tooltip>
              </>
            )}
            {workspaceEntry && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => toggleViewed(rootPath, workspaceEntry.viewedKey)}
                    aria-pressed={currentViewed}
                    aria-label="Viewed"
                    data-testid="diff-viewed-button"
                    className={cn(
                      "ml-1 flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
                      currentViewed
                        ? "bg-status-success/15 text-status-success"
                        : "text-muted-foreground hover:text-daintree-text hover:bg-daintree-border"
                    )}
                  >
                    <Check className="w-3.5 h-3.5" />
                    Viewed
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Mark as viewed — v also steps to the next file
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {mode === "diff" && hasDiff && hunkCount > 0 && (
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => stepHunk(-1)}
                    disabled={activeHunkIndex <= 0 && !hasPrevFile}
                    aria-label="Previous hunk"
                    className="p-1.5 rounded transition-colors text-muted-foreground hover:text-daintree-text hover:bg-daintree-border disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none"
                  >
                    <ChevronUp className="w-4 h-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Previous hunk (p)</TooltipContent>
              </Tooltip>
              <span
                data-testid="hunk-position-indicator"
                className="text-xs text-muted-foreground tabular-nums"
              >
                {activeHunkIndex >= 0
                  ? `Hunk ${activeHunkIndex + 1} of ${hunkCount}`
                  : `${hunkCount} ${hunkCount === 1 ? "hunk" : "hunks"}`}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => stepHunk(1)}
                    disabled={activeHunkIndex >= hunkCount - 1 && !hasNextFile}
                    aria-label="Next hunk"
                    className="p-1.5 rounded transition-colors text-muted-foreground hover:text-daintree-text hover:bg-daintree-border disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none"
                  >
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Next hunk (n)</TooltipContent>
              </Tooltip>
            </div>
          )}

          <div className="flex items-center gap-2">
            {markdownFile && mode === "view" && (
              <IconToggle
                pressed={markdownWrapLines}
                label="Wrap long lines"
                onToggle={() => setMarkdownWrapLines(!markdownWrapLines)}
              >
                <WrapText className="w-4 h-4" />
              </IconToggle>
            )}
            {mode === "diff" && hasDiff && (
              <>
                <IconToggle
                  pressed={searchOpen}
                  label="Find in diff"
                  onToggle={() => {
                    if (searchOpen) {
                      closeSearch();
                    } else {
                      setSearchOpen(true);
                      requestAnimationFrame(() => searchInputRef.current?.focus());
                    }
                  }}
                >
                  <Search className="w-4 h-4" />
                </IconToggle>
                <IconToggle
                  pressed={diffWrapLines}
                  label="Wrap long lines"
                  onToggle={() => setDiffWrapLines(!diffWrapLines)}
                >
                  <WrapText className="w-4 h-4" />
                </IconToggle>
                <IconToggle
                  pressed={diffIgnoreWhitespace}
                  label="Ignore whitespace changes"
                  onToggle={() => setDiffIgnoreWhitespace(!diffIgnoreWhitespace)}
                >
                  <Pilcrow className="w-4 h-4" />
                </IconToggle>
                <SegmentedToggle
                  options={DIFF_FONT_SIZE_ORDER.map((size) => ({
                    value: size,
                    label: size.toUpperCase(),
                    ariaLabel: `${DIFF_FONT_SIZE_LABEL[size]} text`,
                  }))}
                  value={diffFontSize}
                  onChange={setDiffFontSize}
                />
                <SegmentedToggle
                  options={[
                    { value: "split" as DiffViewType, label: "Split" },
                    { value: "unified" as DiffViewType, label: "Unified" },
                  ]}
                  value={diffViewType}
                  onChange={setDiffViewType}
                />
              </>
            )}
          </div>
        </div>
      )}
    </AppDialog>
  );
}
