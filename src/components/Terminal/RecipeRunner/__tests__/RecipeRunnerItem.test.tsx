// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";

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
// Rendered inline so the menu's items can be read without driving Radix's
// right-click open path; the ownership tests are about which actions are offered.
vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  ContextMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <div role="menuitem" onClick={onSelect}>
      {children}
    </div>
  ),
  ContextMenuSeparator: () => <hr />,
}));
import { RecipeRunnerItem } from "../RecipeRunnerItem";
import {
  basePressTreatment,
  reduceMotionSelectors,
  transitionWideners,
} from "../../__tests__/launcherMotionContract";
import type { TerminalRecipe } from "@/types";

const recipe: TerminalRecipe = {
  id: "alpha",
  name: "Alpha",
  terminals: [{ type: "terminal", env: {} }],
  createdAt: 0,
};

const noop = () => {};

const renderItem = (
  mode: "grid" | "list",
  props?: { disabled?: boolean; recipe?: TerminalRecipe; onRun?: (id: string) => void }
) =>
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
    "carries exactly the press treatment the shared Button owns (%s mode)",
    (mode) => {
      const press = basePressTreatment();
      // Guard: if the shared recipe ever loses its `active:` classes there is
      // nothing left to enforce, and the comparison below would pass vacuously.
      expect(press.length).toBeGreaterThan(0);

      renderItem(mode);

      // Exact, not superset: a class the shared recipe has dropped must not
      // linger here either.
      const pressed = screen
        .getByRole("option")
        .className.split(/\s+/)
        .filter((c) => c.startsWith("active:"));

      expect(new Set(pressed)).toEqual(new Set(press));
    }
  );

  it.each(["grid", "list"] as const)(
    "keeps transform out of its transition set, so the press snaps (%s mode)",
    (mode) => {
      renderItem(mode);

      // Anything that pulls a transform into the transition set would ease the
      // scale back over the shared 150ms instead of snapping it.
      expect(transitionWideners(screen.getByRole("option").className)).toEqual([]);
    }
  );

  // `active:scale-*` emits the individual `scale` property, which the app's
  // `transform: none` reduced-motion button reset cannot neutralize — so only a
  // class the reduce-motion block actually names can stop the press scale.
  it.each(["grid", "list"] as const)(
    "registers the press scale with the reduce-animations kill switch (%s mode)",
    (mode) => {
      const suppressed = reduceMotionSelectors();
      expect(suppressed.size).toBeGreaterThan(0);

      renderItem(mode);

      const covered = screen
        .getByRole("option")
        .className.split(/\s+/)
        .filter((c) => suppressed.has(c));

      expect(covered.length).toBeGreaterThan(0);
    }
  );
});

describe("RecipeRunnerItem — scope indicator", () => {
  it.each(["grid", "list"] as const)(
    "renders same-named recipes from different scopes distinguishably (%s mode)",
    (mode) => {
      const global = { ...recipe, id: "g", name: "Work", projectId: undefined };
      const local = { ...recipe, id: "l", name: "Work", projectId: "proj-1" };

      const { unmount } = renderItem(mode, { recipe: global });
      const globalText = screen.getByRole("option").textContent ?? "";
      unmount();

      renderItem(mode, { recipe: local });
      const localText = screen.getByRole("option").textContent ?? "";

      expect(globalText).not.toBe(localText);
    }
  );

  it.each(["grid", "list"] as const)(
    "exposes the scope through the option's accessible name, not styling alone (%s mode)",
    (mode) => {
      renderItem(mode, { recipe: { ...recipe, projectId: "proj-1" } });
      // Screen readers flatten an option's descendant text into its name, so a
      // visible text label is what carries the scope to assistive tech.
      expect(screen.getByRole("option", { name: /Project-wide/ })).toBeTruthy();
    }
  );

  it.each(["grid", "list"] as const)(
    "keeps a shadowed recipe marked and runnable rather than hiding it (%s mode)",
    (mode) => {
      const onRun = vi.fn<(id: string) => void>();
      renderItem(mode, {
        recipe: { ...recipe, id: "shadowed", shadowedBy: "Alpha" },
        onRun,
      });

      const option = screen.getByRole("option");
      expect(option.textContent).toContain("Runs team recipe");
      expect(option.hasAttribute("disabled")).toBe(false);

      fireEvent.click(option);
      expect(onRun).toHaveBeenCalledWith("shadowed");
    }
  );
});

const pluginRecipe: TerminalRecipe = {
  ...recipe,
  id: "acme.tools.alpha",
  origin: { kind: "plugin", pluginId: "acme.tools", contributionId: "alpha" },
};

const menuLabels = () => screen.getAllByRole("menuitem").map((el) => el.textContent?.trim());

describe("RecipeRunnerItem — the context menu offers only what the recipe's owner allows", () => {
  it.each(["grid", "list"] as const)(
    "never offers a mutation the store rejects for a plugin recipe (%s mode)",
    (mode) => {
      for (const candidate of [recipe, pluginRecipe]) {
        const { unmount } = renderItem(mode, { recipe: candidate });
        const labels = menuLabels();
        const pluginOwned = candidate.origin?.kind === "plugin";
        const mutatesContent = labels.filter((l) => l === "Edit" || l?.startsWith("Delete"));
        // Content edits belong to whoever owns the content; everything else
        // (run, duplicate, pin) is the user's on any recipe.
        expect(mutatesContent.length > 0).toBe(!pluginOwned);
        expect(labels).toContain("Run");
        expect(labels).toContain("Duplicate");
        unmount();
      }
    }
  );
});
