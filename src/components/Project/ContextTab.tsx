import { useState, useEffect } from "react";
import {
  FolderX,
  Plus,
  Trash2,
  AlertTriangle,
  Play,
  Check,
  Settings,
  FileCode,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { copyTreeClient } from "@/clients/copyTreeClient";
import type { CopyTreeSettings, CopyTreeTestConfigResult, Worktree } from "@/types";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

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

  useEffect(() => {
    if (!isOpen) {
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
        excluded: { byTruncation: 0, bySize: 0, byPattern: 0 },
        error: "No worktree available to test configuration",
      });
      return;
    }

    setIsTestingConfig(true);
    setTestConfigResult(null);

    try {
      const testOptions: import("@/types").CopyTreeOptions = {};

      if (excludedPaths.length > 0) {
        const sanitizedPaths = excludedPaths.map((p) => p.trim()).filter(Boolean);
        if (sanitizedPaths.length > 0) {
          testOptions.exclude = sanitizedPaths;
        }
      }

      if (copyTreeSettings.maxContextSize !== undefined) {
        testOptions.maxTotalSize = copyTreeSettings.maxContextSize;
      }
      if (copyTreeSettings.maxFileSize !== undefined) {
        testOptions.maxFileSize = copyTreeSettings.maxFileSize;
      }
      if (copyTreeSettings.charLimit !== undefined) {
        testOptions.charLimit = copyTreeSettings.charLimit;
      }
      if (copyTreeSettings.strategy === "modified") {
        testOptions.sort = "modified";
      }
      if (copyTreeSettings.alwaysInclude && copyTreeSettings.alwaysInclude.length > 0) {
        const sanitized = copyTreeSettings.alwaysInclude.map((p) => p.trim()).filter(Boolean);
        if (sanitized.length > 0) {
          testOptions.always = sanitized;
        }
      }
      if (copyTreeSettings.alwaysExclude && copyTreeSettings.alwaysExclude.length > 0) {
        const sanitized = copyTreeSettings.alwaysExclude.map((p) => p.trim()).filter(Boolean);
        if (sanitized.length > 0) {
          testOptions.exclude = [...(testOptions.exclude || []), ...sanitized];
        }
      }

      const result = await copyTreeClient.testConfig(mainWorktree.id, testOptions);
      setTestConfigResult(result);
    } catch (error) {
      console.error("Failed to test config:", error);
      setTestConfigResult({
        includedFiles: 0,
        includedSize: 0,
        excluded: { byTruncation: 0, bySize: 0, byPattern: 0 },
        error: error instanceof Error ? error.message : "Failed to test configuration",
      });
    } finally {
      setIsTestingConfig(false);
    }
  };

  return (
    <>
      <div className="mb-6 pb-6 border-b border-daintree-border">
        <h3 className="text-sm font-semibold text-daintree-text/80 mb-2 flex items-center gap-2">
          <FolderX className="h-4 w-4" />
          Excluded Paths
        </h3>
        <p className="text-xs text-daintree-text/60 mb-4">
          Glob patterns to exclude from monitoring and context injection (e.g., node_modules/**,
          dist/**, .git/**).
        </p>

        <div className="space-y-2">
          {excludedPaths.length === 0 ? (
            <div className="text-sm text-daintree-text/60 text-center py-8 border border-dashed border-daintree-border rounded-[var(--radius-md)]">
              No excluded paths configured yet
            </div>
          ) : (
            excludedPaths.map((path, index) => (
              <div
                key={index}
                className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-daintree-bg border border-daintree-border"
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
                  className="flex-1 bg-transparent border border-daintree-border rounded px-2 py-1 text-sm text-daintree-text font-mono focus:outline-none focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30"
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
            Add Path Pattern
          </Button>
        </div>
      </div>

      {/* CopyTree Settings */}
      <div className="mb-6 pb-6 border-b border-daintree-border">
        <h3 className="text-sm font-semibold text-daintree-text/80 mb-2 flex items-center gap-2">
          <FileCode className="h-4 w-4" />
          Context Generation Settings
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
                Max Context Size (bytes)
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
                placeholder="Default (unlimited)"
                className="w-full bg-daintree-sidebar border border-daintree-border rounded px-2 py-1 text-sm text-daintree-text font-mono focus:outline-none focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30"
              />
              <p className="text-xs text-daintree-text/40 mt-1">Total size limit for all files</p>
            </div>
            <div>
              <label className="block text-xs text-daintree-text/60 mb-1">
                Max File Size (bytes)
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
                placeholder="Default (50KB)"
                className="w-full bg-daintree-sidebar border border-daintree-border rounded px-2 py-1 text-sm text-daintree-text font-mono focus:outline-none focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30"
              />
              <p className="text-xs text-daintree-text/40 mt-1">Skip files larger than this</p>
            </div>
          </div>

          {/* Truncation Strategy */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-daintree-text/60 mb-1">
                Char Limit (per file)
              </label>
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
                className="w-full bg-daintree-sidebar border border-daintree-border rounded px-2 py-1 text-sm text-daintree-text font-mono focus:outline-none focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30"
              />
              <p className="text-xs text-daintree-text/40 mt-1">
                Truncate each file to this many characters
              </p>
            </div>
            <div>
              <label className="block text-xs text-daintree-text/60 mb-1">
                File Priority Strategy
              </label>
              <select
                value={copyTreeSettings.strategy ?? ""}
                onChange={(e) => {
                  const value = e.target.value as "modified" | "all" | undefined;
                  onCopyTreeSettingsChange({ ...copyTreeSettings, strategy: value || undefined });
                  setTestConfigResult(null);
                }}
                className="w-full bg-daintree-sidebar border border-daintree-border rounded px-2 py-1 text-sm text-daintree-text focus:outline-none focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30"
              >
                <option value="">Default (all files)</option>
                <option value="all">Include all files</option>
                <option value="modified">Recently modified first</option>
              </select>
              <p className="text-xs text-daintree-text/40 mt-1">
                Which files to prioritize when truncating
              </p>
            </div>
          </div>

          {/* Always Include Patterns */}
          <div>
            <label className="block text-xs text-daintree-text/60 mb-1">
              Always Include (glob patterns)
            </label>
            <p className="text-xs text-daintree-text/40 mb-2">
              Files matching these patterns will always be included, even if they would otherwise be
              excluded.
            </p>
            <div className="space-y-2">
              {(copyTreeSettings.alwaysInclude || []).map((pattern, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-daintree-bg border border-daintree-border"
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
                    className="flex-1 bg-transparent border border-daintree-border rounded px-2 py-1 text-sm text-daintree-text font-mono focus:outline-none focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30"
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
                Add Include Pattern
              </Button>
            </div>
          </div>

          {/* Always Exclude Patterns */}
          <div>
            <label className="block text-xs text-daintree-text/60 mb-1">
              Always Exclude (glob patterns)
            </label>
            <p className="text-xs text-daintree-text/40 mb-2">
              Additional exclusion patterns beyond the default excluded paths above.
            </p>
            <div className="space-y-2">
              {(copyTreeSettings.alwaysExclude || []).map((pattern, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-daintree-bg border border-daintree-border"
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
                    className="flex-1 bg-transparent border border-daintree-border rounded px-2 py-1 text-sm text-daintree-text font-mono focus:outline-none focus:border-daintree-accent focus:ring-1 focus:ring-daintree-accent/30"
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
                Add Exclude Pattern
              </Button>
            </div>
          </div>

          {/* Test Configuration */}
          <div className="mt-6 pt-4 border-t border-daintree-border">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-medium text-daintree-text/80">Test Configuration</h4>
                <p className="text-xs text-daintree-text/40">
                  Preview what files would be included with current settings
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleTestConfig}
                disabled={isTestingConfig || worktrees.length === 0}
              >
                {isTestingConfig ? (
                  <>
                    <Settings className="h-4 w-4 animate-spin" />
                    Testing...
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4" />
                    Test Config
                  </>
                )}
              </Button>
            </div>

            {testConfigResult && (
              <div
                className={cn(
                  "mt-4 p-4 rounded-[var(--radius-md)] border",
                  testConfigResult.error
                    ? "bg-status-error/5 border-status-error/15"
                    : "bg-daintree-bg border-daintree-border"
                )}
              >
                {testConfigResult.error ? (
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-status-error mt-0.5 shrink-0" />
                    <p className="text-sm text-status-error">{testConfigResult.error}</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-status-success" />
                      <span className="text-sm font-medium text-daintree-text">
                        {testConfigResult.includedFiles} files would be included
                      </span>
                      <span className="text-xs text-daintree-text/60">
                        ({formatBytes(testConfigResult.includedSize)})
                      </span>
                    </div>
                    <div className="text-xs text-daintree-text/60 space-y-1">
                      <p>
                        Excluded by pattern:{" "}
                        <span className="font-mono">{testConfigResult.excluded.byPattern}</span>
                      </p>
                      <p>
                        Excluded by size:{" "}
                        <span className="font-mono">{testConfigResult.excluded.bySize}</span>
                      </p>
                      <p>
                        Excluded by truncation:{" "}
                        <span className="font-mono">{testConfigResult.excluded.byTruncation}</span>
                      </p>
                    </div>
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
