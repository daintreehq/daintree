import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import {
  useRecipeStore,
  type RecipeRunOptions,
  type RecipeSpawnFailure,
  type RecipeSpawnResults,
} from "@/store/recipeStore";
import { requestRecipeRunConfirmation } from "@/store/recipeRunConfirmStore";
import { pluginOnlyCopyRefusal, recipeUsesPluginOnlyFeatures } from "@/utils/pluginRecipeCopy";
import { notify } from "@/lib/notify";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { usePanelStore } from "@/store/panelStore";
import { actionService } from "@/services/ActionService";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { recipeContextFromWorktree, type RecipeContext } from "@/utils/recipeVariables";
import { missingRecipeVariables } from "@/utils/recipeAgentStep";
import { isRecipeChangedSinceShownError, recipeApprovalDigest } from "@/utils/recipeApprovalDigest";
import { getAgentConfig } from "@/config/agents";
import { recipePanelStepName } from "@/components/Terminal/utils/recipeUtils";
import { isInRepoRecipeId } from "@shared/utils/recipeFilename";
import { isPluginRecipe } from "@shared/types/project";
import { logError } from "@/utils/logger";
import { PANEL_LIMIT_DECLINED_REASON } from "@/services/actions/definitions/panelLimitError";
import {
  buildRecipeSections,
  rankSearchResults,
  type RecipeSections,
  type RankedRecipe,
} from "./recipeRunnerUtils";
import type { TerminalRecipe, RecipeTerminal, RunCommand } from "@/types";
import { keyBelongsToField, stepListboxCursor } from "@/hooks/useListboxCursor";

// Every missing terminal is one the user chose not to open at the panel-limit
// confirm. They answered it a moment ago; a failure banner would blame the limit.
function allDeclined(results: RecipeSpawnResults): boolean {
  return (
    results.failed.length > 0 &&
    results.failed.every((f) => f.error === PANEL_LIMIT_DECLINED_REASON)
  );
}

export interface UseRecipeRunnerOptions {
  activeWorktreeId: string | null | undefined;
  defaultCwd: string | undefined;
}

type RanRecipe = NonNullable<RecipeRunOptions["expectedRecipe"]>;

export interface SpawnFailureSummary {
  /** The id the run was started with, which may be a row a team recipe shadows. */
  recipeId: string;
  /** The recipe that actually ran: its failure indices only mean anything against these steps. */
  ranRecipe: RanRecipe;
  recipeName: string;
  totalCount: number;
  failures: Array<RecipeSpawnFailure & { displayName: string }>;
}

function isRecipeThatRan(recipe: TerminalRecipe | undefined, ran: RanRecipe): boolean {
  return (
    recipe !== undefined &&
    recipe.id === ran.id &&
    recipeApprovalDigest(recipe.terminals) === ran.terminalsDigest
  );
}

/** A confirmed run the store refused because the recipe changed under the dialog (#17447). */
export interface ChangedRecipeRefusal {
  /** The row that was run; review resolves it to whatever that row launches now. */
  recipeId: string;
  /** As the confirm named it. */
  recipeName: string;
  /**
   * What the row resolves to now: a recipe the editor can open, a plugin's
   * recipe (its plugin owns the content, so there is no editor to offer), or
   * nothing, once it is deleted or its plugin unloaded.
   */
  current: "editable" | "plugin" | "missing";
}

