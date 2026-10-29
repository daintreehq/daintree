// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor, fireEvent } from "@testing-library/react";
import { RecipeRunConfirmDialog } from "../RecipeRunConfirmDialog";
import {
  cancelRecipeRunConfirmations,
  requestRecipeRunConfirmation,
} from "@/store/recipeRunConfirmStore";

// No jest-dom in this repo — plain DOM reads only.

function ask(recipeName: string, missing: string[]) {
  let answer: boolean | undefined;
  act(() => {
    void requestRecipeRunConfirmation({ recipeName, missing }).then((approved) => {
      answer = approved;
    });
  });
  return () => answer;
}

function footerButton(role: "cancel" | "confirm"): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-confirm-role="${role}"]`);
  if (!button) throw new Error(`no ${role} footer action`);
  return button;
}

afterEach(() => {
  act(() => cancelRecipeRunConfirmations());
  cleanup();
});

describe("RecipeRunConfirmDialog (#15022)", () => {
  it("renders nothing when no run is waiting", () => {
    const { container } = render(<RecipeRunConfirmDialog />);
    expect(container.textContent).toBe("");
  });

  it("names the recipe and every variable that would go out empty", () => {
    ask("Fix issue", ["issue_number", "branch_name"]);
    render(<RecipeRunConfirmDialog />);

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Run 'Fix issue' with empty variables?");
    const tokens = Array.from(
      screen.getByTestId("recipe-run-missing-variables").querySelectorAll("li")
    ).map((li) => li.querySelector("span")?.textContent);
    expect(tokens).toEqual(["{{issue_number}}", "{{branch_name}}"]);
  });

  it("opens on the way back out, so a reflexive Enter doesn't start the run", async () => {
    ask("Fix issue", ["issue_number"]);
    render(<RecipeRunConfirmDialog />);

    await waitFor(() => expect(document.activeElement).toBe(footerButton("cancel")));
  });

  it("runs only on the explicit choice", async () => {
    const answer = ask("Fix issue", ["issue_number"]);
    render(<RecipeRunConfirmDialog />);

    fireEvent.click(footerButton("confirm"));

    await waitFor(() => expect(answer()).toBe(true));
  });

  it("backs out on Cancel and moves on to the next waiting run", async () => {
    const first = ask("Fix issue", ["issue_number"]);
    const second = ask("Review PR", ["pr_number"]);
    render(<RecipeRunConfirmDialog />);

    fireEvent.click(footerButton("cancel"));

    await waitFor(() => expect(first()).toBe(false));
    expect(screen.getByRole("dialog").textContent).toContain("Run 'Review PR'");
    expect(second()).toBeUndefined();
  });
});
