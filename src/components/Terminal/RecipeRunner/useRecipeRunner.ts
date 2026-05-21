import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import {
  useRecipeStore,
  type RecipeSpawnFailure,
  type RecipeSpawnResults,
} from "@/store/recipeStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { actionService } from "@/services/ActionService";
import { detectUnresolvedVariables, type RecipeContext } from "@/utils/recipeVariables";
import { getAgentConfig } from "@/config/agents";
import { logError } from "@/utils/logger";
import {
  buildRecipeSections,
  rankSearchResults,
  nextDuplicateName,
  type RecipeSections,
  type RankedRecipe,
} from "./recipeRunnerUtils";
import type { TerminalRecipe, RecipeTerminal, RunCommand } from "@/types";

export interface UseRecipeRunnerOptions {
  activeWorktreeId: string | null | undefined;
  defaultCwd: string | undefined;
}

export interface SpawnFailureSummary {
  recipeName: string;
  totalCount: number;
  failures: Array<RecipeSpawnFailure & { displayName: string }>;
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
  unresolvedVars: string[];
  isRetryingFailed: boolean;
  handleRun: (recipeId: string) => void;
  handleEdit: (recipeId: string) => void;
  handleDuplicate: (recipeId: string) => void;
  handlePin: (recipeId: string) => void;
  handleUnpin: (recipeId: string) => void;
  handleDelete: (recipeId: string) => void;
  handleCreate: () => void;
  handleRetryFailed: () => void;
  dismissSpawnFailures: () => void;
  dismissUnresolvedVars: () => void;
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
  if (terminal.type !== "terminal") {
    const agent = getAgentConfig(terminal.type);
    if (agent?.name) return agent.name;
  }
  return `Terminal ${index + 1}`;
}

// Only scans terminal.initialPrompt — that is the single field the store
// passes through replaceRecipeVariables (recipeStore.ts:600). terminal.command,
// terminal.devCommand, and terminal.args are forwarded raw, so flagging
// {{var}} in them would mislead the user into thinking the substitution was
// expected to happen.
function collectUnresolvedVars(recipe: TerminalRecipe, context: RecipeContext): string[] {
  const seen = new Set<string>();
  for (const terminal of recipe.terminals) {
    if (!terminal.initialPrompt) continue;
    for (const name of detectUnresolvedVariables(terminal.initialPrompt, context)) {
      seen.add(name);
    }
  }
  return Array.from(seen);
}

