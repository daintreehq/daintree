// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

// The real editor, store, conflict gate and both dialogs: only the IPC write is
// faked, so the stacked dialogs, their dismissal paths and focus hand-back all
// run as they do in the app.
vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({ isOpen, title }: { isOpen: boolean; title: string }) =>
    isOpen ? <div data-testid="discard-confirm">{title}</div> : null,
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
vi.mock("@/components/TerminalRecipe/RecipeVariablePreview", () => ({
  RecipeVariablePreview: () => null,
}));

import { RecipeEditor } from "../RecipeEditor";
import { RecipeConflictDialog } from "../RecipeConflictDialog";
import { projectClient } from "@/clients";
import { useRecipeStore } from "@/store/recipeStore";
import { useRecipeConflictStore } from "@/store/recipeConflictStore";
import { useRecipeEditorActivityStore } from "@/store/recipeEditorActivityStore";
import { useProjectStore } from "@/store/projectStore";
import type { Project, TerminalRecipe } from "@/types";

const RECIPE: TerminalRecipe = {
  id: "inrepo-build",
  name: "Build",
  createdAt: 0,
  terminals: [{ type: "terminal", title: "Shell", command: "npm run build", env: {} }],
};

/** The `[AppError|<code>|<userMessage>]` prefix the preload puts on a main-process AppError. */
function refusal(code: "RECIPE_STALE_CONFLICT" | "RECIPE_FORWARD_COMPAT_CONFLICT") {
  return new Error(`[AppError|${code}|${encodeURIComponent("build.json")}] Refused`);
}

const updateInRepoRecipe = vi.spyOn(projectClient, "updateInRepoRecipe");

beforeEach(() => {
  updateInRepoRecipe.mockReset();
  useRecipeEditorActivityStore.setState({ openCount: 0 });
  useRecipeStore.setState({
    inRepoRecipes: [RECIPE],
    projectRecipes: [],
    globalRecipes: [],
    pluginRecipes: [],
    recipes: [RECIPE],
    currentProjectId: "proj",
  });
  useProjectStore.setState({
    currentProject: { id: "proj", name: "proj", path: "/p", emoji: "🌲", lastOpened: 0 } as Project,
  });
});

afterEach(() => {
  act(() => {
    if (useRecipeConflictStore.getState().pendingConflict) {
      useRecipeConflictStore.getState().resolveConflict("cancel");
    }
  });
  cleanup();
});

function renderEditor() {
  const onClose = vi.fn();
  const onSave = vi.fn();
  render(
    <>
      <RecipeEditor recipe={RECIPE} isOpen onClose={onClose} onSave={onSave} />
      <RecipeConflictDialog />
    </>
  );
  return { onClose, onSave };
}

const nameField = () => document.getElementById("recipe-name") as HTMLInputElement;
const commandField = () => document.getElementById("terminal-command-0") as HTMLInputElement;
const editorDialog = () => screen.getByRole("dialog", { name: "Edit recipe" });
const conflictDialog = () => screen.queryByRole("dialog", { name: /^Recipe 'Build v2'/ });

/** A pointer press focuses the button in Chromium; jsdom's `click()` alone doesn't. */
function pressSave() {
  const save = within(editorDialog()).getByRole("button", { name: "Update recipe" });
  save.focus();
  save.click();
}

async function editAndHitConflict(code: Parameters<typeof refusal>[0]) {
  updateInRepoRecipe.mockRejectedValueOnce(refusal(code));
  fireEvent.change(nameField(), { target: { value: "Build v2" } });
  fireEvent.change(commandField(), { target: { value: "npm run build:all" } });
  await act(async () => {
    pressSave();
  });
  await waitFor(() => expect(conflictDialog()).not.toBeNull());
}

const dismissals = {
  "the Cancel button": () =>
    within(conflictDialog()!).getByRole("button", { name: "Cancel" }).click(),
  "the close button": () =>
    within(conflictDialog()!).getByRole("button", { name: "Close dialog" }).click(),
  Escape: () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }),
};

