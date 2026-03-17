import { useState, useEffect } from "react";
import {
  FolderX,
  Key,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  AlertTriangle,
  Play,
  Check,
  Settings,
  FileCode,
  Lock,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { copyTreeClient } from "@/clients/copyTreeClient";
import { isSensitiveEnvKey } from "@shared/utils/envVars";
import type { CopyTreeSettings, CopyTreeTestConfigResult, Worktree } from "@/types";
import type { EnvVar } from "./projectSettingsDirty";
import type { ProjectSettings } from "@shared/types/project";

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
  environmentVariables: EnvVar[];
  onEnvironmentVariablesChange: (value: EnvVar[]) => void;
  worktrees: Worktree[];
  settings: ProjectSettings | null;
  isOpen: boolean;
}

export function ContextTab({
  excludedPaths,
  onExcludedPathsChange,
  copyTreeSettings,
  onCopyTreeSettingsChange,
  environmentVariables,
  onEnvironmentVariablesChange,
  worktrees,
  settings,
  isOpen,
}: ContextTabProps) {
  const [visibleEnvVars, setVisibleEnvVars] = useState<Set<string>>(new Set());
  const [testConfigResult, setTestConfigResult] = useState<CopyTreeTestConfigResult | null>(null);
  const [isTestingConfig, setIsTestingConfig] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setVisibleEnvVars(new Set());
      setTestConfigResult(null);
      setIsTestingConfig(false);
    }
  }, [isOpen]);

  const toggleEnvVarVisibility = (id: string) => {
    setVisibleEnvVars((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

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
      <div className="mb-6 pb-6 border-b border-canopy-border">
        <h3 className="text-sm font-semibold text-canopy-text/80 mb-2 flex items-center gap-2">
          <FolderX className="h-4 w-4" />
          Excluded Paths
        </h3>
        <p className="text-xs text-canopy-text/60 mb-4">
          Glob patterns to exclude from monitoring and context injection (e.g., node_modules/**,
          dist/**, .git/**).
        </p>

        <div className="space-y-2">
          {excludedPaths.length === 0 ? (
            <div className="text-sm text-canopy-text/60 text-center py-8 border border-dashed border-canopy-border rounded-[var(--radius-md)]">
              No excluded paths configured yet
            </div>
          ) : (
            excludedPaths.map((path, index) => (
              <div
                key={index}
                className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-canopy-bg border border-canopy-border"
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
                  className="flex-1 bg-transparent border border-canopy-border rounded px-2 py-1 text-sm text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
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
      <div className="mb-6 pb-6 border-b border-canopy-border">
        <h3 className="text-sm font-semibold text-canopy-text/80 mb-2 flex items-center gap-2">
          <FileCode className="h-4 w-4" />
          Context Generation Settings
        </h3>
        <p className="text-xs text-canopy-text/60 mb-4">
          Configure how CopyTree generates context for AI agents. These settings apply when
          injecting context into terminals or copying to clipboard.
        </p>

        <div className="space-y-4">
          {/* Size Limits */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-canopy-text/60 mb-1">
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
                className="w-full bg-canopy-sidebar border border-canopy-border rounded px-2 py-1 text-sm text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
              />
              <p className="text-xs text-canopy-text/40 mt-1">Total size limit for all files</p>
            </div>
            <div>
              <label className="block text-xs text-canopy-text/60 mb-1">
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
                className="w-full bg-canopy-sidebar border border-canopy-border rounded px-2 py-1 text-sm text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
              />
              <p className="text-xs text-canopy-text/40 mt-1">Skip files larger than this</p>
            </div>
          </div>

          {/* Truncation Strategy */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-canopy-text/60 mb-1">
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
                className="w-full bg-canopy-sidebar border border-canopy-border rounded px-2 py-1 text-sm text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
              />
              <p className="text-xs text-canopy-text/40 mt-1">
                Truncate each file to this many characters
              </p>
            </div>
            <div>
              <label className="block text-xs text-canopy-text/60 mb-1">
                File Priority Strategy
              </label>
              <select
                value={copyTreeSettings.strategy ?? ""}
                onChange={(e) => {
                  const value = e.target.value as "modified" | "all" | undefined;
                  onCopyTreeSettingsChange({ ...copyTreeSettings, strategy: value || undefined });
                  setTestConfigResult(null);
                }}
                className="w-full bg-canopy-sidebar border border-canopy-border rounded px-2 py-1 text-sm text-canopy-text focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
              >
                <option value="">Default (all files)</option>
                <option value="all">Include all files</option>
                <option value="modified">Recently modified first</option>
              </select>
              <p className="text-xs text-canopy-text/40 mt-1">
                Which files to prioritize when truncating
              </p>
            </div>
          </div>

          {/* Always Include Patterns */}
          <div>
            <label className="block text-xs text-canopy-text/60 mb-1">
              Always Include (glob patterns)
            </label>
            <p className="text-xs text-canopy-text/40 mb-2">
              Files matching these patterns will always be included, even if they would otherwise be
              excluded.
            </p>
            <div className="space-y-2">
              {(copyTreeSettings.alwaysInclude || []).map((pattern, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-canopy-bg border border-canopy-border"
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
                    className="flex-1 bg-transparent border border-canopy-border rounded px-2 py-1 text-sm text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
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
            <label className="block text-xs text-canopy-text/60 mb-1">
              Always Exclude (glob patterns)
            </label>
            <p className="text-xs text-canopy-text/40 mb-2">
              Additional exclusion patterns beyond the default excluded paths above.
            </p>
            <div className="space-y-2">
              {(copyTreeSettings.alwaysExclude || []).map((pattern, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-canopy-bg border border-canopy-border"
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
                    className="flex-1 bg-transparent border border-canopy-border rounded px-2 py-1 text-sm text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
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
          <div className="mt-6 pt-4 border-t border-canopy-border">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-medium text-canopy-text/80">Test Configuration</h4>
                <p className="text-xs text-canopy-text/40">
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
                    : "bg-canopy-bg border-canopy-border"
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
                      <span className="text-sm font-medium text-canopy-text">
                        {testConfigResult.includedFiles} files would be included
                      </span>
                      <span className="text-xs text-canopy-text/60">
                        ({formatBytes(testConfigResult.includedSize)})
                      </span>
                    </div>
                    <div className="text-xs text-canopy-text/60 space-y-1">
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

      <div className="mb-6">
        <h3 className="text-sm font-semibold text-canopy-text/80 mb-2 flex items-center gap-2">
          <Key className="h-4 w-4" />
          Environment Variables
        </h3>
        <p className="text-xs text-canopy-text/60 mb-4">
          Project-specific environment variables. Variable names containing KEY, SECRET, TOKEN, or
          PASSWORD are stored securely using OS encryption <Lock className="inline h-3 w-3" />.
        </p>

        {settings?.insecureEnvironmentVariables &&
          settings.insecureEnvironmentVariables.length > 0 && (
            <div className="mb-4 p-3 bg-status-warning/10 border border-status-warning/20 rounded-[var(--radius-md)] flex items-start gap-2">
              <ShieldAlert className="h-4 w-4 text-status-warning mt-0.5 flex-shrink-0" />
              <div className="flex-1 text-xs">
                <p className="text-status-warning font-semibold mb-1">
                  Insecure sensitive variables detected
                </p>
                <p className="text-status-warning/80 mb-2">
                  The following variables contain sensitive keywords but are stored in plaintext:{" "}
                  <span className="font-mono">
                    {settings.insecureEnvironmentVariables.join(", ")}
                  </span>
                </p>
                <p className="text-status-warning/80">
                  Click Save to automatically move them to secure storage.
                </p>
              </div>
            </div>
          )}

        <div className="space-y-2">
          {environmentVariables.length === 0 ? (
            <div className="text-sm text-canopy-text/60 text-center py-8 border border-dashed border-canopy-border rounded-[var(--radius-md)]">
              No environment variables configured yet
            </div>
          ) : (
            environmentVariables.map((envVar, index) => {
              const isSensitive = isSensitiveEnvKey(envVar.key);
              const isInsecure = settings?.insecureEnvironmentVariables?.includes(envVar.key);
              const isSecured = isSensitive && !isInsecure;
              const isVisible = visibleEnvVars.has(envVar.id);
              const shouldMask = isSensitive && !isVisible;
              return (
                <div
                  key={envVar.id}
                  className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-canopy-bg border border-canopy-border"
                >
                  {isSecured && (
                    <Lock
                      className="h-3.5 w-3.5 text-status-success/60 flex-shrink-0"
                      aria-label="Stored securely"
                    />
                  )}
                  {isInsecure && (
                    <ShieldAlert
                      className="h-3.5 w-3.5 text-status-warning/60 flex-shrink-0"
                      aria-label="Stored in plaintext"
                    />
                  )}
                  <input
                    type="text"
                    value={envVar.key}
                    onChange={(e) => {
                      const nextKey = e.target.value;
                      const wasSensitive = isSensitiveEnvKey(envVar.key);
                      const nowSensitive = isSensitiveEnvKey(nextKey);
                      onEnvironmentVariablesChange(
                        environmentVariables.map((ev, i) =>
                          i === index ? { ...envVar, key: nextKey } : ev
                        )
                      );
                      if (!wasSensitive && nowSensitive) {
                        setVisibleEnvVars((prev) => {
                          const next = new Set(prev);
                          next.delete(envVar.id);
                          return next;
                        });
                      }
                    }}
                    spellCheck={false}
                    autoCapitalize="none"
                    className="flex-1 bg-transparent border border-canopy-border rounded px-2 py-1 text-sm text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
                    placeholder="VARIABLE_NAME"
                    aria-label="Environment variable name"
                  />
                  <span className="text-canopy-text/60">=</span>
                  <div className="flex-1 relative">
                    <input
                      type={shouldMask ? "password" : "text"}
                      value={envVar.value}
                      onChange={(e) => {
                        onEnvironmentVariablesChange(
                          environmentVariables.map((ev, i) =>
                            i === index ? { ...envVar, value: e.target.value } : ev
                          )
                        );
                      }}
                      spellCheck={false}
                      autoCapitalize="none"
                      autoComplete={isSensitive ? "new-password" : "off"}
                      className={cn(
                        "w-full bg-canopy-sidebar border border-canopy-border rounded px-2 py-1 text-sm text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30",
                        isSensitive && "pr-8"
                      )}
                      placeholder="value"
                      aria-label="Environment variable value"
                    />
                    {isSensitive && (
                      <button
                        type="button"
                        onClick={() => toggleEnvVarVisibility(envVar.id)}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-canopy-border/50 transition-colors"
                        aria-pressed={isVisible}
                        aria-label={`${isVisible ? "Hide" : "Show"} value${envVar.key ? ` for ${envVar.key}` : ""}`}
                      >
                        {isVisible ? (
                          <EyeOff className="h-4 w-4 text-canopy-text/60" />
                        ) : (
                          <Eye className="h-4 w-4 text-canopy-text/60" />
                        )}
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      onEnvironmentVariablesChange(
                        environmentVariables.filter((_, i) => i !== index)
                      );
                      setVisibleEnvVars((prev) => {
                        const next = new Set(prev);
                        next.delete(envVar.id);
                        return next;
                      });
                    }}
                    className="p-1 rounded hover:bg-status-error/15 transition-colors"
                    aria-label="Delete environment variable"
                  >
                    <Trash2 className="h-4 w-4 text-status-error" />
                  </button>
                </div>
              );
            })
          )}
          <Button
            variant="outline"
            onClick={() => {
              onEnvironmentVariablesChange([
                ...environmentVariables,
                {
                  id: `env-${Date.now()}-${Math.random()}`,
                  key: "",
                  value: "",
                },
              ]);
            }}
            className="w-full"
          >
            <Plus />
            Add Variable
          </Button>
        </div>
      </div>
    </>
  );
}