export interface UseRecipeRunnerResult {
  recipes: TerminalRecipe[];
  sections: RecipeSections;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  searchResults: RankedRecipe[];
  focusedIndex: number;
  setFocusedIndex: (i: number) => void;
  showSearch: boolean;
  totalItems: number;
  focusedItemId: string | undefined;
  suggestions: RunCommand[];
  spawnFailureSummary: SpawnFailureSummary | null;
  /**
   * False once the recipe behind the failure banner was edited, reordered,
   * shadowed or deleted: its failed indices would now name other steps.
   */
  canRetryFailed: boolean;
  changedRecipe: ChangedRecipeRefusal | null;
  /** A plugin recipe's own variables the last run launched empty: no plugin supplied them. */
  unresolvedVars: string[];
  isRetryingFailed: boolean;
  handleRun: (recipeId: string) => void;
  handleEdit: (recipeId: string) => void;
  handleDuplicate: (recipeId: string) => void;
  handlePin: (recipeId: string) => void;
  handleUnpin: (recipeId: string) => void;
  handleDelete: (recipeId: string) => void;
  /** The recipe the delete confirm is open for; null once it closes. */
  pendingDeleteId: string | null;
  /** The recipe the delete confirm last asked about, kept through its exit. */
  deleteTarget: { id: string; name: string } | null;
  isDeleting: boolean;
  deleteError: string | null;
  confirmDelete: () => void;
  cancelDelete: () => void;
  handleCreate: () => void;
  handleManage: () => void;
  handleRunSuggestion: (suggestion: RunCommand) => void;
  handleRetryFailed: () => void;
  dismissSpawnFailures: () => void;
  dismissUnresolvedVars: () => void;
  reviewChangedRecipe: () => void;
  dismissChangedRecipe: () => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  getFlatRecipes: () => TerminalRecipe[];
}

function getTerminalDisplayName(terminal: RecipeTerminal, index: number): string {
  if (terminal.title && terminal.title.trim().length > 0) {
    return terminal.title.trim();
  }
  if (terminal.type === "dev-preview") {
    return "Dev server";
  }
  if (terminal.type === "plugin-panel") {
    return recipePanelStepName(terminal);
  }
  if (terminal.type !== "terminal") {
    const agent = getAgentConfig(terminal.type);
    if (agent?.name) return agent.name;
  }
  return `Terminal ${index + 1}`;
}

