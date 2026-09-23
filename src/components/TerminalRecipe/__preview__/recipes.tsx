import { FROZEN_NOW } from "./bootstrap";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useRecipeStore } from "@/store/recipeStore";
import { useProjectStore } from "@/store/projectStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import type { Project, RecipeTerminal, RunCommand, TerminalRecipe } from "@/types";
import { RecipeManager } from "../RecipeManager";
import { RecipeEditor } from "../RecipeEditor";
import { RecipeRunner } from "@/components/Terminal/RecipeRunner/RecipeRunner";
import "@/index.css";

/**
 * Standalone visual-review harness for recipe management and launch.
 *
 * Mounts the real `RecipeManager` (the sidebar's dialog), the real
 * `RecipeRunner` (the recipe band on the empty canvas) and the real
 * `RecipeEditor` against the real theme tokens and `index.css`, with the recipe
 * store seeded across all four sources: global, plugin, team (in-repo) and
 * project. The Electron harness (`canvas-home-review.spec.ts`) can only reach
 * in-repo recipes from disk, and a manager with one source populated hides
 * every density question worth asking.
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?view=manager|runner      which surface to mount (default manager)
 *   ?fixture=…                inventory, see MANAGER_FIXTURES / RUNNER_FIXTURES
 *   ?edit=<recipe id>         open the editor on that recipe instead
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const view = params.get("view") === "runner" ? "runner" : "manager";
const fixture = params.get("fixture") ?? "populated";
const editId = params.get("edit");

const DAY = 24 * 60 * 60 * 1000;
const PROJECT_ID = "preview-project";

const claude = (title?: string, initialPrompt?: string): RecipeTerminal => ({
  type: "claude",
  title,
  initialPrompt,
  env: {},
});
const codex = (title?: string): RecipeTerminal => ({ type: "codex", title, env: {} });
const shell = (title: string, command: string): RecipeTerminal => ({
  type: "terminal",
  title,
  command,
  env: {},
});
const devServer = (): RecipeTerminal => ({
  type: "dev-preview",
  title: "Dev server",
  devCommand: "npm run dev",
  env: {},
});

let seq = 0;
function recipe(
  name: string,
  terminals: RecipeTerminal[],
  extra: Partial<TerminalRecipe> = {}
): TerminalRecipe {
  seq += 1;
  return {
    id: `recipe-${seq}`,
    name,
    terminals,
    createdAt: FROZEN_NOW - 40 * DAY,
    ...extra,
  };
}
const used = (daysAgo: number) => ({
  lastUsedAt: FROZEN_NOW - daysAgo * DAY,
  usageHistory: [FROZEN_NOW - daysAgo * DAY],
});
const project = { projectId: PROJECT_ID };
const team = (slug: string) => ({ id: `inrepo-${slug}`, scope: "inrepo" as const, ...project });
const plugin = (pluginId: string, contributionId: string) => ({
  id: `${pluginId}.${contributionId}`,
  origin: { kind: "plugin" as const, pluginId, contributionId },
});

interface Inventory {
  global: TerminalRecipe[];
  plugin: TerminalRecipe[];
  team: TerminalRecipe[];
  project: TerminalRecipe[];
}

function populated(): Inventory {
  return {
    global: [
      recipe("Work an issue", [claude("Work", "/work {{issue_number}}")], {
        ...used(2),
        showInEmptyState: true,
      }),
      recipe("Design review", [claude("Design review"), codex("Reviewer")], used(9)),
      recipe("Scratch shell", [shell("Shell", "")]),
    ],
    plugin: [
      recipe(
        "Release checklist",
        [claude("Release"), shell("Changelog", "npm run changelog")],
        plugin("acme.release-tools", "release")
      ),
    ],
    team: [
      recipe("Full stack", [devServer(), shell("API", "npm run api"), claude("Agent")], {
        ...team("full-stack"),
        ...used(0.2),
        showInEmptyState: true,
      }),
      recipe(
        "Test watch",
        [shell("Vitest", "npm test -- --watch"), shell("Coverage", "npm run coverage")],
        team("test-watch")
      ),
    ],
    project: [
      recipe("Test watch", [shell("Vitest", "npx vitest")], { ...project, ...used(20) }),
      recipe(
        "Migrate remaining Jest suites to Vitest",
        [claude("Migrate"), codex("Check"), shell("Tests", "npm test")],
        { ...project, ...used(1) }
      ),
      recipe("Storybook", [shell("Storybook", "npm run storybook")], {
        ...project,
        worktreeId: "wt-feature",
      }),
    ],
  };
}

function crowded(): Inventory {
  const base = populated();
  const more = (n: number, prefix: string, extra: Partial<TerminalRecipe>) =>
    Array.from({ length: n }, (_, i) =>
      recipe(
        `${prefix} ${i + 1}${i % 3 === 0 ? " with a deliberately long descriptive name" : ""}`,
        i % 2 ? [claude(), codex(), shell("Logs", "tail -f log")] : [claude()],
        { ...extra, ...(i % 4 === 0 ? used(i + 1) : {}) }
      )
    );
  return {
    global: [...base.global, ...more(5, "Global flow", {})],
    plugin: [
      ...base.plugin,
      recipe("Deploy preview", [shell("Deploy", "vercel")], plugin("acme.deploy", "preview")),
      recipe(
        "Incident triage",
        [claude("Triage"), shell("Logs", "kubectl logs")],
        plugin("acme.sre-toolbox-with-a-long-publisher-name", "triage")
      ),
    ],
    team: [
      ...base.team,
      ...Array.from({ length: 4 }, (_, i) =>
        recipe(`Team flow ${i + 1}`, [claude(), shell("Server", "npm start")], team(`flow-${i}`))
      ),
    ],
    project: [...base.project, ...more(6, "Project task", project)],
  };
}

function only(kind: keyof Inventory): Inventory {
  const base = populated();
  return {
    global: [],
    plugin: [],
    team: [],
    project: [],
    [kind]: base[kind],
  } as Inventory;
}

const EMPTY: Inventory = { global: [], plugin: [], team: [], project: [] };

const MANAGER_FIXTURES: Record<string, () => Inventory> = {
  populated,
  crowded,
  empty: () => EMPTY,
  "global-only": () => only("global"),
  "project-only": () => only("project"),
};

/**
 * The canvas band only ever sees the merged list for the active worktree, so
 * its fixtures are counts rather than sources: one (hero card), three (grid),
 * many (> 6 switches to the filterable list).
 */
