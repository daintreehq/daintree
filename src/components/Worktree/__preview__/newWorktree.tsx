// First: the bridge must exist before any client module reads it.
import { PREVIEW_ROOT, PROJECT_ID, SCENARIO } from "./newWorktreeBridge";
import { StrictMode, lazy, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import motionFeatures from "@/lib/motionFeatures";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { registerBuiltinView } from "@/registry/builtinRendererRegistry";
import { useProjectStore } from "@/store/projectStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useRecipeStore } from "@/store/recipeStore";
import type { WorktreeState } from "@/types";
import type { Issue, PR } from "@shared/types/forge";
import type { Project, TerminalRecipe } from "@shared/types/project";
import { NewWorktreeDialog } from "../NewWorktreeDialog";
import "@/index.css";

/**
 * Standalone visual-review harness for `NewWorktreeDialog`.
 *
 * The real dialog against the real theme tokens and `index.css`; its bridge
 * calls are answered by `newWorktreeBridge.ts`, which also explains `?scenario=`.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?scenario=rest|issue|…    see the bridge
 *   ?agent=claude             the project's remembered first agent
 */

const params = new URLSearchParams(window.location.search);
applyAppThemeToRoot(document.documentElement, resolveAppTheme(params.get("theme") ?? "daintree"));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const PROJECT = {
  id: PROJECT_ID,
  path: PREVIEW_ROOT,
  name: "helios-dashboard",
  emoji: "🌲",
  lastOpened: Date.now(),
} as Project;

const worktreeStore = createWorktreeStore();
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture
const inUse = {
  id: "/Users/you/Code/helios-dashboard-worktrees/uploads",
  path: "/Users/you/Code/helios-dashboard-worktrees/uploads",
  name: "uploads",
  branch: "feature/streaming-uploads",
} as unknown as WorktreeState;
worktreeStore.setState({ worktrees: new Map([[inUse.id, inUse]]) });
setCurrentViewStore(worktreeStore);
useProjectStore.setState({ currentProject: PROJECT });

const agent = params.get("agent");
usePreferencesStore.setState({
  assignWorktreeToSelf: true,
  lastSelectedWorktreeAgentIdByProject: agent ? { [PROJECT_ID]: agent } : {},
  lastSelectedWorktreeRecipeIdByProject: {},
});

const RECIPES: TerminalRecipe[] =
  SCENARIO === "bare"
    ? []
    : [
        {
          id: "recipe-pair",
          name: "Claude + Codex pair",
          projectId: PROJECT_ID,
          terminals: [
            { type: "claude", title: "Claude", env: {}, initialPrompt: "" },
            { type: "codex", title: "Codex", env: {}, initialPrompt: "" },
          ],
          createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
        },
        {
          id: "recipe-tests",
          name: "Dev server + tests",
          projectId: PROJECT_ID,
          terminals: [
            { type: "terminal", title: "Dev", command: "npm run dev", env: {} },
            { type: "terminal", title: "Tests", command: "npm test -- --watch", env: {} },
          ],
          createdAt: Date.now() - 12 * 24 * 60 * 60 * 1000,
        },
      ];
useRecipeStore.setState({
  globalRecipes: [],
  pluginRecipes: [],
  inRepoRecipes: [],
  projectRecipes: RECIPES,
  recipes: RECIPES,
  currentProjectId: PROJECT_ID,
  isLoading: false,
});

registerBuiltinView(
  "github.issueSelector",
  lazy(() =>
    import("../../../../plugins/builtin/github/renderer/components/IssueSelector").then((m) => ({
      default: m.IssueSelector,
    }))
  ),
  { pluginId: "daintree.github", label: "Issue picker" }
);

const ISSUE: Issue = {
  number: 11958,
  title: "Retry backoff ignores the server's Retry-After header",
  body: "",
  state: "open",
  rawState: "OPEN",
  url: "https://github.com/helios-labs/helios-dashboard/issues/11958",
  author: { login: "mira-okafor", avatarUrl: "", rawData: null },
  assignees: [],
  labels: [],
  commentCount: 0,
  createdAt: Date.parse("2026-09-20T09:00:00Z"),
  updatedAt: Date.parse("2026-09-27T09:00:00Z"),
  rawData: {},
};

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture
const PULL = {
  number: 12044,
  title: "Stream large uploads in chunks instead of buffering the whole file",
  body: "Closes #11990",
  state: "open",
  rawState: "OPEN",
  isDraft: false,
  merged: false,
  url: "https://github.com/helios-labs/helios-dashboard/pull/12044",
  baseRef: "develop",
  headRef: SCENARIO === "pr-unresolved" ? "feature/chunked-uploads" : "feature/dark-mode-tokens",
} as PR;

function Preview() {
  const [open, setOpen] = useState(true);
  return (
    <div data-preview-shell className="h-screen w-screen">
      <NewWorktreeDialog
        isOpen={open}
        onClose={() => setOpen(false)}
        rootPath={PREVIEW_ROOT}
        initialIssue={SCENARIO === "issue" ? ISSUE : null}
        initialPR={SCENARIO === "pr" || SCENARIO === "pr-unresolved" ? PULL : null}
      />
    </div>
  );
}

const { LazyMotion } = await import("framer-motion");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LazyMotion strict features={motionFeatures}>
      <WorktreeStoreContext.Provider value={worktreeStore}>
        <TooltipProvider>
          <Preview />
        </TooltipProvider>
      </WorktreeStoreContext.Provider>
    </LazyMotion>
  </StrictMode>
);
