// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { RunCommand } from "@/types";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

import { RecipeRunnerEmpty } from "../RecipeRunnerEmpty";

function makeSuggestion(overrides: Partial<RunCommand> & { id: string; name: string }): RunCommand {
  return {
    command: `npm run ${overrides.name}`,
    ...overrides,
  };
}

describe("RecipeRunnerEmpty", () => {
  it("renders the descriptive copy and create button when there are no suggestions", () => {
    render(<RecipeRunnerEmpty onCreate={vi.fn()} suggestions={[]} onRunSuggestion={vi.fn()} />);

    expect(
      screen.getByText(/Launch agents, dev servers, and terminals together with one click/i)
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create your first recipe/i })).toBeTruthy();
  });

  it("renders a card for each suggestion and hides the descriptive copy", () => {
    const suggestions = [
      makeSuggestion({ id: "1", name: "dev", command: "npm run dev" }),
      makeSuggestion({ id: "2", name: "test", command: "npm run test" }),
    ];

    render(
      <RecipeRunnerEmpty onCreate={vi.fn()} suggestions={suggestions} onRunSuggestion={vi.fn()} />
    );

    // The suggestion's name is its accessible name; the command it runs is the
    // description, so the two are announced apart rather than run together.
    for (const [name, command] of [
      ["dev", "npm run dev"],
      ["test", "npm run test"],
    ]) {
      const card = screen.getByRole("button", { name });
      const described = document.getElementById(card.getAttribute("aria-describedby") ?? "");
      expect(described?.textContent).toBe(command);
    }
    expect(
      screen.queryByText(/Launch agents, dev servers, and terminals together with one click/i)
    ).toBeNull();
    expect(screen.getByRole("button", { name: /Create your first recipe/i })).toBeTruthy();
  });

  it("calls onRunSuggestion with the clicked suggestion", () => {
    const onRunSuggestion = vi.fn();
    const suggestion = makeSuggestion({ id: "1", name: "dev", command: "npm run dev" });

    render(
      <RecipeRunnerEmpty
        onCreate={vi.fn()}
        suggestions={[suggestion]}
        onRunSuggestion={onRunSuggestion}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "dev" }));
    expect(onRunSuggestion).toHaveBeenCalledWith(suggestion);
  });

  it("calls onCreate when the create button is clicked", () => {
    const onCreate = vi.fn();
    render(<RecipeRunnerEmpty onCreate={onCreate} suggestions={[]} onRunSuggestion={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Create your first recipe/i }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("disables suggestion cards when disabled is true and skips onRunSuggestion on click", () => {
    const onRunSuggestion = vi.fn();
    const suggestion = makeSuggestion({ id: "1", name: "dev", command: "npm run dev" });

    render(
      <RecipeRunnerEmpty
        onCreate={vi.fn()}
        suggestions={[suggestion]}
        onRunSuggestion={onRunSuggestion}
        disabled
      />
    );

    const button = screen.getByRole("button", { name: "dev" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(onRunSuggestion).not.toHaveBeenCalled();
  });
});
