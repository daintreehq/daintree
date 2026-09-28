// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

interface MockAction {
  label: string;
  onClick: () => void;
}

vi.mock("@/components/ui/AppDialog", () => {
  const Dialog = ({ children, isOpen }: { children: ReactNode; isOpen: boolean }) =>
    isOpen ? <div role="dialog">{children}</div> : null;
  Dialog.Header = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  Dialog.Title = ({ children }: { children: ReactNode }) => <h2>{children}</h2>;
  Dialog.CloseButton = () => <button type="button" aria-label="Close dialog" />;
  Dialog.Body = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  Dialog.Footer = ({ primaryAction }: { primaryAction?: MockAction }) =>
    primaryAction ? (
      <button type="button" data-confirm-role="confirm" onClick={primaryAction.onClick}>
        {primaryAction.label}
      </button>
    ) : null;
  return { AppDialog: Dialog };
});
vi.mock("@/components/ui/ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
vi.mock("@/components/TerminalRecipe/RecipeVariablePreview", () => ({
  RecipeVariablePreview: () => null,
}));

import { RecipeEditor } from "../RecipeEditor";
import { useRecipeStore } from "@/store/recipeStore";
import { useProjectStore } from "@/store/projectStore";
import type { Project, TerminalRecipe } from "@/types";

const RECIPE: TerminalRecipe = {
  id: "r1",
  name: "Full stack",
  projectId: "proj",
  createdAt: 0,
  terminals: [
    { type: "dev-preview", title: "Dev", devCommand: "npm run dev", env: {} },
    { type: "terminal", title: "API", command: "npm run api", env: {} },
    { type: "claude", title: "Agent", initialPrompt: "Go", env: {} },
  ],
};

/** The tokens that make a control read as a field: fill, edge, corner, focus ring. */
function chrome(el: Element): string[] {
  return [...el.classList]
    .filter((t) => /^(bg-surface-|border-border-|rounded-|focus-visible:outline)/.test(t))
    .sort();
}

const updateRecipe = vi.fn();
const createRecipe = vi.fn();

beforeEach(() => {
  updateRecipe.mockReset().mockResolvedValue(undefined);
  createRecipe.mockReset().mockResolvedValue(undefined);
  useRecipeStore.setState({ updateRecipe, createRecipe });
  useProjectStore.setState({
    currentProject: { id: "proj", name: "proj", path: "/p", emoji: "🌲", lastOpened: 0 } as Project,
  });
});

afterEach(cleanup);

const renderEditor = (recipe?: TerminalRecipe) =>
  render(<RecipeEditor recipe={recipe} isOpen onClose={() => {}} />);

describe("RecipeEditor", () => {
  // One form, one field style: a terminal card's controls must be the same
  // control as the recipe's own rows, not a second, near-miss look.
  it("draws every field in the family chrome, cards included", () => {
    renderEditor(RECIPE);
    const fields = document.querySelectorAll(
      '[role="dialog"] input[type="text"], [role="dialog"] textarea, [role="dialog"] select'
    );
    expect(fields.length).toBeGreaterThan(8);
    // The recipe's own auto-assign row is the reference: whatever the family's
    // chrome is today, every other field in the form must match it.
    const family = chrome(document.getElementById("auto-assign")!);
    expect(family.some((t) => t.startsWith("focus-visible:outline"))).toBe(true);
    expect(family.some((t) => t.startsWith("bg-surface-"))).toBe(true);
    for (const field of fields) {
      expect(chrome(field).join(" "), `#${field.id}`).toEqual(family.join(" "));
    }
  });

  it("names each terminal card as a group, with a remove button that says which", () => {
    renderEditor(RECIPE);
    const groups = screen
      .getAllByRole("group")
      .filter((g) => g.querySelector('button[aria-label^="Remove terminal"]'));
    expect(groups).toHaveLength(3);
    const names = groups.map(
      (g) => document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent
    );
    expect(new Set(names).size).toBe(3);
    const removes = screen.getAllByRole("button", { name: /^Remove terminal / });
    expect(new Set(removes.map((b) => b.getAttribute("aria-label"))).size).toBe(3);
  });

  it("submits on Enter from a single-line field, never from the prompt", async () => {
    renderEditor(RECIPE);
    fireEvent.keyDown(document.getElementById("terminal-initial-prompt-2")!, { key: "Enter" });
    expect(updateRecipe).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(document.getElementById("terminal-command-1")!, { key: "Enter" });
    });
    expect(updateRecipe).toHaveBeenCalledTimes(1);
  });

  it("marks a missing name on the name field itself and saves nothing", async () => {
    renderEditor();
    await act(async () => {
      screen.getByRole("button", { name: "Create recipe" }).click();
    });
    const name = document.getElementById("recipe-name")!;
    expect(name.getAttribute("aria-invalid")).toBe("true");
    const describedBy = name.getAttribute("aria-describedby") ?? "";
    const error = describedBy
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .find((el) => el?.dataset.slot === "field-error");
    expect(error?.textContent).toContain("Name the recipe");
    expect(document.activeElement).toBe(name);
    expect(createRecipe).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: "Build" } });
    expect(name.getAttribute("aria-invalid")).toBeNull();
  });

  it("reports a failed save in the shared error banner", async () => {
    updateRecipe.mockRejectedValue(new Error("EACCES"));
    renderEditor(RECIPE);
    await act(async () => {
      screen.getByRole("button", { name: "Update recipe" }).click();
    });
    const banner = document.querySelector("[data-inline-status-banner]");
    expect(banner?.textContent).toContain("EACCES");
  });

  it("hands focus to the added card, and to a surviving card after a removal", () => {
    renderEditor(RECIPE);
    act(() => {
      screen.getByRole("button", { name: /Add terminal/ }).click();
    });
    expect(document.activeElement?.closest('[role="group"]')).toBe(
      screen.getByRole("button", { name: "Remove terminal 4" }).closest('[role="group"]')
    );

    const titleOfSecond = document.getElementById("terminal-title-1")?.getAttribute("value");
    expect(titleOfSecond).toBeTruthy();
    act(() => {
      screen.getByRole("button", { name: "Remove terminal 1" }).click();
    });
    const focusedCard = document.activeElement?.closest('[role="group"]');
    expect(
      focusedCard?.querySelector<HTMLInputElement>('input[id^="terminal-title-"]')?.value
    ).toBe(titleOfSecond);
  });
});
