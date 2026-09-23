import { useState, useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Copy,
  Download,
  File,
  FileCode,
  FileDiff,
  FileText,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FileStack } from "@/components/icons";
import { orderPatchesForApply, useArtifacts, type SaveArtifactOutcome } from "@/hooks/useArtifacts";
import { useUnseenOutput } from "@/hooks/useUnseenOutput";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import type { Artifact } from "@shared/types";

type ApplyPatchOutcome =
  | { success: true; modifiedFiles: string[] }
  | { success: false; error: string; cancelled?: boolean };

/**
 * The recorded result of the last `git apply` of a patch. It lives on the
 * overlay, not the row, so it survives collapsing the row and closing the
 * tray, and only another apply replaces it — copy and save report separately.
 */
type ApplyResult = { kind: "applied"; files: string[] } | { kind: "failed"; message: string };

/** Copy and save feedback: row-local, and a success clears itself. */
type RowFeedback =
  | { kind: "saved"; filePath: string }
  | { kind: "save-failed"; message: string }
  | { kind: "copy-failed" };

const TRANSIENT_FEEDBACK_MS = 4000;
const COPIED_FLASH_MS = 2000;

export type PatchLineKind = "file" | "hunk" | "add" | "del" | "context" | "meta";

export interface PatchLine {
  kind: PatchLineKind;
  /** The line as written, for kinds that are shown verbatim. */
  text: string;
}

const FILE_HEADER_PREFIXES = [
  "--- ",
  "+++ ",
  "index ",
  "new file mode",
  "deleted file mode",
  "old mode",
  "new mode",
  "similarity index",
  "rename from",
  "rename to",
  "copy from",
  "copy to",
  "Binary files",
];

/**
 * Reads a unified diff line by line with the one piece of context that matters:
 * whether we are inside a hunk. Inside one, a line is a change by its first
 * character alone — so added source text that happens to begin `++` is an
 * addition, not a file header — and `\ No newline at end of file` is a note.
 */
export function parsePatchLines(content: string): PatchLine[] {
  let inHunk = false;
  return content.split("\n").map((text): PatchLine => {
    if (text.startsWith("diff ")) {
      inHunk = false;
      return { kind: "file", text };
    }
    if (text.startsWith("@@")) {
      inHunk = true;
      return { kind: "hunk", text };
    }
    if (inHunk) {
      if (text.startsWith("+")) return { kind: "add", text };
      if (text.startsWith("-")) return { kind: "del", text };
      if (text.startsWith(" ") || text === "") return { kind: "context", text };
      return { kind: "meta", text };
    }
    if (FILE_HEADER_PREFIXES.some((prefix) => text.startsWith(prefix))) {
      return { kind: "file", text };
    }
    return { kind: "meta", text };
  });
}

export function getPatchStats(content: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of parsePatchLines(content)) {
    if (line.kind === "add") additions++;
    else if (line.kind === "del") deletions++;
  }
  return { additions, deletions };
}

/** Files a unified diff touches, in order, from its `+++` headers (`---` for a deletion). */
export function getPatchFiles(content: string): string[] {
  const files: string[] = [];
  const lines = parsePatchLines(content);
  for (let i = 0; i < lines.length; i++) {
    const { kind, text } = lines[i]!;
    if (kind !== "file" || !text.startsWith("+++ ")) continue;
    let target = text.slice(4).trim();
    if (target === "/dev/null") {
      const previous = lines[i - 1]?.text ?? "";
      if (previous.startsWith("--- ")) target = previous.slice(4).trim();
    }
    const path = target.replace(/^[ab]\//, "");
    if (path && path !== "/dev/null" && !files.includes(path)) files.push(path);
  }
  return files;
}

// The diff workspace's reading (DiffViewer): code stays neutral, the row carries
// the tint, and the sign sits in its own column in the gutter colour.
export const PATCH_ROW_CLASS: Record<PatchLineKind, string> = {
  file: "text-text-secondary",
  hunk: "text-status-info bg-overlay-subtle",
  add: "text-text-primary bg-diff-insert-background",
  del: "text-text-primary bg-diff-delete-background",
  context: "text-text-primary",
  meta: "text-text-secondary italic",
};

// The sign column is pinned while the code scrolls sideways, so it needs an
// opaque base under its tint or the code would show through it. The sign is
// the non-colour channel, so it takes full-contrast ink: the gutter hues sit
// near 3:1 on their own tint, and the row already carries the colour.
const PATCH_SIGN_CLASS: Partial<Record<PatchLineKind, string>> = {
  add: "text-text-primary bg-surface-canvas [background-image:linear-gradient(var(--color-diff-insert-background),var(--color-diff-insert-background))]",
  del: "text-text-primary bg-surface-canvas [background-image:linear-gradient(var(--color-diff-delete-background),var(--color-diff-delete-background))]",
  context: "bg-surface-canvas",
};

/**
 * A bounded scroller that says when there is more: an edge fade on whichever
 * side still has content, since the platform's overlay scrollbars show nothing
 * until the user is already scrolling.
 */
function ScrollArea({
  className,
  fadeClassName = "from-surface-canvas",
  children,
}: {
  className?: string;
  fadeClassName?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ bottom: false, right: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setMore((prev) =>
        prev.bottom === bottom && prev.right === right ? prev : { bottom, right }
      );
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    if (el.firstElementChild) observer?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, []);

  return (
    <div className="relative min-h-0">
      <div ref={ref} className={cn("overflow-auto", className)}>
        {children}
      </div>
      {more.bottom && (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-linear-to-t to-transparent",
            fadeClassName
          )}
        />
      )}
      {more.right && (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-y-0 right-0 w-6 bg-linear-to-l to-transparent",
            fadeClassName
          )}
        />
      )}
    </div>
  );
}

