import { useState, useCallback, useTransition, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import type { TerminalRecipe } from "@/types";
import { useRecipeStore } from "@/store/recipeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useSearchablePalette, type UseSearchablePaletteReturn } from "./useSearchablePalette";
import { actionService } from "@/services/ActionService";
import { getAutoAssign } from "@shared/types/project";
import { detectPrefixFromIssue, buildBranchName } from "@/components/Worktree/branchPrefixUtils";
import { generateBranchSlug } from "@/utils/textParsing";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";

export type QuickCreateItem =
  | (TerminalRecipe & { _kind: "recipe" })
  | { _kind: "customize"; id: "__customize__"; name: "Customize…" };

function isCustomize(item: QuickCreateItem): item is QuickCreateItem & { _kind: "customize" } {
  return item._kind === "customize";
}

export type UseQuickCreatePaletteReturn = UseSearchablePaletteReturn<QuickCreateItem> & {
  confirmSelection: () => void;
  confirmItem: (item: QuickCreateItem) => void;
  isPending: boolean;
  assignToSelf: boolean;
  setAssignToSelf: (value: boolean) => void;
  selectedRecipe: TerminalRecipe | null;
};

export function useQuickCreatePalette(): UseQuickCreatePaletteReturn {
  const recipes = useRecipeStore((s) => s.recipes);
  const { quickCreate, openCreateDialog, closeQuickCreate } = useWorktreeSelectionStore(
    useShallow((s) => ({
      quickCreate: s.quickCreate,
      openCreateDialog: s.openCreateDialog,
      closeQuickCreate: s.closeQuickCreate,
    }))
  );
  const [isPending, startTransition] = useTransition();
  const [assignToSelf, setAssignToSelf] = useState(true);
  const comboCountRef = useRef(0);

  const hasRecipes = recipes.length > 0;
  const items: QuickCreateItem[] = hasRecipes
    ? [
        ...recipes.map((r): QuickCreateItem => ({ ...r, _kind: "recipe" })),
        { _kind: "customize", id: "__customize__", name: "Customize…" },
      ]
    : [];

  const filterItems = useCallback(
    (allItems: QuickCreateItem[], query: string): QuickCreateItem[] => {
      if (!query.trim()) return allItems;
      const search = query.trim().toLowerCase();
      return allItems.filter((item) => item.name.toLowerCase().includes(search));
    },
    []
  );

  const palette = useSearchablePalette<QuickCreateItem>({
    items,
    filterFn: filterItems,
    maxResults: 20,
    paletteId: "quick-create",
  });

  // Sync worktreeStore.quickCreate.isOpen → paletteStore
  // When the sidebar "+" button calls openQuickCreate(), this opens the palette
  useEffect(() => {
    if (quickCreate.isOpen && !palette.isOpen) {
      palette.open();
    }
  }, [quickCreate.isOpen, palette.isOpen, palette]);

  const issue = quickCreate.issue;
  const pr = quickCreate.pr;

  const selectedRecipe =
    palette.results.length > 0 &&
    palette.selectedIndex >= 0 &&
    palette.selectedIndex < palette.results.length
      ? (palette.results[palette.selectedIndex] ?? null)
      : null;

  const doConfirm = useCallback(
    (item: QuickCreateItem | null) => {
      if (isPending) return;
      if (!item) {
        if (palette.results.length === 0) {
          // No recipes at all — open recipe manager so user can create one
          closeQuickCreate();
          palette.close();
          void actionService.dispatch("recipe.manager.open", undefined, { source: "user" });
          return;
        }
        palette.close();
        return;
      }

      // Customize fallback → open full modal
      if (isCustomize(item)) {
        closeQuickCreate();
        palette.close();
        openCreateDialog(issue);
        return;
      }

      const recipe = item as TerminalRecipe & { _kind: "recipe" };

      // Derive branch name from issue or PR context
      const issueTitle = issue?.title ?? pr?.title;
      const issueNumber = issue?.number;
      if (!issueTitle) {
        // No context to derive a branch name — fall through to full modal
        closeQuickCreate();
        palette.close();
        openCreateDialog(issue, { initialRecipeId: recipe.id });
        return;
      }

      const prefix = issue ? (detectPrefixFromIssue(issue) ?? "feature") : "feature";
      const slug = generateBranchSlug(issueTitle);
      if (!slug) {
        closeQuickCreate();
        palette.close();
        openCreateDialog(issue, { initialRecipeId: recipe.id });
        return;
      }

      const issuePrefix = issueNumber ? `issue-${issueNumber}-` : "";
      const branchName = buildBranchName(prefix, `${issuePrefix}${slug}`);

      const autoAssign = getAutoAssign(recipe);
      const shouldAssign = autoAssign === "always" || (autoAssign === "prompt" && assignToSelf);

      startTransition(async () => {
        try {
          const result = await actionService.dispatch(
            "worktree.createWithRecipe",
            {
              branchName,
              recipeId: recipe.id,
              issueNumber,
              assignToSelf: shouldAssign,
            },
            { source: "user", confirmed: true }
          );

          if (result.ok) {
            const {
              worktreeId: createdWorktreeId,
              branch,
              assignedToSelf: wasAssigned,
            } = result.result as {
              worktreeId: string;
              worktreePath: string;
              branch: string;
              recipeLaunched: boolean;
              assignedToSelf: boolean;
            };

            useWorktreeSelectionStore.getState().setPendingWorktree(createdWorktreeId);
            useWorktreeSelectionStore.getState().selectWorktree(createdWorktreeId);

            const assignMsg =
              wasAssigned && issueNumber ? ` · assigned #${issueNumber} to you` : "";

            const worktreeMsg = `${branch}${assignMsg}`;
            const tiers = [worktreeMsg, "Branching out", "It's a tree farm"];
            if (typeof document !== "undefined" && document.hasFocus()) {
              comboCountRef.current += 1;
            }
            const tierIndex = Math.min(comboCountRef.current - 1, tiers.length - 1);
            const tieredMessage = tiers[tierIndex];

            notify({
              type: "success",
              title: "Worktree created",
              message: tieredMessage,
              inboxMessage: worktreeMsg,
              priority: "high",
              countable: false,
              action: {
                label: "Undo",
                onClick: () => {},
                actionId: "worktree.delete",
                actionArgs: { worktreeId: createdWorktreeId, force: true },
              },
            });
          } else {
            notify({
              type: "error",
              title: "Couldn't create worktree",
              message: formatErrorMessage(result.error, "Failed to create worktree"),
            });
          }
        } catch (error) {
          notify({
            type: "error",
            title: "Couldn't create worktree",
            message: formatErrorMessage(error, "Failed to create worktree"),
          });
        } finally {
          closeQuickCreate();
          palette.close();
        }
      });
    },
    [isPending, closeQuickCreate, openCreateDialog, issue, pr, assignToSelf, palette]
  );

  const confirmSelection = useCallback(() => {
    doConfirm(selectedRecipe);
  }, [doConfirm, selectedRecipe]);

  const confirmItem = useCallback(
    (item: QuickCreateItem) => {
      doConfirm(item);
    },
    [doConfirm]
  );

  return {
    ...palette,
    confirmSelection,
    confirmItem,
    isPending,
    assignToSelf,
    setAssignToSelf,
    selectedRecipe: selectedRecipe && !isCustomize(selectedRecipe) ? selectedRecipe : null,
  };
}
