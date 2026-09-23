import { useState, useEffect, useId, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { AlertCircle, Check, ChevronRight } from "lucide-react";

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
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { SettingsSection } from "./SettingsSection";
import { SettingsSelect } from "./SettingsSelect";
import { useSettingsTabValidation } from "./SettingsValidationRegistry";
import { useSettingsTabFlush } from "./SettingsFlushRegistry";
import { formatErrorMessage } from "@shared/utils/errorMessage";

// Named for where the worktree lands, since all three sit beside the repository —
// "Subdirectory" read as inside it.
const PATTERN_PRESETS = [
  {
    label: "Grouped by repository",
    pattern: "{parent-dir}/{base-folder}-worktrees/{branch-slug}",
    description: "One -worktrees folder beside the repository, a folder per branch inside it",
  },
  {
    label: "Repository + branch",
    pattern: "{parent-dir}/{base-folder}-{branch-slug}",
    description: "A folder beside the repository named after it and the branch",
  },
  {
    label: "Branch only",
    pattern: "{parent-dir}/{branch-slug}",
    description: "A folder beside the repository named after the branch",
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState(false);
  const [savedMessageTimeout, setSavedMessageTimeout] = useState<NodeJS.Timeout | null>(null);
  const [showVariables, setShowVariables] = useState(false);
  const variablesId = useId();

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
    let cancelled = false;
    timedOutRef.current = false;
    setIsLoading(true);
    setLoadError(null);
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        timedOutRef.current = true;
        setLoadError("Settings load timed out");
        setIsLoading(false);
      }
    }, 10_000);

    actionService
      .dispatch("worktreeConfig.get", undefined, { source: "user" })
      .then((result) => {
        if (timedOutRef.current || cancelled) return;
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
        if (cancelled) return;
        settled = true;
        clearTimeout(timer);
        setLoadError(formatErrorMessage(err, "Failed to load worktree settings"));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [loadNonce]);

  // Until the stored pattern arrives the field holds a placeholder empty string:
  // validating it, marking it modified, or saving over it would all act on a value
  // the user never saw.
  const unavailable = isLoading || loadError !== null;

  const validation = useMemo(() => {
    if (!pattern.trim()) return { valid: false, error: "Pattern cannot be empty" };
    return validatePathPattern(pattern);
  }, [pattern]);

  useSettingsTabValidation("worktree", !unavailable && !validation.valid);

  const preview = useMemo(() => {
    if (!validation.valid) return null;
    return previewPathPattern(pattern, sampleRootPath, SAMPLE_BRANCH);
  }, [pattern, validation.valid]);

  const hasChanges = pattern !== originalPattern;

  const handleSave = async () => {
    if (unavailable || !validation.valid || isSaving) return;

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

  const patternError = !unavailable && !validation.valid ? validation.error : undefined;

  // Every edit goes through here: a "Saved" from the last commit must not sit
  // beside a value that is no longer the saved one.
  const editPattern = (next: string) => {
    setPattern(next);
    setError(null);
    setSavedMessage(false);
  };

  // Persist a pending pattern change before the dialog dismisses (X click) or
  // the WebContentsView detaches. handleSave's internal validation/saving
  // guards short-circuit cleanly when the pattern is invalid or a save is
  // already in flight.
  useSettingsTabFlush("worktree", handleSave, hasChanges && !unavailable);

  const errorMessages = [patternError, error].filter(Boolean);
  const hasPatternMessages = errorMessages.length > 0;

  return (
    <div className="space-y-8">
      <SettingsSection
        id="worktree-path-pattern"
        title="Path pattern"
        description="Where new worktrees are created. Relative paths (starting with . or ..) resolve from the repository root."
      >
        {loadError !== null && (
          <SettingsLoadErrorBanner
            title="Path pattern didn't load"
            message={loadError}
            onRetry={() => setLoadNonce((n) => n + 1)}
          />
        )}
        <SettingsGroup>
          <SettingsRow
            layout="stacked"
            label="Pattern"
            disabled={unavailable}
            // Measured against the field, not the saved value: reset fills in the
            // default and the explicit Save below still commits it.
            isModified={!unavailable && pattern !== DEFAULT_WORKTREE_PATH_PATTERN}
            onReset={isSaving ? undefined : () => editPattern(DEFAULT_WORKTREE_PATH_PATTERN)}
            resetAriaLabel="Reset path pattern to default"
            control={({ labelId, disabled }) => (
              <div className="grid gap-2">
                <Input
                  id="path-pattern"
                  type="text"
                  value={pattern}
                  onChange={(e) => editPattern(e.target.value)}
                  disabled={disabled}
                  // Locked while a save is in flight: the save's reply replaces the
                  // field, and would otherwise overwrite anything typed meanwhile.
                  readOnly={isSaving}
                  invalid={!!patternError}
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
                    // A failed save interrupts; the live pattern check doesn't.
                    role={error ? "alert" : undefined}
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
            label="Presets"
            disabled={unavailable}
            control={({ labelId, disabled }) => (
              <div role="group" aria-labelledby={labelId} className="flex flex-wrap gap-2">
                {PATTERN_PRESETS.map((preset) => (
                  <Tooltip key={preset.label}>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => editPattern(preset.pattern)}
                        disabled={disabled || isSaving}
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

          <SettingsRow
            layout="stacked"
            label="Preview"
            disabled={unavailable}
            description={
              <>
                <code className="font-mono">{SAMPLE_BRANCH}</code> in{" "}
                <code className="font-mono">{sampleRootPath}</code> becomes
              </>
            }
            control={
              preview ? (
                <code className="block font-mono text-xs text-text-primary break-all select-text">
                  {preview}
                </code>
              ) : (
                <p className="text-xs text-text-secondary">
                  {unavailable
                    ? "Waiting for the saved pattern"
                    : "Fix the pattern to see a preview"}
                </p>
              )
            }
          />

          <div>
            <button
              type="button"
              aria-expanded={showVariables}
              aria-controls={variablesId}
              onClick={() => setShowVariables((v) => !v)}
              className={cn(
                "group flex w-full items-center gap-2 py-2.5 pl-4 pr-4 text-left",
                "text-sm text-text-secondary hover:text-text-primary transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
              )}
            >
              <ChevronRight
                className={cn(
                  "w-3.5 h-3.5 shrink-0 transition-transform duration-150",
                  showVariables ? "rotate-90" : "rotate-0"
                )}
                aria-hidden="true"
              />
              {showVariables ? "Hide variables" : `Show variables (${PATTERN_VARIABLES.length})`}
            </button>
            <div id={variablesId}>
              {showVariables && (
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 pb-3 pl-9 pr-4 text-xs">
                  {PATTERN_VARIABLES.map((variable) => (
                    <div key={variable.token} className="contents">
                      <dt>
                        <code className="font-mono text-text-primary select-text">
                          {variable.token}
                        </code>
                      </dt>
                      <dd className="text-text-secondary">{variable.description}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </div>

          {/* An explicit save rather than instant apply: a half-typed pattern is
              routinely invalid, and each keystroke would otherwise write one. */}
          <SettingsActions
            status={
              savedMessage ? (
                <span className="flex items-center gap-1 text-status-success">
                  <Check className="w-3 h-3" aria-hidden="true" />
                  Saved
                </span>
              ) : hasChanges && !unavailable && validation.valid ? (
                // The dialog flushes a valid pending pattern when it closes, so
                // say so — otherwise Save reads as the only way it takes effect.
                "Also saves when you close Settings"
              ) : null
            }
          >
            {hasChanges && !unavailable && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => editPattern(originalPattern)}
                disabled={isSaving}
              >
                Discard
              </Button>
            )}
            <Button
              type="button"
              variant="contrast"
              size="sm"
              onClick={handleSave}
              disabled={unavailable || !hasChanges || !validation.valid || isSaving}
            >
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </SettingsActions>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Deleted worktrees"
        description="When a worktree is deleted while terminals are still running, its terminals stay in a temporary sidebar row until you move or close them"
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