function runnerInventory(): Inventory {
  const base = populated();
  switch (fixture) {
    case "empty":
    case "suggestions":
      return EMPTY;
    case "one":
      return { ...EMPTY, team: [base.team[0]!] };
    case "three":
      return { ...EMPTY, global: base.global.slice(0, 2), team: [base.team[0]!] };
    case "many":
      return crowded();
    default:
      return base;
  }
}

function merge(inv: Inventory): TerminalRecipe[] {
  const teamNames = new Set(inv.team.map((r) => r.name));
  return [
    ...inv.global,
    ...inv.plugin,
    ...inv.project.map((r) => (teamNames.has(r.name) ? { ...r, shadowedBy: r.name } : r)),
    ...inv.team,
  ];
}

const SUGGESTIONS: RunCommand[] = [
  { id: "npm-dev", name: "dev", command: "npm run dev" },
  { id: "npm-test", name: "test", command: "npm test" },
] as RunCommand[];

function seedStores(): void {
  const inv = view === "runner" ? runnerInventory() : (MANAGER_FIXTURES[fixture] ?? populated)();
  useRecipeStore.setState({
    globalRecipes: inv.global,
    pluginRecipes: inv.plugin,
    inRepoRecipes: inv.team,
    projectRecipes: inv.project,
    recipes: merge(inv),
    currentProjectId: PROJECT_ID,
    isLoading: false,
  });
  useProjectStore.setState({
    currentProject: {
      id: PROJECT_ID,
      path: "/Users/dev/helios-dashboard",
      name: "helios-dashboard",
      emoji: "🌻",
      lastOpened: FROZEN_NOW,
    } as Project,
  });
  if (fixture === "suggestions") {
    useProjectSettingsStore.setState({ allDetectedRunners: SUGGESTIONS });
  }
}

seedStores();

// The editor reads the per-view worktree store and throws without a provider.
const worktreeStore = createWorktreeStore();
setCurrentViewStore(worktreeStore);

function ManagerView() {
  const [editing, setEditing] = useState<TerminalRecipe | undefined>(() =>
    editId ? useRecipeStore.getState().recipes.find((r) => r.id === editId) : undefined
  );
  return (
    <>
      <RecipeManager
        isOpen={editing === undefined}
        onClose={() => {}}
        onEditRecipe={setEditing}
        onCreateRecipe={() => {}}
      />
      {editing && (
        <RecipeEditor
          recipe={editing}
          worktreeId={editing.worktreeId}
          defaultScope={editing.projectId === undefined ? "global" : "project"}
          isOpen
          onClose={() => setEditing(undefined)}
        />
      )}
    </>
  );
}

/**
 * The canvas column the band really sits in: `@container/launcher` at the
 * canvas home's 38rem measure, centred on the canvas surface. Only the band is
 * real; the heading is a stand-in so the band has something above it.
 */
function RunnerView() {
  return (
    <div className="flex min-h-screen flex-col items-center bg-surface-canvas p-8">
      <section
        data-preview-canvas=""
        className="@container/launcher flex w-full max-w-[38rem] flex-col items-center"
      >
        <h3 className="mb-6 text-2xl font-semibold tracking-tight text-text-primary">
          helios-dashboard
        </h3>
        <div data-preview-band="" className="mb-6 flex w-full justify-center">
          <RecipeRunner activeWorktreeId="wt-main" defaultCwd="/Users/dev/helios-dashboard" />
        </div>
      </section>
    </div>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    setReady(true);
  }, [scheme]);

  if (!ready) return null;
  return (
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={worktreeStore}>
        {view === "runner" ? <RunnerView /> : <ManagerView />}
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
