// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
    primaryAction,
  }: {
    children?: ReactNode;
    secondaryAction?: { label: string; onClick: () => void };
    primaryAction?: { label: string; onClick: () => void; disabled?: boolean };
  }) => (
    <div>
      {children}
      {secondaryAction && (
        <button type="button" onClick={secondaryAction.onClick}>
          {secondaryAction.label}
        </button>
      )}
      {primaryAction && (
        <button type="button" disabled={primaryAction.disabled} onClick={primaryAction.onClick}>
          {primaryAction.label}
        </button>
      )}
    </div>
  );
  return { AppDialog: Dialog };
});
vi.mock("@/components/ui/ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("@/components/ui/select", () => import("@/components/ui/__tests__/nativeSelectMock"));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));
const truncation = vi.hoisted(() => ({ isTruncated: false }));
vi.mock("@/hooks/useTruncationDetection", () => ({
  useTruncationDetection: () => ({ ref: () => {}, isTruncated: truncation.isTruncated }),
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

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify")>()),
  notify: notifyMock,
}));

import { RecipeManager } from "../RecipeManager";
import { globalRecipesClient, projectClient } from "@/clients";
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
  truncation.isTruncated = false;
  notifyMock.mockReset();
  useProjectStore.setState({
    currentProject: { id: "proj", name: "proj", path: "/p", emoji: "🌲", lastOpened: 0 } as Project,
  });
});

