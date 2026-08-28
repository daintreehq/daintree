import { useState, useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useArtifacts } from "@/hooks/useArtifacts";
import type { Artifact } from "@shared/types";

type ApplyPatchOutcome =
  | { success: true; modifiedFiles: string[] }
  | { success: false; error: string; cancelled?: boolean };

export function getPatchStats(content: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of content.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

export function patchLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
    return "text-text-secondary";
  }
  if (line.startsWith("+")) return "text-status-success bg-status-success/10";
  if (line.startsWith("-")) return "text-status-error bg-status-error/10";
  return "text-daintree-text/80";
}

function PatchDiffLines({ content, className }: { content: string; className?: string }) {
  return (
    <pre
      className={cn(
        "font-mono text-2xs leading-4 overflow-y-auto overflow-x-auto select-text",
        className
      )}
    >
      {content.split("\n").map((line, i) => (
        <div key={i} className={patchLineClass(line)}>
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function PatchDiffPreview({ content }: { content: string }) {
  return (
    <div className="rounded border border-tint/[0.08] bg-tint/[0.04]">
      <div className="px-3 py-2 border-b border-tint/[0.08]">
        <span className="text-2xs font-semibold uppercase tracking-wider text-daintree-text/60">
          Patch contents
        </span>
      </div>
      <PatchDiffLines content={content} className="px-3 py-2 max-h-[200px]" />
    </div>
  );
}

interface ArtifactOverlayProps {
  terminalId: string;
  worktreeId?: string;
  cwd?: string;
  className?: string;
}

const ARTIFACT_TYPE_COLORS: Record<string, string> = {
  code: "border-status-info bg-[color-mix(in_oklab,var(--color-status-info)_10%,transparent)] text-status-info",
  patch: "border-border-default bg-overlay-subtle text-text-secondary",
  file: "border-state-working bg-[color-mix(in_oklab,var(--color-state-working)_10%,transparent)] text-state-working",
  summary:
    "border-status-warning bg-[color-mix(in_oklab,var(--color-status-warning)_10%,transparent)] text-status-warning",
  other: "border-border-default bg-daintree-sidebar/10 text-daintree-text/60",
};

const ARTIFACT_TYPE_ICONS: Record<string, string> = {
  code: "{ }",
  patch: "+/-",
  file: "[ ]",
  summary: "#",
  other: "...",
};

interface ArtifactItemProps {
  artifact: Artifact;
  onCopy: (artifact: Artifact) => Promise<boolean>;
  onSave: (artifact: Artifact) => Promise<{ filePath: string } | null>;
  onApplyPatch: (artifact: Artifact) => Promise<ApplyPatchOutcome>;
  canApplyPatch: boolean;
  isProcessing: boolean;
}

function ArtifactItem({
  artifact,
  onCopy,
  onSave,
  onApplyPatch,
  canApplyPatch,
  isProcessing,
}: ArtifactItemProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; tone: "success" | "error" } | null>(
    null
  );
  const feedbackTimerRef = useRef<number | null>(null);

  const showFeedback = useCallback((text: string, tone: "success" | "error") => {
    setFeedback({ text, tone });
    if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => setFeedback(null), 2000);
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    const success = await onCopy(artifact);
    if (success) {
      showFeedback("Copied!", "success");
    } else {
      showFeedback("Copy failed", "error");
    }
  }, [artifact, onCopy, showFeedback]);

  const handleSave = useCallback(async () => {
    const result = await onSave(artifact);
    if (result?.filePath) {
      showFeedback("Saved!", "success");
    } else {
      showFeedback("Save failed", "error");
    }
  }, [artifact, onSave, showFeedback]);

  const handleApplyPatch = useCallback(async () => {
    const result = await onApplyPatch(artifact);
    if (result.success) {
      showFeedback("Patch applied!", "success");
    } else if (!result.cancelled) {
      showFeedback(result.error || "Patch failed", "error");
    }
  }, [artifact, onApplyPatch, showFeedback]);

  const colorClass = ARTIFACT_TYPE_COLORS[artifact.type] || ARTIFACT_TYPE_COLORS.other!;
  const icon = ARTIFACT_TYPE_ICONS[artifact.type] || ARTIFACT_TYPE_ICONS.other;
  const title = artifact.filename || artifact.language || artifact.type;
  const previewLines = artifact.content.split("\n").slice(0, 2);
  const hasMore = artifact.content.split("\n").length > 2;
  const lineCount = artifact.content.split("\n").length;

  return (
    <div
      className={cn("border rounded-[var(--radius-md)] overflow-hidden", colorClass.split(" ")[0])}
    >
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "w-full flex items-center justify-between px-3 py-2 text-left",
          colorClass.split(" ")[1],
          "hover:brightness-110 transition"
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn("font-mono text-xs shrink-0", colorClass.split(" ")[2])}>{icon}</span>
          <span className="text-sm text-text-primary font-medium truncate">{title}</span>
          {artifact.language && artifact.language !== artifact.type && (
            <span className="text-xs text-text-secondary shrink-0">{artifact.language}</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-text-secondary">
            {lineCount} line{lineCount !== 1 ? "s" : ""}
          </span>
          <span className="text-daintree-text/60">{isExpanded ? "▼" : "▶"}</span>
        </div>
      </button>

      {isExpanded && (
        <div className="bg-daintree-bg/50">
          <pre className="font-mono text-xs p-3 overflow-x-auto max-h-32 overflow-y-auto select-text">
            <code className="text-text-primary">
              {previewLines.join("\n")}
              {hasMore && <span className="text-text-secondary">{"\n"}...</span>}
            </code>
          </pre>

          <div className="flex items-center gap-2 px-3 py-2 bg-daintree-sidebar/50 border-t border-border-default">
            <button
              onClick={handleCopy}
              disabled={isProcessing}
              className={cn(
                "px-3 py-1 text-xs rounded transition-colors",
                "border border-status-info/30 text-status-info hover:bg-status-info/10",
                "disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none"
              )}
            >
              Copy Code
            </button>
            <button
              onClick={handleSave}
              disabled={isProcessing}
              className={cn(
                "px-3 py-1 text-xs rounded transition-colors",
                "bg-border-default hover:bg-[color-mix(in_oklab,var(--color-border-default)_100%,white_20%)] text-text-primary",
                "disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none"
              )}
            >
              Save to File
            </button>
            {artifact.type === "patch" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <button
                      onClick={handleApplyPatch}
                      disabled={isProcessing || !canApplyPatch}
                      className={cn(
                        "px-3 py-1 text-xs rounded transition-colors",
                        "bg-status-success hover:brightness-110 text-surface-canvas",
                        "disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none"
                      )}
                    >
                      Apply Patch
                    </button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {!canApplyPatch ? "No worktree context available" : "Apply patch to worktree"}
                </TooltipContent>
              </Tooltip>
            )}
            {feedback && (
              <span
                role="status"
                aria-live="polite"
                className={cn(
                  "ml-auto text-xs animate-pulse",
                  feedback.tone === "success" ? "text-status-success" : "text-status-error"
                )}
              >
                {feedback.text}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ArtifactOverlay({ terminalId, worktreeId, cwd, className }: ArtifactOverlayProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [includeAllTypes, setIncludeAllTypes] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ text: string; tone: "success" | "error" } | null>(
    null
  );
  const bulkResultTimerRef = useRef<number | null>(null);
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
    const result = await applyPatch(artifact);
    resolve?.(result);
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
      if (bulkResultTimerRef.current) window.clearTimeout(bulkResultTimerRef.current);
    };
  }, []);

  const showBulkResult = useCallback((text: string, tone: "success" | "error") => {
    setBulkResult({ text, tone });
    if (bulkResultTimerRef.current) window.clearTimeout(bulkResultTimerRef.current);
    bulkResultTimerRef.current = window.setTimeout(() => setBulkResult(null), 3000);
  }, []);

  const handleCopyAll = useCallback(async () => {
    const result = await copyAll(includeAllTypes);
    if (result.succeeded > 0) {
      showBulkResult(
        `Copied ${result.succeeded} artifact${result.succeeded !== 1 ? "s" : ""}`,
        "success"
      );
    } else if (result.failed > 0) {
      showBulkResult(`Failed to copy artifacts`, "error");
    } else {
      showBulkResult(
        includeAllTypes ? "No artifacts to copy" : "No code artifacts (switch to All)",
        "error"
      );
    }
  }, [copyAll, includeAllTypes, showBulkResult]);

  const handleSaveAll = useCallback(async () => {
    const result = await saveAll();
    if (result.succeeded > 0 && result.failed === 0) {
      showBulkResult(
        `Saved ${result.succeeded} artifact${result.succeeded !== 1 ? "s" : ""}`,
        "success"
      );
    } else if (result.succeeded > 0 && result.failed > 0) {
      showBulkResult(`Saved ${result.succeeded}, failed ${result.failed}`, "error");
    } else if (result.failed > 0) {
      showBulkResult(`Failed to save artifacts`, "error");
    }
  }, [saveAll, showBulkResult]);

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
    if (result.succeeded > 0 && result.failed === 0) {
      const filesMsg = result.modifiedFiles?.length
        ? ` (${result.modifiedFiles.length} files)`
        : "";
      showBulkResult(
        `Applied ${result.succeeded} patch${result.succeeded !== 1 ? "es" : ""}${filesMsg}`,
        "success"
      );
    } else if (result.succeeded > 0 && result.failed > 0) {
      showBulkResult(`Applied ${result.succeeded}, failed ${result.failed}`, "error");
    } else if (result.failed > 0) {
      showBulkResult(`Failed to apply patches`, "error");
    }
  }, [applyAllPatches, pendingBulkPatches, showBulkResult]);

  const codeArtifactCount = artifacts.filter((a) => a.type === "code").length;
  const patchCount = artifacts.filter((a) => a.type === "patch").length;
  const copyTargetCount = includeAllTypes ? artifacts.length : codeArtifactCount;
  const showCopyGroup = artifacts.length > 1;
  const canCopyAll = copyTargetCount > 1;
  const showSaveAll = artifacts.length > 1;
  const showApplyAll = patchCount > 1;
  const canApplyAll = showApplyAll && !!worktreeId && !!cwd;
  const isBulkActionRunning = !!bulkProgress;

  if (!hasArtifacts) {
    return null;
  }

  return (
    <div className={cn("absolute bottom-4 right-4 z-10", className)}>
      {!isExpanded ? (
        <button
          onClick={() => setIsExpanded(true)}
          className={cn(
            "px-3 py-2 rounded-[var(--radius-md)] bg-surface-canvas shadow-[var(--theme-shadow-floating)]",
            "border border-status-info/30 text-status-info hover:bg-status-info/10",
            "text-sm font-medium transition-colors",
            "flex items-center gap-2"
          )}
        >
          <span className="font-mono">{"{ }"}</span>
          <span className="tabular-nums">
            {artifacts.length} artifact{artifacts.length !== 1 ? "s" : ""}
          </span>
        </button>
      ) : (
        <div
          className={cn(
            "bg-surface-sidebar border border-border-default rounded-[var(--radius-lg)] shadow-[var(--theme-shadow-floating)]",
            "w-96 max-h-96 flex flex-col overflow-hidden"
          )}
        >
          <div className="bg-surface-canvas border-b border-border-default">
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-status-info">{"{ }"}</span>
                <span className="text-sm font-medium tabular-nums text-text-primary">
                  {artifacts.length} Artifact{artifacts.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={clearArtifacts}
                  disabled={isBulkActionRunning}
                  className="text-xs text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none"
                  aria-label="Clear all artifacts"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleCancelApplyPatch();
                    handleCancelApplyAllPatches();
                    setIsExpanded(false);
                  }}
                  disabled={isBulkActionRunning}
                  className="text-daintree-text/40 hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none"
                  aria-label="Close artifact overlay"
                >
                  ×
                </button>
              </div>
            </div>

            {(showCopyGroup || showSaveAll || showApplyAll) && (
              <div className="px-4 pb-3 flex items-center gap-2 flex-wrap">
                {showCopyGroup && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={handleCopyAll}
                      disabled={isBulkActionRunning || !canCopyAll}
                      className={cn(
                        "px-3 py-1 text-xs rounded transition-colors",
                        "border border-status-info/30 text-status-info hover:bg-status-info/10",
                        "disabled:opacity-50 disabled:cursor-not-allowed"
                      )}
                    >
                      Copy All
                    </button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          <button
                            type="button"
                            onClick={() => setIncludeAllTypes((v) => !v)}
                            disabled={isBulkActionRunning}
                            className={cn(
                              "px-2 py-1 text-xs rounded transition-colors",
                              includeAllTypes
                                ? "bg-border-default text-text-primary"
                                : "bg-surface-sidebar text-daintree-text/60",
                              "hover:brightness-110",
                              "disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none"
                            )}
                          >
                            {includeAllTypes ? "All" : "Code"}
                          </button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        {includeAllTypes ? "Copying all types" : "Copying code only"}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                )}
                {showSaveAll && (
                  <button
                    type="button"
                    onClick={handleSaveAll}
                    disabled={isBulkActionRunning}
                    className={cn(
                      "px-3 py-1 text-xs rounded transition-colors",
                      "bg-border-default hover:bg-[color-mix(in_oklab,var(--color-border-default)_100%,white_20%)] text-text-primary",
                      "disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none"
                    )}
                  >
                    Save All
                  </button>
                )}
                {showApplyAll && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <button
                          type="button"
                          onClick={handleApplyAllPatches}
                          disabled={isBulkActionRunning || !canApplyAll}
                          className={cn(
                            "px-3 py-1 text-xs rounded transition-colors",
                            "bg-status-success hover:brightness-110 text-surface-canvas",
                            "disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none"
                          )}
                        >
                          Apply All Patches
                        </button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {!canApplyAll ? "No worktree context available" : "Apply all patches"}
                    </TooltipContent>
                  </Tooltip>
                )}
                {bulkProgress && (
                  <span className="text-xs tabular-nums text-daintree-text/60 ml-auto">
                    {bulkProgress.action === "copy" && "Copying…"}
                    {bulkProgress.action === "save" &&
                      `Saving ${bulkProgress.current}/${bulkProgress.total}…`}
                    {bulkProgress.action === "apply" &&
                      `Applying ${bulkProgress.current}/${bulkProgress.total}…`}
                  </span>
                )}
                {bulkResult && !bulkProgress && (
                  <span
                    role="status"
                    aria-live="polite"
                    className={cn(
                      "text-xs ml-auto animate-pulse",
                      bulkResult.tone === "success" ? "text-status-success" : "text-status-error"
                    )}
                  >
                    {bulkResult.text}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {artifacts.map((artifact) => (
              <ArtifactItem
                key={artifact.id}
                artifact={artifact}
                onCopy={handleCopy}
                onSave={handleSave}
                onApplyPatch={handleApplyPatch}
                canApplyPatch={canApplyPatch(artifact)}
                isProcessing={isBulkActionRunning || actionInProgress === artifact.id}
              />
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={pendingPatch !== null}
        onClose={handleCancelApplyPatch}
        title="Apply patch to worktree?"
        description={
          <span>
            Writes the diff below to files in this worktree via{" "}
            <span className="font-mono">git apply</span>. Recovery is a manual git checkout of the
            touched files.
          </span>
        }
        confirmLabel="Apply patch"
        variant="destructive"
        hasPreview={true}
        onConfirm={() => void handleConfirmApplyPatch()}
      >
        {pendingPatch && <PatchDiffPreview content={pendingPatch.content} />}
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={pendingBulkPatches !== null}
        onClose={handleCancelApplyAllPatches}
        title={`Apply ${pendingBulkPatches?.length ?? 0} patch${
          pendingBulkPatches?.length !== 1 ? "es" : ""
        } to worktree?`}
        description="Applies each patch below to files in this worktree in extraction order. A patch that fails leaves the earlier ones applied."
        confirmLabel={`Apply ${pendingBulkPatches?.length ?? 0} patch${
          pendingBulkPatches?.length !== 1 ? "es" : ""
        }`}
        variant="destructive"
        hasPreview={true}
        onConfirm={() => void handleConfirmApplyAllPatches()}
      >
        {pendingBulkPatches && (
          <div className="rounded border border-tint/[0.08] bg-tint/[0.04]">
            <div className="px-3 py-2 border-b border-tint/[0.08]">
              <span className="text-2xs font-semibold uppercase tracking-wider text-daintree-text/60">
                Patches to apply
              </span>
            </div>
            <div className="max-h-[260px] overflow-y-auto divide-y divide-tint/[0.08]">
              {pendingBulkPatches.map((patch) => {
                const stats = getPatchStats(patch.content);
                return (
                  // D2 requires actual diff content per patch, not just counts —
                  // open by default; the toggle only tames very long bulk sets.
                  <details key={patch.id} open className="group">
                    <summary className="flex items-baseline gap-2 px-3 py-2 cursor-pointer list-none">
                      <span className="text-daintree-text/40 text-3xs shrink-0 group-open:hidden">
                        ▶
                      </span>
                      <span className="text-daintree-text/40 text-3xs shrink-0 hidden group-open:inline">
                        ▼
                      </span>
                      <span className="text-daintree-text/80 truncate min-w-0">
                        {patch.filename || patch.language || "patch"}
                      </span>
                      <span className="font-mono text-3xs shrink-0 ml-auto tabular-nums">
                        <span className="text-status-success">+{stats.additions}</span>{" "}
                        <span className="text-status-error">-{stats.deletions}</span>
                      </span>
                    </summary>
                    <PatchDiffLines content={patch.content} className="px-3 pb-2 max-h-[120px]" />
                  </details>
                );
              })}
            </div>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
