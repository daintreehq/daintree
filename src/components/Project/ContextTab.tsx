import { useState, useEffect, useRef } from "react";
import { FolderX, Plus, Trash2, AlertTriangle, Play, Check, FileCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { useSkeletonGate, useSkeletonFloor } from "@/hooks/useDeferredLoading";
import { cn } from "@/lib/utils";
import { copyTreeClient } from "@/clients/copyTreeClient";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  CopyTreeExclusionReason,
  CopyTreeSettings,
  CopyTreeTestConfigResult,
  CopyTreeTruncatedBy,
  Worktree,
} from "@/types";
import { logError } from "@/utils/logger";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

/**
 * Token counts are a ±20% heuristic, so they read better rounded than exact.
 * Thresholds are picked off the *rounded* value so it can never print "1000k",
 * and so the one-decimal form stops before it would round up to two digits.
 */
function formatTokenEstimate(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 999_500) {
    const thousands = tokens / 1000;
    return thousands < 9.95 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

// Keyed loosely on purpose: exclusion reasons are additive upstream, and an
// unrecognized one falls back to showing its own key rather than nothing.
const EXCLUSION_LABELS: Record<string, string | undefined> = {
  gitignore: "gitignore",
  copytreeignore: "copytreeignore",
  globalGitignore: "global gitignore",
  gitInfoExclude: "git exclude file",
  configExclude: "built-in excludes",
  optionExclude: "excluded paths",
  filterPattern: "filter patterns",
  testExclude: "test excludes",
  binaryExtension: "binary files",
  sizeGate: "max file size",
  totalSizeBudget: "total size limit",
  fileCountBudget: "file count limit",
  charBudget: "character budget",
  scopeFilter: "scope",
  gitFilter: "git filter",
  duplicate: "duplicates",
  unreadable: "unreadable files",
};

const TRUNCATION_LABELS: Record<CopyTreeTruncatedBy, string> = {
  maxFileCount: "the file count limit",
  maxTotalSize: "the total size limit",
  charLimit: "the character budget",
};

const EXCLUSION_REASON_PREVIEW_COUNT = 3;

/**
 * `truncatedBy` names the budget that bit first, not the only one that bit, and
 * the count mixes files cut short with files left out entirely — so the notice
 * says what is certain and attributes the cause only when the SDK reported one.
 */
function formatTruncationNotice(count?: number, by?: CopyTreeTruncatedBy): string {
  const subject =
    count === undefined ? "Some files were" : count === 1 ? "1 file was" : `${count} files were`;
  const cause = by ? ` — ${TRUNCATION_LABELS[by]} was reached first` : "";
  return `${subject} truncated or left out${cause}`;
}

/** Names the biggest exclusion reasons so the count isn't an unexplained number. */
function describeTopExclusions(byReason: Partial<Record<CopyTreeExclusionReason, number>>): string {
  const top = Object.entries(byReason)
    .filter(([, count]) => (count ?? 0) > 0)
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .slice(0, EXCLUSION_REASON_PREVIEW_COUNT)
    .map(([reason]) => EXCLUSION_LABELS[reason] ?? reason);

  return top.length > 0 ? ` — ${top.join(", ")}` : "";
}

const FILE_PREVIEW_COUNT = 10;

function parsePositiveInt(value: string): number | undefined {
  if (!value) return undefined;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return Math.floor(num);
}

interface ContextTabProps {
  excludedPaths: string[];
  onExcludedPathsChange: (value: string[]) => void;
  copyTreeSettings: CopyTreeSettings;
  onCopyTreeSettingsChange: (value: CopyTreeSettings) => void;
  worktrees: Worktree[];
  isOpen: boolean;
}

export function ContextTab({
  excludedPaths,
  onExcludedPathsChange,
  copyTreeSettings,
  onCopyTreeSettingsChange,
  worktrees,
  isOpen,
}: ContextTabProps) {
  const [testConfigResult, setTestConfigResult] = useState<CopyTreeTestConfigResult | null>(null);
  const [isTestingConfig, setIsTestingConfig] = useState(false);
  const [showAllFiles, setShowAllFiles] = useState(false);

  const testingSkeletonGate = useSkeletonGate(isTestingConfig);
  const showTestingSkeleton = useSkeletonFloor(testingSkeletonGate);

  // Invalidation token for in-flight dry-runs: bumped when the tab closes or a
  // new run starts, so a late-resolving testConfig promise can't write a stale
  // result onto a closed/superseded tab.
  const runIdRef = useRef(0);

  useEffect(() => {
    if (!isOpen) {
      runIdRef.current++;
      setTestConfigResult(null);
      setIsTestingConfig(false);
    }
  }, [isOpen]);

  const handleTestConfig = async () => {
    const mainWorktree = worktrees.find((wt) => wt.isMainWorktree) || worktrees[0];
    if (!mainWorktree) {
      setTestConfigResult({
        includedFiles: 0,
        includedSize: 0,
        error: "No worktree available to test configuration",
      });
      return;
    }

    const runId = ++runIdRef.current;
    setIsTestingConfig(true);
    setTestConfigResult(null);
    setShowAllFiles(false);

    try {
      // Send the complete form state so the dry run reflects exactly what is
      // on screen: a value when set, an explicit null when cleared. null (not
      // undefined — structured clone drops undefined keys) blocks the
      // saved-settings back-fill in the main process for that field.
      const excludePatterns = [...excludedPaths, ...(copyTreeSettings.alwaysExclude ?? [])]
        .map((p) => p.trim())
        .filter(Boolean);
      const alwaysPatterns = (copyTreeSettings.alwaysInclude ?? [])
        .map((p) => p.trim())
        .filter(Boolean);

      const testOptions: import("@/types").CopyTreeTestConfigOptions = {
        exclude: excludePatterns.length > 0 ? excludePatterns : null,
        always: alwaysPatterns.length > 0 ? alwaysPatterns : null,
        maxTotalSize: copyTreeSettings.maxContextSize ?? null,
        maxFileSize: copyTreeSettings.maxFileSize ?? null,
        charLimit: copyTreeSettings.charLimit ?? null,
        sort: copyTreeSettings.strategy === "modified" ? "modified" : null,
      };

      const result = await copyTreeClient.testConfig(mainWorktree.id, testOptions);
      if (runIdRef.current !== runId) return;
      setTestConfigResult(result);
    } catch (error) {
      logError("Failed to test config", error);
      if (runIdRef.current !== runId) return;
      setTestConfigResult({
        includedFiles: 0,
        includedSize: 0,
        error: formatErrorMessage(error, "Failed to test configuration"),
      });
    } finally {
      if (runIdRef.current === runId) {
        setIsTestingConfig(false);
      }
    }
  };

  return (
    <>
      <div id="project-excluded-paths" className="mb-6 pb-6 border-b border-border-default">
        <h3 className="text-sm font-semibold text-daintree-text/80 mb-2 flex items-center gap-2">
          <FolderX className="h-4 w-4" />
          Excluded paths
        </h3>
        <p className="text-xs text-daintree-text/60 mb-4">
          Glob patterns to exclude from monitoring and context injection (e.g., node_modules/**,
          dist/**, .git/**)
        </p>

        <div className="space-y-2">
          {excludedPaths.length === 0 ? (
            <div className="text-sm text-daintree-text/60 text-center py-8 border border-dashed border-border-default rounded-[var(--radius-md)]">
              No excluded paths configured yet
            </div>
          ) : (
            excludedPaths.map((path, index) => (
              <div
                key={index}
                className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-surface-canvas border border-border-default"
              >
                <input
                  type="text"
                  value={path}
                  onChange={(e) => {
                    onExcludedPathsChange(
                      excludedPaths.map((p, i) => (i === index ? e.target.value : p))
                    );
                    setTestConfigResult(null);
                  }}
                  className="flex-1 bg-transparent border border-border-default rounded px-2 py-1 text-sm text-text-primary font-mono focus:outline-hidden focus:border-daintree-accent/40 focus:ring-1 focus:ring-daintree-accent/30"
                  placeholder="node_modules/**"
                  aria-label="Excluded path glob pattern"
                />
                <button
                  type="button"
                  onClick={() => {
                    onExcludedPathsChange(excludedPaths.filter((_, i) => i !== index));
                    setTestConfigResult(null);
                  }}
                  className="p-1 rounded hover:bg-status-error/15 transition-colors"
                  aria-label="Delete excluded path"
                >
                  <Trash2 className="h-4 w-4 text-status-error" />
                </button>
              </div>
            ))
          )}
          <Button
            variant="outline"
            onClick={() => {
              onExcludedPathsChange([...excludedPaths, ""]);
              setTestConfigResult(null);
            }}
            className="w-full"
          >
            <Plus />
            Add path pattern
          </Button>
        </div>
      </div>

      {/* CopyTree Settings */}
      <div id="project-copy-tree" className="mb-6 pb-6 border-b border-border-default">
        <h3 className="text-sm font-semibold text-daintree-text/80 mb-2 flex items-center gap-2">
          <FileCode className="h-4 w-4" />
          Context generation settings
        </h3>
        <p className="text-xs text-daintree-text/60 mb-4">
          Configure how CopyTree generates context for AI agents. These settings apply when
          injecting context into terminals or copying to clipboard.
        </p>

        <div className="space-y-4">
          {/* Size Limits */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-daintree-text/60 mb-1">
                Max context size (bytes)
              </label>
              <input
                type="number"
                value={copyTreeSettings.maxContextSize ?? ""}
                onChange={(e) => {
                  const value = parsePositiveInt(e.target.value);
                  onCopyTreeSettingsChange({ ...copyTreeSettings, maxContextSize: value });
                  setTestConfigResult(null);
                }}
                min={1}
                placeholder="Default (100 MB)"
                className="w-full bg-surface-sidebar border border-border-default rounded px-2 py-1 text-sm text-text-primary font-mono focus:outline-hidden focus:border-daintree-accent/40 focus:ring-1 focus:ring-daintree-accent/30"
              />
              <p className="text-xs text-text-secondary mt-1">Total size limit for all files</p>
            </div>
            <div>
              <label className="block text-xs text-daintree-text/60 mb-1">
                Max file size (bytes)
              </label>
              <input
                type="number"
                value={copyTreeSettings.maxFileSize ?? ""}
                onChange={(e) => {
                  const value = parsePositiveInt(e.target.value);
                  onCopyTreeSettingsChange({ ...copyTreeSettings, maxFileSize: value });
                  setTestConfigResult(null);
                }}
                min={1}
                placeholder="Default (up to 10 MB)"
                className="w-full bg-surface-sidebar border border-border-default rounded px-2 py-1 text-sm text-text-primary font-mono focus:outline-hidden focus:border-daintree-accent/40 focus:ring-1 focus:ring-daintree-accent/30"
              />
              <p className="text-xs text-text-secondary mt-1">Skip files larger than this</p>
            </div>
          </div>

          {/* Truncation Strategy */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-daintree-text/60 mb-1">Character budget</label>
              <input
                type="number"
                value={copyTreeSettings.charLimit ?? ""}
                onChange={(e) => {
                  const value = parsePositiveInt(e.target.value);
                  onCopyTreeSettingsChange({ ...copyTreeSettings, charLimit: value });
                  setTestConfigResult(null);
                }}
                min={1}
                placeholder="Default (no truncation)"
                className="w-full bg-surface-sidebar border border-border-default rounded px-2 py-1 text-sm text-text-primary font-mono focus:outline-hidden focus:border-daintree-accent/40 focus:ring-1 focus:ring-daintree-accent/30"
              />
              <p className="text-xs text-text-secondary mt-1">Total characters across all files</p>
            </div>
            <div>
              <label className="block text-xs text-daintree-text/60 mb-1">
                File priority strategy
              </label>
              <select
                value={copyTreeSettings.strategy ?? ""}
                onChange={(e) => {
                  const value = e.target.value as "modified" | "all" | undefined;
                  onCopyTreeSettingsChange({ ...copyTreeSettings, strategy: value || undefined });
                  setTestConfigResult(null);
                }}
                className="w-full bg-surface-sidebar border border-border-default rounded px-2 py-1 text-sm text-text-primary focus:outline-hidden focus:border-daintree-accent/40 focus:ring-1 focus:ring-daintree-accent/30"
              >
                <option value="">Default (all files)</option>
                <option value="all">Include all files</option>
                <option value="modified">Recently modified first</option>
              </select>
              <p className="text-xs text-text-secondary mt-1">
                Which files to prioritize when truncating
              </p>
            </div>
          </div>

          {/* Always Include Patterns */}
          <div>
            <label className="block text-xs text-daintree-text/60 mb-1">
              Always include (glob patterns)
            </label>
            <p className="text-xs text-text-secondary mb-2">
              Files matching these patterns are included even when an exclude rule or the max file
              size would drop them
            </p>
            <div className="space-y-2">
              {(copyTreeSettings.alwaysInclude || []).map((pattern, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-surface-canvas border border-border-default"
                >
                  <input
                    type="text"
                    value={pattern}
                    onChange={(e) => {
                      const updated = [...(copyTreeSettings.alwaysInclude || [])];
                      updated[index] = e.target.value;
                      onCopyTreeSettingsChange({ ...copyTreeSettings, alwaysInclude: updated });
                      setTestConfigResult(null);
                    }}
                    className="flex-1 bg-transparent border border-border-default rounded px-2 py-1 text-sm text-text-primary font-mono focus:outline-hidden focus:border-daintree-accent/40 focus:ring-1 focus:ring-daintree-accent/30"
                    placeholder="**/*.md"
                    aria-label="Always include pattern"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      onCopyTreeSettingsChange({
                        ...copyTreeSettings,
                        alwaysInclude: (copyTreeSettings.alwaysInclude || []).filter(
                          (_, i) => i !== index
                        ),
                      });
                      setTestConfigResult(null);
                    }}
                    className="p-1 rounded hover:bg-status-error/15 transition-colors"
                    aria-label="Delete pattern"
                  >
                    <Trash2 className="h-4 w-4 text-status-error" />
                  </button>
                </div>
              ))}
              <Button
                variant="outline"
                onClick={() => {
                  onCopyTreeSettingsChange({
                    ...copyTreeSettings,
                    alwaysInclude: [...(copyTreeSettings.alwaysInclude || []), ""],
                  });
                  setTestConfigResult(null);
                }}
                className="w-full"
              >
                <Plus />
                Add include pattern
              </Button>
            </div>
          </div>

          {/* Always Exclude Patterns */}
          <div>
            <label className="block text-xs text-daintree-text/60 mb-1">
              Always exclude (glob patterns)
            </label>
            <p className="text-xs text-text-secondary mb-2">
              Additional exclusion patterns beyond the default excluded paths above
            </p>
            <div className="space-y-2">
              {(copyTreeSettings.alwaysExclude || []).map((pattern, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-surface-canvas border border-border-default"
                >
                  <input
                    type="text"
                    value={pattern}
                    onChange={(e) => {
                      const updated = [...(copyTreeSettings.alwaysExclude || [])];
                      updated[index] = e.target.value;
                      onCopyTreeSettingsChange({ ...copyTreeSettings, alwaysExclude: updated });
                      setTestConfigResult(null);
                    }}
                    className="flex-1 bg-transparent border border-border-default rounded px-2 py-1 text-sm text-text-primary font-mono focus:outline-hidden focus:border-daintree-accent/40 focus:ring-1 focus:ring-daintree-accent/30"
                    placeholder="**/*.lock"
                    aria-label="Always exclude pattern"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      onCopyTreeSettingsChange({
                        ...copyTreeSettings,
                        alwaysExclude: (copyTreeSettings.alwaysExclude || []).filter(
                          (_, i) => i !== index
                        ),
                      });
                      setTestConfigResult(null);
                    }}
                    className="p-1 rounded hover:bg-status-error/15 transition-colors"
                    aria-label="Delete pattern"
                  >
                    <Trash2 className="h-4 w-4 text-status-error" />
                  </button>
                </div>
              ))}
              <Button
                variant="outline"
                onClick={() => {
                  onCopyTreeSettingsChange({
                    ...copyTreeSettings,
                    alwaysExclude: [...(copyTreeSettings.alwaysExclude || []), ""],
                  });
                  setTestConfigResult(null);
                }}
                className="w-full"
              >
                <Plus />
                Add exclude pattern
              </Button>
            </div>
          </div>

          {/* Test Configuration */}
          <div className="mt-6 pt-4 border-t border-border-default">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-medium text-daintree-text/80">Test configuration</h4>
                <p className="text-xs text-text-secondary">
                  Preview what files would be included with current settings
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleTestConfig}
                loading={isTestingConfig}
                disabled={worktrees.length === 0}
              >
                <Play className="h-4 w-4" />
                Test config
              </Button>
            </div>

            {showTestingSkeleton && (
              <Skeleton
                label="Running test configuration"
                className="mt-4 p-4 rounded-[var(--radius-md)] border border-border-default space-y-3"
              >
                <SkeletonBone immediate className="h-4 w-2/3" />
                <SkeletonBone immediate className="h-3 w-1/2" />
                <SkeletonBone immediate className="h-3 w-2/3" />
                <SkeletonBone immediate className="h-3 w-1/3" />
              </Skeleton>
            )}

            {testConfigResult && !showTestingSkeleton && (
              // The skeleton this replaces is a live status, so the outcome has
              // to be announced too — focus stays on the button either way.
              <div
                role={testConfigResult.error ? "alert" : "status"}
                aria-live={testConfigResult.error ? "assertive" : "polite"}
                className={cn(
                  "mt-4 p-4 rounded-[var(--radius-md)] border",
                  testConfigResult.error
                    ? "bg-status-error/5 border-status-error/15"
                    : "bg-surface-canvas border-border-default"
                )}
              >
                {testConfigResult.error ? (
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-status-error mt-0.5 shrink-0" />
                    <p className="text-sm text-status-error">{testConfigResult.error}</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {testConfigResult.noFilesMatched ? (
                      <p className="text-sm text-text-primary">
                        No files match these settings — loosen the excluded paths or size limits
                      </p>
                    ) : (
                      <div className="flex items-center gap-2 flex-wrap">
                        <Check className="h-4 w-4 text-status-success" />
                        <span className="text-sm font-medium text-text-primary">
                          {testConfigResult.includedFiles} files would be included
                        </span>
                        <span className="text-xs text-daintree-text/60">
                          ({formatBytes(testConfigResult.includedSize)})
                        </span>
                        {testConfigResult.estimatedTokens !== undefined && (
                          <span className="text-xs text-daintree-text/60">
                            ~{formatTokenEstimate(testConfigResult.estimatedTokens)} tokens
                          </span>
                        )}
                      </div>
                    )}
                    {testConfigResult.excluded && testConfigResult.excluded.total > 0 && (
                      <p className="text-xs text-daintree-text/60">
                        {testConfigResult.excluded.total} excluded
                        {describeTopExclusions(testConfigResult.excluded.byReason)}
                      </p>
                    )}
                    {copyTreeSettings.charLimit !== undefined && (
                      // The dry run plans the character budget from byte sizes
                      // without reading content, so this preview is an estimate.
                      <p className="text-xs text-text-secondary">
                        Estimated — the character budget is planned from file sizes
                      </p>
                    )}
                    {testConfigResult.truncated && (
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="h-4 w-4 text-status-warning mt-0.5 shrink-0" />
                        <p className="text-xs text-daintree-text/80">
                          {formatTruncationNotice(
                            testConfigResult.truncatedCount,
                            testConfigResult.truncatedBy
                          )}
                        </p>
                      </div>
                    )}
                    {testConfigResult.budgetExceeded && !testConfigResult.truncated && (
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="h-4 w-4 text-status-warning mt-0.5 shrink-0" />
                        <p className="text-xs text-daintree-text/80">
                          The first file alone is over the total size limit, so it was kept anyway
                        </p>
                      </div>
                    )}
                    {testConfigResult.files && testConfigResult.files.length > 0 && (
                      <div className="space-y-1">
                        <ul className="max-h-60 overflow-y-auto space-y-1">
                          {(showAllFiles
                            ? testConfigResult.files
                            : testConfigResult.files.slice(0, FILE_PREVIEW_COUNT)
                          ).map((file) => (
                            <li
                              key={file.path}
                              className="flex items-center justify-between gap-2 text-xs"
                            >
                              <span
                                className="font-mono text-daintree-text/80 truncate"
                                title={file.path}
                              >
                                {file.path}
                              </span>
                              <span className="text-text-secondary shrink-0">
                                {formatBytes(file.size)}
                              </span>
                            </li>
                          ))}
                        </ul>
                        {testConfigResult.files.length > FILE_PREVIEW_COUNT && (
                          <button
                            type="button"
                            onClick={() => setShowAllFiles((value) => !value)}
                            className="text-xs text-daintree-text/60 hover:text-text-primary transition-colors"
                          >
                            {showAllFiles
                              ? "Show fewer"
                              : `Show ${testConfigResult.files.length - FILE_PREVIEW_COUNT} more`}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