function PatchDiffLines({ content }: { content: string }) {
  return (
    <pre className="font-mono text-xs leading-5 select-text">
      <code className="block min-w-max py-1">
        {parsePatchLines(content).map(({ kind, text }, i) => {
          const signed = kind === "add" || kind === "del" || kind === "context";
          return (
            <div key={i} className={cn("flex pr-3", PATCH_ROW_CLASS[kind])}>
              {signed ? (
                <>
                  <span
                    className={cn("sticky left-0 w-6 shrink-0 text-center", PATCH_SIGN_CLASS[kind])}
                  >
                    {kind === "context" ? " " : text[0]}
                  </span>
                  <span>{text.slice(1) || " "}</span>
                </>
              ) : (
                <span className="pl-3">{text || " "}</span>
              )}
            </div>
          );
        })}
      </code>
    </pre>
  );
}

function PatchStats({ content, className }: { content: string; className?: string }) {
  const { additions, deletions } = getPatchStats(content);
  return (
    <span
      className={cn("font-mono text-xs tabular-nums shrink-0", className)}
      aria-label={`${additions} added, ${deletions} removed`}
    >
      <span className="text-diff-gutter-insert">+{additions}</span>{" "}
      <span className="text-diff-gutter-delete">−{deletions}</span>
    </span>
  );
}

/** One patch as the confirm dialogs show it: the files it touches, then every line of it. */
function PatchPreview({ patch, scrollClassName }: { patch: Artifact; scrollClassName?: string }) {
  const files = getPatchFiles(patch.content);
  return (
    <div className="rounded-[var(--radius-md)] border border-border-default bg-surface-canvas overflow-hidden">
      <div className="flex items-baseline gap-3 px-3 py-2 border-b border-border-default bg-overlay-subtle">
        <span className="min-w-0 flex-1 text-xs text-text-primary">
          {files.length > 0 ? (
            files.map((file) => (
              <span key={file} className="block truncate font-mono" title={file}>
                {file}
              </span>
            ))
          ) : (
            <span className="font-mono">{patch.filename || "patch"}</span>
          )}
        </span>
        <PatchStats content={patch.content} />
      </div>
      <ScrollArea className={scrollClassName}>
        <PatchDiffLines content={patch.content} />
      </ScrollArea>
    </div>
  );
}

/**
 * git's own words say what went wrong; this says what to do about it. A plain
 * `git apply` is all-or-nothing, so a failure never leaves half a patch behind.
 */
export function describeApplyFailure(message: string): string {
  if (/no such file|does not exist in index|No such file or directory/i.test(message)) {
    return "It edits a file that isn't in this worktree. Check it's the worktree the agent was working in.";
  }
  if (/corrupt patch|malformed|No valid patches|unrecognized input/i.test(message)) {
    return "The patch text is incomplete, so git can't read it. Ask the agent to print it again.";
  }
  if (/already exists in working directory/i.test(message)) {
    return "It creates a file that already exists here. It may already be applied.";
  }
  if (/patch does not apply|patch failed/i.test(message)) {
    return "It doesn't match the current files. It may already be applied, or the files moved on after the agent wrote it. Check the diff, or ask the agent to regenerate it for this worktree.";
  }
  return "Nothing was changed. Check git's details below, or ask the agent to regenerate the patch.";
}

