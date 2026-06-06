// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { RecipeRunnerGrid } from "../RecipeRunnerGrid";
import type { TerminalRecipe } from "@/types";

function makeRecipe(
  overrides: Partial<TerminalRecipe> & { id: string; name: string }
): TerminalRecipe {
  return {
    terminals: [{ type: "terminal", env: {} }],
    createdAt: Date.now(),
    ...overrides,
  };
}

const noop = () => {};

interface HarnessProps {
  recipes: TerminalRecipe[];
  initialFocusedIndex?: number;
}

function Harness({ recipes, initialFocusedIndex = 0 }: HarnessProps) {
  const [focusedIndex, setFocusedIndex] = useState(initialFocusedIndex);
  return (
    <RecipeRunnerGrid
      recipes={recipes}
      focusedIndex={focusedIndex}
      setFocusedIndex={setFocusedIndex}
      onRun={noop}
      onEdit={noop}
      onDuplicate={noop}
      onPin={noop}
      onUnpin={noop}
      onDelete={noop}
      onCreate={noop}
    />
  );
}

function optionButton(recipe: TerminalRecipe) {
  return screen.getByRole("option", { name: new RegExp(recipe.name) });
}

describe("RecipeRunnerGrid — roving tabindex", () => {
  const recipes: TerminalRecipe[] = [
    makeRecipe({ id: "alpha", name: "Alpha" }),
    makeRecipe({ id: "beta", name: "Beta" }),
    makeRecipe({ id: "gamma", name: "Gamma" }),
  ];

  it("renders one option per recipe plus the trailing create option", () => {
    render(<Harness recipes={recipes} />);

    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(screen.getByRole("option", { name: /Create new recipe/ })).toBeTruthy();
  });

  it("places tabIndex=0 on the focused option and -1 on the rest", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={1} />);

    const [alpha, beta, gamma] = recipes.map((r) => optionButton(r));
    const create = screen.getByRole("option", { name: /Create new recipe/ });

    expect(alpha!.getAttribute("tabindex")).toBe("-1");
    expect(beta!.getAttribute("tabindex")).toBe("0");
    expect(gamma!.getAttribute("tabindex")).toBe("-1");
    expect(create.getAttribute("tabindex")).toBe("-1");
  });

  it("marks only the focused option with aria-selected=true", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={2} />);

    const [alpha, beta, gamma] = recipes.map((r) => optionButton(r));
    const create = screen.getByRole("option", { name: /Create new recipe/ });

    expect(alpha!.getAttribute("aria-selected")).toBe("false");
    expect(beta!.getAttribute("aria-selected")).toBe("false");
    expect(gamma!.getAttribute("aria-selected")).toBe("true");
    expect(create.getAttribute("aria-selected")).toBe("false");
  });
});

