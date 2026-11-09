// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/components/ui/AppDialog", () => {
  const Dialog = ({ children, isOpen }: { children: ReactNode; isOpen: boolean }) =>
    isOpen ? <div role="dialog">{children}</div> : null;
  Dialog.Header = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  Dialog.Title = ({ children }: { children: ReactNode }) => <h2>{children}</h2>;
  Dialog.CloseButton = () => <button type="button" aria-label="Close dialog" />;
  Dialog.Body = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  Dialog.Footer = ({
    children,
    secondaryAction,
  }: {
    children?: ReactNode;
    secondaryAction?: { label: string; onClick: () => void };
  }) => (
    <div>
      {children}
      {secondaryAction && (
        <button type="button" onClick={secondaryAction.onClick}>
          {secondaryAction.label}
        </button>
      )}
    </div>
  );
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
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <div role="menuitem" onClick={onSelect}>
      {children}
    </div>
  ),
  DropdownMenuCheckboxItem: ({
    children,
    checked,
    onSelect,
  }: {
    children: ReactNode;
    checked?: boolean;
    onSelect?: () => void;
  }) => (
    <div role="menuitemcheckbox" aria-checked={checked} onClick={onSelect}>
      {children}
    </div>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

import { RecipeManager } from "../RecipeManager";
import { projectClient } from "@/clients";
import { useRecipeStore } from "@/store/recipeStore";
import { useProjectStore } from "@/store/projectStore";
import type { Project, TerminalRecipe } from "@/types";
import { RecipeImportDropsTerminalsError } from "@/utils/recipeImport";
import { inspectRecipeTerminals } from "@shared/utils/recipeSanitizer";
import { mergeRecipes } from "@shared/utils/recipeListing";

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
  const [global, project, team, plugin] = [
    inv.global ?? [],
    inv.project ?? [],
    inv.team ?? [],
    inv.plugin ?? [],
  ];
  useRecipeStore.setState({
    globalRecipes: global,
    projectRecipes: project,
    inRepoRecipes: team,
    pluginRecipes: plugin,
    recipes: mergeRecipes(global, project, team, plugin),
  });
}

const renderManager = (
  onCreateRecipe: (scope: "global" | "project") => void = () => {},
  onEditRecipe: (recipe: TerminalRecipe) => void = () => {}
) =>
  render(
    <RecipeManager
      isOpen
      onClose={() => {}}
      onEditRecipe={onEditRecipe}
      onCreateRecipe={onCreateRecipe}
    />
  );

const sectionOf = (name: RegExp) => screen.getByRole("heading", { name }).closest("section")!;

