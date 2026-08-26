import { useState, useEffect, useMemo, useRef } from "react";
import { AlertCircle, Check, FolderX, RotateCcw } from "lucide-react";
import { FolderGit2 } from "@/components/icons";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  validatePathPattern,
  previewPathPattern,
  DEFAULT_WORKTREE_PATH_PATTERN,
} from "@shared/utils/pathPattern";
import { actionService } from "@/services/ActionService";
import {
  usePreferencesStore,
  isDeletedWorktreeCleanupSeconds,
  DELETED_WORKTREE_CLEANUP_DEFAULT,
} from "@/store/preferencesStore";
import { FIELD_INPUT, FormGrid, FormRow } from "@/components/Worktree/views";
import { FileBrowserVisibilitySettings } from "./FileBrowserVisibilitySettings";
import { SettingsSection } from "./SettingsSection";
import { SettingsSelect } from "./SettingsSelect";
import { useSettingsTabValidation } from "./SettingsValidationRegistry";
import { useSettingsTabFlush } from "./SettingsFlushRegistry";
import { formatErrorMessage } from "@shared/utils/errorMessage";

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

const DELETED_WORKTREE_CLEANUP_OPTIONS = [
  { value: "30", label: "After 30 seconds" },
  { value: "60", label: "After 1 minute (default)" },
  { value: "300", label: "After 5 minutes" },
  { value: "0", label: "Never — close manually" },
];

