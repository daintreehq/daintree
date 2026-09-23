// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/components/ui/AppDialog", () => {
  const Dialog = ({ children, isOpen }: { children: ReactNode; isOpen: boolean }) =>
    isOpen ? <div role="dialog">{children}</div> : null;
  Dialog.Header = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  Dialog.Title = ({ children }: { children: ReactNode }) => <h2>{children}</h2>;
  Dialog.CloseButton = () => <button type="button" aria-label="Close dialog" />;
  Dialog.Body = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  Dialog.Footer = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { AppDialog: Dialog };
});
vi.mock("@/components/ui/ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
// Items rendered inline so the row's menu can be read without opening it.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => (
    <div role="menuitem">{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

import { RecipeManager } from "../RecipeManager";
import { useRecipeStore } from "@/store/recipeStore";
import { useProjectStore } from "@/store/projectStore";
import type { Project, TerminalRecipe } from "@/types";

const recipe = (id: string, name: string, extra: Partial<TerminalRecipe> = {}): TerminalRecipe => ({
  id,
  name,
  terminals: [{ type: "terminal", env: {} }],
  createdAt: 0,
  ...extra,
});

const GLOBAL = [recipe("g1", "Work an issue", { showInEmptyState: true }), recipe("g2", "Review")];
const PROJECT = [recipe("p1", "Storybook", { projectId: "proj" })];
const TEAM = [recipe("inrepo-t1", "Full stack", { scope: "inrepo", projectId: "proj" })];
const PLUGIN = [
  recipe("acme.tools.rel", "Release", {
    origin: { kind: "plugin", pluginId: "acme.tools", contributionId: "rel" },
  }),
];

function seed(inv: {
  global?: TerminalRecipe[];
  project?: TerminalRecipe[];
  team?: TerminalRecipe[];
  plugin?: TerminalRecipe[];
}) {
  useRecipeStore.setState({
    globalRecipes: inv.global ?? [],
    projectRecipes: inv.project ?? [],
    inRepoRecipes: inv.team ?? [],
    pluginRecipes: inv.plugin ?? [],
  });
}

const renderManager = () =>
  render(
    <RecipeManager isOpen onClose={() => {}} onEditRecipe={() => {}} onCreateRecipe={() => {}} />
  );

const rows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-recipe-row]"));

beforeEach(() => {
  useProjectStore.setState({
    currentProject: { id: "proj", name: "proj", path: "/p", emoji: "🌲", lastOpened: 0 } as Project,
  });
});

describe("RecipeManager — every row's actions are findable without hovering", () => {
  it("gives each row a named actions control that is not hidden at rest", () => {
    seed({ global: GLOBAL, project: PROJECT, team: TEAM, plugin: PLUGIN });
    renderManager();
    expect(rows().length).toBe(5);
    for (const row of rows()) {
      const name = row.dataset.recipeRow!;
      const trigger = within(row).getByRole("button", { name: `More actions for recipe ${name}` });
      // A hover- or focus-within-gated reveal hides the control from anyone
      // scanning the list; nothing between the row and its trigger may do that.
      for (
        let el: HTMLElement | null = trigger;
        el && el !== row.parentElement;
        el = el.parentElement
      ) {
        expect(el.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
      }
    }
  });

  it("offers content edits only on recipes the user owns", () => {
    seed({ global: GLOBAL, project: PROJECT, team: TEAM, plugin: PLUGIN });
    renderManager();
    for (const row of rows()) {
      const name = row.dataset.recipeRow!;
      const pluginOwned = PLUGIN.some((r) => r.name === name);
      const edit = within(row).queryByRole("button", { name: `Edit recipe ${name}` });
      const del = within(row)
        .queryAllByRole("menuitem")
        .filter((el) => el.textContent?.startsWith("Delete"));
      expect(edit === null).toBe(pluginOwned);
      expect(del.length === 0).toBe(pluginOwned);
    }
  });
});

describe("RecipeManager — a row does not repeat what its section already says", () => {
  it("never labels a row with the name of the section it sits in", () => {
    seed({ global: GLOBAL, project: PROJECT, team: TEAM, plugin: PLUGIN });
    renderManager();
    for (const section of Array.from(document.querySelectorAll("section"))) {
      const heading = section.querySelector("h3")!.firstChild!.textContent!;
      const source = heading.replace(/ recipes$/, "");
      for (const badge of Array.from(section.querySelectorAll('[data-slot="badge"]'))) {
        expect(badge.textContent?.trim()).not.toBe(source);
      }
    }
  });
});

describe("RecipeManager — absence takes one place, not one per source", () => {
  it("shows a single empty state when there are no recipes anywhere", () => {
    seed({});
    renderManager();
    expect(document.querySelectorAll("[data-empty-state-icon]").length).toBe(1);
    expect(document.querySelectorAll("section").length).toBe(0);
  });

  it("collapses an empty source to one line when others have recipes", () => {
    seed({ project: PROJECT });
    renderManager();
    expect(document.querySelectorAll("[data-empty-state-icon]").length).toBe(0);
    const globalSection = screen
      .getByRole("heading", { name: /Global recipes/ })
      .closest("section")!;
    expect(globalSection.querySelectorAll("p").length).toBeGreaterThan(0);
    expect(within(globalSection).queryAllByRole("button", { name: /More actions/ }).length).toBe(0);
  });
});

describe("RecipeManager — only a recipe that is actually overridden says so", () => {
  it("marks a same-named project recipe, never a same-named global one", () => {
    seed({
      global: [recipe("g-same", "Full stack")],
      project: [recipe("p-same", "Full stack", { projectId: "proj" })],
      team: TEAM,
    });
    renderManager();
    const overridden = rows().filter((row) =>
      row.textContent?.includes("Overridden by team recipe")
    );
    // mergeRecipes shadows the project-local tier alone; a global recipe of the
    // same name still launches as itself.
    expect(
      overridden.map((row) => row.closest("section")?.getAttribute("aria-labelledby"))
    ).toEqual(["recipe-section-project"]);
  });
});
