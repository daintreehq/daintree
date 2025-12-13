import { useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useArtifacts } from "@/hooks/useArtifacts";
import type { Artifact } from "@shared/types";

interface ArtifactOverlayProps {
  terminalId: string;
  worktreeId?: string;
  cwd?: string;
  className?: string;
}

const ARTIFACT_TYPE_COLORS: Record<string, string> = {
  code: "border-[var(--color-status-info)] bg-[color-mix(in_oklab,var(--color-status-info)_10%,transparent)] text-[var(--color-status-info)]",
  patch:
    "border-[var(--color-status-success)] bg-[color-mix(in_oklab,var(--color-status-success)_10%,transparent)] text-[var(--color-status-success)]",
  file: "border-[var(--color-state-working)] bg-[color-mix(in_oklab,var(--color-state-working)_10%,transparent)] text-[var(--color-state-working)]",
  summary:
    "border-[var(--color-status-warning)] bg-[color-mix(in_oklab,var(--color-status-warning)_10%,transparent)] text-[var(--color-status-warning)]",
  other: "border-canopy-border bg-canopy-sidebar/10 text-canopy-text/60",
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
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

  const showFeedback = useCallback((message: string) => {
    setFeedbackMessage(message);
    setTimeout(() => setFeedbackMessage(null), 2000);
  }, []);

  const handleCopy = useCallback(async () => {
    const success = await onCopy(artifact);
    if (success) {
      showFeedback("Copied!");
    } else {
      showFeedback("Copy failed");
    }
  }, [artifact, onCopy, showFeedback]);

  const handleSave = useCallback(async () => {
    const result = await onSave(artifact);
    if (result) {
      showFeedback("Saved!");
    } else {
      showFeedback("Save failed");
    }
  }, [artifact, onSave, showFeedback]);

  const handleApplyPatch = useCallback(async () => {
    const result = await onApplyPatch(artifact);
    if (result.success) {
      showFeedback("Patch applied!");
    } else {
      showFeedback(result.error || "Patch failed");
    }
  }, [artifact, onApplyPatch, showFeedback]);

  const colorClass = ARTIFACT_TYPE_COLORS[artifact.type] || ARTIFACT_TYPE_COLORS.other;
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
          "hover:brightness-110 transition-all"
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn("font-mono text-xs shrink-0", colorClass.split(" ")[2])}>{icon}</span>
          <span className="text-sm text-canopy-text font-medium truncate">{title}</span>
          {artifact.language && artifact.language !== artifact.type && (
            <span className="text-xs text-canopy-text/40 shrink-0">{artifact.language}</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-canopy-text/40">
            {lineCount} line{lineCount !== 1 ? "s" : ""}
          </span>
          <span className="text-canopy-text/60">{isExpanded ? "▼" : "▶"}</span>
        </div>
      </button>

      {isExpanded && (
        <div className="bg-canopy-bg/50">
          <pre className="font-mono text-xs p-3 overflow-x-auto max-h-32 overflow-y-auto">
            <code className="text-canopy-text">
              {previewLines.join("\n")}
              {hasMore && <span className="text-canopy-text/40">{"\n"}...</span>}
            </code>
          </pre>

          <div className="flex items-center gap-2 px-3 py-2 bg-canopy-sidebar/50 border-t border-canopy-border">
            <button
              onClick={handleCopy}
              disabled={isProcessing}
              className={cn(
                "px-3 py-1 text-xs rounded transition-colors",
                "bg-[var(--color-status-info)] hover:brightness-110 text-white",
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
                "bg-canopy-border hover:bg-[color-mix(in_oklab,var(--color-canopy-border)_100%,white_20%)] text-white",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              Save to File
            </button>
            {artifact.type === "patch" && (
              <button
                onClick={handleApplyPatch}
                disabled={isProcessing || !canApplyPatch}
                className={cn(
                  "px-3 py-1 text-xs rounded transition-colors",
                  "bg-[var(--color-status-success)] hover:brightness-110 text-white",
                  "disabled:opacity-50 disabled:cursor-not-allowed"
                )}
                title={!canApplyPatch ? "No worktree context available" : "Apply patch to worktree"}
              >
                Apply Patch
              </button>
            )}
            {feedbackMessage && (
              <span className="ml-auto text-xs text-[var(--color-status-success)] animate-pulse">
                {feedbackMessage}
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
  const {
    artifacts,
    actionInProgress,
    hasArtifacts,
    copyToClipboard,
    saveToFile,
    applyPatch,
    clearArtifacts,
    canApplyPatch,
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
            "bg-[var(--color-status-info)] hover:brightness-110 text-white",
            "text-sm font-medium transition-all",
            "flex items-center gap-2"
          )}
        >
          <span className="font-mono">{"{ }"}</span>
          <span>
            {artifacts.length} artifact{artifacts.length !== 1 ? "s" : ""}
          </span>
        </button>
      ) : (
        <div
          className={cn(
            "bg-canopy-sidebar border border-canopy-border rounded-[var(--radius-lg)] shadow-2xl",
            "w-96 max-h-96 flex flex-col overflow-hidden"
          )}
        >
          <div className="flex items-center justify-between px-4 py-3 bg-canopy-bg border-b border-canopy-border">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[var(--color-status-info)]">{"{ }"}</span>
              <span className="text-sm font-medium text-canopy-text">
                {artifacts.length} Artifact{artifacts.length !== 1 ? "s" : ""}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={clearArtifacts}
                className="text-xs text-canopy-text/40 hover:text-canopy-text transition-colors"
              >
                Clear
              </button>
              <button
                onClick={() => setIsExpanded(false)}
                className="text-canopy-text/40 hover:text-canopy-text transition-colors"
              >
                ×
              </button>
            </div>
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
                isProcessing={actionInProgress === artifact.id}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default ArtifactOverlay;
