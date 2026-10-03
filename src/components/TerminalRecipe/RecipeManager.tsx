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
  Copy,
  CopyPlus,
  Lock,
  GitBranch,
  MoreHorizontal,
  Pin,
  PinOff,
  Clipboard,
} from "lucide-react";
import { Plug, Workflow } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { copyWithToast } from "@/lib/copyWithToast";
import { SearchField } from "@/components/ui/SearchField";
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
import { RecipeImportDialog } from "@/components/TerminalRecipe/RecipeImportDialog";
import { getRecipeTerminalSummary } from "@/components/Terminal/utils/recipeUtils";
import { nextDuplicateName } from "@/components/Terminal/RecipeRunner/recipeRunnerUtils";
import { getRecipeScope, worktreeDisplayName } from "@/utils/recipeScope";
import type { TerminalRecipe } from "@/types";
import { isInRepoRecipeId } from "@shared/utils/recipeFilename";
import { isPluginRecipe } from "@shared/types/project";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { WorktreeSnapshot } from "@shared/types/workspace-host";
import { pluralize } from "@/lib/pluralize";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";

const EMPTY_WORKTREES = new Map<string, WorktreeSnapshot>();

/**
 * How much of the inventory the dialog is showing right now — the scroll box's
 * height less its padding, capped by the content. Holding the full content
 * height instead would keep an unfiltered list's scroll range around as blank
 * space under a two-row result.
 */
