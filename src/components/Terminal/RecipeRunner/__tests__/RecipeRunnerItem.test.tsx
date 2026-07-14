// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RecipeRunnerItem } from "../RecipeRunnerItem";
import {
  basePressTreatment,
  reduceMotionSelectors,
  TRANSITION_WIDENERS,
} from "../../__tests__/launcherMotionContract";
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
        .filter((c) => TRANSITION_WIDENERS.includes(c));

      expect(widened).toEqual([]);
    }
  );

  // `active:scale-*` emits the individual `scale` property, which the app's
  // `transform: none` reduced-motion button reset cannot neutralize. A recipe
  // card is doubly exposed: it is a Radix context-menu trigger, so it carries a
  // `data-state` attribute, and that reset excludes `[data-state]` buttons
  // outright. Only a class the reduce-motion block names can stop the scale.
  it.each(["grid", "list"] as const)(
    "registers the press scale with the reduce-animations kill switch (%s mode)",
    (mode) => {
      const suppressed = reduceMotionSelectors();
      expect(suppressed.size).toBeGreaterThan(0);

      renderItem(mode);
      const button = screen.getByRole("option");

      // The exclusion this guards against is only real while the card is a
      // Radix trigger — assert that premise rather than trusting it.
      expect(button.getAttribute("data-state")).toBeTruthy();

      const covered = button.className.split(/\s+/).filter((c) => suppressed.has(c));
      expect(covered.length).toBeGreaterThan(0);
    }
  );
});
