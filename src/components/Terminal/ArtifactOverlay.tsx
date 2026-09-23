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
import { useArtifacts, type SaveArtifactOutcome } from "@/hooks/useArtifacts";
import { useUnseenOutput } from "@/hooks/useUnseenOutput";
import type { Artifact } from "@shared/types";

type ApplyPatchOutcome =
  | { success: true; modifiedFiles: string[] }
  | { success: false; error: string; cancelled?: boolean };

/**
 * What a row says about the last thing done to its artifact. Apply results
 * persist until the next attempt — a failed `git apply` explains itself in its
 * own words, and that explanation has to still be there when the user looks
 * back. Copy and save confirmations clear themselves.
 */
type RowOutcome =
  | { kind: "applied"; files: string[] }
  | { kind: "apply-failed"; message: string }
  | { kind: "saved"; filePath: string }
  | { kind: "save-failed"; message: string }
  | { kind: "copy-failed" };

const TRANSIENT_OUTCOME_MS = 4000;
const COPIED_FLASH_MS = 2000;

export function getPatchStats(content: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of content.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

/** Files a unified diff touches, in order, from its `+++` headers (`---` for a deletion). */
export function getPatchFiles(content: string): string[] {
  const files: string[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("+++ ")) continue;
    let target = line.slice(4).trim();
    if (target === "/dev/null") {
      const previous = lines[i - 1] ?? "";
      if (previous.startsWith("--- ")) target = previous.slice(4).trim();
    }
    const path = target.replace(/^[ab]\//, "");
    if (path && path !== "/dev/null" && !files.includes(path)) files.push(path);
  }
  return files;
}

type PatchLineKind = "file" | "hunk" | "add" | "del" | "context";

function patchLineKind(line: string): PatchLineKind {
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("diff ") ||
    line.startsWith("index ")
  ) {
    return "file";
  }
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

// The diff workspace's reading (DiffViewer): code stays neutral, the row carries
// the tint, and the sign sits in its own column in the gutter colour.
const PATCH_ROW_CLASS: Record<PatchLineKind, string> = {
  file: "text-text-secondary",
  hunk: "text-status-info bg-overlay-subtle",
  add: "text-text-primary bg-diff-insert-background",
  del: "text-text-primary bg-diff-delete-background",
  context: "text-text-primary",
};

const PATCH_SIGN_CLASS: Record<PatchLineKind, string> = {
  file: "",
  hunk: "",
  add: "text-diff-gutter-insert",
  del: "text-diff-gutter-delete",
  context: "",
};

export function patchLineClass(line: string): string {
  return PATCH_ROW_CLASS[patchLineKind(line)];
}

function PatchDiffLines({ content, className }: { content: string; className?: string }) {
  return (
    <pre className={cn("font-mono text-xs leading-5 overflow-auto select-text", className)}>
      <code className="block min-w-max py-1">
        {content.split("\n").map((line, i) => {
          const kind = patchLineKind(line);
          const signed = kind === "add" || kind === "del" || kind === "context";
          return (
            <div key={i} className={cn("flex pr-3", PATCH_ROW_CLASS[kind])}>
              {signed ? (
                <>
                  <span className={cn("w-6 shrink-0 text-center", PATCH_SIGN_CLASS[kind])}>
                    {kind === "context" ? " " : line[0]}
                  </span>
                  <span>{line.slice(1) || " "}</span>
                </>
              ) : (
                <span className="pl-3">{line || " "}</span>
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
function PatchPreview({ patch, maxHeightClass }: { patch: Artifact; maxHeightClass: string }) {
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
      <PatchDiffLines content={patch.content} className={maxHeightClass} />
    </div>
  );
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
  outcome: RowOutcome | undefined;
  onOutcome: (id: string, outcome: RowOutcome | null) => void;
  onCopy: (artifact: Artifact) => Promise<boolean>;
  onSave: (artifact: Artifact) => Promise<SaveArtifactOutcome>;
  onApplyPatch: (artifact: Artifact) => Promise<ApplyPatchOutcome>;
  canApplyPatch: boolean;
  isProcessing: boolean;
  isApplying: boolean;
}

function ArtifactItem({
  artifact,
  isExpanded,
  onToggle,
  outcome,
  onOutcome,
  onCopy,
  onSave,
  onApplyPatch,
  canApplyPatch,
  isProcessing,
  isApplying,
}: ArtifactItemProps) {
  const bodyId = useId();
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const outcomeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
      if (outcomeTimerRef.current) window.clearTimeout(outcomeTimerRef.current);
    };
  }, []);

  const setOutcome = useCallback(
    (next: RowOutcome | null, transient = false) => {
      if (outcomeTimerRef.current) window.clearTimeout(outcomeTimerRef.current);
      outcomeTimerRef.current = null;
      onOutcome(artifact.id, next);
      if (next && transient) {
        outcomeTimerRef.current = window.setTimeout(
          () => onOutcome(artifact.id, null),
          TRANSIENT_OUTCOME_MS
        );
      }
    },
    [artifact.id, onOutcome]
  );

  const handleCopy = useCallback(async () => {
    const success = await onCopy(artifact);
    if (success) {
      setCopied(true);
      if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    } else {
      setOutcome({ kind: "copy-failed" });
    }
  }, [artifact, onCopy, setOutcome]);

  const handleSave = useCallback(async () => {
    const result = await onSave(artifact);
    if (result.status === "saved") setOutcome({ kind: "saved", filePath: result.filePath }, true);
    else if (result.status === "failed") setOutcome({ kind: "save-failed", message: result.error });
  }, [artifact, onSave, setOutcome]);

  const handleApplyPatch = useCallback(async () => {
    const result = await onApplyPatch(artifact);
    if (result.success) {
      setOutcome({ kind: "applied", files: result.modifiedFiles });
    } else if (!result.cancelled) {
      setOutcome({ kind: "apply-failed", message: result.error || "git apply failed" });
    }
  }, [artifact, onApplyPatch, setOutcome]);

  const Icon = ARTIFACT_TYPE_ICONS[artifact.type] ?? File;
  const typeLabel = ARTIFACT_TYPE_LABELS[artifact.type] ?? "Artifact";
  const isPatch = artifact.type === "patch";
  const { base, dir } = splitPath(artifact.filename || typeLabel);
  const lines = artifact.content.split("\n").length;
  const applied = outcome?.kind === "applied";

  return (
    <li
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
        {applied && <span className="shrink-0 text-xs text-text-secondary">Applied</span>}
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
          {isPatch ? (
            <PatchDiffLines content={artifact.content} className="max-h-56 bg-surface-canvas" />
          ) : (
            <pre className="max-h-56 overflow-auto bg-surface-canvas px-3 py-2 font-mono text-xs leading-5 text-text-primary select-text">
              <code>{artifact.content}</code>
            </pre>
          )}

          <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-t border-border-default">
            {isPatch && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      variant="contrast"
                      size="sm"
                      onClick={() => void handleApplyPatch()}
                      disabled={!canApplyPatch || (isProcessing && !isApplying)}
                      loading={isApplying}
                    >
                      Apply patch
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {canApplyPatch
                    ? "Preview the diff, then git apply it in this worktree"
                    : "This terminal isn't in a worktree, so there's nowhere to apply it"}
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
            {outcome?.kind === "applied" && (
              <OutcomeLine tone="success" icon={CircleCheck}>
                Applied to {plural(outcome.files.length, "file", "files")}
                {outcome.files.length > 0 && (
                  <span className="block truncate font-mono text-text-secondary">
                    {outcome.files.join(", ")}
                  </span>
                )}
              </OutcomeLine>
            )}
            {outcome?.kind === "apply-failed" && (
              <OutcomeLine tone="error" icon={CircleAlert} onDismiss={() => setOutcome(null)}>
                Patch didn't apply. Nothing was changed.
                <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-text-secondary">
                  {outcome.message}
                </pre>
              </OutcomeLine>
            )}
            {outcome?.kind === "saved" && (
              <OutcomeLine tone="neutral" icon={Check}>
                Saved to <span className="font-mono text-text-secondary">{outcome.filePath}</span>
              </OutcomeLine>
            )}
            {outcome?.kind === "save-failed" && (
              <OutcomeLine tone="error" icon={CircleAlert} onDismiss={() => setOutcome(null)}>
                Couldn't save. Try again, or copy it instead.
                <span className="block text-text-secondary">{outcome.message}</span>
              </OutcomeLine>
            )}
            {outcome?.kind === "copy-failed" && (
              <OutcomeLine tone="error" icon={CircleAlert} onDismiss={() => setOutcome(null)}>
                Couldn't copy to the clipboard.
              </OutcomeLine>
            )}
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
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, RowOutcome>>(() => new Map());
  const [codeOnly, setCodeOnly] = useState(false);
  const [bulkStatus, setBulkStatus] = useState<BulkStatus | null>(null);
  const bulkStatusTimerRef = useRef<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
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

  const handleOutcome = useCallback((id: string, outcome: RowOutcome | null) => {
    setOutcomes((prev) => {
      const next = new Map(prev);
      if (outcome) next.set(id, outcome);
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

  // Closing hands focus back to the pill, the one control that survives the close.
  useEffect(() => {
    if (isExpanded || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus({ preventScroll: true });
  }, [isExpanded]);

  const showBulkStatus = useCallback((status: BulkStatus) => {
    setBulkStatus(status);
    if (bulkStatusTimerRef.current) window.clearTimeout(bulkStatusTimerRef.current);
    bulkStatusTimerRef.current = status.persistent
      ? null
      : window.setTimeout(() => setBulkStatus(null), TRANSIENT_OUTCOME_MS);
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
      showBulkStatus({ text: "Couldn't copy to the clipboard", tone: "error", persistent: true });
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
      showBulkStatus({
        text:
          result.succeeded > 0
            ? `Saved ${result.succeeded}, couldn't save ${result.failed}`
            : "Couldn't save the artifacts",
        tone: "error",
        persistent: true,
      });
    }
  }, [saveAll, showBulkStatus]);

  const handleApplyAllPatches = useCallback(() => {
    // Snapshot at request time so the dialog previews exactly the set confirm
    // will apply — patches detected while the dialog is open are excluded.
    setPendingBulkPatches(artifacts.filter((a) => a.type === "patch"));
  }, [artifacts]);

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
    setOutcomes((prev) => {
      const next = new Map(prev);
      for (const patch of snapshot) {
        const error = failures.get(patch.id);
        next.set(
          patch.id,
          error !== undefined
            ? { kind: "apply-failed", message: error }
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
            ? `Applied ${result.succeeded}, ${result.failed} didn't apply. Details are on the rows below.`
            : `${plural(result.failed, "patch", "patches")} didn't apply. Details are on the rows below.`,
        tone: "error",
        persistent: true,
      });
    }
  }, [applyAllPatches, pendingBulkPatches, showBulkStatus]);

  const closePanel = useCallback(() => {
    handleCancelApplyPatch();
    handleCancelApplyAllPatches();
    restoreFocusRef.current = true;
    setIsExpanded(false);
  }, [handleCancelApplyPatch, handleCancelApplyAllPatches]);

  const openPanel = useCallback(() => {
    // One artifact has nothing to choose between, so it opens ready to act on.
    if (artifacts.length === 1) setExpandedIds(new Set([artifacts[0]!.id]));
    setIsExpanded(true);
  }, [artifacts]);

  const handleClear = useCallback(() => {
    setOutcomes(new Map());
    setExpandedIds(new Set());
    setBulkStatus(null);
    clearArtifacts();
  }, [clearArtifacts]);

  const codeArtifactCount = artifacts.filter((a) => a.type === "code").length;
  const patchCount = artifacts.filter((a) => a.type === "patch").length;
  const copyTargetCount = codeOnly ? codeArtifactCount : artifacts.length;
  const showBulkBar = artifacts.length > 1;
  const showApplyAll = patchCount > 1;
  const canApplyAll = showApplyAll && !!worktreeId && !!cwd;
  const isBulkActionRunning = !!bulkProgress;

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
                    <Copy aria-hidden="true" />
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
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={() => void handleSaveAll()}
                  disabled={isBulkActionRunning}
                >
                  <Download aria-hidden="true" />
                  Save all…
                </Button>
                {showApplyAll && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Button
                          variant="subtle"
                          size="sm"
                          onClick={handleApplyAllPatches}
                          disabled={isBulkActionRunning || !canApplyAll}
                          loading={bulkProgress?.action === "apply"}
                        >
                          <FileDiff aria-hidden="true" />
                          Apply {plural(patchCount, "patch", "patches")}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {canApplyAll
                        ? "Preview every diff, then git apply them in order"
                        : "This terminal isn't in a worktree, so there's nowhere to apply them"}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            )}

            <div role="status" aria-live="polite">
              {(bulkProgressText || bulkStatus) && (
                <div className="flex items-center gap-2 px-3 pb-2 text-xs">
                  {bulkProgressText ? (
                    <span className="tabular-nums text-text-secondary">{bulkProgressText}</span>
                  ) : bulkStatus ? (
                    <>
                      {bulkStatus.tone === "success" ? (
                        <CircleCheck
                          aria-hidden="true"
                          className="size-3.5 shrink-0 text-status-success"
                        />
                      ) : (
                        <CircleAlert
                          aria-hidden="true"
                          className="size-3.5 shrink-0 text-status-error"
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
                outcome={outcomes.get(artifact.id)}
                onOutcome={handleOutcome}
                onCopy={handleCopy}
                onSave={handleSave}
                onApplyPatch={handleApplyPatch}
                canApplyPatch={canApplyPatch(artifact)}
                isProcessing={isBulkActionRunning || actionInProgress === artifact.id}
                isApplying={applyingId === artifact.id}
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
          <PatchPreview patch={pendingPatch} maxHeightClass="max-h-[min(24rem,50vh)]" />
        )}
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={pendingBulkPatches !== null}
        onClose={handleCancelApplyAllPatches}
        title={`Apply ${plural(pendingBulkCount, "patch", "patches")} to this worktree?`}
        description={
          <span>
            Runs <span className="font-mono">git apply</span> on each patch below, in the order the
            agent wrote them, in <span className="font-mono text-text-primary">{cwd}</span>. Every
            patch is attempted; if one fails, the others still apply. There's no automatic undo.
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
          <div className="max-h-[min(28rem,55vh)] overflow-y-auto space-y-2">
            {pendingBulkPatches.map((patch) => (
              <PatchPreview key={patch.id} patch={patch} maxHeightClass="" />
            ))}
          </div>
        )}
      </ConfirmDialog>
    </>
  );
}
