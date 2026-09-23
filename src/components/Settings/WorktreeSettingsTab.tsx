import { useState, useEffect, useMemo, useRef } from "react";
import { AlertCircle, Check } from "lucide-react";

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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileBrowserVisibilitySettings } from "./FileBrowserVisibilitySettings";
import { SettingsActions, SettingsGroup, SettingsRow } from "./SettingsGroup";
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
    label: "Sibling folder",
    pattern: "{parent-dir}/{base-folder}-{branch-slug}",
    description: "Creates worktrees as siblings with branch suffix",
  },
  {
    label: "Flat sibling",
    pattern: "{parent-dir}/{branch-slug}",
    description: "Creates worktrees as siblings named by branch",
  },
] as const;

const PATTERN_VARIABLES = [
  { token: "{base-folder}", description: "Repository folder name" },
  { token: "{branch-slug}", description: "Sanitized branch name" },
  { token: "{repo-name}", description: "Repository name" },
  { token: "{parent-dir}", description: "Parent directory path" },
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

  // A failed load leaves the pattern empty, which trips validation too — so
  // these are reported together rather than one masking the other's cause.
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

  const errorMessages = [patternError, error].filter(Boolean);
  const hasPatternMessages = errorMessages.length > 0;

  return (
    <div className="space-y-8">
      <SettingsSection
        id="worktree-path-pattern"
        title="Path pattern"
        description="Where new worktrees are created. Relative paths (starting with . or ..) resolve from the repository root."
      >
        <SettingsGroup>
          <SettingsRow
            layout="stacked"
            label="Pattern"
            // Measured against the field, not the saved value: reset fills in the
            // default and the explicit Save below still commits it.
            isModified={!isLoading && pattern !== DEFAULT_WORKTREE_PATH_PATTERN}
            onReset={handleReset}
            resetAriaLabel="Reset path pattern to default"
            control={({ labelId }) => (
              <div className="grid gap-2">
                <Input
                  id="path-pattern"
                  type="text"
                  value={pattern}
                  onChange={(e) => {
                    setPattern(e.target.value);
                    setError(null);
                  }}
                  disabled={isLoading}
                  invalid={!validation.valid && !isLoading}
                  aria-labelledby={labelId}
                  aria-invalid={!!patternError}
                  aria-describedby={hasPatternMessages ? "path-pattern-error" : undefined}
                  className="min-w-0 font-mono"
                  placeholder="{parent-dir}/{base-folder}-worktrees/{branch-slug}"
                />
                {hasPatternMessages && (
                  <div
                    id="path-pattern-error"
                    className="space-y-1 text-xs text-status-error"
                    role="alert"
                  >
                    {errorMessages.map((message) => (
                      <div key={message} className="flex items-start gap-2">
                        <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" aria-hidden="true" />
                        <span>{message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          />

          <SettingsRow
            layout="stacked"
            label="Variables"
            control={
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
                {PATTERN_VARIABLES.map((variable) => (
                  <div key={variable.token} className="contents">
                    <dt>
                      <code className="font-mono text-text-primary">{variable.token}</code>
                    </dt>
                    <dd className="text-text-secondary">{variable.description}</dd>
                  </div>
                ))}
              </dl>
            }
          />

          <SettingsRow
            layout="stacked"
            label="Presets"
            control={({ labelId }) => (
              <div role="group" aria-labelledby={labelId} className="flex flex-wrap gap-2">
                {PATTERN_PRESETS.map((preset) => (
                  <Tooltip key={preset.label}>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handlePresetClick(preset.pattern)}
                        disabled={isLoading}
                      >
                        {preset.label}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{preset.description}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            )}
          />

          {validation.valid && preview && (
            <SettingsRow
              layout="stacked"
              label="Preview"
              description={
                <>
                  <code className="font-mono">{SAMPLE_BRANCH}</code> in{" "}
                  <code className="font-mono">{sampleRootPath}</code> becomes
                </>
              }
              control={
                <code className="block font-mono text-xs text-text-primary break-all select-text">
                  {preview}
                </code>
              }
            />
          )}

          {/* An explicit save rather than instant apply: a half-typed pattern is
              routinely invalid, and each keystroke would otherwise write one. */}
          <SettingsActions
            status={
              savedMessage && (
                <span className="flex items-center gap-1 text-status-success">
                  <Check className="w-3 h-3" aria-hidden="true" />
                  Saved
                </span>
              )
            }
          >
            <Button
              type="button"
              variant="contrast"
              size="sm"
              onClick={handleSave}
              disabled={isLoading || !hasChanges || !validation.valid || isSaving}
            >
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </SettingsActions>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Deleted worktrees"
        description="When a worktree is deleted while terminals are still running, its terminals stay in a temporary sidebar row until you move or close them."
      >
        <SettingsGroup>
          <SettingsSelect
            label="Close leftover terminals"
            description="Leftover terminals move to trash when the timer ends. The timer only counts down while the project is open."
            controlWidth="wide"
            value={String(cleanupSeconds)}
            onValueChange={handleCleanupChange}
            options={DELETED_WORKTREE_CLEANUP_OPTIONS}
            isModified={cleanupSeconds !== DELETED_WORKTREE_CLEANUP_DEFAULT}
            onReset={() => setCleanupSeconds(DELETED_WORKTREE_CLEANUP_DEFAULT)}
          />
        </SettingsGroup>
      </SettingsSection>

      <FileBrowserVisibilitySettings />
    </div>
  );
}
