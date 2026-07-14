// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { buttonVariants } from "@/components/ui/button";
import { RecipeRunnerItem } from "../RecipeRunnerItem";
import type { TerminalRecipe } from "@/types";

const recipe: TerminalRecipe = {
  id: "alpha",
  name: "Alpha",
  terminals: [{ type: "terminal", env: {} }],
  createdAt: 0,
};

const noop = () => {};

const renderItem = (mode: "grid" | "list", props?: { disabled?: boolean }) =>
  render(
    <RecipeRunnerItem
      recipe={recipe}
      isFocused={false}
      mode={mode}
      id="recipe-alpha"
      onRun={noop}
      onEdit={noop}
      onDuplicate={noop}
      onPin={noop}
      onUnpin={noop}
      onDelete={noop}
      {...props}
    />
  );

/**
 * The press treatment every shared `Button` inherits, read out of the cva
 * itself rather than copied: the `ghost` variant contributes no `active:`
 * classes of its own, so what survives is exactly the base press recipe. A
 * recipe card is a hand-rolled button, so nothing makes it inherit that — this
 * is what keeps it from drifting back to feeling inert on click.
 */
const basePressTreatment = () =>
  buttonVariants({ variant: "ghost" })
    .split(/\s+/)
    .filter((token) => token.startsWith("active:"));

describe("RecipeRunnerItem — press feedback", () => {
  it.each(["grid", "list"] as const)(
    "carries the same press treatment the shared Button owns (%s mode)",
    (mode) => {
      const press = basePressTreatment();
      // Guard: if the shared recipe ever loses its `active:` classes there is
      // nothing left to enforce, and the loop below would pass vacuously.
      expect(press.length).toBeGreaterThan(0);

      renderItem(mode);

      const classes = screen.getByRole("option").className.split(/\s+/);
      for (const token of press) expect(classes).toContain(token);
    }
  );

  it.each(["grid", "list"] as const)(
    "keeps transform out of its transition set, so the press snaps (%s mode)",
    (mode) => {
      renderItem(mode);

      // A bare `transition`/`transition-all` — or an explicit
      // `transition-transform` — would ease the scale back over the shared
      // 150ms instead of snapping it.
      const widened = screen
        .getByRole("option")
        .className.split(/\s+/)
        .filter((c) => ["transition", "transition-all", "transition-transform"].includes(c));

      expect(widened).toEqual([]);
    }
  );
});
