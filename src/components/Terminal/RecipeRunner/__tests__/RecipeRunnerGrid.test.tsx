// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState, type ReactNode } from "react";

// The launcher's truncating controls disclose their full name through the
// shared Tooltip, which needs a TooltipProvider ancestor it has no business
// growing inside a unit test. Stubbed the same way the panel suites do it —
// these tests are about keyboard behaviour, not the tooltip.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
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

  it("renders one option per recipe and no create option", () => {
    render(<Harness recipes={recipes} />);

    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.queryByRole("option", { name: /Create new recipe/ })).toBeNull();
  });

  it("places tabIndex=0 on the focused option and -1 on the rest", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={1} />);

    const [alpha, beta, gamma] = recipes.map((r) => optionButton(r));

    expect(alpha!.getAttribute("tabindex")).toBe("-1");
    expect(beta!.getAttribute("tabindex")).toBe("0");
    expect(gamma!.getAttribute("tabindex")).toBe("-1");
  });

  it("marks only the focused option with aria-selected=true", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={2} />);

    const [alpha, beta, gamma] = recipes.map((r) => optionButton(r));

    expect(alpha!.getAttribute("aria-selected")).toBe("false");
    expect(beta!.getAttribute("aria-selected")).toBe("false");
    expect(gamma!.getAttribute("aria-selected")).toBe("true");
  });

  it("clamps a cursor left past the last recipe so a card keeps the tab stop", () => {
    // List mode's Create row sits one past the last recipe in the hook's cursor.
    render(<Harness recipes={recipes} initialFocusedIndex={3} />);

    const [alpha, beta, gamma] = recipes.map((r) => optionButton(r));

    expect(alpha!.getAttribute("tabindex")).toBe("-1");
    expect(beta!.getAttribute("tabindex")).toBe("-1");
    expect(gamma!.getAttribute("tabindex")).toBe("0");
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
});

// jsdom has no layout, so every card reports offsetTop 0 and the grid reads as
// one row. Rows are laid out explicitly for the Up/Down cases.
function layOutRows(buttons: HTMLElement[], columns: number) {
  buttons.forEach((button, i) => {
    Object.defineProperty(button, "offsetTop", {
      configurable: true,
      get: () => Math.floor(i / columns) * 100,
    });
  });
}

describe("RecipeRunnerGrid — arrow navigation", () => {
  const recipes: TerminalRecipe[] = [
    makeRecipe({ id: "alpha", name: "Alpha" }),
    makeRecipe({ id: "beta", name: "Beta" }),
    makeRecipe({ id: "gamma", name: "Gamma" }),
  ];

  it("ArrowRight moves focus and tabindex to the next option", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={0} />);
    const [alpha, beta, gamma] = recipes.map((r) => optionButton(r));

    alpha!.focus();
    fireEvent.keyDown(alpha!, { key: "ArrowRight" });

    expect(alpha!.getAttribute("tabindex")).toBe("-1");
    expect(beta!.getAttribute("tabindex")).toBe("0");
    expect(gamma!.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(beta);
  });

  it("ArrowLeft moves focus to the previous option", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={1} />);
    const [alpha, beta] = recipes.map((r) => optionButton(r));

    beta!.focus();
    fireEvent.keyDown(beta!, { key: "ArrowLeft" });

    expect(alpha!.getAttribute("tabindex")).toBe("0");
    expect(beta!.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(alpha);
  });

  it("wraps from the last option to the first on ArrowRight", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={2} />);
    const [alpha, , gamma] = recipes.map((r) => optionButton(r));

    gamma!.focus();
    fireEvent.keyDown(gamma!, { key: "ArrowRight" });

    expect(alpha!.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(alpha);
  });

  it("wraps from the first option to the last on ArrowLeft", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={0} />);
    const [alpha, , gamma] = recipes.map((r) => optionButton(r));

    alpha!.focus();
    fireEvent.keyDown(alpha!, { key: "ArrowLeft" });

    expect(gamma!.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(gamma);
  });

  it("ArrowDown moves a whole row in a two-column grid", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={0} />);
    const buttons = recipes.map((r) => optionButton(r));
    layOutRows(buttons, 2);
    const [alpha, , gamma] = buttons;

    alpha!.focus();
    fireEvent.keyDown(alpha!, { key: "ArrowDown" });

    expect(gamma!.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(gamma);
  });

  it("ArrowUp moves a whole row in a two-column grid", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={2} />);
    const buttons = recipes.map((r) => optionButton(r));
    layOutRows(buttons, 2);
    const [alpha, , gamma] = buttons;

    gamma!.focus();
    fireEvent.keyDown(gamma!, { key: "ArrowUp" });

    expect(alpha!.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(alpha);
  });

  it("claims ArrowDown on the bottom row without moving focus", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={2} />);
    const buttons = recipes.map((r) => optionButton(r));
    layOutRows(buttons, 2);
    const gamma = buttons[2]!;

    gamma.focus();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    gamma.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(gamma.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(gamma);
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

  it("End jumps to the last recipe", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={0} />);
    const alpha = optionButton(recipes[0]!);
    const gamma = optionButton(recipes[2]!);

    alpha!.focus();
    fireEvent.keyDown(alpha!, { key: "End" });

    expect(gamma.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(gamma);
  });

  it("does not intercept keys when a modifier is held", () => {
    render(<Harness recipes={recipes} initialFocusedIndex={0} />);
    const alpha = optionButton(recipes[0]!);

    alpha!.focus();
    fireEvent.keyDown(alpha!, { key: "ArrowRight", metaKey: true });

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
