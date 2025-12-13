import { useState, useEffect, useMemo } from "react";
import { GitBranch, AlertCircle, Check, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { worktreeConfigClient } from "@/clients";
import {
  validatePathPattern,
  previewPathPattern,
  DEFAULT_WORKTREE_PATH_PATTERN,
} from "@shared/utils/pathPattern";

const PATTERN_PRESETS = [
  {
    label: "Subdirectory",
    pattern: "{parent-dir}/{base-folder}-worktrees/{branch-slug}",
    description: "Creates worktrees in a sibling -worktrees folder",
  },
  {
    label: "Sibling Folder",
    pattern: "{parent-dir}/{base-folder}-{branch-slug}",
    description: "Creates worktrees as siblings with branch suffix",
  },
  {
    label: "Flat Sibling",
    pattern: "{parent-dir}/{branch-slug}",
    description: "Creates worktrees as siblings named by branch",
  },
] as const;

const SAMPLE_BRANCH = "feature/example-branch";

export function WorktreeSettingsTab() {
  const [pattern, setPattern] = useState("");
  const [originalPattern, setOriginalPattern] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState(false);
  const [savedMessageTimeout, setSavedMessageTimeout] = useState<NodeJS.Timeout | null>(null);

  const sampleRootPath = "/Users/name/Projects/my-project";

  useEffect(() => {
    return () => {
      if (savedMessageTimeout) {
        clearTimeout(savedMessageTimeout);
      }
    };
  }, [savedMessageTimeout]);

  useEffect(() => {
    worktreeConfigClient
      .get()
      .then((config) => {
        setPattern(config.pathPattern);
        setOriginalPattern(config.pathPattern);
      })
      .catch((err) => {
        setError(err.message || "Failed to load settings");
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, []);

  const validation = useMemo(() => {
    if (!pattern.trim()) return { valid: false, error: "Pattern cannot be empty" };
    return validatePathPattern(pattern);
  }, [pattern]);

  const preview = useMemo(() => {
    if (!validation.valid) return null;
    return previewPathPattern(pattern, sampleRootPath, SAMPLE_BRANCH);
  }, [pattern, validation.valid]);

  const hasChanges = pattern !== originalPattern;

  const handleSave = async () => {
    if (!validation.valid || isSaving) return;

    setIsSaving(true);
    setError(null);

    try {
      const result = await worktreeConfigClient.setPattern(pattern);
      setOriginalPattern(result.pathPattern);
      setPattern(result.pathPattern);
      setSavedMessage(true);
      if (savedMessageTimeout) {
        clearTimeout(savedMessageTimeout);
      }
      const timeout = setTimeout(() => setSavedMessage(false), 2000);
      setSavedMessageTimeout(timeout);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save pattern");
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setPattern(DEFAULT_WORKTREE_PATH_PATTERN);
    setError(null);
  };

  const handlePresetClick = (presetPattern: string) => {
    setPattern(presetPattern);
    setError(null);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-5 h-5 border-2 border-canopy-accent border-t-transparent rounded-full animate-spin" />
        <span className="ml-2 text-sm text-canopy-text/60">Loading settings...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h4 className="text-sm font-medium text-canopy-text mb-2 flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-canopy-accent" />
          Worktree Path Pattern
        </h4>
        <p className="text-xs text-canopy-text/50 mb-4">
          Configure the default path pattern for new worktrees. Use variables to build dynamic paths
          based on your repository and branch names.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <label htmlFor="path-pattern" className="block text-sm font-medium text-canopy-text">
            Pattern
          </label>
          <div className="flex gap-2">
            <input
              id="path-pattern"
              type="text"
              value={pattern}
              onChange={(e) => {
                setPattern(e.target.value);
                setError(null);
              }}
              className={cn(
                "flex-1 px-3 py-2 bg-canopy-bg border rounded-[var(--radius-md)] text-canopy-text font-mono text-sm",
                "focus:outline-none focus:ring-2 focus:ring-canopy-accent",
                !validation.valid ? "border-red-500/50" : "border-canopy-border"
              )}
              placeholder="{parent-dir}/{base-folder}-worktrees/{branch-slug}"
            />
            <button
              onClick={handleReset}
              className="px-3 py-2 border border-canopy-border rounded-[var(--radius-md)] text-canopy-text/60 hover:text-canopy-text hover:bg-canopy-border/50 transition-colors"
              title="Reset to default"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          </div>

          {!validation.valid && validation.error && (
            <div className="flex items-start gap-2 text-xs text-red-400">
              <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
              <span>{validation.error}</span>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-400">
              <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <span className="block text-xs font-medium text-canopy-text/70">
            Available variables:
          </span>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="flex items-center gap-2 p-2 bg-canopy-bg/50 rounded border border-canopy-border">
              <code className="text-canopy-accent">{"{base-folder}"}</code>
              <span className="text-canopy-text/50">Repository folder name</span>
            </div>
            <div className="flex items-center gap-2 p-2 bg-canopy-bg/50 rounded border border-canopy-border">
              <code className="text-canopy-accent">{"{branch-slug}"}</code>
              <span className="text-canopy-text/50">Sanitized branch name</span>
            </div>
            <div className="flex items-center gap-2 p-2 bg-canopy-bg/50 rounded border border-canopy-border">
              <code className="text-canopy-accent">{"{repo-name}"}</code>
              <span className="text-canopy-text/50">Repository name</span>
            </div>
            <div className="flex items-center gap-2 p-2 bg-canopy-bg/50 rounded border border-canopy-border">
              <code className="text-canopy-accent">{"{parent-dir}"}</code>
              <span className="text-canopy-text/50">Parent directory path</span>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <span className="block text-xs font-medium text-canopy-text/70">Presets:</span>
          <div className="flex flex-wrap gap-2">
            {PATTERN_PRESETS.map((preset) => (
              <button
                key={preset.label}
                onClick={() => handlePresetClick(preset.pattern)}
                className={cn(
                  "px-3 py-1.5 text-xs rounded-[var(--radius-md)] border transition-colors",
                  pattern === preset.pattern
                    ? "bg-canopy-accent/10 border-canopy-accent text-canopy-accent"
                    : "border-canopy-border text-canopy-text/70 hover:bg-canopy-border/50"
                )}
                title={preset.description}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        {validation.valid && preview && (
          <div className="space-y-2 p-3 bg-canopy-bg/50 rounded-[var(--radius-md)] border border-canopy-border">
            <span className="block text-xs font-medium text-canopy-text/70">Preview:</span>
            <div className="text-xs space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-canopy-text/50">Repository:</span>
                <code className="text-canopy-text">{sampleRootPath}</code>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-canopy-text/50">Branch:</span>
                <code className="text-canopy-text">{SAMPLE_BRANCH}</code>
              </div>
              <div className="flex items-center gap-2 pt-1 border-t border-canopy-border mt-1">
                <span className="text-canopy-text/50">Result:</span>
                <code className="text-canopy-accent break-all">{preview}</code>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between pt-4 border-t border-canopy-border">
        <div className="flex items-center gap-2">
          {savedMessage && (
            <span className="flex items-center gap-1 text-xs text-green-400">
              <Check className="w-3 h-3" />
              Saved
            </span>
          )}
        </div>
        <button
          onClick={handleSave}
          disabled={!hasChanges || !validation.valid || isSaving}
          className={cn(
            "px-4 py-2 text-sm font-medium rounded-[var(--radius-md)] transition-colors",
            hasChanges && validation.valid
              ? "bg-canopy-accent text-white hover:bg-canopy-accent/90"
              : "bg-canopy-border text-canopy-text/50 cursor-not-allowed"
          )}
        >
          {isSaving ? "Saving..." : "Save Changes"}
        </button>
      </div>

      <div className="pt-4 border-t border-canopy-border">
        <p className="text-xs text-canopy-text/40">
          The path pattern determines where new worktrees are created when you use the New Worktree
          dialog. Relative paths (starting with . or ..) are resolved from the repository root.
        </p>
      </div>
    </div>
  );
}
