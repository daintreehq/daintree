import {
  forwardRef,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";
import {
  parseDiff,
  Diff,
  Hunk,
  Decoration,
  getChangeKey,
  expandFromRawCode,
  getCollapsedLinesCountBetween,
} from "react-diff-view";
import type {
  ChangeData,
  DiffType,
  HunkData,
  HunkTokens,
  RenderGutter,
  RenderToken,
  TokenNode,
  ViewType,
} from "react-diff-view";
import "react-diff-view/style/index.css";
// Our overrides — must come after the library stylesheet it overrides.
import "./DiffViewer.css";
import {
  Check,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
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
import { useScopedSelectAll } from "@/hooks/useScopedSelectAll";
import { actionService } from "@/services/ActionService";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  DIFF_SOFT_COLLAPSE_BYTES,
  getFilePath,
  shouldCollapseByDefault,
  estimateFileDiffBytes,
  estimateHunksBytes,
} from "./diffCollapseUtils";
import { detectMovedLines } from "./diffMovedUtils";
import { computeSearchRanges, computeTrailingWsRanges } from "./diffTokenRanges";
import type { SideRanges } from "./diffTokenRanges";
import { isLanguageFailed } from "./diffRefractor";
import { diffTokenizeClient } from "@/services/DiffTokenizeService";
import { formatBytes } from "@/lib/formatBytes";

export { _resetLangStateForTests, _flushLangLoadsForTests } from "./diffRefractor";

/**
 * Why a requested full-file view fell back to the plain diff.
 * - `source-mismatch`: the supplied source isn't the diff's new side, so its
 *   lines would be context from different code.
 * - `too-large`: expanding would commit more rows than the un-virtualized
 *   table can render responsively.
 * - `unsupported`: the diff has no expandable single-file modify shape.
 */
export type FullFileUnavailableReason = "source-mismatch" | "too-large" | "unsupported";

/**
 * Row ceiling for full-file expansion. `expandFromRawCode` merges adjacent
 * hunks, so a fully expanded file becomes one hunk that the per-hunk
 * progressive reveal can no longer stage — every row commits in a single
 * layout pass. Until the table is virtualized this is the backstop.
 */
export const FULL_FILE_MAX_LINES = 5000;

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
  /**
   * Expand every gap so the rendered diff covers the whole file. Requires
   * `source`; without a usable one the diff renders unexpanded and
   * `onFullFileVerdict` fires so the host can explain why.
   */
  fullFile?: boolean;
  /**
   * The verdict on a requested `fullFile`, with the `source` it was judged
   * against. Lets the host surface one explanation in its own chrome instead of
   * the viewer growing a second banner system.
   *
   * Fires with `null` on success too: a host that only heard about failures
   * couldn't tell a current verdict from a superseded one, and would keep
   * showing the last refusal after a refresh made the expansion work.
   */
  onFullFileVerdict?: (
    reason: FullFileUnavailableReason | null,
    forSource: string | null | undefined
  ) => void;
  /** Soft-wrap long lines instead of horizontal scrolling */
  wrapLines?: boolean;
  /** Case-insensitive plain-text query; matches render as .diff-search-match spans */
  searchQuery?: string;
  onRetry?: () => void;
  /** Fired whenever rendered hunk rows change (collapse toggles, context expansion, progressive reveal), so consumers can re-scan the live DOM */
  onToggleCollapse?: () => void;
  /** Fired after a file's token pass commits (highlighting, search marks) — the signal that .diff-search-match spans are scannable */
  onTokensRendered?: () => void;
}

/**
 * Default line number plus a textual +/- marker so insert/delete state never
 * relies on color alone (WCAG 1.4.1; survives forced-colors). Gutters are
 * user-select: none, so markers stay out of copied text.
 */
const renderGutterWithMarker: RenderGutter = ({ change, renderDefault, wrapInAnchor }) => (
  <>
    <span className="diff-line-number">{wrapInAnchor(renderDefault())}</span>
    <span className="diff-line-marker">
      {change.type === "insert" ? "+" : change.type === "delete" ? "-" : ""}
    </span>
  </>
);

/** Moved-aware variant: adds screen-reader text so relocation isn't styling-only. */
function makeGutterRenderer(movedKeys: ReadonlySet<string>): RenderGutter {
  if (movedKeys.size === 0) return renderGutterWithMarker;
  const render: RenderGutter = ({ change, renderDefault, wrapInAnchor }) => (
    <>
      <span className="diff-line-number">{wrapInAnchor(renderDefault())}</span>
      <span className="diff-line-marker">
        {change.type === "insert" ? "+" : change.type === "delete" ? "-" : ""}
      </span>
      {change.type !== "normal" && movedKeys.has(getChangeKey(change)) && (
        <span className="sr-only">moved</span>
      )}
    </>
  );
  return render;
}

