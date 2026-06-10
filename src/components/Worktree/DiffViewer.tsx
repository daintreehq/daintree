import {
  forwardRef,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactElement } from "react";
import {
  parseDiff,
  Diff,
  Hunk,
  Decoration,
  tokenize,
  markEdits,
  expandFromRawCode,
  getCollapsedLinesCountBetween,
} from "react-diff-view";
import type {
  DiffType,
  HunkData,
  HunkTokens,
  RenderGutter,
  TokenizeOptions,
  ViewType,
} from "react-diff-view";
import { refractor } from "refractor/core";
import type { Syntax } from "refractor/core";
import bash from "refractor/bash";
import css from "refractor/css";
import javascript from "refractor/javascript";
import jsx from "refractor/jsx";
import json from "refractor/json";
import markdown from "refractor/markdown";
import tsx from "refractor/tsx";
import typescript from "refractor/typescript";
import "react-diff-view/style/index.css";
import {
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  FileDiff as FileDiffIcon,
  FileQuestion,
  FileWarning,
  FileX,
  UnfoldVertical,
} from "lucide-react";
import { join } from "@shared/utils/path";
import { getLanguageForFile } from "@/components/FileViewer/languageUtils";
import { actionService } from "@/services/ActionService";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  DIFF_SOFT_COLLAPSE_BYTES,
  getFilePath,
  shouldCollapseByDefault,
  estimateFileDiffBytes,
} from "./diffCollapseUtils";
import { formatBytes } from "@/lib/formatBytes";

for (const lang of [bash, css, javascript, jsx, json, markdown, tsx, typescript]) {
  refractor.register(lang);
}

const LANG_LOADERS: Record<string, () => Promise<{ default: Syntax }>> = {
  c: () => import("refractor/c"),
  cpp: () => import("refractor/cpp"),
  csharp: () => import("refractor/csharp"),
  docker: () => import("refractor/docker"),
  go: () => import("refractor/go"),
  graphql: () => import("refractor/graphql"),
  java: () => import("refractor/java"),
  kotlin: () => import("refractor/kotlin"),
  less: () => import("refractor/less"),
  makefile: () => import("refractor/makefile"),
  markup: () => import("refractor/markup"),
  php: () => import("refractor/php"),
  python: () => import("refractor/python"),
  ruby: () => import("refractor/ruby"),
  rust: () => import("refractor/rust"),
  sass: () => import("refractor/sass"),
  scss: () => import("refractor/scss"),
  sql: () => import("refractor/sql"),
  swift: () => import("refractor/swift"),
  toml: () => import("refractor/toml"),
  yaml: () => import("refractor/yaml"),
};

const langLoadPromises = new Map<string, Promise<void>>();
const FAILED_LANGS = new Set<string>();

export function _resetLangStateForTests(): void {
  FAILED_LANGS.clear();
  langLoadPromises.clear();
}

function ensureLanguage(language: string): Promise<void> {
  if (refractor.registered(language)) return Promise.resolve();
  const loader = LANG_LOADERS[language];
  if (!loader) return Promise.resolve();
  let pending = langLoadPromises.get(language);
  if (!pending) {
    pending = loader()
      .then((mod) => {
        refractor.register(mod.default);
      })
      .catch((err: unknown) => {
        console.warn(`Failed to load refractor grammar for "${language}"`, err);
        FAILED_LANGS.add(language);
      });
    langLoadPromises.set(language, pending);
  }
  return pending;
}

export interface DiffViewerProps {
  diff: string;
  viewType?: ViewType;
  /** Absolute path to the worktree root, used to resolve per-file open-in-editor paths */
  rootPath?: string;
  /**
   * Full new-side file content for single-file working-tree diffs. Enables
   * "expand hidden lines" between hunks; omit for branch/ref diffs where the
   * loaded file may not match the diff's new side.
   */
  source?: string | null;
  /** Soft-wrap long lines instead of horizontal scrolling */
  wrapLines?: boolean;
  onRetry?: () => void;
  /** Fired whenever rendered hunk rows change (collapse toggles, context expansion, progressive reveal), so consumers can re-scan the live DOM */
  onToggleCollapse?: () => void;
}

