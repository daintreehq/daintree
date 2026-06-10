import { useEffect, useEffectEvent, useCallback, useState, useRef, useMemo } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import type { RestoreFocusTarget } from "@/components/ui/AppDialog";
import { DiffViewer } from "@/components/Worktree/DiffViewer";
import { CodeViewer } from "./CodeViewer";
import type { CodeViewerHandle } from "./CodeViewer";
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
  Pilcrow,
  WrapText,
} from "lucide-react";
import { Skeleton, SkeletonBone, SkeletonText } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/formatBytes";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FileReadErrorCode } from "@shared/types/ipc/files";
import { isClientAppError } from "@/utils/clientAppError";
import { sanitizeSvg } from "@shared/utils/svgSanitizer";
import { createTrustedHTML } from "@/lib/trustedTypesPolicy";
import { logError } from "@/utils/logger";
import { usePreferencesStore } from "@/store/preferencesStore";
import type { DiffViewType } from "@/store/preferencesStore";
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
}

type ViewMode = "view" | "diff";
type LoadState = "loading" | "loaded" | "error" | "image" | "svg";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);
const SVG_EXTENSION = "svg";

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

interface SegmentedToggleOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: SegmentedToggleOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex bg-daintree-sidebar rounded p-0.5 shrink-0">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          disabled={option.disabled}
          aria-pressed={value === option.value}
          className={cn(
            "px-2.5 py-1 text-xs font-medium rounded transition-colors",
            value === option.value
              ? "bg-daintree-border text-daintree-text"
              : "text-muted-foreground hover:text-daintree-text disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
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

const ERROR_MESSAGES: Record<FileReadErrorCode, string> = {
  BINARY_FILE: "Binary file — cannot display",
  FILE_TOO_LARGE: "File too large to display (> 500 KB)",
  LFS_POINTER: "Git LFS pointer — run `git lfs pull` to download the file contents",
  NOT_FOUND: "File no longer exists",
  OUTSIDE_ROOT: "File is outside the project root",
  INVALID_PATH: "Invalid file path",
  PERMISSION: "Permission denied — you don't have access to this file",
};

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
  const [mode, setMode] = useState<ViewMode>(() => {
    if (isImageFile(filePath)) return "view";
    if (defaultMode) return defaultMode;
    return hasDiff && !initialLine ? "diff" : "view";
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
  const [diffCopied, setDiffCopied] = useState(false);
  const [sanitizedSvg, setSanitizedSvg] = useState<string | null>(null);
  const requestRef = useRef(0);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const imageFile = isImageFile(filePath);
  const svgFile = isSvgFile(filePath);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
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
      setSanitizedSvg(null);
      requestRef.current++;
      hasSwitchedToDiffRef.current = false;
      currentHunkIndexRef.current = -1;
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

    if (imageFile && !svgFile) {
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
      }, 2000);
    } catch {
      // Silently fail
    }
  }, [hasDiff, diff]);

  const fileName = filePath.split(/[/\\]/).filter(Boolean).pop() || filePath;

  const canShowView = loadState === "loaded" && content !== null;
  const isImageMode = loadState === "image" || loadState === "svg";

  const metadata = useMemo(() => {
    if (!canShowView || content === null) return null;
    const lineCount = content.split("\n").length;
    const byteSize = new TextEncoder().encode(content).byteLength;
    return { lineCount, sizeLabel: formatBytes(byteSize) };
  }, [canShowView, content]);

  // Route Cmd+F (daintree:find-in-panel) and Cmd+L to CodeViewer
  useEffect(() => {
    if (!isOpen || isImageMode || mode !== "view") return;

    const handleFindInPanel = () => {
      codeViewerRef.current?.openSearch();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
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
  }, [isOpen, isImageMode, mode]);

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

  const stepHunk = useCallback(
    (delta: -1 | 1) => {
      const current = currentHunkIndexRef.current;
      // Stepping from the initial sentinel (-1) lands on the first hunk so
      // the user gets feedback either way before they've started navigating.
      scrollToHunkIndex(current < 0 ? 0 : current + delta);
    },
    [scrollToHunkIndex]
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

  // IntersectionObserver tracks the most-visible hunk during free scrolling.
  // Observes tr:first-child (not tbody — table-row-group collapses to 0 height
  // in Chromium and races with layout). The observer is keyed on diffViewType
  // so split/unified toggles re-observe the new DOM.
  useEffect(() => {
    if (!isOpen || mode !== "diff" || !diff) {
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
  }, [isOpen, mode, diff, diffViewType, diffWrapLines, collapseRevision]);

  const handleDiffToggleCollapse = useCallback(() => {
    setCollapseRevision((r) => r + 1);
  }, []);

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size={mode === "diff" && hasDiff && diffViewType === "split" ? "7xl" : "6xl"}
      maxHeight="max-h-[90vh]"
      restoreFocusTo={restoreFocusTo}
      data-testid="file-viewer-dialog"
    >
      <AppDialog.Header className="py-3">
        <div className="flex items-center gap-3 min-w-0">
          <Tooltip>
            <AppDialog.Title className="text-sm font-medium min-w-0">
              <TooltipTrigger asChild>
                <span className="truncate cursor-default text-daintree-text">{fileName}</span>
              </TooltipTrigger>
            </AppDialog.Title>
            <TooltipContent side="bottom" className="max-w-lg break-all">
              {branch ? `${branch} — ${filePath}` : filePath}
            </TooltipContent>
          </Tooltip>

          {/* Show view/diff toggle only when both are potentially available */}
          {hasDiff && !imageFile && (canShowView || loadState !== "loading") && (
            <SegmentedToggle
              options={[
                { value: "view" as ViewMode, label: "View", disabled: !canShowView },
                { value: "diff" as ViewMode, label: "Diff" },
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

      <div className="relative flex-1 min-h-0 flex flex-col">
        <AppDialog.BodyScroll className="p-0">
          {isImageMode && (
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

          {!isImageMode && mode === "view" && (
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
                    {displayErrorMessage ?? (errorCode ? ERROR_MESSAGES[errorCode] : "")}
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

              {loadState === "loaded" && content !== null && (
                <>
                  {metadata && (
                    <div
                      data-testid="file-viewer-metadata"
                      className="px-3 py-1 border-b border-daintree-border text-xs text-muted-foreground font-mono"
                    >
                      {metadata.lineCount} lines · {metadata.sizeLabel} · UTF-8
                    </div>
                  )}
                  <CodeViewer
                    ref={codeViewerRef}
                    content={content}
                    filePath={filePath}
                    initialLine={initialLine}
                    className="min-h-[300px]"
                  />
                </>
              )}
            </>
          )}

          {!isImageMode && mode === "diff" && diff && (
            <DiffViewer
              ref={diffViewerRef}
              diff={diff}
              viewType={diffViewType}
              rootPath={rootPath}
              wrapLines={diffWrapLines}
              // Expansion needs the diff's new side to byte-match the loaded
              // file; an ignore-whitespace diff can show old-side context lines.
              source={diffMatchesFile && !diffIgnoreWhitespace && canShowView ? content : undefined}
              onRetry={onRetryDiff}
              onToggleCollapse={handleDiffToggleCollapse}
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

        {/* Overview rail: one tick per hunk at its proportional position in the
            scroll run; sits left of the body scrollbar. */}
        {mode === "diff" && hunkMarkers.length > 1 && (
          <div
            className="absolute right-2.5 top-1 bottom-1 w-2 z-10"
            data-testid="hunk-overview-rail"
          >
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
          </div>
        )}
      </div>

      {/* Slim footer toolbar: navigation + diff display controls (Kaleidoscope-
          style bottom stepper). Rendered whenever there's something to put in
          it — file stepping in either mode, diff controls in diff mode. */}
      {(canStepFiles || (mode === "diff" && hasDiff)) && (
        <div className="flex items-center justify-between gap-3 px-4 py-1.5 border-t border-border-strong bg-surface-panel shrink-0">
          <div className="flex items-center gap-1 min-w-0">
            {canStepFiles && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => onNavigateFile?.(-1)}
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
                      onClick={() => onNavigateFile?.(1)}
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
          </div>

          {mode === "diff" && hasDiff && hunkCount > 0 && (
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => stepHunk(-1)}
                    disabled={hunkCount < 2 || activeHunkIndex === 0}
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
                    disabled={hunkCount < 2 || activeHunkIndex >= hunkCount - 1}
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
            {mode === "diff" && hasDiff && (
              <>
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
