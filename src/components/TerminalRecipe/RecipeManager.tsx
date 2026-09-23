import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  Globe,
  FolderOpen,
  FolderGit2,
  Plus,
  Trash2,
  Pencil,
  FileDown,
  FileUp,
  Check,
  Copy,
  Lock,
  GitBranch,
  MoreHorizontal,
  Pin,
  Search,
} from "lucide-react";
import { Plug, Workflow } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/EmptyState";
import { AppDialog } from "@/components/ui/AppDialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRecipeStore } from "@/store/recipeStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeStoreOptional } from "@/hooks/useWorktreeStore";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import { LiveTimeAgo } from "@/components/Worktree/LiveTimeAgo";
import {
  FIELD_FOCUS,
  FIELD_INPUT,
  FIELD_SURFACE,
  FormGrid,
  FormRow,
} from "@/components/Worktree/views";
import { getRecipeTerminalSummary } from "@/components/Terminal/utils/recipeUtils";
import { getRecipeScope, worktreeDisplayName } from "@/utils/recipeScope";
import { cn } from "@/lib/utils";
import type { TerminalRecipe } from "@/types";
import { isInRepoRecipeId } from "@shared/utils/recipeFilename";
import { isPluginRecipe } from "@shared/types/project";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";

const EMPTY_WORKTREES = new Map<string, WorktreeSnapshot>();

interface RecipeManagerProps {
  isOpen: boolean;
  onClose: () => void;
  onEditRecipe: (recipe: TerminalRecipe) => void;
  onCreateRecipe: (scope: "global" | "project") => void;
}