export function useRecipeRunner({
  activeWorktreeId,
  defaultCwd,
}: UseRecipeRunnerOptions): UseRecipeRunnerResult {
  const allRecipes = useRecipeStore((s) => s.recipes);
  const runRecipeWithResults = useRecipeStore((s) => s.runRecipeWithResults);
  const updateRecipe = useRecipeStore((s) => s.updateRecipe);
  const deleteRecipe = useRecipeStore((s) => s.deleteRecipe);
  const createRecipe = useRecipeStore((s) => s.createRecipe);
  const getRecipeById = useRecipeStore((s) => s.getRecipeById);

  const allDetectedRunners = useProjectSettingsStore((s) => s.allDetectedRunners);

  const [searchQuery, setSearchQuery] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [spawnFailureSummary, setSpawnFailureSummary] = useState<SpawnFailureSummary | null>(null);
  const [unresolvedVars, setUnresolvedVars] = useState<string[]>([]);
  const [isRetryingFailed, setIsRetryingFailed] = useState(false);

  const isRunningRef = useRef(false);
  const lastRunRecipeIdRef = useRef<string | null>(null);
  // Generation counter: every run/retry captures the current value, then any
  // resolved async work checks the latest value before calling setState. If a
  // worktree switch (or a new run) bumps the counter while the old promise is
  // still in flight, the old setState is dropped on the floor.
  const runGenerationRef = useRef(0);

  // Stable filtered recipe array for Fuse cache
  const recipes = useMemo(() => {
    return allRecipes.filter(
      (r) => r.worktreeId === activeWorktreeId || r.worktreeId === undefined
    );
  }, [allRecipes, activeWorktreeId]);

  const showSearch = recipes.length > 6;

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
    lastRunRecipeIdRef.current = null;
    runGenerationRef.current += 1;
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

  // Suggestions from package.json
  const suggestions = useMemo(() => {
    const keywords = ["dev", "start", "serve", "test", "build"];
    return allDetectedRunners.filter((r) =>
      keywords.some(
        (kw) => r.command.toLowerCase().includes(kw) || r.name.toLowerCase().includes(kw)
      )
    );
  }, [allDetectedRunners]);

  const buildContext = useCallback(
    (cwd: string): RecipeContext => {
      const worktreeData = activeWorktreeId
        ? getCurrentViewStore().getState().worktrees.get(activeWorktreeId)
        : null;
      return {
        issueNumber: worktreeData?.issueNumber,
        prNumber: worktreeData?.linked?.pr?.ref.number,
        worktreePath: cwd,
        branchName: worktreeData?.branch,
      };
    },
    [activeWorktreeId]
  );

  const summarizeFailures = useCallback(
    (recipe: TerminalRecipe, results: RecipeSpawnResults): SpawnFailureSummary | null => {
      if (results.failed.length === 0) return null;
      return {
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

  const handleRun = useCallback(
    (recipeId: string) => {
      if (!defaultCwd) return;
      if (isRunningRef.current) return;

      const recipe = getRecipeById(recipeId);
      if (!recipe) return;

      const cwd = defaultCwd;
      const context = buildContext(cwd);

      // Clear any leftover failure banner from a prior run — the new run is
      // the user's current intent and the old retry button must not target a
      // recipe that's no longer relevant.
      setSpawnFailureSummary(null);
      // Pre-flight: detect unresolved variables across all terminals so the user
      // sees a single aggregated warning rather than discovering them per-spawn.
      setUnresolvedVars(collectUnresolvedVars(recipe, context));

      isRunningRef.current = true;
      lastRunRecipeIdRef.current = recipeId;
      const runId = ++runGenerationRef.current;

      void (async () => {
        try {
          const results = await runRecipeWithResults(
            recipeId,
            cwd,
            activeWorktreeId ?? undefined,
            context,
            { spawnedBy: "recipe" }
          );
          if (runGenerationRef.current === runId) {
            setSpawnFailureSummary(summarizeFailures(recipe, results));
          }
        } catch (error) {
          // The store throws synchronously when the recipe was deleted between
          // the local lookup and the store call. Don't let this become an
          // unhandled rejection (Electron 41 crashes utility processes on
          // unhandled rejections).
          logError("Recipe run failed", error);
        } finally {
          isRunningRef.current = false;
        }
      })();
    },
    [
      defaultCwd,
      activeWorktreeId,
      runRecipeWithResults,
      getRecipeById,
      buildContext,
      summarizeFailures,
    ]
  );

  const handleRetryFailed = useCallback(() => {
    const recipeId = lastRunRecipeIdRef.current;
    const summary = spawnFailureSummary;
    if (!recipeId || !summary || summary.failures.length === 0) return;
    if (!defaultCwd) return;
    if (isRunningRef.current) return;

    const recipe = getRecipeById(recipeId);
    if (!recipe) return;

    const indices = summary.failures.map((f) => f.index);
    const cwd = defaultCwd;
    const context = buildContext(cwd);

    isRunningRef.current = true;
    setIsRetryingFailed(true);
    const runId = ++runGenerationRef.current;

    void (async () => {
      try {
        const results = await runRecipeWithResults(
          recipeId,
          cwd,
          activeWorktreeId ?? undefined,
          context,
          { spawnedBy: "recipe", terminalIndices: indices }
        );
        if (runGenerationRef.current !== runId) return;
        if (results.failed.length === 0) {
          setSpawnFailureSummary(null);
        } else {
          // Carry forward the original total so the banner copy stays anchored
          // to the original run ("Started X of Y") rather than the retry subset.
          setSpawnFailureSummary({
            recipeName: recipe.name,
            totalCount: summary.totalCount,
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
  }, [
    spawnFailureSummary,
    defaultCwd,
    activeWorktreeId,
    runRecipeWithResults,
    getRecipeById,
    buildContext,
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

  const handleDuplicate = useCallback(
    (recipeId: string) => {
      const recipe = getRecipeById(recipeId);
      if (!recipe) return;
      // Pick a name whose stableInRepoId doesn't collide with any existing recipe —
      // otherwise duplicating an in-repo recipe twice silently overwrites the first.
      const existingIds = new Set(allRecipes.map((r) => r.id));
      const copyName = nextDuplicateName(recipe.name, existingIds);
      void createRecipe(
        recipe.projectId,
        copyName,
        recipe.worktreeId,
        recipe.terminals,
        false,
        recipe.autoAssign
      );
    },
    [getRecipeById, createRecipe, allRecipes]
  );

  const handlePin = useCallback(
    (recipeId: string) => {
      void updateRecipe(recipeId, { showInEmptyState: true });
    },
    [updateRecipe]
  );

  const handleUnpin = useCallback(
    (recipeId: string) => {
      void updateRecipe(recipeId, { showInEmptyState: false });
    },
    [updateRecipe]
  );

  const handleDelete = useCallback(
    (recipeId: string) => {
      void deleteRecipe(recipeId);
    },
    [deleteRecipe]
  );

  const handleCreate = useCallback(() => {
    void actionService.dispatch(
      "recipe.editor.open",
      { worktreeId: activeWorktreeId },
      { source: "user" }
    );
  }, [activeWorktreeId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((prev) => (prev + 1) % totalItems);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((prev) => (prev - 1 + totalItems) % totalItems);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const flat = getFlatRecipes();
        if (focusedIndex < flat.length) {
          handleRun(flat[focusedIndex]!.id);
        } else {
          handleCreate();
        }
      } else if (e.key === "Escape") {
        if (searchQuery) {
          e.preventDefault();
          setSearchQuery("");
        }
      } else if (
        e.key === "e" &&
        // Ctrl+E in a text input means "move cursor to end of line" on
        // Linux/Windows (readline binding) — don't steal it. Cmd+E on macOS
        // doesn't conflict with input editing, so allow it from any target.
        (e.metaKey || (e.ctrlKey && !(e.target instanceof HTMLInputElement)))
      ) {
        e.preventDefault();
        const flat = getFlatRecipes();
        if (focusedIndex < flat.length) {
          handleEdit(flat[focusedIndex]!.id);
        }
      }
    },
    [totalItems, focusedIndex, getFlatRecipes, handleRun, handleCreate, handleEdit, searchQuery]
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
    unresolvedVars,
    isRetryingFailed,
    handleRun,
    handleEdit,
    handleDuplicate,
    handlePin,
    handleUnpin,
    handleDelete,
    handleCreate,
    handleRetryFailed,
    dismissSpawnFailures,
    dismissUnresolvedVars,
    handleKeyDown,
    getFlatRecipes,
  };
}
