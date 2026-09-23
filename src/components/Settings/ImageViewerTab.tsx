import { useState, useEffect, useRef, useId } from "react";
import { RadioChoiceGroup, RadioChoiceRow, CHOICE_LABEL_INSET } from "@/components/ui/RadioChoice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsActions, SettingsGroup } from "@/components/Settings/SettingsGroup";
import { useProjectStore, patchCachedProjectSettings } from "@/store";
import { projectClient } from "@/clients";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";

type ImageViewerMode = "os" | "custom";

interface PersistedImageViewer {
  mode: ImageViewerMode;
  customCommand: string;
}

/** Options are rows of the group: the focus ring sits inside the row, the selection is a neutral lift. */
const ROW_CLASSES =
  "px-4 py-3 transition-colors has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:-outline-offset-2 has-[input:focus-visible]:outline-accent-primary";
const ROW_SELECTED = "bg-overlay-selected";
const ROW_UNSELECTED = "hover:bg-overlay-soft";

export function ImageViewerTab() {
  const commandFieldId = useId();
  const [mode, setMode] = useState<ImageViewerMode>("os");
  const [customCommand, setCustomCommand] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [commandError, setCommandError] = useState<string | null>(null);
  // What is on disk, so Save means "write this change". Null while the project has
  // no preference yet: the OS default shown then is a suggestion, and saving it is
  // still a real first write.
  const [persisted, setPersisted] = useState<PersistedImageViewer | null>(null);
  const isMountedRef = useRef(true);

  const activeProject = useProjectStore((s) => s.currentProject);
  const activeProjectId = activeProject?.id;

  const controlsDisabled = isLoading || Boolean(loadError);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!activeProjectId) return;
    setMode("os");
    setCustomCommand("");
    setSaved(false);
    setPersisted(null);
    setSaveError(null);
    setLoadError(null);
    setIsLoading(true);
    let cancelled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!cancelled && isMountedRef.current) {
        setLoadError("The saved image viewer took too long to load");
        setIsLoading(false);
      }
    }, 10_000);
    window.electron.project
      .getSettings(activeProjectId)
      .then((settings) => {
        if (cancelled || timedOut || !isMountedRef.current) return;
        const pref = settings?.preferredImageViewer;
        if (pref) {
          setMode(pref.mode);
          setCustomCommand(pref.customCommand ?? "");
          setPersisted({ mode: pref.mode, customCommand: pref.customCommand ?? "" });
        }
      })
      .catch((err) => {
        if (cancelled || !isMountedRef.current) return;
        logError("[ImageViewerTab] Failed to load settings", err);
        setLoadError(formatErrorMessage(err, "Couldn't load image viewer settings"));
      })
      .finally(() => {
        clearTimeout(timer);
        if (!cancelled && isMountedRef.current) setIsLoading(false);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeProjectId, loadAttempt]);

  const handleModeChange = (newMode: ImageViewerMode) => {
    setMode(newMode);
    setSaved(false);
  };

  const handleCommandChange = (value: string) => {
    setCustomCommand(value);
    setSaved(false);
    setCommandError(null);
  };

  const handleSave = async () => {
    if (!activeProjectId || isSaving || isLoading || loadError) return;
    if (mode === "custom" && !customCommand.trim()) {
      setCommandError("Enter the command that opens images");
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      // Routed through projectClient so the per-projectId getSettings cache
      // is invalidated on save. Bypassing it left other readers reading
      // stale data for up to the cache TTL.
      const preferredImageViewer = {
        mode,
        customCommand: mode === "custom" ? customCommand.trim() : undefined,
      };
      const settings = await projectClient.getSettings(activeProjectId);
      await projectClient.saveSettings(activeProjectId, { ...settings, preferredImageViewer });
      // Merge into whatever the cache holds now, not into the object fetched
      // before the await — a concurrent write may have landed in between. A
      // stale cache here is what reverts this save on dialog close (#12326).
      patchCachedProjectSettings(activeProjectId, { preferredImageViewer });
      if (!isMountedRef.current) return;
      setPersisted({ mode, customCommand: preferredImageViewer.customCommand ?? "" });
      setSaved(true);
    } catch (err) {
      if (!isMountedRef.current) return;
      setSaveError(formatErrorMessage(err, "Failed to save image viewer preference"));
    } finally {
      if (isMountedRef.current) setIsSaving(false);
    }
  };

  const isDirty =
    !persisted ||
    persisted.mode !== mode ||
    (mode === "custom" && persisted.customCommand !== customCommand.trim());

  if (!activeProjectId) {
    return (
      <div className="p-4 text-sm text-text-secondary">
        Open a project to configure its image viewer preference.
      </div>
    );
  }

  return (
    <SettingsSection
      id="image-viewer"
      title="Image viewer"
      description={`The app "Open in image viewer" launches from the file viewer. Saved for ${activeProject?.name ?? "this project"} only.`}
    >
      <SettingsGroup className="overflow-hidden">
        <RadioChoiceGroup
          legend="Image viewer mode"
          legendHidden
          className="space-y-0 divide-y divide-border-subtle"
        >
          <RadioChoiceRow
            bare
            name="imageViewerMode"
            value="os"
            checked={mode === "os"}
            onChange={() => handleModeChange("os")}
            disabled={controlsDisabled}
            label="Use OS default"
            description="Opens images with your system default viewer — Preview on macOS, Photos on Windows"
            className={cn(ROW_CLASSES, mode === "os" ? ROW_SELECTED : ROW_UNSELECTED)}
          />

          {/* The command field belongs to this option, so it renders inside
              the option's row and outside the label: nesting is what carries
              the dependency once forced-colors has flattened every fill. */}
          <div
            className={cn(
              mode === "custom" ? ROW_SELECTED : ROW_UNSELECTED,
              controlsDisabled && "opacity-50"
            )}
          >
            <RadioChoiceRow
              bare
              name="imageViewerMode"
              value="custom"
              checked={mode === "custom"}
              onChange={() => handleModeChange("custom")}
              disabled={controlsDisabled}
              label="Custom command"
              description="Opens images with a command you provide"
              className={ROW_CLASSES}
            />
            {mode === "custom" && (
              <div className={cn("px-4 pb-3 space-y-1.5", CHOICE_LABEL_INSET)}>
                <label
                  htmlFor={commandFieldId}
                  className="block text-xs font-medium text-text-secondary"
                >
                  Command
                </label>
                <Input
                  id={commandFieldId}
                  type="text"
                  value={customCommand}
                  onChange={(e) => handleCommandChange(e.target.value)}
                  disabled={controlsDisabled}
                  placeholder="open -a Photoshop, gimp"
                  aria-describedby={`${commandFieldId}-help${commandError ? ` ${commandFieldId}-error` : ""}`}
                  aria-invalid={commandError ? true : undefined}
                  className="font-mono"
                />
                {commandError && (
                  <p id={`${commandFieldId}-error`} className="text-xs text-status-error">
                    {commandError}
                  </p>
                )}
                <p
                  id={`${commandFieldId}-help`}
                  className="text-xs text-text-secondary select-text"
                >
                  The file path is appended as the last argument
                </p>
              </div>
            )}
          </div>
        </RadioChoiceGroup>

        <SettingsActions
          status={
            loadError ? (
              <span className="text-status-error">{loadError}</span>
            ) : saveError ? (
              <span className="text-status-error">{saveError}</span>
            ) : saved && !isDirty ? (
              "Saved"
            ) : !persisted && !isLoading ? (
              "Not saved yet — images open with the OS default"
            ) : persisted && isDirty ? (
              "Unsaved changes"
            ) : null
          }
        >
          {loadError && (
            <Button variant="outline" size="sm" onClick={() => setLoadAttempt((n) => n + 1)}>
              Retry
            </Button>
          )}
          <Button
            variant="contrast"
            size="sm"
            onClick={handleSave}
            disabled={isSaving || isLoading || Boolean(loadError) || !isDirty}
          >
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </SettingsActions>
      </SettingsGroup>
    </SettingsSection>
  );
}