function flattenTokenText(token: TokenNode): string {
  if (typeof token.value === "string") return token.value;
  if (!token.children) return "";
  let text = "";
  for (const child of token.children) {
    text += flattenTokenText(child);
  }
  return text;
}

function renderWhitespaceGlyphs(text: string): ReactElement[] {
  const out: ReactElement[] = [];
  let spaceRun = "";
  const flushSpaces = () => {
    if (!spaceRun) return;
    out.push(
      <span key={out.length} className="diff-ws diff-ws-space">
        {spaceRun}
      </span>
    );
    spaceRun = "";
  };
  for (const ch of text) {
    if (ch === " ") {
      spaceRun += ch;
    } else {
      flushSpaces();
      out.push(
        <span key={out.length} className="diff-ws diff-ws-tab">
          {"\t"}
        </span>
      );
    }
  }
  flushSpaces();
  return out;
}

/**
 * Whitespace-only edit segments are otherwise invisible — the highlight pill
 * has no glyphs in it. Overlay · / → markers via CSS while keeping the real
 * space/tab characters as the DOM text, so copied code stays byte-identical.
 * Edits containing visible characters render normally; their pill boundary
 * already shows what changed.
 */
export const renderTokenWithInvisibles: RenderToken = (token, renderDefault, index) => {
  if (token.type !== "edit") return renderDefault(token, index);
  const text = flattenTokenText(token);
  if (!text || /[^ \t]/.test(text)) return renderDefault(token, index);
  return (
    <span key={index} className="diff-code-edit diff-ws-visualized">
      {renderWhitespaceGlyphs(text)}
    </span>
  );
};

interface TokenizePass {
  hunks: HunkData[];
  language: string;
  highlight: boolean;
  tokens: HunkTokens | null;
  langLoadFailed: boolean;
}

function useTokens(
  hunks: HunkData[],
  language: string,
  enabled: boolean,
  highlight: boolean,
  extraRanges: SideRanges | null
): {
  tokens: HunkTokens | null;
  langLoadFailed: boolean;
} {
  const requestKey = useId();
  const [pass, setPass] = useState<TokenizePass | null>(null);

  // Two-pass paint: the unhighlighted table commits first, then tokenization
  // runs in the diff-tokenize worker and lands as a low-priority update.
  // Collapsed files skip the work entirely until expanded; size-gated files
  // keep markEdits word-level marks but skip the grammar walk (highlight:
  // false). While a request is in flight the previous pass keeps rendering —
  // tokens are dropped at derivation when the hunks, language, or highlight
  // mode they were built from change, so a stale tree never mismatches the
  // rendered rows or the active grammar. extraRanges is deliberately not
  // gated: keeping the previous search marks visible until the new pass lands
  // mirrors the old useDeferredValue semantics.
  useEffect(() => {
    if (!enabled || !hunks.length) {
      setPass(null);
      return;
    }
    let cancelled = false;
    void diffTokenizeClient
      .tokenize(requestKey, { hunks, language, highlight, extraRanges })
      .then((result) => {
        if (cancelled || !result) return;
        startTransition(() => {
          setPass({
            hunks,
            language,
            highlight,
            tokens: result.tokens,
            langLoadFailed: result.langLoadFailed,
          });
        });
      });
    return () => {
      cancelled = true;
    };
  }, [hunks, language, enabled, highlight, extraRanges, requestKey]);

  const passCurrent = pass !== null && pass.hunks === hunks && pass.language === language;
  return {
    tokens: passCurrent && pass.highlight === highlight ? pass.tokens : null,
    langLoadFailed: passCurrent ? pass.langLoadFailed : isLanguageFailed(language),
  };
}

/**
 * Estimate a line's rendered width in monospace columns for the centered-split
 * scroll range. Tabs count at the default tab-size of 8 (a deliberate
 * overestimate — tabs advance to the next stop, so the real width is ≤ this;
 * the only cost is extra blank scroll space past the longest line). CJK and
 * other wide glyphs occupy two columns, so they count once more.
 */
const WIDE_CHAR_RE =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}/gu;
const NON_ASCII_RE = /[^\u0020-\u00FF]/;

function estimateLineColumns(text: string): number {
  let cols = text.length;
  if (text.includes("\t")) {
    cols += (text.match(/\t/g) ?? []).length * 7;
  }
  if (NON_ASCII_RE.test(text)) {
    cols += (text.match(WIDE_CHAR_RE) ?? []).length;
  }
  return cols;
}

