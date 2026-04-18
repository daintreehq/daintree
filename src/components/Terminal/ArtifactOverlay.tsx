import { useState, useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { useArtifacts } from "@/hooks/useArtifacts";
import type { Artifact } from "@shared/types";

interface ArtifactOverlayProps {
  terminalId: string;
  worktreeId?: string;
  cwd?: string;
  className?: string;
}

const ARTIFACT_TYPE_COLORS: Record<string, string> = {
  code: "border-status-info bg-[color-mix(in_oklab,var(--color-status-info)_10%,transparent)] text-status-info",
  patch:
    "border-status-success bg-[color-mix(in_oklab,var(--color-status-success)_10%,transparent)] text-status-success",
  file: "border-state-working bg-[color-mix(in_oklab,var(--color-state-working)_10%,transparent)] text-state-working",
  summary:
    "border-status-warning bg-[color-mix(in_oklab,var(--color-status-warning)_10%,transparent)] text-status-warning",
  other: "border-daintree-border bg-daintree-sidebar/10 text-daintree-text/60",
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
  onSave: (artifact: Artifact) => Promise<{ filePath: string; success: boolean } | null>;
  onApplyPatch: (
    artifact: Artifact
  ) => Promise<{ success: boolean; error?: string; modifiedFiles?: string[] }>;
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
    if (result?.success) {
      showFeedback("Saved!", "success");
    } else {
      showFeedback("Save failed", "error");
    }
  }, [artifact, onSave, showFeedback]);

  const handleApplyPatch = useCallback(async () => {
    const result = await onApplyPatch(artifact);
    if (result.success) {
      showFeedback("Patch applied!", "success");
    } else {
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
          <span className="text-sm text-daintree-text font-medium truncate">{title}</span>
          {artifact.language && artifact.language !== artifact.type && (
            <span className="text-xs text-daintree-text/40 shrink-0">{artifact.language}</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-daintree-text/40">
            {lineCount} line{lineCount !== 1 ? "s" : ""}
          </span>
          <span className="text-daintree-text/60">{isExpanded ? "▼" : "▶"}</span>
        </div>
      </button>

      {isExpanded && (
        <div className="bg-daintree-bg/50">
          <pre className="font-mono text-xs p-3 overflow-x-auto max-h-32 overflow-y-auto select-text">
            <code className="text-daintree-text">
              {previewLines.join("\n")}
              {hasMore && <span className="text-daintree-text/40">{"\n"}...</span>}
            </code>
          </pre>

          <div className="flex items-center gap-2 px-3 py-2 bg-daintree-sidebar/50 border-t border-daintree-border">
            <button
              onClick={handleCopy}
              disabled={isProcessing}
              className={cn(
                "px-3 py-1 text-xs rounded transition-colors",
                "border border-status-info/30 text-status-info hover:bg-status-info/10",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              Copy Code
            </button>
            <button
              onClick={handleSave}
              disabled={isProcessing}
              className={cn(
                "px-3 py-1 text-xs rounded transition-colors",
                "bg-daintree-border hover:bg-[color-mix(in_oklab,var(--color-daintree-border)_100%,white_20%)] text-daintree-text",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              Save to File
            </button>
            {artifact.type === "patch" && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">
                      <button
                        onClick={handleApplyPatch}
                        disabled={isProcessing || !canApplyPatch}
                        className={cn(
                          "px-3 py-1 text-xs rounded transition-colors",
                          "bg-status-success hover:brightness-110 text-daintree-bg",
                          "disabled:opacity-50 disabled:cursor-not-allowed"
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
              </TooltipProvider>
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

  const handleApplyPatch = useCallback(
    async (artifact: Artifact) => {
      return await applyPatch(artifact);
    },
    [applyPatch]
  );

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

  const handleApplyAllPatches = useCallback(async () => {
    const result = await applyAllPatches();
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
  }, [applyAllPatches, showBulkResult]);

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
            "px-3 py-2 rounded-[var(--radius-md)] shadow-lg",
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
            "bg-daintree-sidebar border border-daintree-border rounded-[var(--radius-lg)] shadow-[var(--theme-shadow-floating)]",
            "w-96 max-h-96 flex flex-col overflow-hidden"
          )}
        >
          <div className="bg-daintree-bg border-b border-daintree-border">
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-status-info">{"{ }"}</span>
                <span className="text-sm font-medium tabular-nums text-daintree-text">
                  {artifacts.length} Artifact{artifacts.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={clearArtifacts}
                  disabled={isBulkActionRunning}
                  className="text-xs text-daintree-text/40 hover:text-daintree-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Clear all artifacts"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => setIsExpanded(false)}
                  disabled={isBulkActionRunning}
                  className="text-daintree-text/40 hover:text-daintree-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
                    <TooltipProvider>
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
                                  ? "bg-daintree-border text-daintree-text"
                                  : "bg-daintree-sidebar text-daintree-text/60",
                                "hover:brightness-110",
                                "disabled:opacity-50 disabled:cursor-not-allowed"
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
                    </TooltipProvider>
                  </div>
                )}
                {showSaveAll && (
                  <button
                    type="button"
                    onClick={handleSaveAll}
                    disabled={isBulkActionRunning}
                    className={cn(
                      "px-3 py-1 text-xs rounded transition-colors",
                      "bg-daintree-border hover:bg-[color-mix(in_oklab,var(--color-daintree-border)_100%,white_20%)] text-daintree-text",
                      "disabled:opacity-50 disabled:cursor-not-allowed"
                    )}
                  >
                    Save All
                  </button>
                )}
                {showApplyAll && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          <button
                            type="button"
                            onClick={handleApplyAllPatches}
                            disabled={isBulkActionRunning || !canApplyAll}
                            className={cn(
                              "px-3 py-1 text-xs rounded transition-colors",
                              "bg-status-success hover:brightness-110 text-daintree-bg",
                              "disabled:opacity-50 disabled:cursor-not-allowed"
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
                  </TooltipProvider>
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
    </div>
  );
}

export default ArtifactOverlay;
