import { useState, useEffect, useRef, useId } from "react";
import {
  RadioChoiceGroup,
  RadioChoiceRow,
  CHOICE_SHELL,
  CHOICE_PAD,
  CHOICE_SELECTED,
  CHOICE_UNSELECTED,
  CHOICE_LABEL_INSET,
} from "@/components/ui/RadioChoice";
import { cn } from "@/lib/utils";
import { Image } from "lucide-react";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { useProjectStore } from "@/store";
import { projectClient } from "@/clients";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";

type ImageViewerMode = "os" | "custom";

export function ImageViewerTab() {
  const commandFieldId = useId();
  const [mode, setMode] = useState<ImageViewerMode>("os");
  const [customCommand, setCustomCommand] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
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
    setSaveError(null);
    setLoadError(null);
    setIsLoading(true);
    let cancelled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!cancelled && isMountedRef.current) {
        setLoadError("Settings took too long to load. Reopen the tab to retry.");
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
  }, [activeProjectId]);

  const handleModeChange = (newMode: ImageViewerMode) => {
    setMode(newMode);
    setSaved(false);
  };

  const handleCommandChange = (value: string) => {
    setCustomCommand(value);
    setSaved(false);
  };

  const handleSave = async () => {
    if (!activeProjectId || isSaving || isLoading || loadError) return;
    if (mode === "custom" && !customCommand.trim()) {
      setSaveError("Custom command cannot be empty");
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      // Routed through projectClient so the per-projectId getSettings cache
      // is invalidated on save. Bypassing it left other readers reading
      // stale data for up to the cache TTL.
      const settings = await projectClient.getSettings(activeProjectId);
      await projectClient.saveSettings(activeProjectId, {
        ...settings,
        preferredImageViewer: {
          mode,
          customCommand: mode === "custom" ? customCommand.trim() : undefined,
        },
      });
      if (!isMountedRef.current) return;
      setSaved(true);
    } catch (err) {
      if (!isMountedRef.current) return;
      setSaveError(formatErrorMessage(err, "Failed to save image viewer preference"));
    } finally {
      if (isMountedRef.current) setIsSaving(false);
    }
  };

  if (!activeProjectId) {
    return (
      <div className="p-4 text-sm text-daintree-text/50">
        Open a project to configure its image viewer preference.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        icon={Image}
        title="Image viewer"
        description="Choose the application that opens when you click 'Open in Image Viewer' in the file viewer."
      >
        <div className="space-y-4">
          <RadioChoiceGroup legend="Image viewer mode" legendHidden>
            <RadioChoiceRow
              name="imageViewerMode"
              value="os"
              checked={mode === "os"}
              onChange={() => handleModeChange("os")}
              disabled={controlsDisabled}
              label="Use OS default"
              description="Opens images with your system default viewer — Preview on macOS, Photos on Windows"
            />

            {/* The command field belongs to this option, so it renders inside
                the card and outside the label: nesting is what carries the
                dependency once forced-colors has flattened every fill. */}
            <div
              className={cn(
                CHOICE_SHELL,
                mode === "custom" ? CHOICE_SELECTED : CHOICE_UNSELECTED,
                controlsDisabled && "opacity-50"
              )}
            >
              <RadioChoiceRow
                name="imageViewerMode"
                value="custom"
                checked={mode === "custom"}
                onChange={() => handleModeChange("custom")}
                disabled={controlsDisabled}
                label="Custom command"
                description="Opens images with a command you provide"
                bare
              />
              {mode === "custom" && (
                <div className={cn(CHOICE_PAD, "pt-0 space-y-1.5", CHOICE_LABEL_INSET)}>
                  <label
                    htmlFor={commandFieldId}
                    className="block text-xs font-medium text-text-secondary"
                  >
                    Command
                  </label>
                  <input
                    id={commandFieldId}
                    type="text"
                    value={customCommand}
                    onChange={(e) => handleCommandChange(e.target.value)}
                    disabled={controlsDisabled}
                    placeholder="e.g. open -a Photoshop, gimp"
                    className="w-full bg-surface-input border border-border-strong rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-daintree-text font-mono transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                  <p className="text-xs text-text-secondary select-text">
                    The file path is appended as the last argument
                  </p>
                </div>
              )}
            </div>
          </RadioChoiceGroup>

          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={isSaving || isLoading || Boolean(loadError)}
              className="px-4 py-2 rounded-[var(--radius-md)] bg-daintree-accent text-accent-primary-foreground text-sm font-medium hover:bg-daintree-accent/90 disabled:opacity-50 disabled:pointer-events-none transition-colors"
            >
              {isSaving ? "Saving…" : "Save"}
            </button>
            {saved && <span className="text-xs text-status-success">Saved</span>}
          </div>

          {loadError && <p className="text-xs text-status-error">{loadError}</p>}
          {saveError && <p className="text-xs text-status-error">{saveError}</p>}
        </div>
      </SettingsSection>
    </div>
  );
}
