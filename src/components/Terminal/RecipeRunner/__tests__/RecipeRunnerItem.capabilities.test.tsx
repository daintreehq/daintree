// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

// Rendered inline so the menu's items can be read without driving Radix's
// right-click open path; these tests are about which actions are offered.
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
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
import { RecipeRunnerItem } from "../RecipeRunnerItem";
import type { TerminalRecipe } from "@/types";

const userRecipe: TerminalRecipe = {
  id: "alpha",
  name: "Alpha",
  terminals: [{ type: "terminal", env: {} }],
  createdAt: 0,
};
const pluginRecipe: TerminalRecipe = {
  ...userRecipe,
  id: "acme.tools.alpha",
  origin: { kind: "plugin", pluginId: "acme.tools", contributionId: "alpha" },
};

const noop = () => {};
const menuLabels = () => screen.getAllByRole("menuitem").map((el) => el.textContent?.trim());

describe("RecipeRunnerItem — the context menu offers only what the recipe's owner allows", () => {
  it.each(["grid", "list"] as const)(
    "never offers a mutation the store rejects for a plugin recipe (%s mode)",
    (mode) => {
      for (const recipe of [userRecipe, pluginRecipe]) {
        const { unmount } = render(
          <RecipeRunnerItem
            recipe={recipe}
            isFocused={false}
            mode={mode}
            id={`recipe-${recipe.id}`}
            onRun={noop}
            onEdit={noop}
            onDuplicate={noop}
            onPin={noop}
            onUnpin={noop}
            onDelete={noop}
          />
        );
        const labels = menuLabels();
        const pluginOwned = recipe.origin?.kind === "plugin";
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