const ARTIFACT_TYPE_ICONS: Record<Artifact["type"], LucideIcon> = {
  code: FileCode,
  patch: FileDiff,
  file: File,
  summary: FileText,
  other: File,
};

const ARTIFACT_TYPE_LABELS: Record<Artifact["type"], string> = {
  code: "Code",
  patch: "Patch",
  file: "File",
  summary: "Summary",
  other: "Artifact",
};

function splitPath(path: string): { base: string; dir: string } {
  const slash = path.lastIndexOf("/");
  if (slash === -1) return { base: path, dir: "" };
  return { base: path.slice(slash + 1), dir: path.slice(0, slash) };
}

function artifactName(artifact: Artifact): string {
  return splitPath(artifact.filename || ARTIFACT_TYPE_LABELS[artifact.type] || "Artifact").base;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function OutcomeLine({
  tone,
  icon: Icon,
  children,
  onDismiss,
}: {
  tone: "success" | "error" | "neutral";
  icon: LucideIcon;
  children: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className="flex items-start gap-2 px-3 py-2 border-t border-border-default text-xs">
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 mt-px",
          tone === "success" && "text-status-success",
          tone === "error" && "text-status-error",
          tone === "neutral" && "text-text-secondary"
        )}
      />
      <div className="min-w-0 flex-1 text-text-primary">{children}</div>
      {onDismiss && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-my-1 -mr-1"
        >
          <X />
        </Button>
      )}
    </div>
  );
}

interface ArtifactItemProps {
  artifact: Artifact;
  isExpanded: boolean;
  onToggle: (id: string) => void;
  applyResult: ApplyResult | undefined;
  onApplyResult: (id: string, result: ApplyResult | null) => void;
  onCopy: (artifact: Artifact) => Promise<boolean>;
  onSave: (artifact: Artifact) => Promise<SaveArtifactOutcome>;
  onApplyPatch: (artifact: Artifact) => Promise<ApplyPatchOutcome>;
  canApplyPatch: boolean;
  isProcessing: boolean;
  isApplying: boolean;
  isApplyLocked: boolean;
}