const rows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-recipe-row]"));

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("RecipeManager — a plugin recipe names its plugin", () => {
  it("names a project plugin by its manifest id, never its instance key (#13796)", () => {
    const instanceKey = "project__0123abcd__acme.local";
    seed({
      plugin: [
        recipe(`${instanceKey}.boot`, "Boot", {
          origin: { kind: "plugin", pluginId: instanceKey, contributionId: "boot" },
        }),
      ],
    });
    renderManager();
    const [row] = rows();
    expect(row?.textContent).toContain("From acme.local");
    expect(row?.textContent).not.toContain("0123abcd");
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

describe("RecipeManager — a new recipe in a project is a team recipe, and says so (#16262)", () => {
  const click = async (el: HTMLElement) => {
    await act(async () => {
      el.click();
    });
  };
  const creatorLabels = () =>
    screen
      .getAllByRole("button", { name: /^New / })
      .map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim());
  const rowNames = (section: HTMLElement) =>
    Array.from(section.querySelectorAll("[data-recipe-row]")).map((r) =>
      r.getAttribute("data-recipe-row")
    );

  it("puts the project-level New on Team recipes and opens the editor on the project scope", async () => {
    seed({ global: GLOBAL, project: PROJECT, team: TEAM });
    const onCreateRecipe = vi.fn();
    renderManager(onCreateRecipe);

    await click(within(sectionOf(/Team recipes/)).getByRole("button", { name: "New team recipe" }));
    expect(onCreateRecipe).toHaveBeenLastCalledWith("project");

    await click(
      within(sectionOf(/Global recipes/)).getByRole("button", { name: "New global recipe" })
    );
    expect(onCreateRecipe).toHaveBeenLastCalledWith("global");
  });

  it("lists sections global, team, project, plugin", () => {
    seed({ global: GLOBAL, project: PROJECT, team: TEAM, plugin: PLUGIN });
    renderManager();
    expect(
      Array.from(document.querySelectorAll("section h3")).map((h) => h.firstChild?.textContent)
    ).toEqual(["Global recipes", "Team recipes", "Project recipes", "Plugin recipes"]);
  });

  it("keeps a legacy machine-local recipe editable, and makes no promise about new ones", async () => {
    seed({ global: GLOBAL, project: PROJECT, team: TEAM });
    const onEditRecipe = vi.fn();
    renderManager(() => {}, onEditRecipe);

    const section = sectionOf(/Project recipes/);
    expect(within(section).queryAllByRole("button", { name: /^New/ })).toEqual([]);
    const description = section.querySelector("p")!.textContent!;
    expect(description).toMatch(/this machine/);
    expect(description).toMatch(/team recipe/);
    expect(description).not.toMatch(/\bnew\b|none yet/i);

    await click(within(section).getByRole("button", { name: "Edit recipe Storybook" }));
    expect(onEditRecipe).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
  });

  it.each([
    ["a populated inventory", { global: GLOBAL, project: PROJECT, team: TEAM }],
    ["a team section with nothing in it", { global: GLOBAL }],
  ])("never promises a new recipe stays on this machine outside Global (%s)", (_, inventory) => {
    seed(inventory);
    renderManager();

    expect(creatorLabels()).toEqual(["New global recipe", "New team recipe"]);
    for (const section of Array.from(document.querySelectorAll("section"))) {
      if (section.querySelector("h3")?.textContent?.startsWith("Global")) continue;
      // The legacy section may say where its existing recipes live, never where
      // a new one will go.
      const promise = Array.from(section.querySelectorAll("p"))
        .map((p) => p.textContent)
        .filter((text) => /stays on this machine until/i.test(text ?? ""));
      expect(promise).toEqual([]);
    }
  });

  it("shows Team recipes while empty, with the next action, and hides Project recipes", () => {
    seed({ global: GLOBAL });
    renderManager();

    expect(screen.queryByRole("heading", { name: /Project recipes/ })).toBeNull();
    const team = sectionOf(/Team recipes/);
    expect(within(team).getByRole("button", { name: "New team recipe" })).toBeDefined();
    expect(team.textContent).toMatch(/None yet/);
    expect(team.textContent).toMatch(/git status/);
  });

  it.each([
    ["an opaque id marked by scope", { id: "recipe-opaque-1", scope: "inrepo" as const }],
    ["an inrepo- id without the scope marker", { id: "inrepo-legacy" }],
  ])(
    "lists only machine-local recipes under Project recipes, never a team recipe's mirror (%s)",
    (_, ids) => {
      const team = recipe(ids.id, "Deploy", { ...ids, projectId: "proj" });
      const mirror = { ...team, lastUsedAt: 5 };
      seed({ project: [mirror, ...PROJECT], team: [team] });
      renderManager();

      expect(rowNames(sectionOf(/Project recipes/))).toEqual(["Storybook"]);
      const teamSection = sectionOf(/Team recipes/);
      expect(rowNames(teamSection)).toEqual(["Deploy"]);
      expect(teamSection.textContent).not.toContain("Overridden by team recipe");
    }
  );

  it("hides Project recipes when the machine-local store holds only team mirrors", () => {
    seed({ project: [{ ...TEAM[0]! }], team: TEAM });
    renderManager();

    expect(screen.queryByRole("heading", { name: /Project recipes/ })).toBeNull();
  });

  it("keeps listing a marked local record that no team recipe backs", () => {
    seed({ project: [recipe("inrepo-orphan", "Orphan", { scope: "inrepo", projectId: "proj" })] });
    renderManager();

    expect(rowNames(sectionOf(/Project recipes/))).toEqual(["Orphan"]);
  });

  it("opens a team recipe from its row with the env values only the mirror holds", async () => {
    const canonical = recipe("inrepo-env", "Env", {
      scope: "inrepo",
      projectId: "proj",
      terminals: [{ type: "terminal", env: { MODE: "" } }],
    });
    const mirror = {
      ...canonical,
      terminals: [{ type: "terminal" as const, env: { MODE: "dev" } }],
    };
    seed({ project: [mirror], team: [canonical] });
    const onEditRecipe = vi.fn();
    renderManager(() => {}, onEditRecipe);

    await click(within(sectionOf(/Team recipes/)).getByRole("button", { name: "Edit recipe Env" }));
    expect(onEditRecipe.mock.calls[0]![0].terminals[0].env).toEqual({ MODE: "dev" });
  });

  it("filters to the team row once, with no mirror left under Project recipes", () => {
    const team = recipe("inrepo-full", "Full stack", { scope: "inrepo", projectId: "proj" });
    seed({ project: [{ ...team }, ...PROJECT], team: [team] });
    renderManager();

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter recipes" }), {
      target: { value: "Full" },
    });
    expect(rows().map((r) => r.dataset.recipeRow)).toEqual(["Full stack"]);
    expect(screen.queryByRole("heading", { name: /Project recipes/ })).toBeNull();
  });

  it("drops the empty Team section while filtering, and brings it back when the filter clears", () => {
    seed({ global: GLOBAL, project: PROJECT });
    renderManager();
    const filter = screen.getByRole("searchbox", { name: "Filter recipes" });

    fireEvent.change(filter, { target: { value: "Storybook" } });
    expect(screen.getByRole("heading", { name: /Project recipes/ })).toBeDefined();
    expect(screen.queryByRole("heading", { name: /Team recipes/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^New / })).toBeNull();

    fireEvent.change(filter, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "New team recipe" })).toBeDefined();
  });

  it.each([
    ["no project is open", null],
    ["the open project has no id", { id: "", name: "x", path: "/x", lastOpened: 0 } as Project],
  ])("offers no team New when %s", (_, currentProject) => {
    useProjectStore.setState({ currentProject });
    seed({ global: GLOBAL });
    renderManager();

    expect(screen.queryByRole("heading", { name: /Team recipes/ })).toBeNull();
    expect(creatorLabels()).toEqual(["New global recipe"]);
  });

  it("leads the zero-data state with a team recipe when a project is open", async () => {
    seed({});
    const onCreateRecipe = vi.fn();
    renderManager(onCreateRecipe);

    expect(creatorLabels()).toEqual(["New team recipe", "New global recipe"]);
    const [primary, secondary] = screen.getAllByRole("button", { name: /^New / });
    await click(primary!);
    expect(onCreateRecipe).toHaveBeenLastCalledWith("project");
    await click(secondary!);
    expect(onCreateRecipe).toHaveBeenLastCalledWith("global");
  });

  it.each([
    ["no project is open", null],
    ["the open project has no id", { id: "", name: "x", path: "/x", lastOpened: 0 } as Project],
  ])("leads the zero-data state with a global recipe when %s", async (_, currentProject) => {
    useProjectStore.setState({ currentProject });
    seed({});
    const onCreateRecipe = vi.fn();
    renderManager(onCreateRecipe);

    expect(creatorLabels()).toEqual(["New global recipe"]);
    await click(screen.getByRole("button", { name: "New global recipe" }));
    expect(onCreateRecipe).toHaveBeenLastCalledWith("global");
  });

  it("lists the recipe the store just created under Team recipes", async () => {
    vi.spyOn(projectClient, "updateInRepoRecipe").mockResolvedValue(undefined as never);
    seed({ global: GLOBAL });
    renderManager();

    await act(async () => {
      await useRecipeStore
        .getState()
        .createRecipe("proj", "Just made", undefined, [{ type: "terminal", env: {} }]);
    });

    const row = rows().find((r) => r.dataset.recipeRow === "Just made")!;
    const section = row.closest("section")!;
    expect(section.getAttribute("aria-labelledby")).toBe("recipe-section-team");
    expect(section.querySelector("h3")?.textContent).toContain("Team recipes");
    expect(section.textContent).toContain(".daintree/recipes/");
  });
});

