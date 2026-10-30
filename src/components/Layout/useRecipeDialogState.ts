import { useCallback, useEffect, useState } from "react";
import { useRecipeStore, type RecipeLayoutOmissions } from "@/store/recipeStore";
import { useRecipeEditorActivityStore } from "@/store/recipeEditorActivityStore";
import type { RecipeTerminal } from "@/types";
import type { TerminalRecipe } from "@/types";

interface UseRecipeDialogStateReturn {
  isRecipeEditorOpen: boolean;
  recipeEditorWorktreeId: string | undefined;
  recipeEditorInitialTerminals: RecipeTerminal[] | undefined;
  recipeEditorLayoutOmissions: RecipeLayoutOmissions | undefined;
  recipeEditorDefaultScope: "global" | "project" | undefined;
  recipeManagerEdit: TerminalRecipe | undefined;
  isRecipeManagerOpen: boolean;
  handleCloseRecipeEditor: () => void;
  handleCloseRecipeManager: () => void;
  handleRecipeManagerEdit: (recipe: TerminalRecipe) => void;
  handleRecipeManagerCreate: (scope: "global" | "project") => void;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The event detail is untyped; a malformed report is dropped rather than shown. */
function readLayoutOmissions(value: unknown): RecipeLayoutOmissions | undefined {
  if (!isPlainRecord(value)) return undefined;
  const { panelKinds, cappedTerminalCount } = value;
  if (!isCount(cappedTerminalCount) || !isPlainRecord(panelKinds)) return undefined;
  const entries = Object.entries(panelKinds);
  if (!entries.every((entry): entry is [string, number] => isCount(entry[1]))) return undefined;
  return { panelKinds: Object.fromEntries(entries), cappedTerminalCount };
}

function useRecipeDialogState(): UseRecipeDialogStateReturn {
  const [isRecipeEditorOpen, setIsRecipeEditorOpen] = useState(false);
  const [recipeEditorWorktreeId, setRecipeEditorWorktreeId] = useState<string | undefined>(
    undefined
  );
  const [recipeEditorInitialTerminals, setRecipeEditorInitialTerminals] = useState<
    RecipeTerminal[] | undefined
  >(undefined);
  const [recipeEditorLayoutOmissions, setRecipeEditorLayoutOmissions] = useState<
    RecipeLayoutOmissions | undefined
  >(undefined);
  const [recipeEditorDefaultScope, setRecipeEditorDefaultScope] = useState<
    "global" | "project" | undefined
  >(undefined);
  const [isRecipeManagerOpen, setIsRecipeManagerOpen] = useState(false);
  const [recipeManagerEdit, setRecipeManagerEdit] = useState<TerminalRecipe | undefined>(undefined);

  // Mirror the open/close transitions of the two recipe surfaces into the
  // shared activity store so the focus-reload hook can suppress its silent
  // reload while the user is mid-edit (#9186). The editor registers itself as
  // well, for mounts outside this host; holding it here too covers the lazy
  // editor chunk's load, after the recipe snapshot is already taken.
  useEffect(() => {
    if (!isRecipeEditorOpen) return;
    useRecipeEditorActivityStore.getState().enter();
    return () => useRecipeEditorActivityStore.getState().leave();
  }, [isRecipeEditorOpen]);

  useEffect(() => {
    if (!isRecipeManagerOpen) return;
    useRecipeEditorActivityStore.getState().enter();
    return () => useRecipeEditorActivityStore.getState().leave();
  }, [isRecipeManagerOpen]);

  const handleOpenRecipeEditor = useCallback(
    (
      worktreeId: string,
      initialTerminals?: RecipeTerminal[],
      layoutOmissions?: RecipeLayoutOmissions
    ) => {
      // A new draft replaces whatever the editor held: left in place, an
      // existing recipe would win over the capture and take its save.
      setIsRecipeManagerOpen(false);
      setRecipeManagerEdit(undefined);
      setRecipeEditorDefaultScope(undefined);
      setRecipeEditorWorktreeId(worktreeId);
      setRecipeEditorInitialTerminals(initialTerminals);
      setRecipeEditorLayoutOmissions(layoutOmissions);
      setIsRecipeEditorOpen(true);
    },
    []
  );

  useEffect(() => {
    const handleOpenRecipeEditorEvent = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as unknown;
      if (!detail) return;
      const d = detail as {
        worktreeId?: unknown;
        recipeId?: unknown;
        initialTerminals?: unknown;
        layoutOmissions?: unknown;
        acknowledge?: () => void;
      };
      // The dispatcher can pass a callback to learn that this listener actually
      // took the request (#11908). Without it an action that only fires the
      // event has no way to tell "the editor opened" from "nothing was
      // listening", and the assistant-facing handoffs report the former either
      // way. Called on each path that really opens the editor, never on the
      // early returns below.
      const acknowledge = () => {
        d.acknowledge?.();
      };

      if (typeof d.recipeId === "string") {
        const recipe = useRecipeStore.getState().getRecipeById(d.recipeId);
        if (recipe) {
          setIsRecipeManagerOpen(false);
          setRecipeEditorWorktreeId(recipe.worktreeId);
          setRecipeEditorDefaultScope(recipe.projectId === undefined ? "global" : "project");
          setRecipeEditorInitialTerminals(undefined);
          setRecipeEditorLayoutOmissions(undefined);
          setRecipeManagerEdit(recipe);
          setIsRecipeEditorOpen(true);
          acknowledge();
          return;
        }
      }

      if (typeof d.worktreeId !== "string") return;
      const worktreeId = d.worktreeId;
      const initialTerminals = Array.isArray(d.initialTerminals)
        ? (d.initialTerminals as RecipeTerminal[])
        : undefined;
      handleOpenRecipeEditor(
        worktreeId,
        initialTerminals,
        initialTerminals ? readLayoutOmissions(d.layoutOmissions) : undefined
      );
      acknowledge();
    };

    const controller = new AbortController();
    window.addEventListener("daintree:open-recipe-editor", handleOpenRecipeEditorEvent, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [handleOpenRecipeEditor]);

  useEffect(() => {
    const handleOpenRecipeManagerEvent = () => {
      setIsRecipeManagerOpen(true);
    };
    const controller = new AbortController();
    window.addEventListener("daintree:open-recipe-manager", handleOpenRecipeManagerEvent, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, []);

  const handleCloseRecipeManager = useCallback(() => {
    setIsRecipeManagerOpen(false);
  }, []);

  const handleRecipeManagerEdit = useCallback((recipe: TerminalRecipe) => {
    setIsRecipeManagerOpen(false);
    setRecipeEditorWorktreeId(recipe.worktreeId);
    setRecipeEditorDefaultScope(recipe.projectId === undefined ? "global" : "project");
    setRecipeEditorInitialTerminals(undefined);
    setRecipeEditorLayoutOmissions(undefined);
    setTimeout(() => {
      setIsRecipeEditorOpen(true);
    }, 100);
    setRecipeManagerEdit(recipe);
  }, []);

  const handleRecipeManagerCreate = useCallback((scope: "global" | "project") => {
    setIsRecipeManagerOpen(false);
    setRecipeEditorDefaultScope(scope);
    setRecipeEditorWorktreeId(undefined);
    setRecipeEditorInitialTerminals(undefined);
    setRecipeEditorLayoutOmissions(undefined);
    setRecipeManagerEdit(undefined);
    setTimeout(() => {
      setIsRecipeEditorOpen(true);
    }, 100);
  }, []);

  const handleCloseRecipeEditor = useCallback(() => {
    setIsRecipeEditorOpen(false);
    setRecipeEditorWorktreeId(undefined);
    setRecipeEditorInitialTerminals(undefined);
    setRecipeEditorLayoutOmissions(undefined);
    setRecipeEditorDefaultScope(undefined);
    setRecipeManagerEdit(undefined);
  }, []);

  return {
    isRecipeEditorOpen,
    recipeEditorWorktreeId,
    recipeEditorInitialTerminals,
    recipeEditorLayoutOmissions,
    recipeEditorDefaultScope,
    recipeManagerEdit,
    isRecipeManagerOpen,
    handleCloseRecipeEditor,
    handleCloseRecipeManager,
    handleRecipeManagerEdit,
    handleRecipeManagerCreate,
  };
}

export { useRecipeDialogState };