export function useRecipeRunner({
  activeWorktreeId,
  defaultCwd,
}: UseRecipeRunnerOptions): UseRecipeRunnerResult {
  const allRecipes = useRecipeStore((s) => s.recipes);
  const runRecipeWithResults = useRecipeStore((s) => s.runRecipeWithResults);
  const updateRecipe = useRecipeStore((s) => s.updateRecipe);
  const duplicateRecipe = useRecipeStore((s) => s.duplicateRecipe);
  const getRecipeById = useRecipeStore((s) => s.getRecipeById);

  const allDetectedRunners = useProjectSettingsStore((s) => s.allDetectedRunners);
  const addPanel = usePanelStore((s) => s.addPanel);

  const [searchQuery, setSearchQuery] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [spawnFailureSummary, setSpawnFailureSummary] = useState<SpawnFailureSummary | null>(null);
  const [unresolvedVars, setUnresolvedVars] = useState<string[]>([]);
  const [changedRecipeRun, setChangedRecipeRun] = useState<{
    recipeId: string;
    recipeName: string;
  } | null>(null);
  const [isRetryingFailed, setIsRetryingFailed] = useState(false);
  // Kept after the confirm closes, so its title still names the recipe through
  // the exit: by then a deleted recipe has already left the store.
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const pendingDeleteId = isDeleteOpen ? (deleteTarget?.id ?? null) : null;

  // Subscribed rather than read through `getRecipeById` at render: an edit,
  // reload or new shadowing team recipe has to withdraw Retry on its own.
  const retryRecipeId = spawnFailureSummary?.recipeId;
  const retryRecipe = useRecipeStore((s) =>
    retryRecipeId === undefined ? undefined : s.getRecipeById(retryRecipeId)
  );
  const canRetryFailed =
    spawnFailureSummary !== null && isRecipeThatRan(retryRecipe, spawnFailureSummary.ranRecipe);

  const isRunningRef = useRef(false);
  const isSpawningSuggestionRef = useRef(false);
  const isConfirmingDeleteRef = useRef(false);
  // Bumped by every delete request and worktree switch: a delete that settles
  // after either has no confirm left to answer.
  const deleteRequestRef = useRef(0);
  // The run waiting on the missing-variables confirm, so a worktree switch or
  // unmount can withdraw a question about a target that's no longer here.
  const pendingConfirmRef = useRef<AbortController | null>(null);
  // Generation counter: every run/retry captures the current value, then any
  // resolved async work checks the latest value before calling setState. If a
  // worktree switch (or a new run) bumps the counter while the old promise is
  // still in flight, the old setState is dropped on the floor.
  const runGenerationRef = useRef(0);

  // Stable filtered recipe array for Fuse cache
  const recipes = useMemo(() => {
    const visible = allRecipes.filter(
      (r) => r.worktreeId === activeWorktreeId || r.worktreeId === undefined
    );
    // A shadowed row launches the team recipe it defers to (`getRecipeById`
    // redirects the run), so it has to describe that recipe's terminals, not
    // its own — otherwise the row names one set of terminals and starts another.
    return visible.map((r) => {
      if (!r.shadowedBy) return r;
      const winner = allRecipes.find((w) => w.name === r.name && isInRepoRecipeId(w));
      return winner ? { ...r, terminals: winner.terminals } : r;
    });
  }, [allRecipes, activeWorktreeId]);

  // A live query keeps the list, even once the inventory drops to six or
  // fewer: the grid has no filter field, so switching to it with a query still
  // applied would hide recipes behind a search the user can no longer see.
  const showSearch = recipes.length > 6 || searchQuery.trim().length > 0;

  const sections = useMemo(() => buildRecipeSections(recipes), [recipes]);

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    return rankSearchResults(recipes, searchQuery.trim(), Date.now());
  }, [recipes, searchQuery]);

  // Build flat list for keyboard navigation
  const getFlatRecipes = useCallback((): TerminalRecipe[] => {
    if (searchQuery.trim()) {
      return searchResults.map((r) => r.recipe);
    }
    return [...sections.pinned, ...sections.recent, ...sections.all];
  }, [searchQuery, searchResults, sections]);

  // +1 for "Create new recipe" button
  const totalItems = getFlatRecipes().length + 1;

  // Deleting the last filtered result, or the inventory shrinking under an
  // open band, must not leave Enter pointed past the end of the list.
  useEffect(() => {
    if (focusedIndex >= totalItems) setFocusedIndex(totalItems - 1);
  }, [focusedIndex, totalItems]);

  // A query outliving every recipe would otherwise reappear, invisible, the
  // next time one is created.
  useEffect(() => {
    if (recipes.length === 0) setSearchQuery("");
  }, [recipes.length]);

  // Reset focused index on worktree/query change
  useEffect(() => {
    setFocusedIndex(0);
  }, [activeWorktreeId, searchQuery]);

  // Clear stale banner state when the active worktree changes — failures and
  // unresolved vars are computed against a specific worktree's context. Bump
  // the generation counter so any in-flight run that resolves after the switch
  // can detect the change and skip its setState.
  useEffect(() => {
    setSpawnFailureSummary(null);
    setUnresolvedVars([]);
    setChangedRecipeRun(null);
    // Drop any in-flight delete confirmation — a pending recipe id belongs to
    // the previous worktree's filtered list; confirming it after the switch
    // would delete a recipe out of its original context.
    deleteRequestRef.current += 1;
    setIsDeleteOpen(false);
    runGenerationRef.current += 1;
    return () => pendingConfirmRef.current?.abort();
  }, [activeWorktreeId]);

  const focusedItemId = useMemo(() => {
    const flat = getFlatRecipes();
    if (focusedIndex < flat.length) {
      return `recipe-option-${flat[focusedIndex]!.id}`;
    }
    if (focusedIndex === flat.length) {
      return "recipe-option-create";
    }
    return undefined;
  }, [focusedIndex, getFlatRecipes]);

  // Suggestions from package.json. Capped at 2 so the empty state stays a
  // launchpad ("here's the obvious next click") rather than a gallery — the
  // user can browse the full set after creating a recipe.
  const suggestions = useMemo(() => {
    const keywords = ["dev", "start", "serve", "test", "build"];
    return allDetectedRunners
      .filter((r) =>
        keywords.some(
          (kw) => r.command.toLowerCase().includes(kw) || r.name.toLowerCase().includes(kw)
        )
      )
      .slice(0, 2);
  }, [allDetectedRunners]);

  const buildContext = useCallback(
    (cwd: string): RecipeContext => {
      const worktreeData = activeWorktreeId
        ? getCurrentViewStore().getState().worktrees.get(activeWorktreeId)
        : null;
      return {
        ...(worktreeData ? recipeContextFromWorktree(worktreeData) : {}),
        worktreePath: cwd,
      };
    },
    [activeWorktreeId]
  );

  const summarizeFailures = useCallback(
    (
      recipeId: string,
      recipe: TerminalRecipe,
      results: RecipeSpawnResults
    ): SpawnFailureSummary | null => {
      if (results.failed.length === 0) return null;
      if (allDeclined(results)) return null;
      return {
        recipeId,
        ranRecipe: { id: recipe.id, terminalsDigest: recipeApprovalDigest(recipe.terminals) },
        recipeName: recipe.name,
        totalCount: results.spawned.length + results.failed.length,
        failures: results.failed.map((f) => ({
          ...f,
          displayName: recipe.terminals[f.index]
            ? getTerminalDisplayName(recipe.terminals[f.index]!, f.index)
            : `Terminal ${f.index + 1}`,
        })),
      };
    },
    []
  );

  // Resolved from the subscribed list rather than `getRecipeById`, so the
  // banner follows the store: a recipe deleted after the refusal loses its
  // Review action instead of opening a blank draft.
  const changedRecipe = useMemo((): ChangedRecipeRefusal | null => {
    if (!changedRecipeRun) return null;
    const row = allRecipes.find((r) => r.id === changedRecipeRun.recipeId);
    // The store resolves through `inRepoRecipes`, which never holds a plugin's.
    const winner = row?.shadowedBy
      ? allRecipes.find((w) => w.name === row.name && isInRepoRecipeId(w) && !isPluginRecipe(w))
      : undefined;
    const resolved = winner ?? row;
    return {
      ...changedRecipeRun,
      current: !resolved ? "missing" : isPluginRecipe(resolved) ? "plugin" : "editable",
    };
  }, [changedRecipeRun, allRecipes]);

  // Holds a run whose prompts would send built-in variables blank until the
  // user decides (#15022). With nothing missing, `proceed` runs synchronously,
  // so a recipe with every value launches exactly as it always has.
  const gateOnMissingVariables = useCallback(
    (
      recipe: TerminalRecipe,
      missing: string[],
      proceed: (expectedRecipe?: RecipeRunOptions["expectedRecipe"]) => void
    ) => {
      if (missing.length === 0) {
        proceed();
        return;
      }
      const controller = new AbortController();
      pendingConfirmRef.current = controller;
      void requestRecipeRunConfirmation(
        { recipeName: recipe.name, missing },
        controller.signal
      ).then((approved) => {
        if (pendingConfirmRef.current === controller) pendingConfirmRef.current = null;
        // A worktree switch or unmount aborts the question. One that lands
        // after the answer still counts: the approval settled first, but its
        // target is gone.
        if (!approved || controller.signal.aborted) {
          isRunningRef.current = false;
          return;
        }
        // What the user approved is what starts: a recipe edited while the
        // dialog was open is refused rather than launched as its new self.
        proceed({ id: recipe.id, terminalsDigest: recipeApprovalDigest(recipe.terminals) });
      });
    },
    []
  );

  const handleRun = useCallback(
    (recipeId: string) => {
      if (!defaultCwd) return;
      if (isRunningRef.current) return;

      const recipe = getRecipeById(recipeId);
      if (!recipe) return;

      const cwd = defaultCwd;
      const context = buildContext(cwd);
      const missing = missingRecipeVariables(recipe, context);

      // Taken before the confirm, so a second Enter can't queue another run
      // behind the dialog.
      isRunningRef.current = true;
      const runId = ++runGenerationRef.current;

      gateOnMissingVariables(recipe, missing.builtIn, (expectedRecipe) => {
        // Clear any leftover failure banner from a prior run — the new run is
        // the user's current intent and the old retry button must not target a
        // recipe that's no longer relevant. Backing out of the confirm keeps it.
        setSpawnFailureSummary(null);
        setChangedRecipeRun(null);
        // A plugin's own variables only get values when the plugin runs the
        // recipe, so started from here they launch empty without asking.
        setUnresolvedVars(missing.plugin);

        void (async () => {
          try {
            const results = await runRecipeWithResults(
              recipeId,
              cwd,
              activeWorktreeId ?? undefined,
              context,
              { spawnedBy: "recipe", ...(expectedRecipe && { expectedRecipe }) }
            );
            if (runGenerationRef.current === runId) {
              // `recipe` is what the store ran: its lookup happens in this same
              // tick, and a confirm in between pins it through `expectedRecipe`.
              setSpawnFailureSummary(summarizeFailures(recipeId, recipe, results));
            }
          } catch (error) {
            // The confirm approved one recipe and the store now holds another,
            // or none, so it refused before starting anything: say so, since
            // the panes the user just agreed to never appear.
            if (isRecipeChangedSinceShownError(error)) {
              if (runGenerationRef.current === runId) {
                setUnresolvedVars([]);
                setChangedRecipeRun({ recipeId, recipeName: recipe.name });
              }
              return;
            }
            // The store throws synchronously when the recipe was deleted between
            // the local lookup and the store call. Don't let this become an
            // unhandled rejection (Electron 41 crashes utility processes on
            // unhandled rejections).
            logError("Recipe run failed", error);
          } finally {
            isRunningRef.current = false;
          }
        })();
      });
    },
    [
      defaultCwd,
      activeWorktreeId,
      runRecipeWithResults,
      getRecipeById,
      buildContext,
      summarizeFailures,
      gateOnMissingVariables,
    ]
  );

  const handleRetryFailed = useCallback(() => {
    const summary = spawnFailureSummary;
    if (!summary || summary.failures.length === 0) return;
    if (!defaultCwd) return;
    if (isRunningRef.current) return;

    const { recipeId, ranRecipe } = summary;
    const recipe = getRecipeById(recipeId);
    // The failures are indices into the steps that ran. After a reorder,
    // removal or replacement the same index names a different step (#17446).
    if (!recipe || !isRecipeThatRan(recipe, ranRecipe)) return;

    const indices = summary.failures.map((f) => f.index);
    const cwd = defaultCwd;
    const context = buildContext(cwd);
    const missing = missingRecipeVariables(recipe, context, indices);

    isRunningRef.current = true;
    const runId = ++runGenerationRef.current;

    // A retry is another launch: the worktree may have lost a value since.
    gateOnMissingVariables(recipe, missing.builtIn, () => {
      setIsRetryingFailed(true);
      void (async () => {
        try {
          const results = await runRecipeWithResults(
            recipeId,
            cwd,
            activeWorktreeId ?? undefined,
            context,
            // Pinned even without a confirm: the store refuses the run if an edit
            // lands between this check and its own lookup.
            { spawnedBy: "recipe", terminalIndices: indices, expectedRecipe: ranRecipe }
          );
          if (runGenerationRef.current !== runId) return;
          // Declining the confirm opened nothing, so the outstanding failures
          // are unchanged — keep the banner as it was rather than re-reporting.
          if (allDeclined(results)) return;
          if (results.failed.length === 0) {
            setSpawnFailureSummary(null);
          } else {
            // Carry forward the original total so the banner copy stays anchored
            // to the original run ("Started X of Y") rather than the retry subset.
            setSpawnFailureSummary({
              ...summary,
              failures: results.failed.map((f) => ({
                ...f,
                displayName: recipe.terminals[f.index]
                  ? getTerminalDisplayName(recipe.terminals[f.index]!, f.index)
                  : `Terminal ${f.index + 1}`,
              })),
            });
          }
        } catch (error) {
          logError("Recipe retry failed", error);
        } finally {
          isRunningRef.current = false;
          setIsRetryingFailed(false);
        }
      })();
    });
  }, [
    spawnFailureSummary,
    defaultCwd,
    activeWorktreeId,
    runRecipeWithResults,
    getRecipeById,
    buildContext,
    gateOnMissingVariables,
  ]);

  const dismissSpawnFailures = useCallback(() => {
    setSpawnFailureSummary(null);
  }, []);

  const dismissUnresolvedVars = useCallback(() => {
    setUnresolvedVars([]);
  }, []);

  const handleEdit = useCallback(
    (recipeId: string) => {
      window.dispatchEvent(
        new CustomEvent("daintree:open-recipe-editor", {
          detail: { recipeId, worktreeId: activeWorktreeId },
        })
      );
    },
    [activeWorktreeId]
  );

  // The banner stays while the editor is open, so closing it hands focus back
  // to Review; the next run clears it. The editor opens a blank draft for an
  // id it can't find, and a plugin's recipe isn't the canvas's to edit.
  const reviewChangedRecipe = useCallback(() => {
    if (changedRecipe?.current !== "editable") return;
    handleEdit(changedRecipe.recipeId);
  }, [changedRecipe, handleEdit]);

  const dismissChangedRecipe = useCallback(() => {
    setChangedRecipeRun(null);
  }, []);

  const handleDuplicate = useCallback(
    (recipeId: string) => {
      // The row's own recipe, not `getRecipeById`'s: a row badged as overridden
      // by a team recipe copies itself, not the team recipe (#17200).
      const recipe = allRecipes.find((r) => r.id === recipeId);
      if (!recipe) return;
      // A plugin's panel steps and variables only work in its own recipe (#13797).
      if (recipeUsesPluginOnlyFeatures(recipe)) {
        notify({
          type: "warning",
          title: "Can't duplicate recipe",
          message: pluginOnlyCopyRefusal(recipe),
          // The click did nothing else, so it stays a toast rather than inbox-only.
          priority: "high",
          context: { eventKind: "uiFeedback" },
        });
        return;
      }
      // The store picks a name no existing recipe has — otherwise duplicating a
      // recipe twice produces two same-named copies that slug to the same
      // on-disk filename and overwrite each other — and the copy's tier.
      const duplicate = () => {
        duplicateRecipe(recipe.id).catch((err: unknown) => {
          logError("Failed to duplicate recipe", err);
          notify({
            type: "error",
            title: "Couldn't duplicate recipe",
            message: `The copy couldn't be saved: ${formatErrorMessage(err, "unknown error")}`,
            priority: "high",
            action: { label: "Retry", onClick: duplicate },
            context: { eventKind: "uiFeedback" },
          });
        });
      };
      duplicate();
    },
    [allRecipes, duplicateRecipe]
  );

  // The store rolls the row back when the write rejects, so without a toast the
  // recipe just jumps back to where it was with no explanation.
  const setPinned = useCallback(
    (recipeId: string, pinned: boolean) => {
      const name = allRecipes.find((r) => r.id === recipeId)?.name ?? "this recipe";
      updateRecipe(recipeId, { showInEmptyState: pinned }).catch((err: unknown) => {
        logError("Failed to update recipe pin", err);
        notify({
          type: "error",
          title: "Couldn't update recipe pin",
          message: `The pin change for “${name}” couldn't be saved: ${formatErrorMessage(err, "unknown error")}`,
          // The click did nothing else, so it stays a toast rather than inbox-only.
          priority: "high",
          action: { label: "Retry", onClick: () => setPinned(recipeId, pinned) },
          context: { eventKind: "uiFeedback" },
        });
      });
    },
    [allRecipes, updateRecipe]
  );

  const handlePin = useCallback((recipeId: string) => setPinned(recipeId, true), [setPinned]);

  const handleUnpin = useCallback((recipeId: string) => setPinned(recipeId, false), [setPinned]);

  // Route deletes through the `recipe.delete` action (danger:"confirm") behind
  // a ConfirmDialog rendered in RecipeRunner.tsx, matching RecipeManager and
  // RecipesTab — never call the store's deleteRecipe directly (Tier D1 gate).
  const handleDelete = useCallback(
    (recipeId: string) => {
      deleteRequestRef.current += 1;
      setDeleteError(null);
      setDeleteTarget({ id: recipeId, name: getRecipeById(recipeId)?.name ?? "recipe" });
      setIsDeleteOpen(true);
    },
    [getRecipeById]
  );

  const confirmDelete = useCallback(() => {
    const recipeId = pendingDeleteId;
    if (!recipeId) return;
    // Guard with a ref (not state) — dispatch is async and a double-click would
    // otherwise fire recipe.delete twice, the second failing with a transient
    // "already gone" error.
    if (isConfirmingDeleteRef.current) return;
    isConfirmingDeleteRef.current = true;
    setIsDeleting(true);
    const request = deleteRequestRef.current;
    void (async () => {
      setDeleteError(null);
      try {
        const result = await actionService.dispatch(
          "recipe.delete",
          { recipeId },
          { source: "user", confirmed: true }
        );
        if (request !== deleteRequestRef.current) return;
        if (result.ok) {
          setIsDeleteOpen(false);
        } else {
          // Keep the dialog open with retry copy rather than closing on a silent
          // failure (the action surface is the user's only recovery path here).
          logError("Failed to delete recipe", result.error);
          setDeleteError(formatErrorMessage(result.error, "Failed to delete recipe"));
        }
      } finally {
        isConfirmingDeleteRef.current = false;
        setIsDeleting(false);
      }
    })();
  }, [pendingDeleteId]);

  // The error stays with the closing confirm, like its title; the next request
  // clears it.
  const cancelDelete = useCallback(() => {
    if (isConfirmingDeleteRef.current) return;
    setIsDeleteOpen(false);
  }, []);

  const handleCreate = useCallback(() => {
    // A folder without git has no worktree; the draft is then project-wide.
    void actionService.dispatch(
      "recipe.editor.open",
      activeWorktreeId ? { worktreeId: activeWorktreeId } : {},
      { source: "user" }
    );
  }, [activeWorktreeId]);

  const handleManage = useCallback(() => {
    void actionService.dispatch("recipe.manager.open", undefined, { source: "user" });
  }, []);

  const handleRunSuggestion = useCallback(
    (suggestion: RunCommand) => {
      if (!defaultCwd) return;
      // Guard with useRef (not useState) — addPanel is async and a state-based
      // guard would batch and leave a double-fire window. See PR #4703.
      if (isSpawningSuggestionRef.current) return;
      isSpawningSuggestionRef.current = true;

      void (async () => {
        try {
          const id = await addPanel({
            kind: "terminal",
            title: suggestion.name,
            cwd: defaultCwd,
            command: suggestion.command,
            location: "grid",
            worktreeId: activeWorktreeId ?? undefined,
            spawnedBy: "quickrun",
          });
          // addPanel resolves null when the panel is rejected (panel limit,
          // policy gate, cancelled confirmation). Log so a silent click on a
          // first-run discovery surface leaves a diagnostic trail.
          if (id === null) {
            logError("Suggestion run rejected by panel store", suggestion.command);
          }
        } catch (error) {
          // Unhandled rejection crashes Electron 41 utility processes.
          logError("Suggestion run failed", error);
        } finally {
          isSpawningSuggestionRef.current = false;
        }
      })();
    },
    [defaultCwd, activeWorktreeId, addPanel]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Confirming an IME candidate sends Enter (or 229) to the input, not the list.
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      const next = keyBelongsToField(e) ? null : stepListboxCursor(e.key, focusedIndex, totalItems);
      if (next !== null) {
        e.preventDefault();
        setFocusedIndex(next);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const flat = getFlatRecipes();
        if (focusedIndex < flat.length) {
          handleRun(flat[focusedIndex]!.id);
        } else {
          handleCreate();
        }
      } else if (
        // F2 edits the selected item, as it renames one on Windows and in VS
        // Code. Not Cmd+E, which opens Canopy from anywhere on macOS. Ctrl+E
        // stays outside a text input, where it is readline's end of line.
        e.key === "F2" ||
        (e.key === "e" && e.ctrlKey && !e.metaKey && !(e.target instanceof HTMLInputElement))
      ) {
        e.preventDefault();
        const flat = getFlatRecipes();
        const target = flat[focusedIndex];
        // Same rule as the context menu: a plugin owns its recipe's content.
        if (target && !isPluginRecipe(target)) {
          handleEdit(target.id);
        }
      }
    },
    [totalItems, focusedIndex, getFlatRecipes, handleRun, handleCreate, handleEdit]
  );

  return {
    recipes,
    sections,
    searchQuery,
    setSearchQuery,
    searchResults,
    focusedIndex,
    setFocusedIndex,
    showSearch,
    totalItems,
    focusedItemId,
    suggestions,
    spawnFailureSummary,
    canRetryFailed,
    changedRecipe,
    unresolvedVars,
    isRetryingFailed,
    handleRun,
    handleEdit,
    handleDuplicate,
    handlePin,
    handleUnpin,
    handleDelete,
    pendingDeleteId,
    deleteTarget,
    isDeleting,
    deleteError,
    confirmDelete,
    cancelDelete,
    handleCreate,
    handleManage,
    handleRunSuggestion,
    handleRetryFailed,
    dismissSpawnFailures,
    dismissUnresolvedVars,
    reviewChangedRecipe,
    dismissChangedRecipe,
    handleKeyDown,
    getFlatRecipes,
  };
}