describe("RecipeEditor save conflict (#15035)", () => {
  describe.each(["RECIPE_STALE_CONFLICT", "RECIPE_FORWARD_COMPAT_CONFLICT"] as const)(
    "%s",
    (code) => {
      it.each(Object.keys(dismissals) as (keyof typeof dismissals)[])(
        "backs out of the save, not the edit, from %s",
        async (how) => {
          const { onClose, onSave } = renderEditor();
          await editAndHitConflict(code);

          await act(async () => {
            dismissals[how]();
          });
          await waitFor(() => expect(conflictDialog()).toBeNull());

          // Still editing, with the draft exactly as typed and nothing reported.
          expect(onClose).not.toHaveBeenCalled();
          expect(onSave).not.toHaveBeenCalled();
          expect(nameField().value).toBe("Build v2");
          expect(commandField().value).toBe("npm run build:all");
          expect(nameField().readOnly).toBe(false);
          expect(document.querySelector("[data-inline-status-banner]")).toBeNull();
          // Focus comes back into the editor rather than falling behind it.
          await waitFor(() => expect(editorDialog().contains(document.activeElement)).toBe(true));

          // Nothing was forced through, and the store holds no trace of the edit.
          expect(updateInRepoRecipe).toHaveBeenCalledTimes(1);
          expect(useRecipeStore.getState().recipes.map((r) => r.name)).toEqual(["Build"]);
        }
      );
    }
  );

  it("saves the kept draft on the next attempt", async () => {
    const { onClose, onSave } = renderEditor();
    await editAndHitConflict("RECIPE_STALE_CONFLICT");
    await act(async () => {
      dismissals["the Cancel button"]();
    });
    await waitFor(() => expect(conflictDialog()).toBeNull());

    updateInRepoRecipe.mockResolvedValueOnce(undefined);
    await act(async () => {
      pressSave();
    });

    expect(updateInRepoRecipe).toHaveBeenCalledTimes(2);
    const [, written, , options] = updateInRepoRecipe.mock.calls[1]!;
    expect(written.name).toBe("Build v2");
    expect(written.terminals[0]?.command).toBe("npm run build:all");
    expect(options).toBeUndefined();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("still asks before closing on the kept draft", async () => {
    const { onClose } = renderEditor();
    await editAndHitConflict("RECIPE_STALE_CONFLICT");
    await act(async () => {
      dismissals["the Cancel button"]();
    });
    await waitFor(() => expect(conflictDialog()).toBeNull());

    act(() => {
      within(editorDialog()).getByRole("button", { name: "Cancel" }).click();
    });
    expect(screen.queryByTestId("discard-confirm")).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes without reporting a save when the file is reloaded instead", async () => {
    const { onClose, onSave } = renderEditor();
    await editAndHitConflict("RECIPE_STALE_CONFLICT");

    await act(async () => {
      within(conflictDialog()!).getByRole("button", { name: "Reload from disk" }).click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(updateInRepoRecipe).toHaveBeenCalledTimes(1);
  });

  // A focus reload would refresh main's hash for the file, and the kept draft
  // would then save over the newer version without the dialog ever opening.
  it("holds off the focus reload for as long as it is open", () => {
    const { rerender } = render(<RecipeEditor recipe={RECIPE} isOpen onClose={() => {}} />);
    expect(useRecipeEditorActivityStore.getState().isOpen()).toBe(true);

    rerender(<RecipeEditor recipe={RECIPE} isOpen={false} onClose={() => {}} />);
    expect(useRecipeEditorActivityStore.getState().isOpen()).toBe(false);

    rerender(<RecipeEditor recipe={RECIPE} isOpen onClose={() => {}} />);
    cleanup();
    expect(useRecipeEditorActivityStore.getState().openCount).toBe(0);
  });
});