describe("RecipeRunnerGrid — focus-driven Enter runs the focused recipe", () => {
  it("does not call preventDefault on Enter so the button's native activation is preserved", () => {
    const onRun = vi.fn();
    const recipes: TerminalRecipe[] = [
      makeRecipe({ id: "alpha", name: "Alpha" }),
      makeRecipe({ id: "beta", name: "Beta" }),
      makeRecipe({ id: "gamma", name: "Gamma" }),
    ];

    function StatefulHarness() {
      const [focusedIndex, setFocusedIndex] = useState(2);
      return (
        <RecipeRunnerGrid
          recipes={recipes}
          focusedIndex={focusedIndex}
          setFocusedIndex={setFocusedIndex}
          onRun={onRun}
          onEdit={noop}
          onDuplicate={noop}
          onPin={noop}
          onUnpin={noop}
          onDelete={noop}
          onCreate={noop}
        />
      );
    }

    render(<StatefulHarness />);

    // The bug: an ancestor onKeyDown called e.preventDefault() on Enter and
    // dispatched handleRun(flat[focusedIndex]). With the fix the per-option
    // onKeyDown only intercepts navigation keys, so Enter falls through to
    // the button's native click handler.
    const gamma = optionButton(recipes[2]!);
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    gamma.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("runs the focused recipe when Enter activates its button, not index 0", () => {
    const onRun = vi.fn();
    const recipes: TerminalRecipe[] = [
      makeRecipe({ id: "alpha", name: "Alpha" }),
      makeRecipe({ id: "beta", name: "Beta" }),
      makeRecipe({ id: "gamma", name: "Gamma" }),
    ];

    function StatefulHarness() {
      const [focusedIndex, setFocusedIndex] = useState(2);
      return (
        <RecipeRunnerGrid
          recipes={recipes}
          focusedIndex={focusedIndex}
          setFocusedIndex={setFocusedIndex}
          onRun={onRun}
          onEdit={noop}
          onDuplicate={noop}
          onPin={noop}
          onUnpin={noop}
          onDelete={noop}
          onCreate={noop}
        />
      );
    }

    render(<StatefulHarness />);

    // Browsers dispatch a click after Enter on a focused button; jsdom doesn't
    // so we simulate both halves of that chain. The regression guard is
    // that keyDown(Enter) does not preventDefault (asserted above) and the
    // click still calls onRun with the focused recipe's id, not index 0.
    const gamma = optionButton(recipes[2]!);
    fireEvent.keyDown(gamma, { key: "Enter" });
    fireEvent.click(gamma);

    expect(onRun).toHaveBeenCalledWith("gamma");
    expect(onRun).not.toHaveBeenCalledWith("alpha");
  });

  it("runs the create action when Enter is pressed on the focused create option", () => {
    const onCreate = vi.fn();
    const recipes: TerminalRecipe[] = [
      makeRecipe({ id: "alpha", name: "Alpha" }),
      makeRecipe({ id: "beta", name: "Beta" }),
    ];

    function StatefulHarness() {
      const [focusedIndex, setFocusedIndex] = useState(2);
      return (
        <RecipeRunnerGrid
          recipes={recipes}
          focusedIndex={focusedIndex}
          setFocusedIndex={setFocusedIndex}
          onRun={noop}
          onEdit={noop}
          onDuplicate={noop}
          onPin={noop}
          onUnpin={noop}
          onDelete={noop}
          onCreate={onCreate}
        />
      );
    }

    render(<StatefulHarness />);

    const create = screen.getByRole("option", { name: /Create new recipe/ });
    fireEvent.keyDown(create, { key: "Enter" });
    fireEvent.click(create);

    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});

describe("RecipeRunnerGrid — disabled entry point", () => {
  it("keeps the create option tabbable when all recipes are disabled", () => {
    const recipes: TerminalRecipe[] = [
      makeRecipe({ id: "alpha", name: "Alpha" }),
      makeRecipe({ id: "beta", name: "Beta" }),
    ];

    render(
      <RecipeRunnerGrid
        recipes={recipes}
        focusedIndex={0}
        setFocusedIndex={() => {}}
        onRun={noop}
        onEdit={noop}
        onDuplicate={noop}
        onPin={noop}
        onUnpin={noop}
        onDelete={noop}
        onCreate={noop}
        disabled
      />
    );

    const create = screen.getByRole("option", { name: /Create new recipe/ });
    expect(create.getAttribute("tabindex")).toBe("0");
  });
});

describe("RecipeRunnerGrid — arrow navigation", () => {
  const recipes: TerminalRecipe[] = [
    makeRecipe({ id: "alpha", name: "Alpha" }),
    makeRecipe({ id: "beta", name: "Beta" }),
    makeRecipe({ id: "gamma", name: "Gamma" }),
  ];

  it("ArrowDown moves focus and tabindex to the next option", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={0} />);
    const [alpha, beta, gamma] = recipes.map((r) => optionButton(r));

    alpha!.focus();
    fireEvent.keyDown(alpha!, { key: "ArrowDown" });

    expect(alpha!.getAttribute("tabindex")).toBe("-1");
    expect(beta!.getAttribute("tabindex")).toBe("0");
    expect(gamma!.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(beta);
  });

  it("ArrowUp moves focus to the previous option", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={1} />);
    const [alpha, beta] = recipes.map((r) => optionButton(r));

    beta!.focus();
    fireEvent.keyDown(beta!, { key: "ArrowUp" });

    expect(alpha!.getAttribute("tabindex")).toBe("0");
    expect(beta!.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(alpha);
  });

  it("wraps from the last option to the first on ArrowDown", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={3} />);
    const create = screen.getByRole("option", { name: /Create new recipe/ });
    const alpha = optionButton(recipes[0]!);

    create.focus();
    fireEvent.keyDown(create, { key: "ArrowDown" });

    expect(alpha.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(alpha);
  });

  it("wraps from the first option to the last on ArrowUp", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={0} />);
    const alpha = optionButton(recipes[0]!);
    const create = screen.getByRole("option", { name: /Create new recipe/ });

    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowUp" });

    expect(create.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(create);
  });

  it("Home jumps to the first option", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={2} />);
    const gamma = optionButton(recipes[2]!);
    const alpha = optionButton(recipes[0]!);

    gamma!.focus();
    fireEvent.keyDown(gamma!, { key: "Home" });

    expect(alpha!.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(alpha);
  });

  it("End jumps to the last option (the create button)", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={0} />);
    const alpha = optionButton(recipes[0]!);
    const create = screen.getByRole("option", { name: /Create new recipe/ });

    alpha!.focus();
    fireEvent.keyDown(alpha!, { key: "End" });

    expect(create.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(create);
  });

  it("does not intercept keys when a modifier is held", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={0} />);
    const alpha = optionButton(recipes[0]!);

    alpha!.focus();
    fireEvent.keyDown(alpha!, { key: "ArrowDown", metaKey: true });

    // Focus should not have moved; meta+arrow is left alone.
    expect(alpha!.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(alpha);
  });
});

describe("RecipeRunnerGrid — focus sync", () => {
  const recipes: TerminalRecipe[] = [
    makeRecipe({ id: "alpha", name: "Alpha" }),
    makeRecipe({ id: "beta", name: "Beta" }),
    makeRecipe({ id: "gamma", name: "Gamma" }),
  ];

  it("moves the roving tabindex to the focused option on focus events", () => {
    function StatefulHarness() {
      const [focusedIndex, setFocusedIndex] = useState(0);
      return (
        <RecipeRunnerGrid
          recipes={recipes}
          focusedIndex={focusedIndex}
          setFocusedIndex={setFocusedIndex}
          onRun={noop}
          onEdit={noop}
          onDuplicate={noop}
          onPin={noop}
          onUnpin={noop}
          onDelete={noop}
          onCreate={noop}
        />
      );
    }

    render(<StatefulHarness />);

    const beta = optionButton(recipes[1]!);
    const gamma = optionButton(recipes[2]!);
    fireEvent.focus(beta);

    expect(beta.getAttribute("tabindex")).toBe("0");
    expect(gamma.getAttribute("tabindex")).toBe("-1");
  });
});
