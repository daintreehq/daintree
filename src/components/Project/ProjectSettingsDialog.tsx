import { useState, useEffect, useRef } from "react";
import {
  Terminal,
  Key,
  FolderX,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Eye,
  EyeOff,
  Image,
  Upload,
  X,
  BookOpen,
  Edit3,
  Download,
  FileDown,
  Play,
  AlertTriangle,
  Rocket,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { AppDialog } from "@/components/ui/AppDialog";
import { useProjectSettings } from "@/hooks";
import { useProjectStore } from "@/store/projectStore";
import { useRecipeStore } from "@/store/recipeStore";
import { useWorktrees } from "@/hooks/useWorktrees";
import type { RunCommand, TerminalRecipe } from "@/types";
import { getProjectGradient } from "@/lib/colorUtils";
import { cn } from "@/lib/utils";
import { validateProjectSvg, svgToDataUrl } from "@/lib/svg";
import { RecipeEditor } from "@/components/TerminalRecipe/RecipeEditor";
import { ConfirmDialog } from "@/components/Terminal/ConfirmDialog";
import { LiveTimeAgo } from "@/components/Worktree/LiveTimeAgo";

interface ProjectSettingsDialogProps {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
}

interface EnvVar {
  id: string;
  key: string;
  value: string;
}

const SENSITIVE_ENV_KEY_RE = /\b(key|secret|token|password)\b/i;

export function ProjectSettingsDialog({ projectId, isOpen, onClose }: ProjectSettingsDialogProps) {
  const { settings, saveSettings, isLoading, error } = useProjectSettings(projectId);
  const { projects, updateProject } = useProjectStore();
  const currentProject = projects.find((p) => p.id === projectId);

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [name, setName] = useState(currentProject?.name || "");
  const [emoji, setEmoji] = useState(currentProject?.emoji || "🌲");
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);

  const [runCommands, setRunCommands] = useState<RunCommand[]>([]);
  const [environmentVariables, setEnvironmentVariables] = useState<EnvVar[]>([]);
  const [excludedPaths, setExcludedPaths] = useState<string[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);
  const [visibleEnvVars, setVisibleEnvVars] = useState<Set<string>>(new Set());
  const [projectIconSvg, setProjectIconSvg] = useState<string | undefined>(undefined);
  const [iconError, setIconError] = useState<string | null>(null);
  const [isDraggingIcon, setIsDraggingIcon] = useState(false);
  const [defaultWorktreeRecipeId, setDefaultWorktreeRecipeId] = useState<string | undefined>(
    undefined
  );
  const [devServerCommand, setDevServerCommand] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    recipes,
    loadRecipes,
    deleteRecipe,
    exportRecipe,
    importRecipe,
    isLoading: recipesLoading,
  } = useRecipeStore();
  const { worktreeMap } = useWorktrees();
  const [isRecipeEditorOpen, setIsRecipeEditorOpen] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState<TerminalRecipe | undefined>(undefined);
  const [recipeToDelete, setRecipeToDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [importJson, setImportJson] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportFeedback, setExportFeedback] = useState<string | null>(null);
  const exportTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hasLoadedRecipes = useRef(false);

  const toggleEnvVarVisibility = (id: string) => {
    setVisibleEnvVars((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleIconFile = async (file: File) => {
    setIconError(null);
    if (!file.type.includes("svg")) {
      setIconError("Please select an SVG file");
      return;
    }
    try {
      const text = await file.text();
      const result = validateProjectSvg(text);
      if (!result.ok) {
        setIconError(result.error);
        return;
      }
      setProjectIconSvg(result.svg);
    } catch {
      setIconError("Failed to read file");
    }
  };

  const handleIconDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingIcon(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      void handleIconFile(file);
    }
  };

  const handleIconDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingIcon(true);
  };

  const handleIconDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingIcon(false);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void handleIconFile(file);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleRemoveIcon = () => {
    setProjectIconSvg(undefined);
    setIconError(null);
  };

  useEffect(() => {
    if (isOpen && settings && !isInitialized) {
      setRunCommands(settings.runCommands || []);
      const envVars = settings.environmentVariables || {};
      setEnvironmentVariables(
        Object.entries(envVars).map(([key, value]) => ({
          id: `env-${Date.now()}-${Math.random()}`,
          key,
          value,
        }))
      );
      setExcludedPaths(settings.excludedPaths || []);
      setProjectIconSvg(settings.projectIconSvg);
      setDefaultWorktreeRecipeId(settings.defaultWorktreeRecipeId);
      setDevServerCommand(settings.devServerCommand || "");
      setIsInitialized(true);
    }
    if (!isOpen) {
      setIsInitialized(false);
      setVisibleEnvVars(new Set());
      setEnvironmentVariables([]);
      setProjectIconSvg(undefined);
      setIconError(null);
      setDefaultWorktreeRecipeId(undefined);
      setDevServerCommand("");
      setSaveError(null);
      hasLoadedRecipes.current = false;
    }
  }, [settings, isOpen, isInitialized]);

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
    if (isOpen && !hasLoadedRecipes.current && !recipesLoading) {
      hasLoadedRecipes.current = true;
      loadRecipes().catch((err) => {
        console.error("Failed to load recipes:", err);
      });
    }
  }, [isOpen, recipesLoading, loadRecipes]);

  useEffect(() => {
    return () => {
      if (exportTimeoutRef.current) {
        clearTimeout(exportTimeoutRef.current);
      }
    };
  }, []);

  const handleSave = async () => {
    if (!settings) return;

    const sanitizedRunCommands = runCommands
      .map((cmd) => ({
        ...cmd,
        name: cmd.name.trim(),
        command: cmd.command.trim(),
      }))
      .filter((cmd) => cmd.name && cmd.command);

    const envVarRecord: Record<string, string> = {};
    const seenKeys = new Set<string>();
    for (const envVar of environmentVariables) {
      const trimmedKey = envVar.key.trim();
      if (!trimmedKey) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedKey)) {
        setSaveError(
          `Invalid environment variable key: "${trimmedKey}". Use only letters, numbers, and underscores.`
        );
        return;
      }
      if (seenKeys.has(trimmedKey)) {
        setSaveError(`Duplicate environment variable key: "${trimmedKey}"`);
        return;
      }
      seenKeys.add(trimmedKey);
      envVarRecord[trimmedKey] = envVar.value;
    }

    const sanitizedPaths = excludedPaths.map((p) => p.trim()).filter(Boolean);

    setIsSaving(true);
    setSaveError(null);
    try {
      if (currentProject) {
        await updateProject(projectId, {
          name: name.trim() || currentProject.name,
          emoji: emoji,
        });
      }

      await saveSettings({
        ...settings,
        runCommands: sanitizedRunCommands,
        environmentVariables: Object.keys(envVarRecord).length > 0 ? envVarRecord : undefined,
        excludedPaths: sanitizedPaths.length > 0 ? sanitizedPaths : undefined,
        projectIconSvg: projectIconSvg,
        defaultWorktreeRecipeId: defaultWorktreeRecipeId,
        devServerCommand: devServerCommand.trim() || undefined,
      });
      onClose();
    } catch (error) {
      console.error("Failed to save settings:", error);
      setSaveError(error instanceof Error ? error.message : "Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  };

  const handleEditRecipe = (recipe: TerminalRecipe) => {
    setEditingRecipe(recipe);
    setIsRecipeEditorOpen(true);
  };

  const handleAddRecipe = () => {
    setEditingRecipe(undefined);
    setIsRecipeEditorOpen(true);
  };

  const handleRecipeEditorClose = () => {
    setIsRecipeEditorOpen(false);
    setEditingRecipe(undefined);
  };

  const handleDeleteRecipe = async (recipeId: string) => {
    setDeleteError(null);
    try {
      await deleteRecipe(recipeId);
      if (recipeId === defaultWorktreeRecipeId) {
        setDefaultWorktreeRecipeId(undefined);
      }
      setRecipeToDelete(null);
    } catch (err) {
      console.error("Failed to delete recipe:", err);
      setDeleteError(err instanceof Error ? err.message : "Failed to delete recipe");
    }
  };

  const handleExportRecipe = async (recipeId: string) => {
    setExportError(null);
    const json = exportRecipe(recipeId);
    if (json) {
      try {
        await navigator.clipboard.writeText(json);
        setExportFeedback(recipeId);
        setExportError(null);
        if (exportTimeoutRef.current) {
          clearTimeout(exportTimeoutRef.current);
        }
        exportTimeoutRef.current = setTimeout(() => {
          setExportFeedback(null);
          exportTimeoutRef.current = null;
        }, 2000);
      } catch (err) {
        console.error("Failed to copy to clipboard:", err);
        setExportError(err instanceof Error ? err.message : "Failed to copy to clipboard");
      }
    }
  };

  const handleImportRecipe = async () => {
    setImportError(null);
    try {
      await importRecipe(importJson);
      setShowImportDialog(false);
      setImportJson("");
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to import recipe");
    }
  };

  const getRecipeScope = (recipe: TerminalRecipe): string => {
    if (!recipe.worktreeId) return "Global";
    const worktree = worktreeMap.get(recipe.worktreeId);
    if (worktree) {
      return `Worktree: ${worktree.branch || worktree.name}`;
    }
    return `Worktree: ${recipe.worktreeId}`;
  };

  return (
    <>
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
                  <h3 className="text-sm font-semibold text-canopy-text/80 mb-2">
                    Project Identity
                  </h3>
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

              <div className="mb-6 pb-6 border-b border-canopy-border">
                <h3 className="text-sm font-semibold text-canopy-text/80 mb-2 flex items-center gap-2">
                  <Rocket className="h-4 w-4" />
                  Dev Server Command
                </h3>
                <p className="text-xs text-canopy-text/60 mb-4">
                  Command to start the development server (e.g., npm run dev). When configured, a
                  button will appear in the toolbar to start the dev server.
                </p>

                <input
                  id="dev-server-command"
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

              <div className="mb-6 pb-6 border-b border-canopy-border">
                <h3 className="text-sm font-semibold text-canopy-text/80 mb-2 flex items-center gap-2">
                  <Image className="h-4 w-4" />
                  Project Icon (SVG)
                </h3>
                <p className="text-xs text-canopy-text/60 mb-4">
                  Shown in the grid empty state. SVG only, max 250KB.
                </p>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/svg+xml,.svg"
                  onChange={handleFileSelect}
                  className="hidden"
                  aria-label="Select SVG file"
                />

                {projectIconSvg ? (
                  <div className="flex items-center gap-4 p-3 rounded-[var(--radius-md)] bg-canopy-bg border border-canopy-border">
                    <div className="h-16 w-16 rounded-[var(--radius-md)] bg-canopy-sidebar flex items-center justify-center overflow-hidden">
                      <img
                        src={svgToDataUrl(projectIconSvg)}
                        alt="Project icon preview"
                        className="max-h-14 max-w-14 object-contain"
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-canopy-text mb-1">Custom icon configured</p>
                      <p className="text-xs text-canopy-text/60">
                        {Math.round(new Blob([projectIconSvg]).size / 1024)}KB
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <Upload className="h-4 w-4 mr-1" />
                        Replace
                      </Button>
                      <Button variant="ghost" size="sm" onClick={handleRemoveIcon}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div
                    className={cn(
                      "flex flex-col items-center justify-center p-8 rounded-[var(--radius-md)] border-2 border-dashed transition-colors cursor-pointer",
                      isDraggingIcon
                        ? "border-canopy-accent bg-canopy-accent/10"
                        : "border-canopy-border hover:border-canopy-border/80 hover:bg-canopy-bg/50"
                    )}
                    onDrop={handleIconDrop}
                    onDragOver={handleIconDragOver}
                    onDragLeave={handleIconDragLeave}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="h-8 w-8 text-canopy-text/40 mb-3" />
                    <p className="text-sm text-canopy-text/60 text-center mb-1">
                      Drag and drop an SVG file here
                    </p>
                    <p className="text-xs text-canopy-text/40">or click to browse</p>
                  </div>
                )}

                {iconError && (
                  <div className="mt-2 text-xs text-[var(--color-status-error)] bg-red-900/20 border border-red-900/30 rounded p-2">
                    {iconError}
                  </div>
                )}
              </div>

              <div className="mb-6">
                <h3 className="text-sm font-semibold text-canopy-text/80 mb-2 flex items-center gap-2">
                  <Terminal className="h-4 w-4" />
                  Run Commands
                </h3>
                <p className="text-xs text-canopy-text/60 mb-4">
                  Quick access to common project tasks (build, test, deploy).
                </p>

                <div className="space-y-3">
                  {runCommands.length === 0 ? (
                    <div className="text-sm text-canopy-text/60 text-center py-8 border border-dashed border-canopy-border rounded-[var(--radius-md)]">
                      No run commands configured yet
                    </div>
                  ) : (
                    runCommands.map((cmd, index) => (
                      <div
                        key={cmd.id}
                        className="p-3 rounded-[var(--radius-md)] bg-canopy-bg border border-canopy-border"
                      >
                        <div className="flex items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
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
                                className="flex-1 bg-transparent border border-canopy-border rounded px-2 py-1 text-sm text-canopy-text focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
                                placeholder="Command name"
                                aria-label="Run command name"
                              />
                              {cmd.icon && <span className="text-lg">{cmd.icon}</span>}
                            </div>
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
                            {cmd.description && (
                              <p className="text-xs text-canopy-text/60 mt-1">{cmd.description}</p>
                            )}
                          </div>
                          <div className="flex flex-col gap-1">
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
                              aria-label="Move run command up"
                            >
                              <ChevronUp className="h-4 w-4" />
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
                              aria-label="Move run command down"
                            >
                              <ChevronDown className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setRunCommands((prev) => prev.filter((_, i) => i !== index));
                              }}
                              className="p-1 rounded hover:bg-red-900/30 transition-colors"
                              aria-label="Delete run command"
                            >
                              <Trash2 className="h-4 w-4 text-[var(--color-status-error)]" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                  <Button
                    variant="outline"
                    onClick={() => {
                      setRunCommands((prev) => [
                        ...prev,
                        {
                          id: `cmd-${Date.now()}`,
                          name: "",
                          command: "",
                        },
                      ]);
                    }}
                    className="w-full"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Command
                  </Button>
                </div>
              </div>

              <div className="mb-6">
                <h3 className="text-sm font-semibold text-canopy-text/80 mb-2 flex items-center gap-2">
                  <Key className="h-4 w-4" />
                  Environment Variables
                </h3>
                <p className="text-xs text-canopy-text/60 mb-4">
                  Project-specific environment variables. Variable names containing KEY, SECRET,
                  TOKEN, or PASSWORD will have their values masked.
                </p>

                <div className="space-y-2">
                  {environmentVariables.length === 0 ? (
                    <div className="text-sm text-canopy-text/60 text-center py-8 border border-dashed border-canopy-border rounded-[var(--radius-md)]">
                      No environment variables configured yet
                    </div>
                  ) : (
                    environmentVariables.map((envVar, index) => {
                      const isSensitive = SENSITIVE_ENV_KEY_RE.test(envVar.key);
                      const isVisible = visibleEnvVars.has(envVar.id);
                      const shouldMask = isSensitive && !isVisible;
                      return (
                        <div
                          key={envVar.id}
                          className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-canopy-bg border border-canopy-border"
                        >
                          <input
                            type="text"
                            value={envVar.key}
                            onChange={(e) => {
                              const nextKey = e.target.value;
                              const wasSensitive = SENSITIVE_ENV_KEY_RE.test(envVar.key);
                              const nowSensitive = SENSITIVE_ENV_KEY_RE.test(nextKey);
                              setEnvironmentVariables((prev) => {
                                const updated = [...prev];
                                updated[index] = { ...envVar, key: nextKey };
                                return updated;
                              });
                              if (!wasSensitive && nowSensitive) {
                                setVisibleEnvVars((prev) => {
                                  const next = new Set(prev);
                                  next.delete(envVar.id);
                                  return next;
                                });
                              }
                            }}
                            spellCheck={false}
                            autoCapitalize="none"
                            className="flex-1 bg-transparent border border-canopy-border rounded px-2 py-1 text-sm text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
                            placeholder="VARIABLE_NAME"
                            aria-label="Environment variable name"
                          />
                          <span className="text-canopy-text/60">=</span>
                          <div className="flex-1 relative">
                            <input
                              type={shouldMask ? "password" : "text"}
                              value={envVar.value}
                              onChange={(e) => {
                                setEnvironmentVariables((prev) => {
                                  const updated = [...prev];
                                  updated[index] = { ...envVar, value: e.target.value };
                                  return updated;
                                });
                              }}
                              spellCheck={false}
                              autoCapitalize="none"
                              autoComplete={isSensitive ? "new-password" : "off"}
                              className={cn(
                                "w-full bg-canopy-sidebar border border-canopy-border rounded px-2 py-1 text-sm text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30",
                                isSensitive && "pr-8"
                              )}
                              placeholder="value"
                              aria-label="Environment variable value"
                            />
                            {isSensitive && (
                              <button
                                type="button"
                                onClick={() => toggleEnvVarVisibility(envVar.id)}
                                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-canopy-border/50 transition-colors"
                                aria-pressed={isVisible}
                                aria-label={`${isVisible ? "Hide" : "Show"} value${envVar.key ? ` for ${envVar.key}` : ""}`}
                              >
                                {isVisible ? (
                                  <EyeOff className="h-4 w-4 text-canopy-text/60" />
                                ) : (
                                  <Eye className="h-4 w-4 text-canopy-text/60" />
                                )}
                              </button>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setEnvironmentVariables((prev) => prev.filter((_, i) => i !== index));
                              setVisibleEnvVars((prev) => {
                                const next = new Set(prev);
                                next.delete(envVar.id);
                                return next;
                              });
                            }}
                            className="p-1 rounded hover:bg-red-900/30 transition-colors"
                            aria-label="Delete environment variable"
                          >
                            <Trash2 className="h-4 w-4 text-[var(--color-status-error)]" />
                          </button>
                        </div>
                      );
                    })
                  )}
                  <Button
                    variant="outline"
                    onClick={() => {
                      setEnvironmentVariables((prev) => [
                        ...prev,
                        {
                          id: `env-${Date.now()}-${Math.random()}`,
                          key: "",
                          value: "",
                        },
                      ]);
                    }}
                    className="w-full"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Variable
                  </Button>
                </div>
              </div>

              <div className="mb-6">
                <h3 className="text-sm font-semibold text-canopy-text/80 mb-2 flex items-center gap-2">
                  <FolderX className="h-4 w-4" />
                  Excluded Paths
                </h3>
                <p className="text-xs text-canopy-text/60 mb-4">
                  Glob patterns to exclude from monitoring and context injection (e.g.,
                  node_modules/**, dist/**, .git/**).
                </p>

                <div className="space-y-2">
                  {excludedPaths.length === 0 ? (
                    <div className="text-sm text-canopy-text/60 text-center py-8 border border-dashed border-canopy-border rounded-[var(--radius-md)]">
                      No excluded paths configured yet
                    </div>
                  ) : (
                    excludedPaths.map((path, index) => (
                      <div
                        key={index}
                        className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-canopy-bg border border-canopy-border"
                      >
                        <input
                          type="text"
                          value={path}
                          onChange={(e) => {
                            setExcludedPaths((prev) => {
                              const updated = [...prev];
                              updated[index] = e.target.value;
                              return updated;
                            });
                          }}
                          className="flex-1 bg-transparent border border-canopy-border rounded px-2 py-1 text-sm text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
                          placeholder="node_modules/**"
                          aria-label="Excluded path glob pattern"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            setExcludedPaths((prev) => prev.filter((_, i) => i !== index));
                          }}
                          className="p-1 rounded hover:bg-red-900/30 transition-colors"
                          aria-label="Delete excluded path"
                        >
                          <Trash2 className="h-4 w-4 text-[var(--color-status-error)]" />
                        </button>
                      </div>
                    ))
                  )}
                  <Button
                    variant="outline"
                    onClick={() => {
                      setExcludedPaths((prev) => [...prev, ""]);
                    }}
                    className="w-full"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Path Pattern
                  </Button>
                </div>
              </div>

              <div className="mb-6 pb-6 border-b border-canopy-border">
                <h3 className="text-sm font-semibold text-canopy-text/80 mb-2 flex items-center gap-2">
                  <Play className="h-4 w-4" />
                  Default Worktree Recipe
                </h3>
                <p className="text-xs text-canopy-text/60 mb-4">
                  Automatically run a recipe when creating new worktrees.
                </p>

                {(() => {
                  const globalRecipes = recipes.filter((r) => !r.worktreeId);
                  const selectedRecipe = globalRecipes.find(
                    (r) => r.id === defaultWorktreeRecipeId
                  );
                  const recipeNotFound =
                    defaultWorktreeRecipeId && !selectedRecipe && !recipesLoading;

                  return (
                    <div className="space-y-3">
                      {globalRecipes.length === 0 ? (
                        <div className="text-sm text-canopy-text/60 text-center py-4 border border-dashed border-canopy-border rounded-[var(--radius-md)]">
                          No global recipes available. Create a recipe first.
                        </div>
                      ) : (
                        <>
                          <select
                            value={defaultWorktreeRecipeId || ""}
                            onChange={(e) =>
                              setDefaultWorktreeRecipeId(e.target.value || undefined)
                            }
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

                          {selectedRecipe && (
                            <div className="p-3 rounded-[var(--radius-md)] bg-canopy-bg/50 border border-canopy-border">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-sm font-medium text-canopy-text">
                                  {selectedRecipe.name}
                                </span>
                                <span className="text-xs text-canopy-text/60 bg-canopy-sidebar px-2 py-0.5 rounded">
                                  {selectedRecipe.terminals.length} terminal
                                  {selectedRecipe.terminals.length !== 1 ? "s" : ""}
                                </span>
                              </div>
                              <p className="text-xs text-canopy-text/60">
                                Will run automatically when creating new worktrees
                              </p>
                            </div>
                          )}

                          {recipeNotFound && (
                            <div className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] bg-yellow-500/10 border border-yellow-500/20">
                              <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
                              <div>
                                <p className="text-sm text-yellow-500">
                                  Selected recipe no longer exists
                                </p>
                                <p className="text-xs text-canopy-text/60 mt-1">
                                  The previously selected recipe was deleted. Please select a new
                                  default or clear the selection.
                                </p>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })()}
              </div>

              <div className="mb-6">
                <h3 className="text-sm font-semibold text-canopy-text/80 mb-2 flex items-center gap-2">
                  <BookOpen className="h-4 w-4" />
                  Terminal Recipes
                </h3>
                <p className="text-xs text-canopy-text/60 mb-4">
                  Manage saved terminal configurations. Recipes can spawn multiple terminals with
                  predefined commands and settings.
                </p>

                <div className="space-y-3">
                  {recipes.length === 0 ? (
                    <div className="text-sm text-canopy-text/60 text-center py-8 border border-dashed border-canopy-border rounded-[var(--radius-md)]">
                      No recipes configured yet
                    </div>
                  ) : (
                    recipes.map((recipe) => (
                      <div
                        key={recipe.id}
                        className="p-3 rounded-[var(--radius-md)] bg-canopy-bg border border-canopy-border"
                      >
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <h4 className="text-sm font-medium text-canopy-text truncate">
                                {recipe.name}
                              </h4>
                              <span className="text-xs text-canopy-text/60 bg-canopy-sidebar px-2 py-0.5 rounded shrink-0">
                                {getRecipeScope(recipe)}
                              </span>
                              {recipe.showInEmptyState && (
                                <span className="text-xs text-canopy-accent bg-canopy-accent/10 px-2 py-0.5 rounded shrink-0">
                                  Empty State
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 text-xs text-canopy-text/60">
                              <span>
                                {recipe.terminals.length} terminal
                                {recipe.terminals.length !== 1 ? "s" : ""}
                              </span>
                              {recipe.lastUsedAt && (
                                <>
                                  <span>•</span>
                                  <span>
                                    Last used <LiveTimeAgo timestamp={recipe.lastUsedAt} />
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleEditRecipe(recipe)}
                          >
                            <Edit3 className="h-3 w-3 mr-1" />
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleExportRecipe(recipe.id)}
                          >
                            <Download className="h-3 w-3 mr-1" />
                            {exportFeedback === recipe.id ? "Copied!" : "Export"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRecipeToDelete(recipe.id)}
                          >
                            <Trash2 className="h-3 w-3 text-[var(--color-status-error)]" />
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                  {exportError && (
                    <div className="text-sm text-[var(--color-status-error)] bg-red-900/20 border border-red-900/30 rounded p-3">
                      {exportError}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={handleAddRecipe} className="flex-1">
                      <Plus className="h-4 w-4 mr-2" />
                      Add Recipe
                    </Button>
                    <Button variant="outline" onClick={() => setShowImportDialog(true)}>
                      <FileDown className="h-4 w-4 mr-2" />
                      Import Recipe
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}
        </AppDialog.Body>

        <AppDialog.Footer>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving || isLoading || !!error}>
            {isSaving ? "Saving..." : "Save Changes"}
          </Button>
        </AppDialog.Footer>
      </AppDialog>

      <RecipeEditor
        recipe={editingRecipe}
        worktreeId={undefined}
        isOpen={isRecipeEditorOpen}
        onClose={handleRecipeEditorClose}
      />

      <ConfirmDialog
        isOpen={recipeToDelete !== null}
        title="Delete Recipe"
        description={
          deleteError
            ? `Error: ${deleteError}`
            : "Are you sure you want to delete this recipe? This action cannot be undone."
        }
        confirmLabel={deleteError ? "Retry" : "Delete"}
        onConfirm={() => {
          if (recipeToDelete) {
            void handleDeleteRecipe(recipeToDelete);
          }
        }}
        onCancel={() => {
          setRecipeToDelete(null);
          setDeleteError(null);
        }}
      />

      <AppDialog
        isOpen={showImportDialog}
        onClose={() => {
          setShowImportDialog(false);
          setImportJson("");
          setImportError(null);
        }}
        size="md"
      >
        <AppDialog.Header>
          <AppDialog.Title>Import Recipe</AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>

        <AppDialog.Body>
          <p className="text-sm text-canopy-text/60 mb-4">
            Paste the JSON configuration for the recipe you want to import.
          </p>
          <textarea
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            placeholder='{"name": "My Recipe", "terminals": [...]}'
            className="w-full h-64 px-3 py-2 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] text-sm text-canopy-text font-mono focus:outline-none focus:ring-2 focus:ring-canopy-accent resize-none"
            spellCheck={false}
          />
          {importError && (
            <div className="mt-3 text-sm text-[var(--color-status-error)] bg-red-900/20 border border-red-900/30 rounded p-3">
              {importError}
            </div>
          )}
        </AppDialog.Body>

        <AppDialog.Footer>
          <Button
            variant="ghost"
            onClick={() => {
              setShowImportDialog(false);
              setImportJson("");
              setImportError(null);
            }}
          >
            Cancel
          </Button>
          <Button onClick={handleImportRecipe} disabled={!importJson.trim()}>
            Import
          </Button>
        </AppDialog.Footer>
      </AppDialog>
    </>
  );
}
