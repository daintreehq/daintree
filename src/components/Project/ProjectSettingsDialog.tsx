import { useState, useEffect } from "react";
import { Server, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { AppDialog } from "@/components/ui/AppDialog";
import { useProjectSettings } from "@/hooks";
import { useProjectStore } from "@/store/projectStore";
import type { ProjectDevServerSettings } from "@/types";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { devServerClient } from "@/clients";

interface ProjectSettingsDialogProps {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
}

export function ProjectSettingsDialog({ projectId, isOpen, onClose }: ProjectSettingsDialogProps) {
  const { settings, saveSettings, isLoading, error } = useProjectSettings(projectId);
  const { projects, updateProject } = useProjectStore();
  const currentProject = projects.find((p) => p.id === projectId);

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [name, setName] = useState(currentProject?.name || "");
  const [emoji, setEmoji] = useState(currentProject?.emoji || "🌲");
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);

  const [devServerEnabled, setDevServerEnabled] = useState(false);
  const [devServerCommand, setDevServerCommand] = useState("");
  const [devServerAutoStart, setDevServerAutoStart] = useState(false);
  const [detectedCommand, setDetectedCommand] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && settings) {
      setDevServerEnabled(settings.devServer?.enabled ?? false);
      setDevServerCommand(settings.devServer?.command ?? "");
      setDevServerAutoStart(settings.devServer?.autoStart ?? false);
    }
  }, [settings, isOpen]);

  useEffect(() => {
    if (isOpen && currentProject) {
      setName(currentProject.name);
      setEmoji(currentProject.emoji || "🌲");
    }
  }, [isOpen, currentProject]);

  useEffect(() => {
    if (!isOpen) {
      setIsEmojiPickerOpen(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !currentProject?.path) {
      setDetectedCommand(null);
      return;
    }

    let cancelled = false;

    devServerClient
      .hasDevScript(currentProject.path)
      .then((hasScript) => {
        if (!cancelled) {
          if (hasScript) {
            setDetectedCommand("npm run dev (auto-detected)");
          } else {
            setDetectedCommand(null);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDetectedCommand(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, currentProject?.path]);

  const handleSave = async () => {
    if (!settings) return;

    if (devServerEnabled && !devServerCommand.trim() && !detectedCommand) {
      setSaveError(
        "Dev server is enabled but no command is configured. Either enter a custom command or ensure your project has a dev script (e.g., 'npm run dev')."
      );
      return;
    }

    setIsSaving(true);
    setSaveError(null);
    try {
      if (currentProject) {
        await updateProject(projectId, {
          name: name.trim() || currentProject.name,
          emoji: emoji,
        });
      }

      const devServerSettings: ProjectDevServerSettings = {
        enabled: devServerEnabled,
        command: devServerCommand.trim() || undefined,
        autoStart: devServerAutoStart,
      };

      await saveSettings({
        ...settings,
        devServer: devServerSettings,
      });
      onClose();
    } catch (error) {
      console.error("Failed to save settings:", error);
      setSaveError(error instanceof Error ? error.message : "Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="md">
      <AppDialog.Header>
        <AppDialog.Title>Project Settings</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        {isLoading && (
          <div className="text-sm text-canopy-text/60 text-center py-8">Loading settings...</div>
        )}
        {error && (
          <div className="text-sm text-[var(--color-status-error)] bg-red-900/20 border border-red-900/30 rounded p-3 mb-4">
            Failed to load settings: {error}
          </div>
        )}
        {saveError && (
          <div className="text-sm text-[var(--color-status-error)] bg-red-900/20 border border-red-900/30 rounded p-3 mb-4">
            {saveError}
          </div>
        )}
        {!isLoading && !error && (
          <>
            {currentProject && (
              <div className="mb-6 pb-6 border-b border-canopy-border">
                <h3 className="text-sm font-semibold text-canopy-text/80 mb-2">Project Identity</h3>
                <p className="text-xs text-canopy-text/60 mb-4">
                  Customize how your project appears in the sidebar and dashboard.
                </p>

                <div className="flex items-start gap-3 p-3 rounded-[var(--radius-md)] bg-canopy-bg border border-canopy-border">
                  <Popover open={isEmojiPickerOpen} onOpenChange={setIsEmojiPickerOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        aria-label="Change project emoji"
                        className="flex h-14 w-14 items-center justify-center rounded-[var(--radius-xl)] shadow-inner shrink-0 bg-white/5 hover:bg-white/10 transition-colors border border-transparent hover:border-canopy-border cursor-pointer group"
                        style={{
                          background: getProjectGradient(currentProject.color),
                        }}
                      >
                        <span className="text-3xl select-none filter drop-shadow-sm group-hover:scale-110 transition-transform">
                          {emoji}
                        </span>
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0">
                      <EmojiPicker
                        onEmojiSelect={({ emoji }) => {
                          setEmoji(emoji);
                          setIsEmojiPickerOpen(false);
                        }}
                      />
                    </PopoverContent>
                  </Popover>

                  <div className="flex-1 min-w-0 flex flex-col justify-center h-14">
                    <label
                      htmlFor="project-name-input"
                      className="text-xs font-medium text-canopy-text/60 mb-1.5 ml-1"
                    >
                      Project Name
                    </label>
                    <input
                      id="project-name-input"
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full bg-transparent border border-canopy-border rounded px-3 py-2 text-sm text-canopy-text focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30 transition-all placeholder:text-canopy-text/40"
                      placeholder="My Awesome Project"
                    />
                  </div>
                </div>
              </div>
            )}

            <div className="mb-6">
              <h3 className="text-sm font-semibold text-canopy-text/80 mb-2 flex items-center gap-2">
                <Server className="h-4 w-4" />
                Dev Server
              </h3>
              <p className="text-xs text-canopy-text/60 mb-4">
                Configure how the development server is managed for this project.
              </p>

              <div className="space-y-4 p-4 rounded-[var(--radius-md)] bg-canopy-bg border border-canopy-border">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={devServerEnabled}
                    onChange={(e) => setDevServerEnabled(e.target.checked)}
                    className="w-4 h-4 rounded border-canopy-border bg-canopy-sidebar text-canopy-accent focus:ring-canopy-accent/50"
                  />
                  <div>
                    <span className="text-sm text-canopy-text">Enable dev server management</span>
                    <p className="text-xs text-canopy-text/60">
                      Show dev server controls on worktree cards
                    </p>
                  </div>
                </label>

                <div
                  className={cn(
                    "transition-opacity space-y-4",
                    !devServerEnabled && "opacity-50 pointer-events-none"
                  )}
                >
                  <div className="space-y-2">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={devServerAutoStart}
                        onChange={(e) => setDevServerAutoStart(e.target.checked)}
                        disabled={!devServerEnabled}
                        className="w-4 h-4 rounded border-canopy-border bg-canopy-sidebar text-canopy-accent focus:ring-canopy-accent/50 disabled:opacity-50"
                      />
                      <div>
                        <span className="text-sm text-canopy-text">Auto-start on project load</span>
                        <p className="text-xs text-canopy-text/60">
                          Automatically start the dev server when switching to this project
                        </p>
                      </div>
                    </label>
                    {devServerAutoStart && devServerEnabled && (
                      <p className="text-xs text-[var(--color-status-success)] ml-7">
                        Dev server will start automatically when you open this project
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <label
                      htmlFor="dev-server-command"
                      className="text-sm font-medium text-canopy-text"
                    >
                      Command
                    </label>
                    <input
                      id="dev-server-command"
                      type="text"
                      value={devServerCommand}
                      onChange={(e) => setDevServerCommand(e.target.value)}
                      disabled={!devServerEnabled}
                      className={cn(
                        "w-full bg-canopy-sidebar border border-canopy-border rounded px-3 py-2 text-sm text-canopy-text font-mono",
                        "focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30 transition-all",
                        "placeholder:text-canopy-text/40 disabled:opacity-50"
                      )}
                      placeholder={detectedCommand || "npm run dev"}
                    />
                    <div className="flex items-start gap-2 text-xs text-canopy-text/60">
                      <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      <span>
                        Leave blank to use auto-detection. Supports any command: npm, yarn, pnpm,
                        python, go, make, etc.
                      </span>
                    </div>
                    {detectedCommand && !devServerCommand && (
                      <div className="text-xs text-[var(--color-status-success)] mt-1">
                        ✓ Auto-detected: {detectedCommand}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button
          onClick={onClose}
          variant="ghost"
          className="text-canopy-text/60 hover:text-canopy-text"
        >
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={isSaving || isLoading || !!error}>
          {isSaving ? "Saving..." : "Save Changes"}
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
