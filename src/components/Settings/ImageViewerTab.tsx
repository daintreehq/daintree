import { useState, useEffect, useRef } from "react";
import { Image } from "lucide-react";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { useProjectStore } from "@/store";

type ImageViewerMode = "os" | "custom";

export function ImageViewerTab() {
  const [mode, setMode] = useState<ImageViewerMode>("os");
  const [customCommand, setCustomCommand] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const isMountedRef = useRef(true);

  const activeProject = useProjectStore((s) => s.currentProject);
  const activeProjectId = activeProject?.id;

  useEffect(() => {
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
    setIsLoading(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled && isMountedRef.current) setIsLoading(false);
    }, 10_000);
    window.electron.project
      .getSettings(activeProjectId)
      .then((settings) => {
        if (cancelled || !isMountedRef.current) return;
        const pref = settings?.preferredImageViewer;
        if (pref) {
          setMode(pref.mode);
          setCustomCommand(pref.customCommand ?? "");
        }
      })
      .catch((err) => {
        if (cancelled || !isMountedRef.current) return;
        console.error("[ImageViewerTab] Failed to load settings:", err);
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
    if (!activeProjectId || isSaving || isLoading) return;
    if (mode === "custom" && !customCommand.trim()) {
      setSaveError("Custom command cannot be empty");
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const settings = await window.electron.project.getSettings(activeProjectId);
      await window.electron.project.saveSettings(activeProjectId, {
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
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      if (isMountedRef.current) setIsSaving(false);
    }
  };

  if (!activeProjectId) {
    return (
      <div className="p-4 text-sm text-canopy-text/50">
        Open a project to configure its image viewer preference.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        icon={Image}
        title="Image Viewer"
        description="Choose the application that opens when you click 'Open in Image Viewer' in the file viewer."
      >
        <div className="space-y-4">
          {isLoading ? (
            <p className="text-xs text-canopy-text/40">Loading…</p>
          ) : (
            <>
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="imageViewerMode"
                    value="os"
                    checked={mode === "os"}
                    onChange={() => handleModeChange("os")}
                    className="accent-canopy-accent"
                  />
                  <span className="text-sm text-canopy-text">Use OS default</span>
                </label>
                <p className="text-xs text-canopy-text/40 ml-6">
                  Opens images with your system default viewer (Preview on macOS, Photos on
                  Windows).
                </p>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="imageViewerMode"
                    value="custom"
                    checked={mode === "custom"}
                    onChange={() => handleModeChange("custom")}
                    className="accent-canopy-accent"
                  />
                  <span className="text-sm text-canopy-text">Custom command</span>
                </label>
              </div>

              {mode === "custom" && (
                <div className="space-y-1 ml-6">
                  <label className="text-xs text-canopy-text/60">Command</label>
                  <input
                    type="text"
                    value={customCommand}
                    onChange={(e) => handleCommandChange(e.target.value)}
                    placeholder="e.g. open -a Photoshop, gimp"
                    className="w-full bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] px-3 py-1.5 text-sm text-canopy-text focus:outline-none focus:border-canopy-accent transition-colors font-mono"
                  />
                  <p className="text-xs text-canopy-text/40">
                    The file path will be appended as the last argument.
                  </p>
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  onClick={handleSave}
                  disabled={isSaving || isLoading}
                  className="px-4 py-2 rounded-[var(--radius-md)] bg-canopy-accent text-canopy-bg text-sm font-medium hover:bg-canopy-accent/90 disabled:opacity-50 transition-colors"
                >
                  {isSaving ? "Saving…" : "Save"}
                </button>
                {saved && <span className="text-xs text-status-success">Saved</span>}
              </div>

              {saveError && <p className="text-xs text-status-error">{saveError}</p>}
            </>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