export function RecipeManager({
  isOpen,
  onClose,
  onEditRecipe,
  onCreateRecipe,
}: RecipeManagerProps) {
  const globalRecipes = useRecipeStore((s) => s.globalRecipes);
  const projectRecipes = useRecipeStore((s) => s.projectRecipes);
  const inRepoRecipes = useRecipeStore((s) => s.inRepoRecipes);
  const pluginRecipes = useRecipeStore((s) => s.pluginRecipes);

  // Derive which project recipes are shadowed by in-repo recipes
  const inRepoNames = useMemo(() => new Set(inRepoRecipes.map((r) => r.name)), [inRepoRecipes]);
  const saveToRepo = useRecipeStore((s) => s.saveToRepo);
  const exportRecipe = useRecipeStore((s) => s.exportRecipe);
  const exportRecipeToFile = useRecipeStore((s) => s.exportRecipeToFile);
  const importRecipe = useRecipeStore((s) => s.importRecipe);
  const importRecipeFromFile = useRecipeStore((s) => s.importRecipeFromFile);
  const updateRecipe = useRecipeStore((s) => s.updateRecipe);
  const currentProject = useProjectStore((s) => s.currentProject);
  const worktrees = useWorktreeStoreOptional((s) => s.worktrees, EMPTY_WORKTREES);
  const [filter, setFilter] = useState("");

  const nameOf = (id: string | null) =>
    (id &&
      [...globalRecipes, ...projectRecipes, ...inRepoRecipes, ...pluginRecipes].find(
        (r) => r.id === id
      )?.name) ??
    "recipe";

  const [recipeToDelete, setRecipeToDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [recipeToSave, setRecipeToSave] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [recipeToDeleteAfterSave, setRecipeToDeleteAfterSave] = useState<string | null>(null);
  const [exportFeedback, setExportFeedback] = useState<string | null>(null);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importScope, setImportScope] = useState<"global" | "project">("project");
  const [importJson, setImportJson] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const exportTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (exportTimeoutRef.current) {
        clearTimeout(exportTimeoutRef.current);
      }
    };
  }, []);

  const handleDeleteRecipe = async (recipeId: string) => {
    setDeleteError(null);
    const result = await actionService.dispatch(
      "recipe.delete",
      { recipeId },
      { source: "user", confirmed: true }
    );
    if (result.ok) {
      setRecipeToDelete(null);
    } else {
      logError("Failed to delete recipe", result.error);
      setDeleteError(formatErrorMessage(result.error, "Failed to delete recipe"));
    }
  };

  const handleExportRecipe = useCallback(
    async (recipeId: string) => {
      const json = exportRecipe(recipeId);
      if (json) {
        try {
          await navigator.clipboard.writeText(json);
          setExportFeedback(recipeId);
          if (exportTimeoutRef.current) clearTimeout(exportTimeoutRef.current);
          exportTimeoutRef.current = setTimeout(() => {
            setExportFeedback(null);
            exportTimeoutRef.current = null;
          }, 2000);
        } catch (err) {
          logError("Failed to copy to clipboard", err);
        }
      }
    },
    [exportRecipe]
  );

  const handleSaveToRepo = async () => {
    if (!recipeToSave) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await saveToRepo(recipeToSave, false);
      const savedId = recipeToSave;
      setRecipeToSave(null);
      // A plugin recipe cannot be deleted — the plugin still owns the original —
      // so there is no "delete the original?" follow-up to offer.
      const saved = pluginRecipes.find((r) => r.id === savedId);
      if (!saved) setRecipeToDeleteAfterSave(savedId);
    } catch (err) {
      setSaveError(formatErrorMessage(err, "Failed to save recipe to repo"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteAfterSave = async () => {
    if (!recipeToDeleteAfterSave) return;
    const result = await actionService.dispatch(
      "recipe.delete",
      { recipeId: recipeToDeleteAfterSave },
      { source: "user", confirmed: true }
    );
    if (!result.ok) {
      logError("Failed to delete original recipe", result.error);
    }
    setRecipeToDeleteAfterSave(null);
  };

  const handleImportRecipe = async () => {
    setImportError(null);
    const targetProjectId = importScope === "global" ? undefined : currentProject?.id;
    if (importScope === "project" && !targetProjectId) {
      setImportError("No project selected");
      return;
    }
    try {
      await importRecipe(targetProjectId, importJson);
      setShowImportDialog(false);
      setImportJson("");
    } catch (err) {
      setImportError(formatErrorMessage(err, "Failed to import recipe"));
    }
  };

  const resolveWorktreeName = (worktreeId: string) =>
    worktreeDisplayName(worktrees.get(worktreeId));

  const query = filter.trim().toLowerCase();
  const matches = (r: TerminalRecipe) => !query || r.name.toLowerCase().includes(query);
  const totalCount =
    globalRecipes.length + pluginRecipes.length + inRepoRecipes.length + projectRecipes.length;
  const isFiltering = query.length > 0;

  const renderRecipeRow = (recipe: TerminalRecipe) => {
    // A plugin owns its recipes' content — editing or deleting one here would
    // be undone on the plugin's next load, so the row offers neither (#11860).
    // "Save as team recipe" stays available: duplicating into a user-owned
    // tier is the sanctioned way to customise one.
    const fromPlugin = isPluginRecipe(recipe);
    const isShadowed = !fromPlugin && !isInRepoRecipeId(recipe) && inRepoNames.has(recipe.name);
    const exported = exportFeedback === recipe.id;
    const isPinned = recipe.showInEmptyState === true;
    const summary = getRecipeTerminalSummary(recipe.terminals);
    const worktreeLabel = recipe.worktreeId
      ? getRecipeScope(recipe, resolveWorktreeName).label
      : null;
    return (
      <div
        key={recipe.id}
        data-recipe-row={recipe.name}
        className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-overlay-subtle"
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-text-primary">{recipe.name}</span>
            {isPinned && (
              <Badge>
                <Pin aria-hidden />
                Pinned
              </Badge>
            )}
            {fromPlugin && (
              <Badge>
                <Lock aria-hidden />
                Read-only
              </Badge>
            )}
            {isShadowed && <Badge>Overridden by team recipe</Badge>}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-text-secondary">
            {fromPlugin && (
              <>
                <span className="shrink-0">From {recipe.origin.pluginId}</span>
                <span aria-hidden>·</span>
              </>
            )}
            {worktreeLabel && (
              <>
                <span className="shrink-0">{worktreeLabel}</span>
                <span aria-hidden>·</span>
              </>
            )}
            <span className="min-w-0 truncate">
              {recipe.terminals.length} terminal{recipe.terminals.length !== 1 ? "s" : ""}
              {summary && summary !== recipe.name ? `: ${summary}` : ""}
            </span>
            <span aria-hidden>·</span>
            <span className="shrink-0">
              {recipe.lastUsedAt ? (
                <>
                  Last used <LiveTimeAgo timestamp={recipe.lastUsedAt} />
                </>
              ) : (
                "Never used"
              )}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {!fromPlugin && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onEditRecipe(recipe)}
                  className="h-7 w-7 text-text-secondary hover:text-text-primary"
                  aria-label={`Edit recipe ${recipe.name}`}
                >
                  <Pencil />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Edit recipe</TooltipContent>
            </Tooltip>
          )}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-text-secondary hover:text-text-primary data-[state=open]:bg-overlay-raised"
                    aria-label={
                      exported
                        ? `Recipe ${recipe.name} exported to clipboard`
                        : `More actions for recipe ${recipe.name}`
                    }
                  >
                    {exported ? <Check /> : <MoreHorizontal />}
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">{exported ? "Copied" : "More actions"}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" sideOffset={4} className="min-w-[200px]">
              <DropdownMenuItem
                onSelect={() =>
                  void updateRecipe(recipe.id, { showInEmptyState: !isPinned }).catch((err) =>
                    logError("Failed to update recipe pin", err)
                  )
                }
              >
                <Pin className="mr-2 h-3.5 w-3.5" />
                {isPinned ? "Unpin from canvas" : "Pin to canvas"}
              </DropdownMenuItem>
              {!isInRepoRecipeId(recipe) && currentProject && (
                <DropdownMenuItem onSelect={() => setRecipeToSave(recipe.id)}>
                  <FolderGit2 className="mr-2 h-3.5 w-3.5" />
                  Save as team recipe…
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void handleExportRecipe(recipe.id)}>
                <Copy className="mr-2 h-3.5 w-3.5" />
                Copy as JSON
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportRecipeToFile(recipe.id)}>
                <FileUp className="mr-2 h-3.5 w-3.5" />
                Export to file…
              </DropdownMenuItem>
              {!fromPlugin && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={() => setRecipeToDelete(recipe.id)}>
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    Delete recipe…
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  };

  const renderSection = ({
    id,
    icon: Icon,
    title,
    description,
    recipes,
    emptyLine,
    onNew,
    newLabel,
    trailing,
  }: {
    id: string;
    icon: typeof Globe;
    title: string;
    description: string;
    recipes: TerminalRecipe[];
    emptyLine?: string;
    onNew?: () => void;
    newLabel?: string;
    trailing?: React.ReactNode;
  }) => {
    const visible = recipes.filter(matches);
    // Plugin and team sources only exist once something is in them; the two
    // user-owned sources always show, so "where would a new one go" has an answer.
    if (visible.length === 0 && (isFiltering || !emptyLine)) return null;
    return (
      <section key={id} aria-labelledby={`recipe-section-${id}`} className="mb-5 last:mb-0">
        <div className="mb-2 flex items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden />
          <div className="min-w-0 flex-1">
            <h3
              id={`recipe-section-${id}`}
              className="flex items-baseline gap-2 text-sm font-semibold text-text-primary"
            >
              {title}
              {trailing}
            </h3>
            <p className="text-xs text-text-secondary">{description}</p>
          </div>
          {onNew && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onNew}
              aria-label={newLabel}
              className="shrink-0"
            >
              <Plus />
              New
            </Button>
          )}
        </div>
        {visible.length > 0 ? (
          <div className="divide-y divide-border-default rounded-[var(--radius-md)] border border-border-default">
            {visible.map(renderRecipeRow)}
          </div>
        ) : (
          <p className="rounded-[var(--radius-md)] border border-dashed border-border-default px-3 py-2.5 text-xs text-text-secondary">
            {emptyLine}
          </p>
        )}
      </section>
    );
  };

  const sections = [
    renderSection({
      id: "global",
      icon: Globe,
      title: "Global recipes",
      description: "Yours, in every project",
      recipes: globalRecipes,
      emptyLine: "None yet. A global recipe launches the same terminals in any project.",
      onNew: () => onCreateRecipe("global"),
      newLabel: "New global recipe",
    }),
    renderSection({
      id: "project",
      icon: FolderOpen,
      title: "Project recipes",
      description: "Yours, in this project only, until you save one as a team recipe",
      recipes: projectRecipes,
      emptyLine: "None yet for this project.",
      onNew: () => onCreateRecipe("project"),
      newLabel: "New project recipe",
      trailing: currentProject && (
        <span className="truncate text-xs font-normal text-text-secondary">
          {currentProject.emoji} {currentProject.name}
        </span>
      ),
    }),
    renderSection({
      id: "team",
      icon: GitBranch,
      title: "Team recipes",
      description: "Committed to .daintree/recipes/ and shared with everyone on the repo",
      recipes: inRepoRecipes,
    }),
    renderSection({
      id: "plugin",
      icon: Plug,
      title: "Plugin recipes",
      description: "Provided by installed plugins, in every project",
      recipes: pluginRecipes,
    }),
  ];
  const hasVisibleSection = sections.some((section) => section !== null);

  return (
    <>
      <AppDialog isOpen={isOpen} onClose={onClose} size="lg">
        <AppDialog.Header>
          <AppDialog.Title>
            <span className="flex items-center gap-2">
              <Workflow className="h-5 w-5" />
              Recipe manager
            </span>
          </AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>

        <AppDialog.Body>
          {totalCount === 0 ? (
            <EmptyState
              variant="zero-data"
              scale="canvas"
              icon={<Workflow />}
              title="No recipes yet"
              description="A recipe launches a set of terminals and agents together in one click."
              action={
                <div className="flex flex-col items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => onCreateRecipe("project")}>
                    <Plus />
                    New project recipe
                  </Button>
                  <div className="flex flex-wrap justify-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => onCreateRecipe("global")}>
                      New global recipe
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setShowImportDialog(true)}>
                      Import from clipboard
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void importRecipeFromFile(currentProject?.id)}
                    >
                      Import from file
                    </Button>
                  </div>
                </div>
              }
            />
          ) : (
            <>
              <div className="mb-4 flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-secondary"
                    aria-hidden
                  />
                  <Input
                    type="search"
                    density="compact"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter recipes…"
                    aria-label="Filter recipes"
                    className="h-7 pl-8"
                  />
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="shrink-0">
                      <FileDown />
                      Import
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" sideOffset={4}>
                    <DropdownMenuItem onSelect={() => setShowImportDialog(true)}>
                      Import from clipboard…
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => void importRecipeFromFile(currentProject?.id)}
                    >
                      Import from file…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {hasVisibleSection ? (
                sections
              ) : (
                <p role="status" className="px-1 py-6 text-center text-sm text-text-secondary">
                  No recipes match &ldquo;{filter.trim()}&rdquo;
                </p>
              )}
            </>
          )}
        </AppDialog.Body>
      </AppDialog>

      <ConfirmDialog
        isOpen={recipeToDelete !== null}
        title={`Delete '${nameOf(recipeToDelete)}'?`}
        description={
          deleteError
            ? `Error: ${deleteError}`
            : "Deletes this recipe — the terminals it launches and their settings. Committed in-repo recipes in .daintree/recipes/ can be restored from git; recipes stored only on this machine can't be recovered."
        }
        confirmLabel={deleteError ? "Retry delete" : "Delete recipe"}
        variant="destructive"
        onConfirm={() => {
          if (recipeToDelete) void handleDeleteRecipe(recipeToDelete);
        }}
        onClose={() => {
          setRecipeToDelete(null);
          setDeleteError(null);
        }}
      />

      <ConfirmDialog
        isOpen={recipeToSave !== null}
        title={`Save '${nameOf(recipeToSave)}' as a team recipe?`}
        description={
          saveError
            ? `Error: ${saveError}`
            : (() => {
                const recipeName = recipeToSave ? nameOf(recipeToSave) : undefined;
                const collision = recipeName && inRepoRecipes.some((r) => r.name === recipeName);
                const base =
                  "This recipe will be written to .daintree/recipes/ in the repository where it can be committed and shared with the team.";
                return collision
                  ? `A team recipe named "${recipeName}" already exists. Saving will replace it. ${base}`
                  : base;
              })()
        }
        confirmLabel={saveError ? "Retry save" : "Save as team recipe"}
        variant="default"
        isConfirmLoading={isSaving}
        onConfirm={() => void handleSaveToRepo()}
        onClose={() => {
          setRecipeToSave(null);
          setSaveError(null);
        }}
      />

      <ConfirmDialog
        isOpen={recipeToDeleteAfterSave !== null}
        title={`Delete original '${nameOf(recipeToDeleteAfterSave)}'?`}
        description="The recipe has been saved to the repository. The original copy on this machine will be permanently removed."
        confirmLabel="Delete original"
        cancelLabel="Keep both"
        variant="destructive"
        onConfirm={() => void handleDeleteAfterSave()}
        onClose={() => setRecipeToDeleteAfterSave(null)}
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
          <AppDialog.Title>Import recipe</AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>

        <AppDialog.Body>
          <FormGrid>
            <FormRow label="Import as" htmlFor="recipe-import-scope">
              <select
                id="recipe-import-scope"
                value={importScope}
                onChange={(e) => setImportScope(e.target.value as "global" | "project")}
                className={cn(FIELD_INPUT, "pr-8")}
              >
                <option value="project">Project Recipe</option>
                <option value="global">Global Recipe</option>
              </select>
            </FormRow>
          </FormGrid>

          {/* Off the rail deliberately: pasted recipe JSON needs the dialog's
              full width more than it needs a label column. */}
          <textarea
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            data-testid="recipe-import-textarea"
            aria-label="Recipe JSON"
            aria-describedby={importError ? "recipe-import-error" : undefined}
            placeholder='{"name": "My Recipe", "terminals": [...]}'
            className={cn(
              FIELD_SURFACE,
              FIELD_FOCUS,
              "mt-3 w-full h-48 px-2.5 py-2 text-sm text-text-primary font-mono resize-none",
              "placeholder:text-text-placeholder"
            )}
            spellCheck={false}
          />
          {importError && (
            <div
              id="recipe-import-error"
              className="mt-3 rounded-[var(--radius-md)] border border-status-error/20 bg-status-error/10 p-3 text-sm text-status-error"
            >
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
          <Button variant="contrast" onClick={handleImportRecipe} disabled={!importJson.trim()}>
            Import
          </Button>
        </AppDialog.Footer>
      </AppDialog>
    </>
  );
}