describe("RecipeManager — open triggers and clipped summaries (#17280)", () => {
  it("holds the hover fill on the open More and Import triggers", () => {
    seed({ global: GLOBAL });
    renderManager();
    const more = screen.getAllByRole("button", { name: /^More actions for recipe/ })[0]!;
    const imp = screen.getAllByRole("button", { name: /Import/ })[0]!;
    for (const el of [more, imp]) {
      expect(el.className).toContain("aria-expanded:bg-overlay-hover");
      expect(el.className).not.toContain("aria-expanded:bg-overlay-raised");
    }
  });

  it("discloses the full terminal summary only when it is clipped", () => {
    const summaryTips = () =>
      screen
        .queryAllByTestId("tooltip-content")
        .filter((e) => /^\d+ terminals?/.test(e.textContent ?? ""));
    seed({ global: GLOBAL });
    renderManager();
    expect(summaryTips()).toHaveLength(0);
    cleanup();
    truncation.isTruncated = true;
    renderManager();
    const tips = summaryTips().map((e) => e.textContent);
    expect(tips).toHaveLength(rows().length);
    for (const row of rows()) {
      const shown = Array.from(row.querySelectorAll("span.truncate"))
        .map((e) => e.textContent ?? "")
        .find((t) => /^\d+ terminals?/.test(t));
      expect(shown).toBeTruthy();
      expect(tips).toContain(shown);
    }
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

describe("RecipeManager — importing a recipe file", () => {
  const CLEAN = JSON.stringify({
    name: "From file",
    terminals: [{ type: "terminal", command: "ls" }],
  });
  const MIXED = JSON.stringify({
    name: "From file",
    terminals: [{ type: "terminal", command: "ls" }, { type: "acme-agent" }],
  });

  const ready = () => ({
    status: "ready",
    fileName: "from-file.json",
    json: CLEAN,
    recipe: { name: "From file", terminals: [{ type: "terminal", command: "ls" }] },
  });
  const refused = () => {
    const { accepted, rejected } = inspectRecipeTerminals(JSON.parse(MIXED).terminals);
    return {
      status: "refused",
      fileName: "from-file.json",
      json: MIXED,
      error: new RecipeImportDropsTerminalsError(accepted.length, rejected),
    };
  };

  const activate = async (el: HTMLElement) => {
    await act(async () => {
      el.click();
    });
  };

  async function importFromFile(result: unknown, inventory: Parameters<typeof seed>[0] = {}) {
    const readRecipeFile = vi.fn().mockResolvedValue(result);
    const importRecipe = vi.fn(async (projectId: string | undefined, json: string) =>
      recipe("recipe-new", JSON.parse(json).name, projectId ? { projectId } : {})
    );
    useRecipeStore.setState({ readRecipeFile, importRecipe });
    seed(inventory);
    renderManager();
    const entry =
      screen.queryByRole("button", { name: "Import from file" }) ??
      screen.getByRole("menuitem", { name: /Import from file/ });
    await activate(entry);
    return { readRecipeFile, importRecipe };
  }

  const field = () => screen.queryByTestId<HTMLTextAreaElement>("recipe-import-textarea");
  const importDialogOpen = () => screen.queryByRole("heading", { name: "Import recipe" }) !== null;

  describe("with a project open", () => {
    it.each([
      ["the empty state", {}],
      ["the inventory's import menu", { global: GLOBAL }],
    ])(
      "saves nothing from %s until a scope is confirmed, then imports to Team",
      async (_, inventory) => {
        const { importRecipe } = await importFromFile(ready(), inventory);

        expect(importDialogOpen()).toBe(true);
        expect(importRecipe).not.toHaveBeenCalled();
        expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("project");
        expect(document.body.textContent).toContain("from-file.json");

        await activate(screen.getByRole("button", { name: "Import recipe" }));
        expect(importRecipe).toHaveBeenCalledWith("proj", CLEAN, undefined);
        expect(importDialogOpen()).toBe(false);
      }
    );

    it("imports the same file as Global when Global is chosen", async () => {
      const { importRecipe } = await importFromFile(ready(), { global: GLOBAL });

      fireEvent.change(screen.getByRole("combobox"), { target: { value: "global" } });
      await activate(screen.getByRole("button", { name: "Import recipe" }));

      expect(importRecipe).toHaveBeenCalledWith(undefined, CLEAN, undefined);
    });

    it("saves nothing when the dialog is cancelled", async () => {
      const { importRecipe } = await importFromFile(ready(), { global: GLOBAL });
      await activate(screen.getByRole("button", { name: "Cancel" }));

      expect(importDialogOpen()).toBe(false);
      expect(importRecipe).not.toHaveBeenCalled();
    });

    it.each([
      ["the empty state", {}],
      ["the inventory's import menu", { global: GLOBAL }],
    ])(
      "opens a file that would drop terminals from %s on its JSON and what would be dropped (#15044)",
      async (_, inventory) => {
        await importFromFile(refused(), inventory);

        expect(field()?.value).toBe(MIXED);
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
      expect(document.body.textContent).not.toContain("from-file.json");
    });

    it("clears a filter that would hide the recipe it imported", async () => {
      await importFromFile(ready(), { global: GLOBAL });
      // The filter is typed after the dialog opened; the manager behind it keeps it.
      const filterField = screen.getByRole("searchbox", { name: "Filter recipes" });
      fireEvent.change(filterField, { target: { value: "Work" } });
      expect((filterField as HTMLInputElement).value).toBe("Work");

      await activate(screen.getByRole("button", { name: "Import recipe" }));

      expect((filterField as HTMLInputElement).value).toBe("");
    });
  });

  // Global is the only place a file can go, so there is nothing to confirm.
  describe("with no project open", () => {
    beforeEach(() => {
      useProjectStore.setState({ currentProject: null });
    });

    it("imports a clean file as Global in one click", async () => {
      const { importRecipe } = await importFromFile(ready(), { global: GLOBAL });

      expect(importRecipe).toHaveBeenCalledWith(undefined, CLEAN);
      expect(importDialogOpen()).toBe(false);
    });

    it("still opens a file that would drop terminals for review", async () => {
      const { importRecipe } = await importFromFile(refused(), { global: GLOBAL });

      expect(importRecipe).not.toHaveBeenCalled();
      expect(field()?.value).toBe(MIXED);
      expect(document.body.textContent).toContain("1 terminal can't be imported");
    });
  });

  it("does nothing when the picker is cancelled", async () => {
    const { importRecipe } = await importFromFile({ status: "cancelled" }, { global: GLOBAL });
    expect(importRecipe).not.toHaveBeenCalled();
    expect(importDialogOpen()).toBe(false);
  });
});

describe("RecipeManager — copying and exporting team and overridden recipes (#17200)", () => {
  // A team recipe has no projectId of its own; the fixtures above that give it
  // one would hide exactly this.
  const TEAM_ROW = recipe("inrepo-shared", "Shared recipe", {
    scope: "inrepo",
    terminals: [{ type: "terminal", command: "team-only", env: {} }],
  });
  const LOCAL_ROW = recipe("recipe-local", "Shared recipe", {
    projectId: "proj",
    terminals: [{ type: "terminal", command: "local-only", env: {} }],
  });

  const rowById = (id: string) =>
    document.querySelector<HTMLElement>(`[data-recipe-id="${CSS.escape(id)}"]`)!;
  const item = (row: HTMLElement, name: RegExp) => within(row).getByRole("menuitem", { name });
  const activate = async (el: HTMLElement) => {
    await act(async () => {
      el.click();
    });
  };
  const writeText = vi.fn();

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    useRecipeStore.setState({ currentProjectId: "proj" });
  });

  describe("duplicating", () => {
    it("copies a team recipe into the open project, not into Global", async () => {
      const updateInRepo = vi
        .spyOn(projectClient, "updateInRepoRecipe")
        .mockResolvedValue(undefined);
      const addGlobal = vi.spyOn(globalRecipesClient, "addRecipe").mockResolvedValue(undefined);
      seed({ team: [TEAM_ROW] });
      renderManager();

      await activate(item(rowById("inrepo-shared"), /Duplicate recipe/));

      expect(addGlobal).not.toHaveBeenCalled();
      expect(updateInRepo).toHaveBeenCalledTimes(1);
      expect(updateInRepo.mock.calls[0]![0]).toBe("proj");
      const copy = rows().find((r) => r.dataset.recipeRow === "Shared recipe (Copy)")!;
      expect(copy.closest("section")?.getAttribute("aria-labelledby")).toBe("recipe-section-team");
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("copies the overridden local row, not the team recipe that overrides it", async () => {
      const updateInRepo = vi
        .spyOn(projectClient, "updateInRepoRecipe")
        .mockResolvedValue(undefined);
      seed({ project: [LOCAL_ROW], team: [TEAM_ROW] });
      renderManager();

      await activate(item(rowById("recipe-local"), /Duplicate recipe/));

      expect(updateInRepo.mock.calls[0]![1].terminals[0]?.command).toBe("local-only");
    });

    it("says why a copy failed and offers one Retry that tries again", async () => {
      const updateInRepo = vi
        .spyOn(projectClient, "updateInRepoRecipe")
        .mockRejectedValueOnce(new Error("EACCES"))
        .mockResolvedValue(undefined);
      seed({ team: [TEAM_ROW] });
      renderManager();

      await activate(item(rowById("inrepo-shared"), /Duplicate recipe/));

      expect(notifyMock).toHaveBeenCalledTimes(1);
      const toast = notifyMock.mock.calls[0]![0];
      expect(toast).toMatchObject({
        type: "error",
        title: "Couldn't duplicate recipe",
        priority: "high",
      });
      expect(toast.message).toContain("EACCES");
      expect(toast.action.label).toBe("Retry");

      await act(async () => {
        toast.action.onClick();
      });

      expect(updateInRepo).toHaveBeenCalledTimes(2);
      expect(notifyMock).toHaveBeenCalledTimes(1);
    });

    it("says a team recipe can't be copied with no project open", async () => {
      const updateInRepo = vi.spyOn(projectClient, "updateInRepoRecipe");
      const addGlobal = vi.spyOn(globalRecipesClient, "addRecipe");
      useRecipeStore.setState({ currentProjectId: null });
      seed({ team: [TEAM_ROW] });
      renderManager();

      await activate(item(rowById("inrepo-shared"), /Duplicate recipe/));

      expect(updateInRepo).not.toHaveBeenCalled();
      expect(addGlobal).not.toHaveBeenCalled();
      expect(notifyMock.mock.calls[0]![0].message).toContain("Open a project");
    });
  });

  describe("exporting a row an override badge sits on", () => {
    it("copies that row's JSON, not the team recipe's", async () => {
      seed({ project: [LOCAL_ROW], team: [TEAM_ROW] });
      renderManager();
      expect(rowById("recipe-local").textContent).toContain("Overridden by team recipe");

      await activate(item(rowById("recipe-local"), /Copy as JSON/));

      expect(writeText).toHaveBeenCalledTimes(1);
      const copied = JSON.parse(writeText.mock.calls[0]![0]);
      expect(copied.id).toBe("recipe-local");
      expect(copied.terminals[0].command).toBe("local-only");
    });

    it("writes that row to the file, not the team recipe", async () => {
      const exportToFile = vi.spyOn(projectClient, "exportRecipeToFile").mockResolvedValue(true);
      seed({ project: [LOCAL_ROW], team: [TEAM_ROW] });
      renderManager();

      await activate(item(rowById("recipe-local"), /Export to file/));

      expect(exportToFile).toHaveBeenCalledTimes(1);
      const written = JSON.parse(exportToFile.mock.calls[0]![1]);
      expect(written.id).toBe("recipe-local");
      expect(written.terminals[0].command).toBe("local-only");
    });

    it("says when the file couldn't be written and offers one way to try again", async () => {
      const exportToFile = vi
        .spyOn(projectClient, "exportRecipeToFile")
        .mockRejectedValueOnce(new Error("ENOSPC"))
        .mockResolvedValue(true);
      seed({ team: [TEAM_ROW] });
      renderManager();

      await activate(item(rowById("inrepo-shared"), /Export to file/));

      expect(notifyMock).toHaveBeenCalledTimes(1);
      const toast = notifyMock.mock.calls[0]![0];
      expect(toast).toMatchObject({
        type: "error",
        title: "Couldn't export recipe",
        priority: "high",
      });
      expect(toast.message).toContain("ENOSPC");
      expect(toast.action.label).toBe("Choose another file");

      await act(async () => {
        toast.action.onClick();
      });

      expect(exportToFile).toHaveBeenCalledTimes(2);
    });

    it("stays quiet when the picker is cancelled", async () => {
      vi.spyOn(projectClient, "exportRecipeToFile").mockResolvedValue(false);
      seed({ team: [TEAM_ROW] });
      renderManager();

      await activate(item(rowById("inrepo-shared"), /Export to file/));

      expect(notifyMock).not.toHaveBeenCalled();
    });
  });

  describe("pinning", () => {
    it("says when the pin couldn't be saved and retries the same change", async () => {
      const updateRecipe = vi
        .fn()
        .mockRejectedValueOnce(new Error("EBUSY"))
        .mockResolvedValue("saved");
      useRecipeStore.setState({ updateRecipe });
      seed({ global: [recipe("g1", "Review")] });
      renderManager();

      await activate(
        within(rowById("g1")).getByRole("menuitemcheckbox", { name: /Pin to canvas/ })
      );

      expect(updateRecipe).toHaveBeenCalledWith("g1", { showInEmptyState: true });
      expect(notifyMock).toHaveBeenCalledTimes(1);
      const toast = notifyMock.mock.calls[0]![0];
      expect(toast).toMatchObject({
        type: "error",
        title: "Couldn't update recipe pin",
        priority: "high",
      });
      expect(toast.message).toContain("EBUSY");
      expect(toast.action.label).toBe("Retry");

      await act(async () => {
        toast.action.onClick();
      });

      expect(updateRecipe).toHaveBeenCalledTimes(2);
      expect(updateRecipe).toHaveBeenLastCalledWith("g1", { showInEmptyState: true });
    });
  });
});