/**
 * Default line number plus a textual +/- marker so insert/delete state never
 * relies on color alone (WCAG 1.4.1; survives forced-colors). Gutters are
 * user-select: none, so markers stay out of copied text.
 */
const renderGutterWithMarker: RenderGutter = ({ change, renderDefault, wrapInAnchor }) => (
  <>
    {wrapInAnchor(renderDefault())}
    <span className="diff-line-marker">
      {change.type === "insert" ? "+" : change.type === "delete" ? "-" : ""}
    </span>
  </>
);

function useTokens(
  hunks: HunkData[],
  language: string,
  enabled: boolean,
  highlight: boolean
): {
  tokens: HunkTokens | null;
  langLoadFailed: boolean;
} {
  const needsGrammar = enabled && highlight;
  const [langReady, setLangReady] = useState(() => refractor.registered(language));
  const [langLoadFailed, setLangLoadFailed] = useState(() => FAILED_LANGS.has(language));

  useEffect(() => {
    if (!needsGrammar) return;
    if (refractor.registered(language)) {
      setLangReady(true);
      setLangLoadFailed(false);
      return;
    }
    setLangReady(false);
    let cancelled = false;
    void ensureLanguage(language).then(() => {
      if (!cancelled) {
        setLangReady(refractor.registered(language));
        setLangLoadFailed(FAILED_LANGS.has(language));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [language, needsGrammar]);

  const [tokens, setTokens] = useState<HunkTokens | null>(null);

  // Two-pass paint: the unhighlighted table commits first, then tokenization
  // runs post-paint and lands as a low-priority update. Collapsed files skip
  // the work entirely until expanded; size-gated files keep markEdits
  // word-level marks but skip the grammar walk (highlight: false).
  useEffect(() => {
    if (!enabled || !hunks.length || (highlight && !langReady)) {
      setTokens(null);
      return;
    }
    let cancelled = false;
    const options: TokenizeOptions = {
      highlight,
      refractor,
      language,
      enhancers: [markEdits(hunks, { type: "block" })],
    };
    startTransition(() => {
      if (cancelled) return;
      try {
        setTokens(tokenize(hunks, options) ?? null);
      } catch {
        setTokens(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hunks, language, langReady, enabled, highlight]);

  return { tokens, langLoadFailed };
}

/**
 * Build an old-side source (indexed by old line numbers, as
 * `expandFromRawCode` expects) from the new-side file content. Unchanged
 * regions are byte-identical between revisions, differing only by the running
 * insert/delete offset — and expansion only ever reads unchanged regions, so
 * positions inside hunks can stay empty.
 */
function buildSyntheticOldSource(newSource: string, hunks: HunkData[]): string[] | null {
  if (!hunks.length) return null;
  const newLines = newSource.split("\n");
  let inserts = 0;
  let deletes = 0;
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      if (change.type === "insert") inserts++;
      else if (change.type === "delete") deletes++;
    }
  }
  const oldTotal = newLines.length - inserts + deletes;
  if (oldTotal <= 0) return null;
  const oldLines = new Array<string>(oldTotal).fill("");
  let delta = 0;
  let prevOldEnd = 0;
  for (const hunk of hunks) {
    if (hunk.oldStart <= prevOldEnd) return null;
    for (let oldLine = prevOldEnd + 1; oldLine < hunk.oldStart; oldLine++) {
      oldLines[oldLine - 1] = newLines[oldLine + delta - 1] ?? "";
    }
    delta += hunk.newLines - hunk.oldLines;
    prevOldEnd = hunk.oldStart + hunk.oldLines - 1;
  }
  for (let oldLine = prevOldEnd + 1; oldLine <= oldTotal; oldLine++) {
    oldLines[oldLine - 1] = newLines[oldLine + delta - 1] ?? "";
  }
  return oldLines;
}

export const DiffViewer = forwardRef<HTMLDivElement, DiffViewerProps>(function DiffViewer(
  { diff, viewType = "split", rootPath, source, wrapLines = false, onRetry, onToggleCollapse },
  ref
) {
  const files = useMemo(() => {
    try {
      const parsed = parseDiff(diff);
      // parseDiff is forgiving — nonsense input yields a synthetic file with
      // empty paths and no hunks. Treat that shape as a parse failure.
      const allEmpty = parsed.every(
        (file) => !file.oldPath && !file.newPath && file.hunks.length === 0
      );
      return allEmpty ? [] : parsed;
    } catch {
      return [];
    }
  }, [diff]);

  // Raw per-file slices of the diff text, used by the per-file copy buttons.
  // Falls back to null (buttons hidden) when the segment count doesn't line up
  // with the parsed files (e.g. non-git-format input).
  const fileTexts = useMemo(() => {
    if (!files.length) return null;
    const starts: number[] = [];
    const re = /^diff --git /gm;
    let match;
    while ((match = re.exec(diff)) !== null) starts.push(match.index);
    if (starts.length !== files.length) return null;
    return starts.map((start, i) => diff.slice(start, starts[i + 1] ?? diff.length));
  }, [diff, files]);

  // Context expansion is only sound when the supplied source is the diff's
  // new side, which callers guarantee only for single-file diffs.
  const oldSource = useMemo(() => {
    if (!source || files.length !== 1) return null;
    const file = files[0];
    if (file.type !== "modify" && file.type !== "rename" && file.type !== "copy") return null;
    return buildSyntheticOldSource(source, file.hunks ?? []);
  }, [source, files]);

  if (!diff || diff === "NO_CHANGES") {
    return (
      <div className="p-8">
        <EmptyState
          variant="zero-data"
          scale="canvas"
          icon={<FileDiffIcon />}
          title="No changes detected"
          instant
        />
      </div>
    );
  }

  if (diff === "BINARY_FILE") {
    return (
      <div className="p-8">
        <EmptyState
          variant="zero-data"
          scale="canvas"
          icon={<FileX />}
          title="Binary file"
          description="Diffs can't be shown for binary content"
          instant
        />
      </div>
    );
  }

  if (diff === "FILE_TOO_LARGE") {
    return (
      <div className="p-8">
        <EmptyState
          variant="zero-data"
          scale="canvas"
          icon={<FileWarning />}
          title="File too large"
          description="Diffs over 1 MB aren't rendered"
          instant
        />
      </div>
    );
  }

  if (diff === "ERROR") {
    return (
      <div className="p-8">
        <EmptyState
          variant="zero-data"
          scale="canvas"
          icon={<FileWarning />}
          title="Couldn't load diff"
          action={
            onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="px-3 py-1.5 text-xs font-medium rounded bg-daintree-border hover:bg-daintree-border/80 text-daintree-text transition-colors"
              >
                Retry
              </button>
            )
          }
          instant
        />
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="p-8">
        <EmptyState
          variant="zero-data"
          scale="canvas"
          icon={<FileQuestion />}
          title="Unable to parse diff"
          instant
        />
      </div>
    );
  }

  return (
    <div ref={ref} className="diff-viewer overflow-auto" data-wrap={wrapLines ? "true" : undefined}>
      {files.map((file, index) => (
        <FileDiff
          key={file.newRevision || file.oldRevision || index}
          file={file}
          rawText={fileTexts?.[index] ?? null}
          viewType={viewType}
          rootPath={rootPath}
          oldSource={files.length === 1 ? oldSource : null}
          onToggleCollapse={onToggleCollapse}
        />
      ))}
    </div>
  );
});

const EXPAND_STEP = 50;
const EXPAND_ALL_MAX = 60;
const INITIAL_VISIBLE_HUNKS = 30;
const SHOW_MORE_HUNKS_STEP = 60;
const COPY_FEEDBACK_MS = 2000;

interface HunkHeaderProps {
  hunk: HunkData;
  /** Old-line-number start of the gap above this hunk (end is hunk.oldStart, exclusive) */
  gapStart: number;
  hiddenCount: number;
  onExpand: ((start: number, end: number) => void) | null;
}

function HunkHeader({ hunk, gapStart, hiddenCount, onExpand }: HunkHeaderProps) {
  return (
    <div className="diff-hunk-header-inner">
      {hiddenCount > 0 && onExpand && (
        <span className="diff-hunk-header-expanders">
          {hiddenCount <= EXPAND_ALL_MAX ? (
            <button type="button" onClick={() => onExpand(gapStart, hunk.oldStart)}>
              <UnfoldVertical className="w-3 h-3" />
              Expand {hiddenCount} {hiddenCount === 1 ? "line" : "lines"}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() =>
                  onExpand(Math.max(hunk.oldStart - EXPAND_STEP, gapStart), hunk.oldStart)
                }
              >
                <UnfoldVertical className="w-3 h-3" />
                Expand {EXPAND_STEP} lines
              </button>
              <button type="button" onClick={() => onExpand(gapStart, hunk.oldStart)}>
                Expand all {hiddenCount}
              </button>
            </>
          )}
        </span>
      )}
      {hiddenCount > 0 && !onExpand && (
        <span className="diff-hunk-header-hidden-count">{hiddenCount} unchanged lines hidden</span>
      )}
      <span className="diff-hunk-header-text">{hunk.content}</span>
    </div>
  );
}

interface FileDiffProps {
  file: ReturnType<typeof parseDiff>[0];
  /** Raw unified-diff text for just this file, when sliceable from the input */
  rawText: string | null;
  viewType: ViewType;
  rootPath?: string;
  /** Synthetic old-side source enabling context expansion (single-file diffs only) */
  oldSource: string[] | null;
  /** Fired whenever this file's rendered hunk rows change (collapse, expansion, reveal) */
  onToggleCollapse?: () => void;
}

function FileDiff({
  file,
  rawText,
  viewType,
  rootPath,
  oldSource,
  onToggleCollapse,
}: FileDiffProps) {
  const relPath = getFilePath(file);
  const language = useMemo(() => {
    const derived = getLanguageForFile(relPath);
    return FAILED_LANGS.has(derived) ? "plaintext" : derived;
  }, [relPath]);
  const diffType: DiffType = file.type as DiffType;

  const fileBytes = useMemo(() => estimateFileDiffBytes(file), [file]);
  const isLargeFile = fileBytes > DIFF_SOFT_COLLAPSE_BYTES;

  const collapseDecision = useMemo(() => shouldCollapseByDefault(file), [file]);
  const [isCollapsed, setIsCollapsed] = useState(collapseDecision.collapse);

  useEffect(() => {
    setIsCollapsed(collapseDecision.collapse);
  }, [collapseDecision.collapse]);

  // Context expansion mutates the rendered hunk set; reset when the file changes.
  const [hunks, setHunks] = useState<HunkData[]>(file.hunks ?? []);
  useEffect(() => {
    setHunks(file.hunks ?? []);
  }, [file]);

  // Progressive reveal for very large expanded files: committing tens of
  // thousands of table cells at once forces a full-table layout pass under
  // width: max-content.
  const [visibleHunkCount, setVisibleHunkCount] = useState(() =>
    isLargeFile ? INITIAL_VISIBLE_HUNKS : Number.POSITIVE_INFINITY
  );
  useEffect(() => {
    setVisibleHunkCount(isLargeFile ? INITIAL_VISIBLE_HUNKS : Number.POSITIVE_INFINITY);
  }, [file, isLargeFile]);

  const visibleHunks = useMemo(
    () => (hunks.length > visibleHunkCount ? hunks.slice(0, visibleHunkCount) : hunks),
    [hunks, visibleHunkCount]
  );
  const hiddenHunkCount = hunks.length - visibleHunks.length;

  const { tokens, langLoadFailed } = useTokens(visibleHunks, language, !isCollapsed, !isLargeFile);

  // Gutter columns get an explicit width sized to the widest line number plus
  // the +/- marker, published as a CSS var that also positions the second
  // sticky gutter column.
  const gutterWidth = useMemo(() => {
    let maxLine = 1;
    for (const hunk of visibleHunks) {
      maxLine = Math.max(
        maxLine,
        hunk.oldStart + hunk.oldLines - 1,
        hunk.newStart + hunk.newLines - 1
      );
    }
    const digits = Math.max(3, String(maxLine).length);
    return `calc(${digits + 1}ch + 21px)`;
  }, [visibleHunks]);

  const diffRegionId = useMemo(
    () =>
      `diff-region-${file.oldPath || "dst"}-${file.newPath || "src"}-${file.newRevision || file.oldRevision || "unknown"}`,
    [file.newPath, file.oldPath, file.newRevision, file.oldRevision]
  );

  const { additions, deletions } = useMemo(() => {
    let adds = 0;
    let dels = 0;
    for (const hunk of file.hunks ?? []) {
      for (const change of hunk.changes) {
        if (change.type === "insert") adds++;
        else if (change.type === "delete") dels++;
      }
    }
    return { additions: adds, deletions: dels };
  }, [file.hunks]);

  const absolutePath =
    rootPath && relPath && !relPath.startsWith("/") ? join(rootPath, relPath) : relPath || null;

  const firstHunkLine = file.hunks?.[0]?.newStart;

  const [fileCopied, setFileCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const handleCopyFileDiff = useCallback(async () => {
    if (!rawText) return;
    try {
      await navigator.clipboard.writeText(rawText);
      setFileCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setFileCopied(false), COPY_FEEDBACK_MS);
    } catch {
      // Silently fail
    }
  }, [rawText]);

  const handleOpenInEditor = () => {
    if (!absolutePath) return;
    void actionService.dispatch(
      "file.openInEditor",
      { path: absolutePath, line: firstHunkLine },
      { source: "user" }
    );
  };

  const handleToggleCollapse = () => {
    // Notify consumers on every toggle so they can re-scan the hunk rows that
    // just appeared (expand) or disappeared (collapse) — the hunk indicator and
    // scroll tracking attach to live DOM and must follow both transitions.
    onToggleCollapse?.();
    setIsCollapsed((prev) => !prev);
  };

  const handleExpandContext = useCallback(
    (start: number, end: number) => {
      if (!oldSource) return;
      setHunks((prev) => {
        try {
          return expandFromRawCode(prev, oldSource, start, end);
        } catch {
          return prev;
        }
      });
      onToggleCollapse?.();
    },
    [oldSource, onToggleCollapse]
  );

  const handleShowMoreHunks = () => {
    setVisibleHunkCount((count) => count + SHOW_MORE_HUNKS_STEP);
    onToggleCollapse?.();
  };

  const fileStyle: CSSProperties & Record<"--diff-gutter-width", string> = {
    "--diff-gutter-width": gutterWidth,
  };

  const oldTotalLines = oldSource?.length ?? null;
  const allHunksVisible = hiddenHunkCount === 0;
  const lastVisibleHunk = visibleHunks[visibleHunks.length - 1];
  const trailingGapStart = lastVisibleHunk
    ? lastVisibleHunk.oldStart + lastVisibleHunk.oldLines
    : null;
  const trailingHiddenCount =
    allHunksVisible && oldTotalLines !== null && trailingGapStart !== null
      ? Math.max(0, oldTotalLines - trailingGapStart + 1)
      : 0;

  const renderHunkRows = (rendered: HunkData[]): ReactElement[] => {
    const rows: ReactElement[] = [];
    for (let i = 0; i < rendered.length; i++) {
      const hunk = rendered[i];
      if (!hunk) continue;
      const previous = (i === 0 ? null : rendered[i - 1]) ?? null;
      const hiddenCount = Math.max(0, getCollapsedLinesCountBetween(previous, hunk));
      const gapStart = previous ? previous.oldStart + previous.oldLines : 1;
      rows.push(
        <Decoration key={`decoration-${hunk.oldStart}-${hunk.newStart}`}>
          <HunkHeader
            hunk={hunk}
            gapStart={gapStart}
            hiddenCount={hiddenCount}
            onExpand={oldSource ? handleExpandContext : null}
          />
        </Decoration>
      );
      rows.push(<Hunk key={`${hunk.oldStart}-${hunk.newStart}`} hunk={hunk} />);
    }
    if (trailingHiddenCount > 0 && trailingGapStart !== null && oldTotalLines !== null) {
      rows.push(
        <Decoration key="decoration-trailing">
          <div className="diff-hunk-header-inner">
            <span className="diff-hunk-header-expanders">
              <button
                type="button"
                onClick={() => handleExpandContext(trailingGapStart, oldTotalLines + 1)}
              >
                <UnfoldVertical className="w-3 h-3" />
                Expand {trailingHiddenCount} {trailingHiddenCount === 1 ? "line" : "lines"}
              </button>
            </span>
          </div>
        </Decoration>
      );
    }
    return rows;
  };

  return (
    <div className="mb-2" style={fileStyle}>
      {relPath && (
        <div className="sticky top-0 z-10 flex items-center justify-between px-3 py-1.5 bg-daintree-sidebar border-b border-daintree-border text-xs font-mono">
          <TruncatedTooltip content={relPath}>
            <span className="truncate text-daintree-text/80">{relPath}</span>
          </TruncatedTooltip>
          {langLoadFailed && (
            <span
              className="text-xs text-text-muted"
              role="status"
              data-testid="diff-plain-text-badge"
            >
              Plain text
            </span>
          )}
          {!langLoadFailed && isLargeFile && !isCollapsed && (
            <span className="text-xs text-text-muted" data-testid="diff-highlight-off-badge">
              Highlighting off for large diff
            </span>
          )}
          <div className="flex items-center gap-2 shrink-0 text-daintree-text/60">
            {(additions > 0 || deletions > 0) && (
              <span className="flex items-center gap-1">
                {additions > 0 && <span className="text-status-success">+{additions}</span>}
                {deletions > 0 && <span className="text-status-danger">-{deletions}</span>}
              </span>
            )}
            {rawText && (
              <button
                onClick={() => void handleCopyFileDiff()}
                title={fileCopied ? "Copied!" : "Copy file diff"}
                aria-label={fileCopied ? "Copied!" : "Copy file diff"}
                className="shrink-0 flex items-center px-1.5 py-0.5 rounded hover:bg-tint/5 hover:text-daintree-text transition-colors"
              >
                {fileCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              </button>
            )}
            {absolutePath && (
              <button
                onClick={handleOpenInEditor}
                title={`Open in editor${firstHunkLine ? ` at line ${firstHunkLine}` : ""}`}
                className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded hover:bg-tint/5 hover:text-daintree-text transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
                Open
              </button>
            )}
          </div>
        </div>
      )}
      {collapseDecision.collapse && (
        <button
          onClick={handleToggleCollapse}
          aria-expanded={!isCollapsed}
          {...(!isCollapsed ? { "aria-controls": diffRegionId } : {})}
          className="flex w-full items-center gap-2 px-3 py-2 text-xs text-text-muted hover:bg-tint/5 transition-colors"
        >
          <ChevronRight
            className={`h-3 w-3 shrink-0 transition-transform duration-150 ${isCollapsed ? "" : "rotate-90"}`}
          />
          <span className="text-left">
            {collapseDecision.reason === "generated"
              ? "Generated file collapsed"
              : `Large diff (${formatBytes(fileBytes)})`}
          </span>
          <span className="ml-auto text-daintree-text/50 font-mono text-xs">
            {isCollapsed ? "Show diff" : "Hide diff"}
          </span>
        </button>
      )}
      {!isCollapsed && (
        <div
          id={diffRegionId}
          className="diff-file-scroll"
          tabIndex={0}
          role="region"
          aria-label={relPath || "Diff"}
        >
          <Diff
            viewType={viewType}
            diffType={diffType}
            hunks={visibleHunks}
            tokens={tokens ?? undefined}
            renderGutter={renderGutterWithMarker}
            optimizeSelection
          >
            {renderHunkRows}
          </Diff>
          {hiddenHunkCount > 0 && (
            <button
              type="button"
              onClick={handleShowMoreHunks}
              className="flex w-full items-center justify-center gap-2 px-3 py-2 text-xs text-text-muted hover:bg-tint/5 transition-colors"
            >
              <UnfoldVertical className="w-3 h-3" />
              Show {Math.min(hiddenHunkCount, SHOW_MORE_HUNKS_STEP)} more{" "}
              {hiddenHunkCount === 1 ? "hunk" : "hunks"} ({hiddenHunkCount} remaining)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
