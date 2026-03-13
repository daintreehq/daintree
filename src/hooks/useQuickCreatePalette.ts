import { useState, useCallback, useTransition } from "react";
import { useShallow } from "zustand/react/shallow";
import type { TerminalRecipe } from "@/types";
import { useRecipeStore } from "@/store/recipeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useSearchablePalette, type UseSearchablePaletteReturn } from "./useSearchablePalette";
import { actionService } from "@/services/ActionService";
import { getAutoAssign } from "@shared/types/domain";
import { detectPrefixFromIssue, buildBranchName } from "@/components/Worktree/branchPrefixUtils";
import { generateBranchSlug } from "@/utils/textParsing";
import { notify } from "@/lib/notify";

export type QuickCreateItem =
  | (TerminalRecipe & { _kind: "recipe" })
  | { _kind: "customize"; id: "__customize__"; name: "Customize…" };

function isCustomize(item: QuickCreateItem): item is QuickCreateItem & { _kind: "customize" } {
  return item._kind === "customize";
}

export type UseQuickCreatePaletteReturn = UseSearchablePaletteReturn<QuickCreateItem> & {
  confirmSelection: () => void;
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

  const items: QuickCreateItem[] = [
    ...recipes.map((r): QuickCreateItem => ({ ...r, _kind: "recipe" })),
    { _kind: "customize", id: "__customize__", name: "Customize…" },
  ];

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

  const issue = quickCreate.issue;
  const pr = quickCreate.pr;

  const selectedRecipe =
    palette.results.length > 0 &&
    palette.selectedIndex >= 0 &&
    palette.selectedIndex < palette.results.length
      ? palette.results[palette.selectedIndex]
      : null;

  const confirmSelection = useCallback(() => {
    if (isPending) return;
    if (!selectedRecipe) {
      palette.close();
      return;
    }

    // Customize fallback → open full modal
    if (isCustomize(selectedRecipe)) {
      closeQuickCreate();
      palette.close();
      openCreateDialog(issue);
      return;
    }

    const recipe = selectedRecipe as TerminalRecipe & { _kind: "recipe" };

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
            issueNumber: shouldAssign ? issueNumber : undefined,
          },
          { source: "user", confirmed: true }
        );

        if (result.ok) {
          const { branch, assignedToSelf: wasAssigned } = result.result as {
            worktreeId: string;
            worktreePath: string;
            branch: string;
            recipeLaunched: boolean;
            assignedToSelf: boolean;
          };

          const assignMsg = wasAssigned && issueNumber ? ` · assigned #${issueNumber} to you` : "";

          notify({
            type: "success",
            title: "Worktree Created",
            message: `${branch}${assignMsg}`,
          });
        } else {
          notify({
            type: "error",
            title: "Creation Failed",
            message: result.error.message,
          });
        }
      } catch (error) {
        notify({
          type: "error",
          title: "Creation Failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        closeQuickCreate();
        palette.close();
      }
    });
  }, [
    isPending,
    selectedRecipe,
    closeQuickCreate,
    openCreateDialog,
    issue,
    pr,
    assignToSelf,
    palette,
  ]);

  return {
    ...palette,
    confirmSelection,
    isPending,
    assignToSelf,
    setAssignToSelf,
    selectedRecipe: selectedRecipe && !isCustomize(selectedRecipe) ? selectedRecipe : null,
  };
}