describe("RecipeManager — a file import that can't come across whole (#15044)", () => {
  const json = JSON.stringify({
    name: "From file",
    terminals: [{ type: "terminal", command: "ls" }, { type: "acme-agent" }],
  });

  const refused = () => {
    const { accepted, rejected } = inspectRecipeTerminals(JSON.parse(json).terminals);
    return {
      status: "refused",
      json,
      error: new RecipeImportDropsTerminalsError(accepted.length, rejected),
    };
  };

  const activate = async (el: HTMLElement) => {
    await act(async () => {
      el.click();
    });
  };

  async function importFromFile(result: unknown, inventory: Parameters<typeof seed>[0] = {}) {
    const importRecipeFromFile = vi.fn().mockResolvedValue(result);
    useRecipeStore.setState({ importRecipeFromFile });
    seed(inventory);
    renderManager();
    const entry =
      screen.queryByRole("button", { name: "Import from file" }) ??
      screen.getByRole("menuitem", { name: /Import from file/ });
    await activate(entry);
    return importRecipeFromFile;
  }

  const field = () => screen.queryByTestId<HTMLTextAreaElement>("recipe-import-textarea");

  it.each([
    ["the empty state", {}],
    ["the inventory's import menu", { global: GLOBAL }],
  ])(
    "opens the import dialog from %s on the file's JSON and what would be dropped",
    async (_, inventory) => {
      const importRecipeFromFile = await importFromFile(refused(), inventory);

      expect(importRecipeFromFile).toHaveBeenCalledWith("proj");
      expect(field()?.value).toBe(json);
      expect(document.body.textContent).toContain("1 terminal can't be imported");
      expect(document.body.textContent).toContain('can\'t launch type "acme-agent"');
    }
  );

  it("forgets the file once the dialog closes", async () => {
    await importFromFile(refused(), { global: GLOBAL });
    await activate(screen.getByRole("button", { name: "Cancel" }));
    expect(field()).toBeNull();

    await activate(screen.getByRole("menuitem", { name: /Import from clipboard/ }));
    expect(field()?.value).toBe("");
    expect(document.body.textContent).not.toContain("can't be imported");
  });

  it("leaves a clean file import at one click", async () => {
    const importRecipeFromFile = await importFromFile({ status: "imported" });
    expect(importRecipeFromFile).toHaveBeenCalledTimes(1);
    expect(field()).toBeNull();
  });
});