function visibleInventoryHeight(el: HTMLElement | null): number | null {
  const scroller = el?.parentElement;
  if (!el || !scroller) return null;
  const style = getComputedStyle(scroller);
  const inner =
    scroller.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  return Math.min(el.offsetHeight, inner);
}

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
  const importRecipeFromFile = useRecipeStore((s) => s.importRecipeFromFile);
  const updateRecipe = useRecipeStore((s) => s.updateRecipe);
  const createRecipe = useRecipeStore((s) => s.createRecipe);
  const currentProject = useProjectStore((s) => s.currentProject);
  const worktrees = useWorktreeStoreOptional((s) => s.worktrees, EMPTY_WORKTREES);
  const [filter, setFilter] = useState("");
  const [filterMinHeight, setFilterMinHeight] = useState<number | null>(null);
  const inventoryRef = useRef<HTMLDivElement>(null);
  const handleFilterChange = (next: string) => {
    if (!filter && next) setFilterMinHeight(visibleInventoryHeight(inventoryRef.current));
    if (!next) setFilterMinHeight(null);
    setFilter(next);
  };

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
  const [showImportDialog, setShowImportDialog] = useState(false);

  // Kept mounted between opens; a filter left from last time would reopen the
  // manager showing a fraction of the inventory with no obvious reason why.
  useEffect(() => {
    if (!isOpen) {
      setFilter("");
      setFilterMinHeight(null);
    }
  }, [isOpen]);

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

  // The menu has closed by the time the copy settles, so it confirms like
  // every menu copy: a brief "Copied" flash, and a Retry toast when refused.
  const handleExportRecipe = useCallback(
    (recipe: TerminalRecipe) => {
      const json = exportRecipe(recipe.id);
      if (json !== null) copyWithToast("Recipe", json);
    },
    [exportRecipe]
  );

  // Same naming rule as the canvas band's Duplicate, so a copy made in either
  // place never collides with an existing recipe's name or on-disk filename.
  // A plugin recipe's copy has no projectId and lands as a global the user owns.
  const handleDuplicateRecipe = async (recipe: TerminalRecipe) => {
    const existingNames = new Set(useRecipeStore.getState().recipes.map((r) => r.name));
    try {
      await createRecipe(
        recipe.projectId,
        nextDuplicateName(recipe.name, existingNames),
        recipe.worktreeId,
        recipe.terminals,
        false,
        recipe.autoAssign
      );
    } catch (err) {
      logError("Failed to duplicate recipe", err);
    }
  };

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

  const resolveWorktreeName = (worktreeId: string) =>
    worktreeDisplayName(worktrees.get(worktreeId));

  const projectRecipeIds = new Set(projectRecipes.map((r) => r.id));
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
    // Only a project-local recipe can be overridden: `mergeRecipes` shadows
    // that tier alone, and a global recipe of the same name still launches as
    // itself.
    const isShadowed = projectRecipeIds.has(recipe.id) && inRepoNames.has(recipe.name);
    const isPinned = recipe.showInEmptyState === true;
    const summary = getRecipeTerminalSummary(recipe.terminals);
    const worktreeLabel = recipe.worktreeId
      ? getRecipeScope(recipe, resolveWorktreeName).label
      : null;
    return (
      <div
        key={recipe.id}
        data-recipe-row={recipe.name}
        className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-overlay-subtle has-[[data-state=open]]:bg-overlay-subtle"
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <TruncatedTooltip content={recipe.name}>
              <span className="truncate text-sm font-medium text-text-primary">{recipe.name}</span>
            </TruncatedTooltip>
            {isPinned && (
              <Badge size="xs">
                <Pin aria-hidden />
                Pinned
              </Badge>
            )}
            {fromPlugin && (
              <Badge size="xs">
                <Lock aria-hidden />
                Read-only
              </Badge>
            )}
            {isShadowed && <Badge size="xs">Overridden by team recipe</Badge>}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-text-secondary">
            {fromPlugin && (
              <>
                <TruncatedTooltip content={recipe.origin.pluginId}>
                  <span className="max-w-[40%] truncate">From {recipe.origin.pluginId}</span>
                </TruncatedTooltip>
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
              {pluralize(recipe.terminals.length, "terminal")}
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
                  size="icon-sm"
                  onClick={() => onEditRecipe(recipe)}
                  className="text-text-secondary hover:text-text-primary"
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
                    size="icon-sm"
                    className="text-text-secondary hover:text-text-primary data-[state=open]:bg-overlay-raised"
                    aria-label={`More actions for recipe ${recipe.name}`}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">More actions</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" sideOffset={4} className="min-w-[200px]">
              <DropdownMenuItem
                onSelect={() =>
                  void updateRecipe(recipe.id, { showInEmptyState: !isPinned }).catch((err) =>
                    logError("Failed to update recipe pin", err)
                  )
                }
              >
                {isPinned ? (
                  <PinOff data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Pin data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                )}
                {isPinned ? "Unpin from canvas" : "Pin to canvas"}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void handleDuplicateRecipe(recipe)}>
                <CopyPlus data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                Duplicate recipe
              </DropdownMenuItem>
              {!isInRepoRecipeId(recipe) && currentProject && (
                <DropdownMenuItem onSelect={() => setRecipeToSave(recipe.id)}>
                  <FolderGit2 data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                  Save as team recipe…
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => handleExportRecipe(recipe)}>
                <Copy data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                Copy as JSON
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportRecipeToFile(recipe.id)}>
                <FileUp data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                Export to file…
              </DropdownMenuItem>
              {!fromPlugin && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={() => setRecipeToDelete(recipe.id)}>
                    <Trash2 data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
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
      description: "Yours, in this project only",
      recipes: projectRecipes,
      emptyLine:
        "None yet. A project recipe stays on this machine until you save it as a team recipe.",
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
          <AppDialog.Title icon={<Workflow />}>Recipe manager</AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>

        {/* Each query starts its results from the top: filtering from the
            bottom of a long list would otherwise leave the matches scrolled
            out of view above the sticky field. */}
        <AppDialog.Body resetScrollKey={filter}>
          {totalCount === 0 ? (
            <EmptyState
              variant="zero-data"
              scale="canvas"
              icon={<Workflow />}
              title="No recipes yet"
              description="A recipe launches a set of terminals and agents together in one click."
              action={
                <div className="flex flex-col items-center gap-2">
                  <Button variant="contrast" size="sm" onClick={() => onCreateRecipe("project")}>
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
            // While a filter is active the inventory keeps the height it had
            // before filtering, so narrowing a long list to two rows does not
            // shrink and recentre the dialog and pull the field out from under
            // the pointer. The bottom padding lets the last row scroll clear of
            // the body's edge fade.
            <div
              ref={inventoryRef}
              className="min-h-[24rem] pb-6"
              style={filterMinHeight ? { minHeight: filterMinHeight } : undefined}
            >
              {/* Stays put while the inventory scrolls, so filtering or
                  importing from the bottom of a long list is not a trip back
                  to the top. The negative margin reclaims the body's top
                  padding so nothing scrolls visibly above it. */}
              <div className="sticky -top-6 z-10 -mt-6 mb-4 flex items-center gap-2 bg-surface-dialog pb-2 pt-6">
                <SearchField
                  size="compact"
                  fieldClassName="flex-1"
                  type="search"
                  value={filter}
                  onChange={(e) => handleFilterChange(e.target.value)}
                  onClear={() => handleFilterChange("")}
                  placeholder="Filter recipes…"
                  aria-label="Filter recipes"
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="shrink-0">
                      <FileDown />
                      Import
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" sideOffset={4}>
                    <DropdownMenuItem onSelect={() => setShowImportDialog(true)}>
                      <Clipboard data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                      Import from clipboard…
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => void importRecipeFromFile(currentProject?.id)}
                    >
                      <FileDown data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                      Import from file…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {hasVisibleSection ? (
                sections
              ) : (
                <EmptyState
                  variant="filtered-empty"
                  scale="sidebar"
                  title={`No recipes match “${filter.trim()}”`}
                />
              )}
            </div>
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

      <RecipeImportDialog
        isOpen={showImportDialog}
        onClose={() => setShowImportDialog(false)}
        projectId={currentProject?.id}
      />
    </>
  );
}