export function WorktreeSettingsTab() {
  const [pattern, setPattern] = useState("");
  const [originalPattern, setOriginalPattern] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState(false);
  const [savedMessageTimeout, setSavedMessageTimeout] = useState<NodeJS.Timeout | null>(null);

  const sampleRootPath = "/Users/name/Projects/my-project";

  const cleanupSeconds = usePreferencesStore((s) => s.deletedWorktreeCleanupSeconds);
  const setCleanupSeconds = usePreferencesStore((s) => s.setDeletedWorktreeCleanupSeconds);
  const handleCleanupChange = (value: string) => {
    const parsed = Number(value);
    if (isDeletedWorktreeCleanupSeconds(parsed)) setCleanupSeconds(parsed);
  };

  useEffect(() => {
    return () => {
      if (savedMessageTimeout) {
        clearTimeout(savedMessageTimeout);
      }
    };
  }, [savedMessageTimeout]);

  const timedOutRef = useRef(false);

  useEffect(() => {
    let settled = false;
    timedOutRef.current = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        timedOutRef.current = true;
        setError("Settings load timed out");
        setIsLoading(false);
      }
    }, 10_000);

    actionService
      .dispatch("worktreeConfig.get", undefined, { source: "user" })
      .then((result) => {
        if (timedOutRef.current) return;
        settled = true;
        clearTimeout(timer);
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        const config = result.result as { pathPattern: string };
        setPattern(config.pathPattern);
        setOriginalPattern(config.pathPattern);
      })
      .catch((err) => {
        settled = true;
        clearTimeout(timer);
        setError(formatErrorMessage(err, "Failed to load worktree settings"));
      })
      .finally(() => {
        setIsLoading(false);
      });

    return () => clearTimeout(timer);
  }, []);

  const validation = useMemo(() => {
    if (!pattern.trim()) return { valid: false, error: "Pattern cannot be empty" };
    return validatePathPattern(pattern);
  }, [pattern]);

  // Report validation state to sidebar (only after loading completes)
  useSettingsTabValidation("worktree", !isLoading && !validation.valid);

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
      const result = await actionService.dispatch(
        "worktreeConfig.setPattern",
        { pattern },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      const config = result.result as { pathPattern: string };
      setOriginalPattern(config.pathPattern);
      setPattern(config.pathPattern);
      setSavedMessage(true);
      if (savedMessageTimeout) {
        clearTimeout(savedMessageTimeout);
      }
      const timeout = setTimeout(() => setSavedMessage(false), 2000);
      setSavedMessageTimeout(timeout);
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to save pattern"));
    } finally {
      setIsSaving(false);
    }
  };

  // One hint slot, so validation and save failures can't stack two error rows
  // under the field. Validation wins: it blocks the save that would report the other.
  const patternError = !isLoading && !validation.valid ? validation.error : undefined;

  const handleReset = () => {
    setPattern(DEFAULT_WORKTREE_PATH_PATTERN);
    setError(null);
  };

  const handlePresetClick = (presetPattern: string) => {
    setPattern(presetPattern);
    setError(null);
  };

  // Persist a pending pattern change before the dialog dismisses (X click) or
  // the WebContentsView detaches. handleSave's internal validation/saving
  // guards short-circuit cleanly when the pattern is invalid or a save is
  // already in flight.
  useSettingsTabFlush("worktree", handleSave, hasChanges && !isLoading);

  return (
    <div className="space-y-6">
      <SettingsSection
        icon={FolderGit2}
        title="Worktree path pattern"
        description="Configure the default path pattern for new worktrees. Use variables to build dynamic paths based on your repository and branch names."
      >
        <div className="contents">
          <FormGrid>
            <FormRow
              label="Pattern"
              htmlFor="path-pattern"
              hint={
                (patternError || error) && (
                  <div
                    id="path-pattern-error"
                    className="flex items-start gap-2 text-xs text-status-error"
                    role="alert"
                  >
                    <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" aria-hidden="true" />
                    <span>{patternError ?? error}</span>
                  </div>
                )
              }
            >
              <div className="flex gap-2">
                <input
                  id="path-pattern"
                  type="text"
                  value={pattern}
                  onChange={(e) => {
                    setPattern(e.target.value);
                    setError(null);
                  }}
                  disabled={isLoading}
                  aria-invalid={!!patternError}
                  aria-describedby={patternError || error ? "path-pattern-error" : undefined}
                  className={cn(
                    FIELD_INPUT,
                    "flex-1 min-w-0 font-mono",
                    !validation.valid && "border-status-error/50"
                  )}
                  placeholder="{parent-dir}/{base-folder}-worktrees/{branch-slug}"
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={handleReset}
                      disabled={isLoading}
                      className="px-3 py-1.5 border border-daintree-border rounded-[var(--radius-md)] text-daintree-text/60 hover:text-daintree-text hover:bg-daintree-border/50 transition-colors disabled:opacity-50"
                      aria-label="Reset to default"
                    >
                      <RotateCcw className="w-4 h-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Reset to default</TooltipContent>
                </Tooltip>
              </div>
            </FormRow>
          </FormGrid>

          <div className="space-y-2">
            <span className="block text-xs font-medium text-daintree-text/70">
              Available variables:
            </span>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="flex items-center gap-2 p-2 bg-daintree-bg/50 rounded-[var(--radius-md)] border border-daintree-border">
                <code className="text-text-secondary">{"{base-folder}"}</code>
                <span className="text-daintree-text/50">Repository folder name</span>
              </div>
              <div className="flex items-center gap-2 p-2 bg-daintree-bg/50 rounded-[var(--radius-md)] border border-daintree-border">
                <code className="text-text-secondary">{"{branch-slug}"}</code>
                <span className="text-daintree-text/50">Sanitized branch name</span>
              </div>
              <div className="flex items-center gap-2 p-2 bg-daintree-bg/50 rounded-[var(--radius-md)] border border-daintree-border">
                <code className="text-text-secondary">{"{repo-name}"}</code>
                <span className="text-daintree-text/50">Repository name</span>
              </div>
              <div className="flex items-center gap-2 p-2 bg-daintree-bg/50 rounded-[var(--radius-md)] border border-daintree-border">
                <code className="text-text-secondary">{"{parent-dir}"}</code>
                <span className="text-daintree-text/50">Parent directory path</span>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <span className="block text-xs font-medium text-daintree-text/70">Presets:</span>
            <div className="flex flex-wrap gap-2">
              {PATTERN_PRESETS.map((preset) => (
                <Tooltip key={preset.label}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => handlePresetClick(preset.pattern)}
                      disabled={isLoading}
                      className={cn(
                        "px-3 py-1.5 text-xs rounded-[var(--radius-md)] border transition-colors disabled:opacity-50",
                        pattern === preset.pattern
                          ? "bg-overlay-selected border-border-strong text-daintree-text font-medium"
                          : "border-daintree-border text-daintree-text/70 hover:bg-daintree-border/50"
                      )}
                    >
                      {preset.label}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{preset.description}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          </div>

          {validation.valid && preview && (
            <div className="space-y-2 p-3 bg-daintree-bg/50 rounded-[var(--radius-md)] border border-daintree-border">
              <span className="block text-xs font-medium text-daintree-text/70">Preview:</span>
              <div className="text-xs space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-daintree-text/50">Repository:</span>
                  <code className="text-daintree-text">{sampleRootPath}</code>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-daintree-text/50">Branch:</span>
                  <code className="text-daintree-text">{SAMPLE_BRANCH}</code>
                </div>
                <div className="flex items-center gap-2 pt-1 border-t border-daintree-border mt-1">
                  <span className="text-daintree-text/50">Result:</span>
                  <code className="text-daintree-text break-all">{preview}</code>
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {savedMessage && (
                <span className="flex items-center gap-1 text-xs text-status-success">
                  <Check className="w-3 h-3" />
                  Saved
                </span>
              )}
            </div>
            <button
              onClick={handleSave}
              disabled={isLoading || !hasChanges || !validation.valid || isSaving}
              className={cn(
                "px-4 py-1.5 text-sm font-medium rounded-[var(--radius-md)] transition-colors",
                hasChanges && validation.valid
                  ? "bg-daintree-accent text-accent-primary-foreground hover:bg-daintree-accent/90"
                  : "bg-daintree-border text-daintree-text/50 cursor-not-allowed"
              )}
            >
              {isSaving ? "Saving…" : "Save Changes"}
            </button>
          </div>

          <p className="text-xs text-daintree-text/40">
            The path pattern determines where new worktrees are created when you use the New
            Worktree dialog. Relative paths (starting with . or ..) are resolved from the repository
            root.
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={FolderX}
        title="Deleted worktrees"
        description="When a worktree is deleted while terminals are still running, its terminals stay in a temporary sidebar row until you move or close them."
      >
        <SettingsSelect
          label="Close leftover terminals"
          description="Leftover terminals move to trash when the timer ends. The timer only counts down while the project is open, and pauses for a while during a drag, an open close confirmation, or an agent that's still working."
          scope="global"
          value={String(cleanupSeconds)}
          onValueChange={handleCleanupChange}
          options={DELETED_WORKTREE_CLEANUP_OPTIONS}
          isModified={cleanupSeconds !== DELETED_WORKTREE_CLEANUP_DEFAULT}
          onReset={() => setCleanupSeconds(DELETED_WORKTREE_CLEANUP_DEFAULT)}
        />
      </SettingsSection>

      <FileBrowserVisibilitySettings />
    </div>
  );
}