function ArtifactItem({
  artifact,
  isExpanded,
  onToggle,
  applyResult,
  onApplyResult,
  onCopy,
  onSave,
  onApplyPatch,
  canApplyPatch,
  isProcessing,
  isApplying,
  isApplyLocked,
}: ArtifactItemProps) {
  const bodyId = useId();
  const rowRef = useRef<HTMLLIElement>(null);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedbackState] = useState<RowFeedback | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
      if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  // An opened row brings its actions into view instead of growing below the fold.
  useEffect(() => {
    if (isExpanded) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [isExpanded]);

  const setFeedback = useCallback((next: RowFeedback | null, transient = false) => {
    if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = null;
    setFeedbackState(next);
    if (next && transient) {
      feedbackTimerRef.current = window.setTimeout(
        () => setFeedbackState(null),
        TRANSIENT_FEEDBACK_MS
      );
    }
  }, []);

  const handleCopy = useCallback(async () => {
    const success = await onCopy(artifact);
    if (success) {
      setFeedback(null);
      setCopied(true);
      if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    } else {
      setFeedback({ kind: "copy-failed" });
    }
  }, [artifact, onCopy, setFeedback]);

  const handleSave = useCallback(async () => {
    const result = await onSave(artifact);
    if (result.status === "saved") setFeedback({ kind: "saved", filePath: result.filePath }, true);
    else if (result.status === "failed")
      setFeedback({ kind: "save-failed", message: result.error });
  }, [artifact, onSave, setFeedback]);

  const handleApplyPatch = useCallback(async () => {
    const result = await onApplyPatch(artifact);
    if (result.success) {
      onApplyResult(artifact.id, { kind: "applied", files: result.modifiedFiles });
    } else if (!result.cancelled) {
      onApplyResult(artifact.id, {
        kind: "failed",
        message: result.error || "git apply failed",
      });
    }
  }, [artifact, onApplyPatch, onApplyResult]);

  const Icon = ARTIFACT_TYPE_ICONS[artifact.type] ?? File;
  const typeLabel = ARTIFACT_TYPE_LABELS[artifact.type] ?? "Artifact";
  const isPatch = artifact.type === "patch";
  const { base, dir } = splitPath(artifact.filename || typeLabel);
  const lines = artifact.content.split("\n").length;

  return (
    <li
      ref={rowRef}
      data-artifact-item={artifact.id}
      className="rounded-[var(--radius-md)] border border-border-default bg-surface-panel overflow-hidden"
    >
      <button
        type="button"
        onClick={() => onToggle(artifact.id)}
        aria-expanded={isExpanded}
        aria-controls={bodyId}
        className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-overlay-soft transition-colors duration-150 ease-out"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-text-secondary transition-transform duration-150 ease-out",
            isExpanded && "rotate-90"
          )}
        />
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-text-secondary" />
        <span className="min-w-0 flex-1 truncate text-sm" title={artifact.filename || undefined}>
          <span className="sr-only">{typeLabel}: </span>
          <span className="font-medium text-text-primary">{base}</span>
          {dir && <span className="ml-1.5 text-xs text-text-secondary">{dir}</span>}
        </span>
        {applyResult && (
          <span className="shrink-0 text-xs text-text-secondary">
            {applyResult.kind === "applied" ? "Applied" : "Didn't apply"}
          </span>
        )}
        {isPatch ? (
          <PatchStats content={artifact.content} />
        ) : (
          <span className="shrink-0 text-xs tabular-nums text-text-secondary">
            {plural(lines, "line", "lines")}
          </span>
        )}
      </button>

      {isExpanded && (
        <div id={bodyId} className="border-t border-border-default">
          <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
            {isPatch && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      variant={applyResult?.kind === "applied" ? "subtle" : "contrast"}
                      size="sm"
                      onClick={() => void handleApplyPatch()}
                      disabled={!canApplyPatch || (isApplyLocked && !isApplying)}
                      loading={isApplying}
                    >
                      {applyResult?.kind === "applied" ? "Apply again" : "Apply patch"}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {!canApplyPatch
                    ? "This terminal isn't in a worktree, so there's nowhere to apply it"
                    : isApplyLocked && !isApplying
                      ? "Another patch is being applied"
                      : applyResult?.kind === "applied"
                        ? "Already applied here, so applying it again will usually fail"
                        : "Preview the diff, then git apply it in this worktree"}
                </TooltipContent>
              </Tooltip>
            )}
            <Button
              variant="subtle"
              size="sm"
              onClick={() => void handleCopy()}
              disabled={isProcessing}
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button
              variant="subtle"
              size="sm"
              onClick={() => void handleSave()}
              disabled={isProcessing}
            >
              <Download aria-hidden="true" />
              Save as…
            </Button>
            {isPatch && !canApplyPatch && (
              <span className="text-xs text-text-secondary">No worktree to apply to</span>
            )}
          </div>

          <div role="status" aria-live="polite">
            {copied && <span className="sr-only">Copied to clipboard</span>}
            {applyResult?.kind === "applied" && (
              <OutcomeLine tone="success" icon={CircleCheck}>
                Applied to {plural(applyResult.files.length, "file", "files")}
                {applyResult.files.map((file) => (
                  <span key={file} className="block break-all font-mono text-text-secondary">
                    {file}
                  </span>
                ))}
              </OutcomeLine>
            )}
            {applyResult?.kind === "failed" && (
              <OutcomeLine
                tone="error"
                icon={CircleAlert}
                onDismiss={() => onApplyResult(artifact.id, null)}
              >
                Patch didn't apply. {describeApplyFailure(applyResult.message)}
                <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-text-secondary">
                  {applyResult.message}
                </pre>
              </OutcomeLine>
            )}
            {feedback?.kind === "saved" && (
              <OutcomeLine tone="neutral" icon={Check}>
                Saved to{" "}
                <span className="break-all font-mono text-text-secondary">{feedback.filePath}</span>
              </OutcomeLine>
            )}
            {feedback?.kind === "save-failed" && (
              <OutcomeLine tone="error" icon={CircleAlert} onDismiss={() => setFeedback(null)}>
                Couldn't save. Try again, or copy it instead.
                <span className="block text-text-secondary">{feedback.message}</span>
              </OutcomeLine>
            )}
            {feedback?.kind === "copy-failed" && (
              <OutcomeLine tone="error" icon={CircleAlert} onDismiss={() => setFeedback(null)}>
                Couldn't copy to the clipboard. Save it as a file instead.
              </OutcomeLine>
            )}
          </div>

          <div className="border-t border-border-default bg-surface-canvas">
            <ScrollArea className="max-h-56">
              {isPatch ? (
                <PatchDiffLines content={artifact.content} />
              ) : (
                <pre className="px-3 py-2 font-mono text-xs leading-5 text-text-primary select-text">
                  <code>{artifact.content}</code>
                </pre>
              )}
            </ScrollArea>
          </div>
        </div>
      )}
    </li>
  );
}

interface ArtifactOverlayProps {
  terminalId: string;
  worktreeId?: string;
  cwd?: string;
  className?: string;
}

