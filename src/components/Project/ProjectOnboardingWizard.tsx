import { useState, useEffect } from "react";
import {
  Terminal,
  Rocket,
  Play,
  FileCode,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { AppDialog } from "@/components/ui/AppDialog";
import { useProjectSettings } from "@/hooks";
import { useProjectStore } from "@/store/projectStore";
import { useRecipeStore } from "@/store/recipeStore";
import type { RunCommand } from "@/types";
import { getProjectGradient } from "@/lib/colorUtils";
import { projectClient } from "@/clients";

interface ProjectOnboardingWizardProps {
  isOpen: boolean;
  projectId: string;
  onClose: () => void;
}

export function ProjectOnboardingWizard({
  isOpen,
  projectId,
  onClose,
}: ProjectOnboardingWizardProps) {
  const { settings, saveSettings, isLoading } = useProjectSettings(projectId);
  const { projects, updateProject } = useProjectStore();
  const currentProject = projects.find((p) => p.id === projectId);

  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🌲");
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
  const [devServerCommand, setDevServerCommand] = useState("");
  const [runCommands, setRunCommands] = useState<RunCommand[]>([]);
  const [claudeMdContent, setClaudeMdContent] = useState("");
  const [defaultWorktreeRecipeId, setDefaultWorktreeRecipeId] = useState<string | undefined>(
    undefined
  );
  const [isInitialized, setIsInitialized] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const { recipes, loadRecipes, isLoading: recipesLoading } = useRecipeStore();

  useEffect(() => {
    let cancelled = false;

    if (isOpen && !isLoading && settings && currentProject && !isInitialized) {
      setName(currentProject.name);
      setEmoji(currentProject.emoji || "🌲");
      setDevServerCommand(settings.devServerCommand || "");
      setRunCommands(settings.runCommands || []);
      setDefaultWorktreeRecipeId(settings.defaultWorktreeRecipeId);

      projectClient
        .readClaudeMd(projectId)
        .then((content) => {
          if (!cancelled) setClaudeMdContent(content ?? "");
        })
        .catch(() => {
          if (!cancelled) setClaudeMdContent("");
        });

      loadRecipes(projectId).catch(() => {});
      setIsInitialized(true);
    }

    if (!isOpen) {
      setIsInitialized(false);
      setSaveError(null);
      setIsEmojiPickerOpen(false);
    }

    return () => {
      cancelled = true;
    };
  }, [isOpen, isLoading, settings, currentProject, isInitialized, projectId, loadRecipes]);

  const handleFinish = async () => {
    if (!settings || isSaving) return;

    const sanitizedRunCommands = runCommands
      .map((cmd) => ({ ...cmd, name: cmd.name.trim(), command: cmd.command.trim() }))
      .filter((cmd) => cmd.name && cmd.command);

    setIsSaving(true);
    setSaveError(null);
    try {
      if (currentProject) {
        await updateProject(projectId, {
          name: name.trim() || currentProject.name,
          emoji,
        });
      }

      await saveSettings({
        ...settings,
        runCommands: sanitizedRunCommands,
        devServerCommand: devServerCommand.trim() || undefined,
        defaultWorktreeRecipeId,
      });

      if (claudeMdContent.trim()) {
        await projectClient.writeClaudeMd(projectId, claudeMdContent);
      }

      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  };

  const globalRecipes = recipes.filter((r) => !r.worktreeId);

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="md" dismissible={!isSaving}>
      <AppDialog.Body>
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-canopy-text">Set up your project</h2>
          <p className="text-sm text-canopy-text/60 mt-1">
            Configure the essentials for your new project. You can change these anytime in settings.
          </p>
        </div>

        {!isInitialized && (
          <div className="text-sm text-canopy-text/60 text-center py-8">
            Loading project settings...
          </div>
        )}
        <div className={`space-y-6 ${!isInitialized ? "hidden" : ""}`}>
          {/* Identity */}
          <div className="pb-6 border-b border-canopy-border">
            <h3 className="text-sm font-semibold text-canopy-text/80 mb-3">Project Identity</h3>
            <div className="flex items-center gap-3 p-3 rounded-[var(--radius-md)] bg-canopy-bg border border-canopy-border">
              <Popover open={isEmojiPickerOpen} onOpenChange={setIsEmojiPickerOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="Change project emoji"
                    className="flex h-12 w-12 items-center justify-center rounded-[var(--radius-xl)] shrink-0 hover:opacity-80 transition-opacity cursor-pointer"
                    style={{
                      background: currentProject
                        ? getProjectGradient(currentProject.color)
                        : undefined,
                    }}
                  >
                    <span className="text-2xl select-none">{emoji}</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <EmojiPicker
                    onEmojiSelect={({ emoji: e }) => {
                      setEmoji(e);
                      setIsEmojiPickerOpen(false);
                    }}
                  />
                </PopoverContent>
              </Popover>

              <div className="flex-1 min-w-0">
                <label
                  htmlFor="onboarding-project-name"
                  className="text-xs font-medium text-canopy-text/60 mb-1 ml-1 block"
                >
                  Project Name
                </label>
                <input
                  id="onboarding-project-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-transparent border border-canopy-border rounded px-3 py-2 text-sm text-canopy-text focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30 transition-all placeholder:text-canopy-text/40"
                  placeholder="My Project"
                />
              </div>
            </div>
          </div>

          {/* Dev Server */}
          <div className="pb-6 border-b border-canopy-border">
            <h3 className="text-sm font-semibold text-canopy-text/80 mb-1 flex items-center gap-2">
              <Rocket className="h-4 w-4" />
              Dev Server
            </h3>
            <p className="text-xs text-canopy-text/60 mb-3">
              Command to start your development server (e.g.{" "}
              <code className="font-mono">npm run dev</code>).
            </p>
            <input
              type="text"
              value={devServerCommand}
              onChange={(e) => setDevServerCommand(e.target.value)}
              className="w-full bg-canopy-bg border border-canopy-border rounded px-3 py-2 text-sm text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30 transition-all placeholder:text-canopy-text/40"
              placeholder="npm run dev"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              aria-label="Dev server command"
            />
          </div>

          {/* Run Commands */}
          <div className="pb-6 border-b border-canopy-border">
            <h3 className="text-sm font-semibold text-canopy-text/80 mb-1 flex items-center gap-2">
              <Terminal className="h-4 w-4" />
              Run Commands
            </h3>
            <p className="text-xs text-canopy-text/60 mb-3">
              Quick-access commands for building, testing, and deploying.
            </p>
            <div className="space-y-2">
              {runCommands.map((cmd, index) => (
                <div
                  key={cmd.id}
                  className="p-3 rounded-[var(--radius-md)] bg-canopy-bg border border-canopy-border"
                >
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0 space-y-1">
                      <input
                        type="text"
                        value={cmd.name}
                        onChange={(e) => {
                          setRunCommands((prev) => {
                            const updated = [...prev];
                            updated[index] = { ...cmd, name: e.target.value };
                            return updated;
                          });
                        }}
                        className="w-full bg-transparent border border-canopy-border rounded px-2 py-1 text-sm text-canopy-text focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
                        placeholder="Command name"
                        aria-label="Run command name"
                      />
                      <input
                        type="text"
                        value={cmd.command}
                        onChange={(e) => {
                          setRunCommands((prev) => {
                            const updated = [...prev];
                            updated[index] = { ...cmd, command: e.target.value };
                            return updated;
                          });
                        }}
                        className="w-full bg-canopy-sidebar border border-canopy-border rounded px-2 py-1 text-xs text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
                        placeholder="npm run build"
                        aria-label="Run command"
                      />
                    </div>
                    <div className="flex flex-col gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          if (index > 0) {
                            setRunCommands((prev) => {
                              const updated = [...prev];
                              [updated[index - 1], updated[index]] = [
                                updated[index],
                                updated[index - 1],
                              ];
                              return updated;
                            });
                          }
                        }}
                        disabled={index === 0}
                        className="p-1 rounded hover:bg-canopy-border/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        aria-label="Move up"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (index < runCommands.length - 1) {
                            setRunCommands((prev) => {
                              const updated = [...prev];
                              [updated[index], updated[index + 1]] = [
                                updated[index + 1],
                                updated[index],
                              ];
                              return updated;
                            });
                          }
                        }}
                        disabled={index === runCommands.length - 1}
                        className="p-1 rounded hover:bg-canopy-border/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        aria-label="Move down"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setRunCommands((prev) => prev.filter((_, i) => i !== index))}
                        className="p-1 rounded hover:bg-red-900/30 transition-colors"
                        aria-label="Delete command"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-[var(--color-status-error)]" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              <Button
                variant="outline"
                onClick={() =>
                  setRunCommands((prev) => [
                    ...prev,
                    { id: `cmd-${Date.now()}`, name: "", command: "" },
                  ])
                }
                className="w-full"
              >
                <Plus className="h-4 w-4" />
                Add Command
              </Button>
            </div>
          </div>

          {/* AI Rules */}
          <div className="pb-6 border-b border-canopy-border">
            <h3 className="text-sm font-semibold text-canopy-text/80 mb-1 flex items-center gap-2">
              <FileCode className="h-4 w-4" />
              AI Rules (CLAUDE.md)
            </h3>
            <p className="text-xs text-canopy-text/60 mb-3">
              Instructions for AI agents working on this project. Written to{" "}
              <code className="font-mono">CLAUDE.md</code> in the project root.
            </p>
            <textarea
              value={claudeMdContent}
              onChange={(e) => setClaudeMdContent(e.target.value)}
              rows={6}
              className="w-full bg-canopy-bg border border-canopy-border rounded px-3 py-2 text-sm text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30 transition-all placeholder:text-canopy-text/40 resize-y"
              placeholder="# Project Guidelines&#10;&#10;Describe coding conventions, architecture decisions, and anything agents should know..."
              aria-label="CLAUDE.md content"
              spellCheck={false}
            />
          </div>

          {/* Default Recipe */}
          <div>
            <h3 className="text-sm font-semibold text-canopy-text/80 mb-1 flex items-center gap-2">
              <Play className="h-4 w-4" />
              Default Worktree Recipe
            </h3>
            <p className="text-xs text-canopy-text/60 mb-3">
              Automatically run a recipe when creating new worktrees.
            </p>
            {recipesLoading ? (
              <div className="text-sm text-canopy-text/60 text-center py-3 border border-dashed border-canopy-border rounded-[var(--radius-md)]">
                Loading recipes...
              </div>
            ) : globalRecipes.length === 0 ? (
              <div className="text-sm text-canopy-text/60 text-center py-3 border border-dashed border-canopy-border rounded-[var(--radius-md)]">
                No recipes yet — create them in Project Settings after setup.
              </div>
            ) : (
              <select
                value={defaultWorktreeRecipeId || ""}
                onChange={(e) => setDefaultWorktreeRecipeId(e.target.value || undefined)}
                className="w-full px-3 py-2 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] text-sm text-canopy-text focus:outline-none focus:ring-2 focus:ring-canopy-accent"
              >
                <option value="">No default recipe</option>
                {globalRecipes.map((recipe) => (
                  <option key={recipe.id} value={recipe.id}>
                    {recipe.name} ({recipe.terminals.length} terminal
                    {recipe.terminals.length !== 1 ? "s" : ""})
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </AppDialog.Body>

      {saveError && (
        <div
          className="shrink-0 px-6 py-3 border-t border-canopy-border text-sm text-[var(--color-status-error)] bg-red-900/20"
          role="alert"
        >
          {saveError}
        </div>
      )}

      <AppDialog.Footer>
        <Button variant="ghost" onClick={onClose} disabled={isSaving}>
          Skip
        </Button>
        <Button onClick={handleFinish} disabled={isSaving || isLoading}>
          {isSaving ? "Saving..." : "Finish"}
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
