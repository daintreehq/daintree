import { useState, useCallback, useTransition, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import type { TerminalRecipe } from "@/types";
import type { Issue, PR } from "@shared/types/forge";
import { useRecipeStore } from "@/store/recipeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useSearchablePalette, type UseSearchablePaletteReturn } from "./useSearchablePalette";
import { actionService } from "@/services/ActionService";
import { getAutoAssign } from "@shared/types/project";
import { detectPrefixFromIssue, buildBranchName } from "@/components/Worktree/branchPrefixUtils";
import { isStartingLayoutRecipe } from "@/components/Worktree/hooks/useRecipePicker";
import { generateBranchSlug } from "@/utils/textParsing";
import { issueBranchName } from "@shared/utils/issueBranchName";
import { linkProviderIssue } from "@/utils/linkProviderIssue";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";

export type QuickCreateItem =
  | (TerminalRecipe & { _kind: "recipe" })
  | { _kind: "customize"; id: "__customize__"; name: "Customize…" };

function isCustomize(item: QuickCreateItem): item is QuickCreateItem & { _kind: "customize" } {
  return item._kind === "customize";
}

/**
 * The branch a pick creates straight away, or `null` when the issue or PR
 * context can't name one and the pick hands off to the New Worktree dialog.
 */
function quickCreateBranchName(issue: Issue | null, pr: PR | null): string | null {
  const issueTitle = issue?.title ?? pr?.title;
  if (!issueTitle) return null;

  // A provider-suggested name stands on its own, even for a title that
  // slugs to nothing.
  const suggestedBranch = issueBranchName(issue, "");
  const prefix = issue ? (detectPrefixFromIssue(issue) ?? "feature") : "feature";
  const slug = generateBranchSlug(issueTitle);
  if (!slug && !suggestedBranch) return null;

  const issuePrefix = issue?.number ? `issue-${issue.number}-` : "";
  return suggestedBranch || buildBranchName(prefix, `${issuePrefix}${slug}`);
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
  const getRecipeById = useRecipeStore((s) => s.getRecipeById);
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

  const issue = quickCreate.issue;
  const pr = quickCreate.pr;
  const branchName = quickCreateBranchName(issue, pr);

  // Without a branch name a pick opens the New Worktree dialog, whose picker
  // can't select a worktree recipe, so offering one here would swap it for a
  // different recipe (#14994). Shadowed recipes stay listed (dimmed, marked
  // "Overridden") rather than vanishing — the row still launches, resolved to
  // the winner (#11510).
  // Customize… stays while any recipe exists, so a project whose recipes are
  // all worktree recipes still reaches the dialog rather than "No recipes yet".
  const offeredRecipes = branchName ? recipes : recipes.filter(isStartingLayoutRecipe);
  const hasRecipes = recipes.length > 0;
  const items: QuickCreateItem[] = hasRecipes
    ? [
        ...offeredRecipes.map((r): QuickCreateItem => ({ ...r, _kind: "recipe" })),
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

      if (!branchName) {
        closeQuickCreate();
        palette.close();
        openCreateDialog(issue, { initialRecipeId: recipe.id });
        return;
      }

      const issueNumber = issue?.number;

      // A shadowed row launches the winning recipe, so its auto-assign
      // preference has to come from that winner, not the losing row.
      const autoAssign = getAutoAssign(getRecipeById(recipe.id) ?? recipe);
      const shouldAssign = autoAssign === "always" || (autoAssign === "prompt" && assignToSelf);

      startTransition(async () => {
        try {
          const result = await actionService.dispatch(
            "worktree.createWithRecipe",
            {
              // `issueNumber` and `assignToSelf` belong to the source arm, not
              // the root: the root object strips unknown keys, so anything left
              // at the top level never reaches `run()`.
              source: {
                kind: "newBranch" as const,
                branchName,
                issueNumber,
                assignToSelf: shouldAssign,
              },
              recipeId: recipe.id,
            },
            { source: "user", confirmed: true }
          );

          if (result.ok) {
            const {
              worktreeId: createdWorktreeId,
              branch,
              assignedToSelf: wasAssigned,
              assignedUsername,
              assignmentError,
            } = result.result as {
              worktreeId: string;
              worktreePath: string;
              branch: string;
              recipeLaunched: boolean;
              assignedToSelf: boolean;
              assignedUsername: string | null;
              assignmentError: string | null;
            };

            useWorktreeSelectionStore.getState().setPendingWorktree(createdWorktreeId);
            useWorktreeSelectionStore.getState().selectWorktree(createdWorktreeId);
            linkProviderIssue(createdWorktreeId, issue);

            const assignMsg =
              wasAssigned && issueNumber ? ` · assigned #${issueNumber} to you` : "";

            const worktreeMsg = `${branch}${assignMsg}`;
            const tiers = [worktreeMsg, "Branching out", "It's a tree farm"];
            if (typeof document !== "undefined" && document.hasFocus()) {
              comboCountRef.current += 1;
            }
            const tierIndex = Math.min(comboCountRef.current - 1, tiers.length - 1);
            const tieredMessage = tiers[tierIndex];

            // Snapshot rootPath at creation time so a later project switch
            // doesn't redirect the un-assign DELETE at a different repo.
            const snapRootPath = useProjectStore.getState().currentProject?.path ?? null;

            // Sticky toast surface lets users click Undo more than once before
            // the first invocation resolves; guard so worktree.delete and the
            // un-assign each fire at most once per success toast.
            const undoFiredRef = { current: false };
            const undoOnClick = (): void => {
              if (undoFiredRef.current) return;
              undoFiredRef.current = true;
              void (async () => {
                try {
                  await actionService.dispatch(
                    "worktree.delete",
                    { worktreeId: createdWorktreeId, force: true },
                    { source: "user" }
                  );
                } catch (err) {
                  // Half-rollback guard: if delete failed the worktree is still
                  // live, so don't strip the assignment too — that leaves the
                  // user with a worktree on an unassigned issue.
                  logError("Undo: failed to delete worktree", err);
                  return;
                }
                if (wasAssigned && issueNumber && assignedUsername && snapRootPath) {
                  const unassignResult = await actionService.dispatch(
                    "forge.unassignIssue",
                    { cwd: snapRootPath, issueNumber, username: assignedUsername },
                    { source: "user" }
                  );
                  if (!unassignResult.ok) {
                    // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
                    notify({
                      type: "warning",
                      title: "Couldn't undo assignment",
                      message: `${formatErrorMessage(unassignResult.error, "Failed to unassign issue")} — you can unassign manually on the forge`,
                      context: { worktreeId: createdWorktreeId },
                    });
                  }
                }
              })();
            };

            if (assignmentError) {
              notify({
                type: "warning",
                title: "Could not assign issue",
                message: `${assignmentError} — you can assign it manually on the forge`,
                priority: "high",
                context: { worktreeId: createdWorktreeId, eventKind: "uiFeedback" },
              });
            }

            notify({
              type: "success",
              title: "Worktree created",
              message: tieredMessage,
              inboxMessage: worktreeMsg,
              priority: "high",
              countable: false,
              context: { worktreeId: createdWorktreeId },
              // Threads the success into a per-worktree group so subsequent
              // worktree-lifecycle events (e.g. teardown) supersede this row
              // cleanly instead of stacking unrelated entries.
              correlationId: createdWorktreeId,
              action: {
                label: "Undo",
                onClick: undoOnClick,
                // The toast surface fires `onClick` (full delete + un-assign);
                // the inbox-row fallback at NotificationCenterEntry.tsx only
                // dispatches `actionId`, so it stays delete-only — matching
                // pre-fix behavior rather than a silent regression. The toast
                // is the primary undo surface (sticky during the action stack).
                actionId: "worktree.delete",
                actionArgs: { worktreeId: createdWorktreeId, force: true },
              },
            });
          } else {
            // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
            notify({
              type: "error",
              title: "Couldn't create worktree",
              message: formatErrorMessage(result.error, "Failed to create worktree"),
            });
          }
        } catch (error) {
          // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
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
    [
      isPending,
      closeQuickCreate,
      openCreateDialog,
      issue,
      branchName,
      assignToSelf,
      palette,
      getRecipeById,
    ]
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
    // Resolved to the winner for the same reason `doConfirm` resolves: a
    // shadowed row launches the winning recipe, so the auto-assign toggle this
    // drives has to agree with what submission will actually do.
    selectedRecipe:
      selectedRecipe && !isCustomize(selectedRecipe)
        ? (getRecipeById(selectedRecipe.id) ?? selectedRecipe)
        : null,
  };
}
