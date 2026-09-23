import { useState, useEffect, useRef } from "react";
import { Plus, Trash2, AlertTriangle, Play, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsInput } from "@/components/Settings/SettingsInput";
import { SettingsSelect } from "@/components/Settings/SettingsSelect";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { useSkeletonGate, useSkeletonFloor } from "@/hooks/useDeferredLoading";
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

// Radix Select reserves the empty string, so "no strategy set" needs its own value.
const STRATEGY_DEFAULT = "default";

const STRATEGY_OPTIONS = [
  { value: STRATEGY_DEFAULT, label: "Default (all files)" },
  { value: "all", label: "Include all files" },
  { value: "modified", label: "Recently modified first" },
];

function PatternListRow({
  label,
  description,
  patterns,
  onChange,
  placeholder,
  itemLabel,
  addLabel,
}: {
  label: string;
  description: string;
  patterns: string[];
  onChange: (patterns: string[]) => void;
  placeholder: string;
  itemLabel: string;
  addLabel: string;
}) {
  return (
    <SettingsRow
      label={label}
      description={description}
      layout="stacked"
      control={
        <div className="space-y-2">
          {patterns.map((pattern, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                type="text"
                value={pattern}
                onChange={(e) => {
                  const updated = [...patterns];
                  updated[index] = e.target.value;
                  onChange(updated);
                }}
                className="flex-1 min-w-0 font-mono"
                placeholder={placeholder}
                spellCheck={false}
                aria-label={itemLabel}
              />
              <Button
                variant="ghost-danger"
                size="icon-sm"
                onClick={() => onChange(patterns.filter((_, i) => i !== index))}
                aria-label="Delete pattern"
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => onChange([...patterns, ""])}>
            <Plus />
            {addLabel}
          </Button>
        </div>
      }
    />
  );
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

  const invalidateTest = () => setTestConfigResult(null);

  const setCopyTree = (patch: Partial<CopyTreeSettings>) => {
    onCopyTreeSettingsChange({ ...copyTreeSettings, ...patch });
    invalidateTest();
  };

  return (
    <div className="space-y-8">
      <SettingsSection
        id="project-excluded-paths"
        title="Excluded paths"
        description="Glob patterns to exclude from monitoring and context injection (e.g., node_modules/**, dist/**, .git/**)"
      >
        <SettingsGroup>
          {excludedPaths.map((path, index) => (
            <div key={index} className="flex items-center gap-2 px-4 py-2.5">
              <Input
                type="text"
                value={path}
                onChange={(e) => {
                  onExcludedPathsChange(
                    excludedPaths.map((p, i) => (i === index ? e.target.value : p))
                  );
                  invalidateTest();
                }}
                className="flex-1 min-w-0 font-mono"
                placeholder="node_modules/**"
                spellCheck={false}
                aria-label="Excluded path glob pattern"
              />
              <Button
                variant="ghost-danger"
                size="icon-sm"
                onClick={() => {
                  onExcludedPathsChange(excludedPaths.filter((_, i) => i !== index));
                  invalidateTest();
                }}
                aria-label="Delete excluded path"
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
            {excludedPaths.length === 0 && (
              <p className="text-xs text-text-secondary">Nothing is excluded yet</p>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onExcludedPathsChange([...excludedPaths, ""]);
                invalidateTest();
              }}
            >
              <Plus />
              Add path pattern
            </Button>
          </div>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        id="project-copy-tree"
        title="Context generation settings"
        description="Configure how CopyTree generates context for AI agents. These settings apply when injecting context into terminals or copying to clipboard."
      >
        <SettingsGroup label="Limits">
          <SettingsInput
            type="number"
            label="Max context size (bytes)"
            description="Total size limit for all files"
            controlWidth="select"
            value={copyTreeSettings.maxContextSize ?? ""}
            onChange={(e) => setCopyTree({ maxContextSize: parsePositiveInt(e.target.value) })}
            min={1}
            placeholder="Default (100 MB)"
            className="font-mono"
          />
          <SettingsInput
            type="number"
            label="Max file size (bytes)"
            description="Skip files larger than this"
            controlWidth="select"
            value={copyTreeSettings.maxFileSize ?? ""}
            onChange={(e) => setCopyTree({ maxFileSize: parsePositiveInt(e.target.value) })}
            min={1}
            placeholder="Default (up to 10 MB)"
            className="font-mono"
          />
          <SettingsInput
            type="number"
            label="Character budget"
            description="Total characters across all files"
            controlWidth="select"
            value={copyTreeSettings.charLimit ?? ""}
            onChange={(e) => setCopyTree({ charLimit: parsePositiveInt(e.target.value) })}
            min={1}
            placeholder="Default (no truncation)"
            className="font-mono"
          />
          <SettingsSelect
            label="File priority strategy"
            description="Which files to prioritize when truncating"
            value={copyTreeSettings.strategy ?? STRATEGY_DEFAULT}
            onValueChange={(value) =>
              setCopyTree({
                strategy: value === "modified" || value === "all" ? value : undefined,
              })
            }
            options={STRATEGY_OPTIONS}
          />
        </SettingsGroup>

        <SettingsGroup label="Patterns">
          <PatternListRow
            label="Always include (glob patterns)"
            description="Files matching these patterns are included even when an exclude rule or the max file size would drop them"
            patterns={copyTreeSettings.alwaysInclude ?? []}
            onChange={(alwaysInclude) => setCopyTree({ alwaysInclude })}
            placeholder="**/*.md"
            itemLabel="Always include pattern"
            addLabel="Add include pattern"
          />
          <PatternListRow
            label="Always exclude (glob patterns)"
            description="Additional exclusion patterns beyond the default excluded paths above"
            patterns={copyTreeSettings.alwaysExclude ?? []}
            onChange={(alwaysExclude) => setCopyTree({ alwaysExclude })}
            placeholder="**/*.lock"
            itemLabel="Always exclude pattern"
            addLabel="Add exclude pattern"
          />
        </SettingsGroup>

        <SettingsGroup>
          <SettingsRow
            label="Test configuration"
            description="Preview what files would be included with current settings"
            control={
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestConfig}
                loading={isTestingConfig}
                disabled={worktrees.length === 0}
              >
                <Play />
                Test config
              </Button>
            }
          />

          {showTestingSkeleton && (
            <Skeleton label="Running test configuration" className="px-4 py-3 space-y-3">
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
              className="px-4 py-3"
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
                      <span className="text-xs text-text-secondary">
                        ({formatBytes(testConfigResult.includedSize)})
                      </span>
                      {testConfigResult.estimatedTokens !== undefined && (
                        <span className="text-xs text-text-secondary">
                          ~{formatTokenEstimate(testConfigResult.estimatedTokens)} tokens
                        </span>
                      )}
                    </div>
                  )}
                  {testConfigResult.excluded && testConfigResult.excluded.total > 0 && (
                    <p className="text-xs text-text-secondary">
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
                      <p className="text-xs text-text-primary">
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
                      <p className="text-xs text-text-primary">
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
                              className="font-mono text-text-primary truncate"
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
                          className="text-xs text-text-secondary hover:text-text-primary transition-colors"
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
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