/**
 * Split file content into its lines. A file ending in a newline splits with a
 * trailing empty element that is not a line of the file — left in, it renders
 * as a phantom blank row at the end of every expanded file and shifts the line
 * count used for the size ceiling.
 */
function toSourceLines(source: string): string[] {
  // A zero-byte file has no lines; splitting it would claim one empty line and
  // push the reconstructed old side one line long.
  if (source === "") return [];
  const lines = source.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  // A CRLF checkout leaves a carriage return on every line of the disk read
  // that git's diff output doesn't carry. Left in, every line compares unequal
  // and the whole feature reads as a permanent mismatch on Windows.
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Confirm the supplied source really is the diff's new side before any of it is
 * shown as context.
 *
 * `buildSyntheticOldSource` trusts the source completely — it reconstructs the
 * old side by indexing into it at hunk offsets, so a source that has drifted
 * from the diff (the file edited between the two reads, or a revision the diff
 * was never generated against) yields believable-looking context lines that
 * belong to different code. Every hunk already carries its own new-side lines,
 * which gives a cheap way to check: they must appear verbatim at `newStart`.
 */
function sourceMatchesHunks(newLines: string[], hunks: HunkData[]): boolean {
  if (!hunks.length) return false;
  for (const hunk of hunks) {
    let lineNumber = hunk.newStart;
    for (const change of hunk.changes) {
      // Deletes exist only on the old side and occupy no new-side line.
      if (change.type === "delete") continue;
      if (newLines[lineNumber - 1] !== change.content) return false;
      lineNumber++;
    }
    // A hunk claiming more new-side lines than it listed means the diff and the
    // source disagree about the file's shape.
    if (lineNumber !== hunk.newStart + hunk.newLines) return false;
  }
  return true;
}

/**
 * Build an old-side source (indexed by old line numbers, as
 * `expandFromRawCode` expects) from the new-side file content. Unchanged
 * regions are byte-identical between revisions, differing only by the running
 * insert/delete offset — and expansion only ever reads unchanged regions, so
 * positions inside hunks can stay empty.
 */
function buildSyntheticOldSource(newLines: string[], hunks: HunkData[]): string[] | null {
  if (!hunks.length) return null;
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
  {
    diff,
    viewType = "split",
    rootPath,
    source,
    fullFile = false,
    onFullFileVerdict,
    wrapLines = false,
    searchQuery,
    onRetry,
    onToggleCollapse,
    onTokensRendered,
  },
  ref
) {
  // Select All over a diff has no owner, so the native Edit-menu command falls
  // back to the whole app (#12135). Claim it for the diff body. The root also
  // carries a forwarded ref, so publish to both.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useScopedSelectAll(rootRef);
  const setRoot = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref]
  );

  // Keep keystrokes responsive: highlighting re-tokenizes the whole file, so
  // the query lands as a deferred value and the table catches up after paint.
  const deferredSearchQuery = useDeferredValue(searchQuery ?? "");
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
  // new side, which callers guarantee only for single-file diffs — and which
  // `sourceMatchesHunks` then verifies, since a caller's guarantee can still be
  // defeated by the file changing between the diff and the source read.
  //
  // The rejection reason is carried alongside so a requested full-file view can
  // say why it fell back rather than silently rendering the plain diff.
  const expansion = useMemo<{
    oldSource: string[] | null;
    reason: FullFileUnavailableReason | null;
  }>(() => {
    if (source == null) return { oldSource: null, reason: null };
    if (files.length !== 1) return { oldSource: null, reason: "unsupported" };
    const file = files[0];
    if (file.type !== "modify" && file.type !== "rename" && file.type !== "copy") {
      return { oldSource: null, reason: "unsupported" };
    }
    const hunks = file.hunks ?? [];
    // A diff with no hunks (a pure rename, a mode change) has no gaps to fill.
    // Reporting that as a mismatch would tell the user their file changed.
    if (!hunks.length) return { oldSource: null, reason: "unsupported" };
    const newLines = toSourceLines(source);
    if (!sourceMatchesHunks(newLines, hunks)) {
      return { oldSource: null, reason: "source-mismatch" };
    }
    const built = buildSyntheticOldSource(newLines, hunks);
    if (built === null) return { oldSource: null, reason: "unsupported" };
    // Both sides are rendered, and they diverge: inserting 2,000 lines into a
    // 4,000-line file leaves the old side under the ceiling while the new side
    // is well past it. The larger side is what the table has to carry.
    if (Math.max(built.length, newLines.length) > FULL_FILE_MAX_LINES) {
      return { oldSource: built, reason: "too-large" };
    }
    return { oldSource: built, reason: null };
  }, [source, files]);
  const oldSource = expansion.oldSource;

  // A file past the row ceiling keeps its per-gap expanders (the user can still
  // reveal context deliberately) but never auto-expands wholesale.
  const fullFileBlocked = expansion.reason !== null;
  const effectiveFullFile = fullFile && !fullFileBlocked;

  useEffect(() => {
    if (fullFile) onFullFileVerdict?.(expansion.reason, source);
  }, [fullFile, expansion.reason, onFullFileVerdict, source]);

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
                className="px-3 py-1.5 text-xs font-medium rounded bg-border-default hover:bg-daintree-border/80 text-text-primary transition-colors"
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
    <div ref={setRoot} className="diff-viewer" data-wrap={wrapLines ? "true" : undefined}>
      {files.map((file, index) => (
        <FileDiff
          key={file.newRevision || file.oldRevision || index}
          file={file}
          rawText={fileTexts?.[index] ?? null}
          viewType={viewType}
          wrapLines={wrapLines}
          searchQuery={deferredSearchQuery}
          rootPath={rootPath}
          oldSource={files.length === 1 ? oldSource : null}
          fullFile={effectiveFullFile}
          onToggleCollapse={onToggleCollapse}
          onTokensRendered={onTokensRendered}
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

function HunkCopyButton({ hunk }: { hunk: HunkData }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = async () => {
    // New-side text (what the code looks like after the change); a pure
    // deletion falls back to the removed lines so the button never copies "".
    const newSide = hunk.changes.filter((c) => c.type !== "delete").map((c) => c.content);
    const lines = newSide.length ? newSide : hunk.changes.map((c) => c.content);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      // Silently fail
    }
  };

  return (
    <button
      type="button"
      className="diff-hunk-header-copy"
      data-copied={copied || undefined}
      onClick={() => void handleCopy()}
      aria-label={copied ? "Copied!" : "Copy hunk"}
      title={copied ? "Copied!" : "Copy hunk (new side)"}
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
    </button>
  );
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
                title={`Show ${EXPAND_STEP} lines above this hunk`}
                onClick={() =>
                  onExpand(Math.max(hunk.oldStart - EXPAND_STEP, gapStart), hunk.oldStart)
                }
              >
                <ChevronsUp className="w-3 h-3" />
                Expand up
              </button>
              <button
                type="button"
                title={`Show ${EXPAND_STEP} lines below the previous hunk`}
                onClick={() => onExpand(gapStart, Math.min(gapStart + EXPAND_STEP, hunk.oldStart))}
              >
                <ChevronsDown className="w-3 h-3" />
                Expand down
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
      <HunkCopyButton hunk={hunk} />
    </div>
  );
}

interface FileDiffProps {
  file: ReturnType<typeof parseDiff>[0];
  /** Raw unified-diff text for just this file, when sliceable from the input */
  rawText: string | null;
  viewType: ViewType;
  /** Soft-wrap mode (disables the centered-split horizontal scroll system) */
  wrapLines: boolean;
  /** Already-deferred search query ("" when search is inactive) */
  searchQuery: string;
  rootPath?: string;
  /** Synthetic old-side source enabling context expansion (single-file diffs only) */
  oldSource: string[] | null;
  /** Render every line of the file rather than the changed regions and their context */
  fullFile: boolean;
  /** Fired whenever this file's rendered hunk rows change (collapse, expansion, reveal) */
  onToggleCollapse?: () => void;
  /** Fired after this file's token pass commits */
  onTokensRendered?: () => void;
}

function FileDiff({
  file,
  rawText,
  viewType,
  wrapLines,
  searchQuery,
  rootPath,
  oldSource,
  fullFile,
  onToggleCollapse,
  onTokensRendered,
}: FileDiffProps) {
  const relPath = getFilePath(file);
  const language = useMemo(() => {
    const derived = getLanguageForFile(relPath);
    return isLanguageFailed(derived) ? "plaintext" : derived;
  }, [relPath]);
  const diffType: DiffType = file.type as DiffType;

  const fileBytes = useMemo(() => estimateFileDiffBytes(file), [file]);
  // Whether the diff *as authored* is large. Drives the collapse-by-default and
  // progressive-reveal decisions, which are statements about the change itself
  // and must not shift when the user expands context.
  const isLargeDiff = fileBytes > DIFF_SOFT_COLLAPSE_BYTES;

  const collapseDecision = useMemo(() => shouldCollapseByDefault(file), [file]);
  const [isCollapsed, setIsCollapsed] = useState(collapseDecision.collapse);

  useEffect(() => {
    setIsCollapsed(collapseDecision.collapse);
  }, [collapseDecision.collapse]);

  // Manual per-gap expansion. Reset when the file changes, and when the source
  // changes under it — context revealed from a previous revision must not
  // survive into a newly loaded one.
  const [hunks, setHunks] = useState<HunkData[]>(file.hunks ?? []);
  useEffect(() => {
    setHunks(file.hunks ?? []);
  }, [file, oldSource]);

  // Full file is derived from the file's own hunks rather than folded into
  // `hunks`, so toggling it off restores whatever the user had manually
  // expanded instead of discarding it.
  const renderedHunks = useMemo(() => {
    if (!fullFile || !oldSource) return hunks;
    try {
      // `end` is exclusive, so the last line needs length + 1.
      return expandFromRawCode(file.hunks ?? [], oldSource, 1, oldSource.length + 1);
    } catch {
      return hunks;
    }
  }, [fullFile, oldSource, file, hunks]);

  // Progressive reveal for very large expanded files: committing tens of
  // thousands of table cells at once forces a full-table layout pass under
  // width: max-content.
  const [visibleHunkCount, setVisibleHunkCount] = useState(() =>
    isLargeDiff ? INITIAL_VISIBLE_HUNKS : Number.POSITIVE_INFINITY
  );
  useEffect(() => {
    setVisibleHunkCount(isLargeDiff ? INITIAL_VISIBLE_HUNKS : Number.POSITIVE_INFINITY);
  }, [file, isLargeDiff]);

  const visibleHunks = useMemo(
    () =>
      renderedHunks.length > visibleHunkCount
        ? renderedHunks.slice(0, visibleHunkCount)
        : renderedHunks,
    [renderedHunks, visibleHunkCount]
  );
  const hiddenHunkCount = renderedHunks.length - visibleHunks.length;

  // Measured from what is actually being rendered, not from the parsed diff:
  // expansion merges hunks and grows them without end, so a small diff in a
  // large file would otherwise keep the cheap-to-highlight verdict it earned
  // while collapsed.
  const isLargeRender = useMemo(
    () => estimateHunksBytes(visibleHunks) > DIFF_SOFT_COLLAPSE_BYTES,
    [visibleHunks]
  );

  // Moved-block detection shares the large-file gate with syntax highlighting:
  // past the soft-collapse threshold the diff is churn, not review material.
  const movedKeys = useMemo(
    () => (isCollapsed || isLargeRender ? null : detectMovedLines(visibleHunks)),
    [visibleHunks, isCollapsed, isLargeRender]
  );

  const renderGutter = useMemo(
    () => (movedKeys ? makeGutterRenderer(movedKeys) : renderGutterWithMarker),
    [movedKeys]
  );

  const generateLineClassName = useCallback(
    ({ changes, defaultGenerate }: { changes: ChangeData[]; defaultGenerate: () => string }) => {
      const base = defaultGenerate();
      if (!movedKeys?.size) return base;
      let extra = "";
      for (const change of changes) {
        if (!change || change.type === "normal") continue;
        if (!movedKeys.has(getChangeKey(change))) continue;
        extra += change.type === "insert" ? " diff-line-moved-new" : " diff-line-moved-old";
      }
      return extra ? base + extra : base;
    },
    [movedKeys]
  );

  const searchRanges = useMemo(
    () => (searchQuery && !isCollapsed ? computeSearchRanges(visibleHunks, searchQuery) : null),
    [visibleHunks, searchQuery, isCollapsed]
  );

  const trailingWsRanges = useMemo(() => computeTrailingWsRanges(visibleHunks), [visibleHunks]);

  const extraRanges = useMemo<SideRanges | null>(() => {
    if (!searchRanges && trailingWsRanges.length === 0) return null;
    return {
      old: searchRanges?.old ?? [],
      new: [...trailingWsRanges, ...(searchRanges?.new ?? [])],
    };
  }, [searchRanges, trailingWsRanges]);

  const { tokens, langLoadFailed } = useTokens(
    visibleHunks,
    language,
    !isCollapsed,
    !isLargeRender,
    extraRanges
  );

  useEffect(() => {
    onTokensRendered?.();
  }, [tokens, onTokensRendered]);

  // Single notification point for the rendered row set changing — manual gap
  // expansion, progressive reveal, the full-file scope, and a source arriving
  // after the diff all land here, so each fires exactly once and none can be
  // forgotten. Collapse/expand is separate: it changes visibility, not rows,
  // and notifies from its own handler. The first commit is the initial render
  // rather than a transition, so the ref starts already-notified.
  const lastNotifiedHunksRef = useRef(visibleHunks);
  useEffect(() => {
    if (lastNotifiedHunksRef.current === visibleHunks) return;
    lastNotifiedHunksRef.current = visibleHunks;
    onToggleCollapse?.();
  }, [visibleHunks, onToggleCollapse]);

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

  // Centered split: both panes get a fixed half of the viewport and share one
  // horizontal scroll offset, instead of the old-side column growing to its
  // longest line and shoving the new side off-screen. Only applies to true
  // two-column tables — add/delete files render a single full-width side
  // ("monotonous" in react-diff-view), and wrap mode has no horizontal
  // overflow at all.
  const isCenteredSplit =
    viewType === "split" &&
    !wrapLines &&
    (diffType === "modify" || diffType === "rename" || diffType === "copy");

  // Longest rendered line in monospace columns, sizing the shared scrollbar's
  // range (published as --diff-max-line in ch units).
  const maxLineCols = useMemo(() => {
    if (!isCenteredSplit) return 0;
    let max = 0;
    for (const hunk of visibleHunks) {
      for (const change of hunk.changes) {
        const cols = estimateLineColumns(change.content);
        if (cols > max) max = cols;
      }
    }
    return max;
  }, [visibleHunks, isCenteredSplit]);

  // Unified and single-side (add/delete) tables keep a real native
  // overflow-x scroller and get the sticky strip as a *sibling* proxy that
  // mirrors its offset, rather than replacing it the way centered split does.
  // Keeping the native scroller preserves everything the browser gives for
  // free — find-in-page reveal, scrollIntoView, drag-select autoscroll,
  // shift+wheel and trackpad panning, arrow keys. Wrap mode has no horizontal
  // overflow at all, so it gets no strip.
  const usesNativeHScrollProxy = !isCenteredSplit && !wrapLines;

  const regionRef = useRef<HTMLDivElement | null>(null);
  const hScrollbarRef = useRef<HTMLDivElement | null>(null);
  const nativeScrollerRef = useRef<HTMLDivElement | null>(null);

  // The scrollbar strip is the single scroll surface for both panes: its
  // scrollLeft becomes --diff-hscroll, which shifts every code cell's content
  // via text-indent — the shared offset is what locks the two sides together.
  // Written straight to the DOM (not state) so scrolling never re-renders the
  // diff tree.
  const handleHScroll = useCallback(() => {
    const region = regionRef.current;
    const bar = hScrollbarRef.current;
    if (!region || !bar) return;
    region.style.setProperty("--diff-hscroll", `${bar.scrollLeft}px`);
  }, []);

  // Two-way scrollLeft mirroring between the real scroller and its proxy strip.
  // Deliberately no re-entrancy flag: a synchronously cleared flag can't guard
  // a scroll event that arrives asynchronously anyway. Instead the write is
  // skipped once the two already agree, so the echo event each write triggers
  // finds them equal and stops there.
  //
  // The read-back is not belt-and-braces. If the target clamps the write — its
  // scroll range is the shorter of the two — it lands on a *different* value
  // and fires no scroll event at all, because from its point of view nothing
  // moved. Waiting for an echo would leave the pair permanently out of step, so
  // the landed value is pushed back to the source instead. That second write
  // can never clamp in turn — a clamp only ever moves a value *closer* to the
  // shared zero endpoint (RTL runs [-max, 0], so its clamped offsets are
  // numerically greater), which always lands inside the source's own range.
  // That is what makes this settle within the one call.
  const syncNativeHScroll = useCallback((source: "content" | "proxy") => {
    const content = nativeScrollerRef.current;
    const proxy = hScrollbarRef.current;
    if (!content || !proxy) return;
    const from = source === "content" ? content : proxy;
    const to = source === "content" ? proxy : content;
    const target = from.scrollLeft;
    if (to.scrollLeft === target) return;
    to.scrollLeft = target;
    if (to.scrollLeft !== target && from.scrollLeft === target) from.scrollLeft = to.scrollLeft;
  }, []);

  const handleNativeHScroll = useCallback(() => {
    syncNativeHScroll("content");
  }, [syncNativeHScroll]);

  const handleNativeProxyScroll = useCallback(() => {
    syncNativeHScroll("proxy");
  }, [syncNativeHScroll]);

  // Trackpad/wheel gestures over the diff forward their horizontal component
  // to the scrollbar strip. Native listener because React delegates wheel as
  // passive, which would make preventDefault a no-op.
  useEffect(() => {
    if (!isCenteredSplit) return;
    const region = regionRef.current;
    if (!region) return;
    const onWheel = (event: WheelEvent) => {
      const bar = hScrollbarRef.current;
      if (!bar) return;
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      const maxScroll = bar.scrollWidth - bar.clientWidth;
      if (maxScroll <= 0) return;
      const next = Math.min(maxScroll, Math.max(0, bar.scrollLeft + event.deltaX));
      if (next !== bar.scrollLeft) {
        bar.scrollLeft = next;
        event.preventDefault();
      }
    };
    region.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      region.removeEventListener("wheel", onWheel);
    };
  }, [isCenteredSplit]);

  // Keep the centered indent in sync when the scroll system mounts/unmounts or
  // content changes under a non-zero offset (wrap toggle round-trip, collapse,
  // hunk reveal) — the strip may clamp scrollLeft without firing a scroll
  // event. The native path re-syncs inside its measurement effect instead,
  // because its proxy range depends on a spacer width published there.
  //
  // Layout, not passive, for the same reason as the measurement below: React
  // reuses this div and the strip node across the centered/native branches, so
  // the strip can arrive here still holding the native path's offset while the
  // reused div still holds the old --diff-hscroll. Reconciling that passively
  // paints one frame of code at the wrong indent.
  useLayoutEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    region.style.setProperty("--diff-hscroll", `${hScrollbarRef.current?.scrollLeft ?? 0}px`);
  }, [isCenteredSplit, isCollapsed, visibleHunks]);

  // The strip only takes up vertical space when there is real overflow to
  // scroll. Centered split measures its own spacer (an estimate of the longest
  // line) against the strip's width; the native path measures the real
  // scroller and publishes that scrollWidth so the proxy's range matches the
  // content exactly instead of estimating it. Both observe a second element —
  // the content box, not just the container — because ResizeObserver never
  // fires for a scrollWidth-only change. `isCollapsed` is a dependency because
  // re-expanding a file remounts both elements, and `usesNativeHScrollProxy`
  // because a unified wrap toggle never changes `isCenteredSplit`.
  const [hasHOverflow, setHasHOverflow] = useState(false);
  // Layout, not passive: `hasHOverflow` carries across a mode switch, so a
  // centered split that overflowed would render the native branch with its bar
  // already hidden while the freshly mounted strip still has no measured width
  // — one painted frame of a dead proxy and no scrollbar at all. Measuring
  // before paint retires that frame.
  useLayoutEffect(() => {
    const proxy = hScrollbarRef.current;
    const native = usesNativeHScrollProxy ? nativeScrollerRef.current : null;
    if (!proxy || (usesNativeHScrollProxy && !native)) {
      setHasHOverflow(false);
      return;
    }
    const source = native ?? proxy;
    const measure = () => {
      // Ordered: the proxy's scroll range has to match the content before the
      // offset is mirrored into it, or the write clamps against a stale width.
      if (native) {
        proxy.style.setProperty("--diff-native-scroll-width", `${native.scrollWidth}px`);
      }
      setHasHOverflow(source.scrollWidth > source.clientWidth + 1);
      if (native) syncNativeHScroll("content");
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(source);
    if (source.firstElementChild) observer.observe(source.firstElementChild);
    return () => {
      observer.disconnect();
    };
  }, [
    isCenteredSplit,
    usesNativeHScrollProxy,
    isCollapsed,
    visibleHunks,
    maxLineCols,
    syncNativeHScroll,
  ]);

  // Arrow-key horizontal scrolling parity with the focusable native scroller
  // used by the other view modes.
  const handleRegionKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const bar = hScrollbarRef.current;
    if (!bar) return;
    const maxScroll = bar.scrollWidth - bar.clientWidth;
    if (maxScroll <= 0) return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 40 : -40;
    bar.scrollLeft = Math.min(maxScroll, Math.max(0, bar.scrollLeft + delta));
  }, []);

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

  // Both of these change the rendered row set, so the effect above issues the
  // `onToggleCollapse` notification — notifying here too would double-fire, and
  // would also fire when an expansion failed and changed nothing.
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
    },
    [oldSource]
  );

  const handleShowMoreHunks = () => {
    setVisibleHunkCount((count) => count + SHOW_MORE_HUNKS_STEP);
  };

  const fileStyle: CSSProperties & Record<"--diff-gutter-width" | "--diff-max-line", string> = {
    "--diff-gutter-width": gutterWidth,
    // +1ch slack so the caret-width estimate never clips the last character.
    "--diff-max-line": `${maxLineCols + 1}ch`,
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
              {trailingHiddenCount <= EXPAND_ALL_MAX ? (
                <button
                  type="button"
                  onClick={() => handleExpandContext(trailingGapStart, oldTotalLines + 1)}
                >
                  <UnfoldVertical className="w-3 h-3" />
                  Expand {trailingHiddenCount} {trailingHiddenCount === 1 ? "line" : "lines"}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    title={`Show ${EXPAND_STEP} lines below the last hunk`}
                    onClick={() =>
                      handleExpandContext(trailingGapStart, trailingGapStart + EXPAND_STEP)
                    }
                  >
                    <ChevronsDown className="w-3 h-3" />
                    Expand down
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExpandContext(trailingGapStart, oldTotalLines + 1)}
                  >
                    Expand all {trailingHiddenCount}
                  </button>
                </>
              )}
            </span>
          </div>
        </Decoration>
      );
    }
    return rows;
  };

  const diffBody = (
    <>
      <Diff
        viewType={viewType}
        diffType={diffType}
        hunks={visibleHunks}
        tokens={tokens ?? undefined}
        renderGutter={renderGutter}
        renderToken={renderTokenWithInvisibles}
        generateLineClassName={generateLineClassName}
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
    </>
  );

  // One strip serves both scroll systems: centered split drives every code
  // cell's text-indent through --diff-hscroll, the native path mirrors a real
  // scroller's scrollLeft. Wrap mode has no horizontal overflow, so no strip.
  const hScrollbar = wrapLines ? null : (
    <div
      ref={hScrollbarRef}
      className="diff-hscrollbar"
      data-testid="diff-hscrollbar"
      data-scroll-mode={isCenteredSplit ? "centered" : "native"}
      data-active={hasHOverflow || undefined}
      onScroll={isCenteredSplit ? handleHScroll : handleNativeProxyScroll}
      aria-hidden="true"
      tabIndex={-1}
    >
      <div className="diff-hscroll-spacer" />
    </div>
  );

  return (
    <div className="mb-2" style={fileStyle}>
      {relPath && (
        <div className="sticky top-0 z-10 flex items-center justify-between px-3 py-1.5 bg-surface-sidebar border-b border-border-default text-xs font-mono">
          <TruncatedTooltip content={relPath}>
            <span className="truncate text-text-primary">
              {relPath.includes("/") ? (
                <>
                  <span className="text-text-secondary">
                    {relPath.slice(0, relPath.lastIndexOf("/") + 1)}
                  </span>
                  <span className="text-text-primary">
                    {relPath.slice(relPath.lastIndexOf("/") + 1)}
                  </span>
                </>
              ) : (
                relPath
              )}
            </span>
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
          {!langLoadFailed && isLargeRender && !isCollapsed && (
            <span className="text-xs text-text-muted" data-testid="diff-highlight-off-badge">
              {fullFile ? "Highlighting off for large file" : "Highlighting off for large diff"}
            </span>
          )}
          <div className="flex items-center gap-2 shrink-0 text-text-secondary">
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
                className="shrink-0 flex items-center px-1.5 py-0.5 rounded hover:bg-tint/5 hover:text-text-primary transition-colors"
              >
                {fileCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              </button>
            )}
            {absolutePath && (
              <button
                onClick={handleOpenInEditor}
                title={`Open in editor${firstHunkLine ? ` at line ${firstHunkLine}` : ""}`}
                className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded hover:bg-tint/5 hover:text-text-primary transition-colors"
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
          <span className="ml-auto text-text-secondary font-mono text-xs">
            {isCollapsed ? "Show diff" : "Hide diff"}
          </span>
        </button>
      )}
      {!isCollapsed &&
        (isCenteredSplit ? (
          <div
            id={diffRegionId}
            ref={regionRef}
            className="diff-file-centered"
            tabIndex={0}
            role="region"
            aria-label={relPath || "Diff"}
            onKeyDown={handleRegionKeyDown}
          >
            {diffBody}
            {hScrollbar}
          </div>
        ) : (
          // The shell exists only so the strip can be a sibling of the real
          // scroller: `overflow-x: auto` with overflow-y at its initial
          // `visible` computes to `auto` (CSS Overflow 3 §3.3), so
          // .diff-file-scroll is a scroll container on both axes and a sticky
          // strip inside it would resolve against a scrollport the full height
          // of the file — pinning exactly where the native bar already is.
          <div className="diff-file-shell">
            <div
              id={diffRegionId}
              ref={nativeScrollerRef}
              className="diff-file-scroll"
              data-proxy-active={(usesNativeHScrollProxy && hasHOverflow) || undefined}
              tabIndex={0}
              role="region"
              aria-label={relPath || "Diff"}
              onScroll={usesNativeHScrollProxy ? handleNativeHScroll : undefined}
            >
              {diffBody}
            </div>
            {hScrollbar}
          </div>
        ))}
    </div>
  );
}