type BulkStatus = { text: string; tone: "success" | "error"; persistent: boolean };

export function ArtifactOverlay({ terminalId, worktreeId, cwd, className }: ArtifactOverlayProps) {
  const panelId = useId();
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [applyResults, setApplyResults] = useState<ReadonlyMap<string, ApplyResult>>(
    () => new Map()
  );
  const [codeOnly, setCodeOnly] = useState(false);
  const [bulkStatus, setBulkStatus] = useState<BulkStatus | null>(null);
  const bulkStatusTimerRef = useRef<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef(false);
  const {
    artifacts,
    actionInProgress,
    bulkProgress,
    hasArtifacts,
    copyToClipboard,
    saveToFile,
    applyPatch,
    clearArtifacts,
    canApplyPatch,
    copyAll,
    saveAll,
    applyAllPatches,
  } = useArtifacts(terminalId, worktreeId, cwd);
  // "New output below" owns the pane's bottom-right lane while it shows, so
  // the overlay steps up above it rather than fighting it for the corner.
  const { hasUnseenOutput } = useUnseenOutput(terminalId);

  const handleToggleItem = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleApplyResult = useCallback((id: string, result: ApplyResult | null) => {
    setApplyResults((prev) => {
      const next = new Map(prev);
      if (result) next.set(id, result);
      else next.delete(id);
      return next;
    });
  }, []);

  const handleCopy = useCallback(
    async (artifact: Artifact) => {
      return await copyToClipboard(artifact);
    },
    [copyToClipboard]
  );

  const handleSave = useCallback(
    async (artifact: Artifact) => {
      return await saveToFile(artifact);
    },
    [saveToFile]
  );

  // D2 confirm gate: applying a patch mutates worktree files, so both apply
  // paths preview the change in a ConfirmDialog before the dispatch fires.
  const [pendingPatch, setPendingPatch] = useState<Artifact | null>(null);
  const [pendingBulkPatches, setPendingBulkPatches] = useState<Artifact[] | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const pendingApplyResolveRef = useRef<((outcome: ApplyPatchOutcome) => void) | null>(null);

  const handleApplyPatch = useCallback((artifact: Artifact) => {
    return new Promise<ApplyPatchOutcome>((resolve) => {
      pendingApplyResolveRef.current?.({ success: false, error: "Cancelled", cancelled: true });
      pendingApplyResolveRef.current = resolve;
      setPendingPatch(artifact);
    });
  }, []);

  const handleCancelApplyPatch = useCallback(() => {
    pendingApplyResolveRef.current?.({ success: false, error: "Cancelled", cancelled: true });
    pendingApplyResolveRef.current = null;
    setPendingPatch(null);
  }, []);

  const handleConfirmApplyPatch = useCallback(async () => {
    const resolve = pendingApplyResolveRef.current;
    const artifact = pendingPatch;
    pendingApplyResolveRef.current = null;
    setPendingPatch(null);
    if (!artifact) return;
    setApplyingId(artifact.id);
    try {
      const result = await applyPatch(artifact);
      resolve?.(result);
    } finally {
      setApplyingId(null);
    }
  }, [applyPatch, pendingPatch]);

  // Resolve a pending confirm as cancelled when the overlay loses its artifacts
  // (Clear hides the dialog via the early return below) or unmounts, so the
  // promise awaited in ArtifactItem never hangs.
  useEffect(() => {
    if (hasArtifacts) return;
    pendingApplyResolveRef.current?.({ success: false, error: "Cancelled", cancelled: true });
    pendingApplyResolveRef.current = null;
    setPendingPatch(null);
    setPendingBulkPatches(null);
  }, [hasArtifacts]);

  useEffect(() => {
    return () => {
      pendingApplyResolveRef.current?.({ success: false, error: "Cancelled", cancelled: true });
      pendingApplyResolveRef.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (bulkStatusTimerRef.current) window.clearTimeout(bulkStatusTimerRef.current);
    };
  }, []);

  // The pill unmounts as the tray opens, so focus moves to the first row rather
  // than falling to the document; closing hands it back to the pill.
  useEffect(() => {
    if (isExpanded) {
      panelRef.current
        ?.querySelector<HTMLButtonElement>("[data-artifact-item] > button")
        ?.focus({ preventScroll: true });
      return;
    }
    if (!restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus({ preventScroll: true });
  }, [isExpanded]);

  const showBulkStatus = useCallback((status: BulkStatus) => {
    setBulkStatus(status);
    if (bulkStatusTimerRef.current) window.clearTimeout(bulkStatusTimerRef.current);
    bulkStatusTimerRef.current = status.persistent
      ? null
      : window.setTimeout(() => setBulkStatus(null), TRANSIENT_FEEDBACK_MS);
  }, []);

  const handleCopyAll = useCallback(async () => {
    const result = await copyAll(!codeOnly);
    if (result.succeeded > 0) {
      showBulkStatus({
        text: `Copied ${plural(result.succeeded, "artifact", "artifacts")}`,
        tone: "success",
        persistent: false,
      });
    } else if (result.failed > 0) {
      showBulkStatus({
        text: "Couldn't copy to the clipboard. Save them as files instead.",
        tone: "error",
        persistent: true,
      });
    }
  }, [copyAll, codeOnly, showBulkStatus]);

  const handleSaveAll = useCallback(async () => {
    const result = await saveAll();
    if (result.succeeded > 0 && result.failed === 0) {
      showBulkStatus({
        text: `Saved ${plural(result.succeeded, "artifact", "artifacts")}`,
        tone: "success",
        persistent: false,
      });
    } else if (result.failed > 0) {
      const names = result.failures.map((f) => artifactName(f.artifact)).join(", ");
      showBulkStatus({
        text: `${result.succeeded > 0 ? `Saved ${result.succeeded}. ` : ""}Couldn't save ${names}. Try those again one at a time.`,
        tone: "error",
        persistent: true,
      });
    }
  }, [saveAll, showBulkStatus]);

  const handleApplyAllPatches = useCallback(() => {
    // Snapshot at request time, in the order it will run, so the dialog
    // previews exactly what confirm applies — patches detected while the
    // dialog is open are excluded.
    setPendingBulkPatches(
      orderPatchesForApply(
        artifacts.filter((a) => a.type === "patch" && applyResults.get(a.id)?.kind !== "applied")
      )
    );
  }, [artifacts, applyResults]);

  const handleCancelApplyAllPatches = useCallback(() => {
    setPendingBulkPatches(null);
  }, []);

  const handleConfirmApplyAllPatches = useCallback(async () => {
    const snapshot = pendingBulkPatches;
    setPendingBulkPatches(null);
    if (!snapshot) return;
    const result = await applyAllPatches(snapshot);
    const failures = new Map(result.failures.map((f) => [f.artifact.id, f.error]));
    // Each patch's own row reports its own result, so a partial run shows which ones landed.
    setApplyResults((prev) => {
      const next = new Map(prev);
      for (const patch of snapshot) {
        const error = failures.get(patch.id);
        next.set(
          patch.id,
          error !== undefined
            ? { kind: "failed", message: error }
            : { kind: "applied", files: getPatchFiles(patch.content) }
        );
      }
      return next;
    });
    if (failures.size > 0) {
      setExpandedIds((prev) => new Set([...prev, ...failures.keys()]));
    }
    if (result.succeeded > 0 && result.failed === 0) {
      const files = result.modifiedFiles?.length ?? 0;
      showBulkStatus({
        text: `Applied ${plural(result.succeeded, "patch", "patches")}${
          files ? ` to ${plural(files, "file", "files")}` : ""
        }`,
        tone: "success",
        persistent: true,
      });
    } else if (result.failed > 0) {
      showBulkStatus({
        text:
          result.succeeded > 0
            ? `Applied ${result.succeeded}, ${result.failed} didn't apply. Each row says why.`
            : `${plural(result.failed, "patch", "patches")} didn't apply. Each row says why.`,
        tone: "error",
        persistent: true,
      });
    }
  }, [applyAllPatches, pendingBulkPatches, showBulkStatus]);

  const openPanel = useCallback(() => {
    // One artifact has nothing to choose between, so it opens ready to act on.
    if (artifacts.length === 1) setExpandedIds(new Set([artifacts[0]!.id]));
    setIsExpanded(true);
  }, [artifacts]);

  const closePanel = useCallback(() => {
    handleCancelApplyPatch();
    handleCancelApplyAllPatches();
    restoreFocusRef.current = true;
    setIsExpanded(false);
  }, [handleCancelApplyPatch, handleCancelApplyAllPatches]);

  const handleClear = useCallback(() => {
    setApplyResults(new Map());
    setExpandedIds(new Set());
    setBulkStatus(null);
    // The next artifact to arrive shows as the pill again, not a tray reopened by itself.
    setIsExpanded(false);
    clearArtifacts();
    // The overlay unmounts with its last artifact, so focus goes back to the terminal it sat on.
    terminalInstanceService.focus(terminalId);
  }, [clearArtifacts, terminalId]);

  const codeArtifactCount = artifacts.filter((a) => a.type === "code").length;
  const patchCount = artifacts.filter((a) => a.type === "patch").length;
  const copyTargetCount = codeOnly ? codeArtifactCount : artifacts.length;
  const showBulkBar = artifacts.length > 1;
  // Bulk apply is for what hasn't landed yet; an applied patch reruns only from its own row.
  const unappliedPatchCount = artifacts.filter(
    (a) => a.type === "patch" && applyResults.get(a.id)?.kind !== "applied"
  ).length;
  const showApplyAll = unappliedPatchCount > 1;
  const canApplyAll = showApplyAll && !!worktreeId && !!cwd;
  const isBulkActionRunning = !!bulkProgress;
  // One git apply at a time: while a single apply or a bulk run is in flight,
  // every other apply entry point waits. (An open confirm is modal already.)
  const isApplyLocked = applyingId !== null || bulkProgress?.action === "apply";

  if (!hasArtifacts) {
    return null;
  }

  const bulkProgressText =
    bulkProgress?.action === "copy"
      ? "Copying…"
      : bulkProgress?.action === "save"
        ? `Saving ${bulkProgress.current} of ${bulkProgress.total}…`
        : bulkProgress?.action === "apply"
          ? `Applying ${bulkProgress.current} of ${bulkProgress.total}…`
          : null;

  const pendingBulkCount = pendingBulkPatches?.length ?? 0;
  const pendingPatchName = pendingPatch
    ? splitPath(getPatchFiles(pendingPatch.content)[0] ?? pendingPatch.filename ?? "patch").base
    : "";

  return (
    <>
      {!isExpanded ? (
        <div
          className={cn(
            "absolute right-3 z-10",
            hasUnseenOutput ? "bottom-10" : "bottom-3",
            className
          )}
        >
          <Button
            ref={triggerRef}
            data-artifact-trigger
            variant="pill"
            size="sm"
            onClick={openPanel}
            aria-expanded={false}
            aria-controls={panelId}
            className="shadow-[var(--theme-shadow-floating)]"
          >
            <FileStack aria-hidden="true" />
            <span className="tabular-nums text-text-primary">
              {plural(artifacts.length, "artifact", "artifacts")}
            </span>
            {patchCount > 0 && (
              <span className="tabular-nums">· {plural(patchCount, "patch", "patches")}</span>
            )}
          </Button>
        </div>
      ) : (
        <section
          ref={panelRef}
          id={panelId}
          data-artifact-panel
          aria-label="Artifacts"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            closePanel();
          }}
          className={cn(
            "absolute right-3 z-10 flex flex-col overflow-hidden",
            hasUnseenOutput
              ? "bottom-10 max-h-[min(34rem,calc(100%-3.25rem))]"
              : "bottom-3 max-h-[min(34rem,calc(100%-1.5rem))]",
            "w-[26rem] max-w-[calc(100%-1.5rem)]",
            "rounded-[var(--radius-lg)] border border-border-default bg-surface-sidebar shadow-[var(--theme-shadow-floating)]",
            className
          )}
        >
          <header className="shrink-0 border-b border-border-default bg-surface-canvas">
            <div className="flex items-center gap-2 pl-3 pr-1.5 py-1.5">
              <FileStack aria-hidden="true" className="size-4 shrink-0 text-text-secondary" />
              <h2 className="flex-1 text-sm font-medium text-text-primary">
                Artifacts{" "}
                <span className="font-normal tabular-nums text-text-secondary">
                  {artifacts.length}
                </span>
              </h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClear}
                disabled={isBulkActionRunning}
              >
                Clear
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={closePanel}
                aria-label="Close artifacts"
              >
                <X />
              </Button>
            </div>

            {showBulkBar && (
              <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5">
                <div className="flex items-center gap-px">
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() => void handleCopyAll()}
                    disabled={isBulkActionRunning || copyTargetCount === 0}
                    className="rounded-r-none"
                  >
                    Copy all
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="subtle"
                        size="sm"
                        onClick={() => setCodeOnly((v) => !v)}
                        disabled={isBulkActionRunning || codeArtifactCount === 0}
                        aria-pressed={codeOnly}
                        className={cn(
                          "rounded-l-none",
                          codeOnly && "bg-overlay-strong text-text-primary"
                        )}
                      >
                        Code only
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      Copy all takes only the{" "}
                      {plural(codeArtifactCount, "code block", "code blocks")}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="subtle"
                      size="sm"
                      onClick={() => void handleSaveAll()}
                      disabled={isBulkActionRunning}
                    >
                      Save each…
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    Asks where to save each of the {artifacts.length} in turn
                  </TooltipContent>
                </Tooltip>
                {showApplyAll && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Button
                          variant="subtle"
                          size="sm"
                          onClick={handleApplyAllPatches}
                          disabled={
                            !canApplyAll ||
                            (isApplyLocked && bulkProgress?.action !== "apply") ||
                            (isBulkActionRunning && bulkProgress?.action !== "apply")
                          }
                          loading={bulkProgress?.action === "apply"}
                        >
                          Apply {plural(unappliedPatchCount, "patch", "patches")}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {!canApplyAll
                        ? "This terminal isn't in a worktree, so there's nowhere to apply them"
                        : isApplyLocked
                          ? "Another patch is being applied"
                          : "Preview every diff, then git apply them in order"}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            )}

            <div role="status" aria-live="polite">
              {(bulkProgressText || bulkStatus) && (
                <div className="flex items-start gap-2 px-3 pb-2 text-xs">
                  {bulkProgressText ? (
                    <span className="tabular-nums text-text-secondary">{bulkProgressText}</span>
                  ) : bulkStatus ? (
                    <>
                      {bulkStatus.tone === "success" ? (
                        <CircleCheck
                          aria-hidden="true"
                          className="size-3.5 shrink-0 mt-px text-status-success"
                        />
                      ) : (
                        <CircleAlert
                          aria-hidden="true"
                          className="size-3.5 shrink-0 mt-px text-status-error"
                        />
                      )}
                      <span className="min-w-0 flex-1 text-text-primary">{bulkStatus.text}</span>
                      {bulkStatus.persistent && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => setBulkStatus(null)}
                          aria-label="Dismiss"
                          className="-my-1"
                        >
                          <X />
                        </Button>
                      )}
                    </>
                  ) : null}
                </div>
              )}
            </div>
          </header>

          <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 space-y-1.5">
            {artifacts.map((artifact) => (
              <ArtifactItem
                key={artifact.id}
                artifact={artifact}
                isExpanded={expandedIds.has(artifact.id)}
                onToggle={handleToggleItem}
                applyResult={applyResults.get(artifact.id)}
                onApplyResult={handleApplyResult}
                onCopy={handleCopy}
                onSave={handleSave}
                onApplyPatch={handleApplyPatch}
                canApplyPatch={canApplyPatch(artifact)}
                isProcessing={isBulkActionRunning || actionInProgress === artifact.id}
                isApplying={applyingId === artifact.id}
                isApplyLocked={isApplyLocked}
              />
            ))}
          </ul>
        </section>
      )}

      <ConfirmDialog
        isOpen={pendingPatch !== null}
        onClose={handleCancelApplyPatch}
        title={`Apply patch to ${pendingPatchName}?`}
        description={
          <span>
            Runs <span className="font-mono">git apply</span> with the diff below in{" "}
            <span className="font-mono text-text-primary">{cwd}</span>. There's no automatic undo.
          </span>
        }
        confirmLabel="Apply patch"
        variant="destructive"
        size="lg"
        hasPreview={true}
        onConfirm={() => void handleConfirmApplyPatch()}
      >
        {pendingPatch && (
          <PatchPreview patch={pendingPatch} scrollClassName="max-h-[min(24rem,50vh)]" />
        )}
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={pendingBulkPatches !== null}
        onClose={handleCancelApplyAllPatches}
        title={`Apply ${plural(pendingBulkCount, "patch", "patches")} to this worktree?`}
        description={
          <span>
            Runs <span className="font-mono">git apply</span> on each patch below, in this order, in{" "}
            <span className="font-mono text-text-primary">{cwd}</span>. Every patch is attempted; if
            one fails, the others still apply. There's no automatic undo.
          </span>
        }
        confirmLabel={`Apply ${plural(pendingBulkCount, "patch", "patches")}`}
        variant="destructive"
        size="lg"
        hasPreview={true}
        onConfirm={() => void handleConfirmApplyAllPatches()}
      >
        {pendingBulkPatches && (
          // D2 requires the actual diff of every patch, not just counts, so
          // each one is shown in full and the list is the one vertical scroller.
          <ScrollArea className="max-h-[min(28rem,55vh)]" fadeClassName="from-surface-panel">
            <ol className="space-y-2">
              {pendingBulkPatches.map((patch) => (
                <li key={patch.id}>
                  <PatchPreview patch={patch} />
                </li>
              ))}
            </ol>
          </ScrollArea>
        )}
      </ConfirmDialog>
    </>
  );
}
