import "@/components/Layout/__preview__/launcherShims";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { usePreferencesStore } from "@/store/preferencesStore";
import { ProjectSwitcherPalette } from "../ProjectSwitcherPalette";
import { ProjectGroupDialogs } from "../ProjectGroupMenus";
import { useProjectGroupsStore } from "@/store/projectGroupsStore";
import { useProjectStore } from "@/store/projectStore";
import type { ProjectGroup } from "@shared/types/project";
import {
  PROJECT_SECTION_LABELS,
  type ProjectSectionKey,
  type ProjectBandKey,
  type ProjectSwitcherBrowseBand,
  type ProjectSwitcherProjectRow,
  type ProjectSwitcherRow,
  type ProjectSwitcherScratchRow,
  type SearchableScratch,
} from "@/hooks/useProjectSwitcherPalette";
import {
  installOtherHosts,
  isHostsFixture,
  settleOtherHosts,
  useOtherHostsReader,
} from "./otherHostsFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the project switcher: every state the
 * palette draws from fixtures, against the real tokens and `index.css`.
 * `project-switcher-review.spec.ts` drives it.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?state=browse|dropdown|dropdown-menu|search|nomatch|empty|collapsed
 *          |groups|groups-search|new-group|manage-groups|delete-group|archived-open
 *          |hosts-search|hosts-search-host
 *   ?hosts=offline|mixed|rich|search   other hosts for the band below Scratch
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const state = params.get("state") ?? "browse";
const hostsParam = params.get("hosts");
const hostsFixture = isHostsFixture(hostsParam) ? hostsParam : null;
if (hostsFixture) installOtherHosts(hostsFixture);

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const NOW = Date.now();
const MIN = 60_000;

function project(
  id: string,
  name: string,
  emoji: string,
  color: string,
  section: ProjectBandKey,
  extra: Partial<ProjectSwitcherProjectRow> = {}
): ProjectSwitcherProjectRow {
  return {
    kind: "project",
    id,
    name,
    path: `/Users/dev/Projects/${id}`,
    displayPath: id,
    emoji,
    color,
    status: "active",
    isBackground: false,
    isMissing: false,
    isPinned: false,
    frecencyScore: 1,
    section,
    lastOpened: NOW - 3 * 60 * MIN,
    isActive: false,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    snoozedAgentCount: 0,
    processCount: 0,
    ...extra,
  };
}

const PROJECTS: ProjectSwitcherProjectRow[] = [
  project("daintree", "daintree", "🌳", "emerald", "current", {
    isActive: true,
    isOpenInThisWindow: true,
    activeAgentCount: 2,
    processCount: 3,
    lastOpened: NOW,
  }),
  project("helios-dashboard", "Helios Dashboard", "☀️", "amber", "attention", {
    activeAgentCount: 1,
    waitingAgentCount: 2,
    processCount: 3,
    oldestWaitingSince: NOW - 11 * MIN,
  }),
  project("payments-api", "payments-api", "💳", "violet", "running", {
    activeAgentCount: 3,
    processCount: 3,
    latestWorkingSince: NOW - 4 * MIN,
    openInOtherWindow: "foreground",
  }),
  project("assistant", "assistant", "🤖", "blue", "pinned", { isPinned: true }),
  project("marketing-site", "marketing-site", "📣", "rose", "other"),
  project("backend", "backend", "🛠️", "slate", "other", { resumableAgentCount: 2 }),
  project(
    "design-tokens-and-theme-system",
    "design-tokens-and-theme-system",
    "🎨",
    "pink",
    "other"
  ),
  project("docs", "docs", "📚", "teal", "other"),
  project("legacy-importer", "legacy-importer", "📦", "orange", "unavailable", {
    isMissing: true,
  }),
];

const BANDS: ProjectSwitcherBrowseBand[] = (
  ["current", "attention", "running", "pinned", "other", "unavailable"] as ProjectSectionKey[]
).map((key) => ({
  key,
  label: PROJECT_SECTION_LABELS[key],
  itemCount: PROJECTS.filter((p) => p.section === key).length,
  collapsed: false,
}));

function scratch(
  id: string,
  name: string,
  lastOpenedAgoDays: number,
  extra: Partial<SearchableScratch> = {}
): SearchableScratch {
  return {
    id,
    name,
    path: `/Users/dev/.daintree/scratch/${id}`,
    createdAt: NOW - 20 * 86_400_000,
    lastOpened: NOW - lastOpenedAgoDays * 86_400_000,
    isActive: false,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    snoozedAgentCount: 0,
    processCount: 0,
    ...extra,
  };
}

const SCRATCHES: SearchableScratch[] = [
  scratch("spike-auth", "Spike: auth refresh", 0.1, { activeAgentCount: 1, processCount: 1 }),
  scratch("try-vite", "Try Vite 9", 2),
  scratch("old-bisect", "Bisect flaky shard", 13),
];

const noop = () => {};

const GROUPS: ProjectGroup[] = [
  { id: "daintree", name: "Daintree", position: 0, sortMode: "mostUsed", createdAt: 1 },
  { id: "crisp", name: "Crisp Vector", position: 1, sortMode: "alphabetical", createdAt: 2 },
  { id: "games", name: "Games", position: 2, sortMode: "recent", createdAt: 3 },
];
const groupNamed = (id: string) => GROUPS.find((g) => g.id === id)!;

// The groups fixtures stand in for what the hook bands from real data: a
// current project lifted out of its group, a group with a running member, a
// folded group still reporting its run, an empty group, the residual Other
// band, and the Archived band folded by default.
const GROUPED_PROJECTS: ProjectSwitcherProjectRow[] = [
  project("daintree-app", "Daintree", "🌴", "emerald", "current", {
    isActive: true,
    isOpenInThisWindow: true,
    activeAgentCount: 2,
    processCount: 3,
    groupId: "daintree",
    groupName: "Daintree",
  }),
  project("daintree-website", "Daintree Website", "🌴", "emerald", "group:daintree", {
    activeAgentCount: 1,
    processCount: 1,
    latestWorkingSince: NOW - 6 * MIN,
    groupId: "daintree",
    groupName: "Daintree",
  }),
  project("assistant-backend", "Daintree Assistant Backend", "☁️", "sky", "group:daintree", {
    groupId: "daintree",
    groupName: "Daintree",
  }),
  project("canopy-model-backend", "canopy-model-backend", "🖥️", "slate", "group:daintree", {
    groupId: "daintree",
    groupName: "Daintree",
  }),
  project("strongtyped", "StrongTyped", "🔧", "slate", "other"),
  project("logorefine", "LogoRefine", "✨", "amber", "other"),
  project("lifeplan", "LifePlan", "🧮", "rose", "other"),
  project("businessbenchmark", "BusinessBenchmark", "📈", "teal", "other", {
    resumableAgentCount: 1,
  }),
];

const GROUPED_BANDS: ProjectSwitcherBrowseBand[] = [
  { key: "current", label: "Current project", itemCount: 1, collapsed: false },
  {
    key: "group:daintree",
    label: "Daintree",
    itemCount: 3,
    collapsed: false,
    group: groupNamed("daintree"),
    liftedCount: 1,
    activeAgentCount: 1,
  },
  {
    key: "group:crisp",
    label: "Crisp Vector",
    itemCount: 2,
    collapsed: true,
    group: groupNamed("crisp"),
    activeAgentCount: 1,
    workingAssistantCount: 1,
  },
  {
    key: "group:games",
    label: "Games",
    itemCount: 0,
    collapsed: false,
    group: groupNamed("games"),
    liftedCount: 0,
  },
  { key: "other", label: "Other projects", itemCount: 4, collapsed: false },
  { key: "archived", label: "Archived", itemCount: 3, collapsed: true },
];

const GROUP_SEARCH_ROWS: ProjectSwitcherProjectRow[] = [
  project("crisp-vector-website", "crisp-vector-website", "⚙️", "slate", "group:crisp", {
    groupId: "crisp",
    groupName: "Crisp Vector",
  }),
  project("crisp-vector-backend", "crisp-vector-backend", "🗄️", "slate", "archived", {
    groupId: "crisp",
    groupName: "Crisp Vector",
    isArchived: true,
  }),
  // A long name in a long-named group: the group name truncates, "Archived" stays.
  project(
    "crisp-vector-marketing-redesign",
    "crisp-vector-marketing-site-redesign-2026",
    "🎨",
    "pink",
    "archived",
    { groupId: "crisp", groupName: "Crisp Vector", isArchived: true }
  ),
];

// Archived rows for the open Archived band: one plain, one still filed under a
// group (it keeps its group for when it comes back), one with a long name.
const ARCHIVED_ROWS: ProjectSwitcherProjectRow[] = [
  project("ask-google", "ask-google", "🔎", "sky", "archived", { isArchived: true }),
  project("crisp-vector-backend", "crisp-vector-backend", "🗄️", "slate", "archived", {
    isArchived: true,
    groupId: "crisp",
    groupName: "Crisp Vector",
  }),
  project("greg-priday-writing", "Greg Priday Writing", "📝", "amber", "archived", {
    isArchived: true,
  }),
];

const GROUP_STATES = [
  "groups",
  "groups-search",
  "new-group",
  "manage-groups",
  "delete-group",
  "archived-open",
];
const isGroupsState = GROUP_STATES.includes(state);
if (isGroupsState) {
  useProjectGroupsStore.setState({
    groups: GROUPS,
    dialog:
      state === "new-group"
        ? { kind: "create", projectId: "strongtyped" }
        : state === "manage-groups"
          ? { kind: "manage" }
          : state === "delete-group"
            ? { kind: "delete", groupId: "crisp" }
            : null,
  });
  // The dialogs read membership and names off the project store, as in the app.
  const member = (id: string, name: string, groupId?: string) =>
    ({
      id,
      name,
      path: `/Users/dev/Projects/${id}`,
      emoji: "🌲",
      lastOpened: NOW,
      groupId,
    }) as const;
  useProjectStore.setState({
    projects: [
      member("daintree-app", "Daintree", "daintree"),
      member("daintree-website", "Daintree Website", "daintree"),
      member("assistant-backend", "Daintree Assistant Backend", "daintree"),
      member("canopy-model-backend", "canopy-model-backend", "daintree"),
      member("crisp-vector-website", "crisp-vector-website", "crisp"),
      member("crisp-vector-backend", "crisp-vector-backend", "crisp"),
      member("strongtyped", "StrongTyped"),
    ],
  });
}

function withCollapsed(bands: ProjectSwitcherBrowseBand[], keys: ProjectBandKey[]) {
  return bands.map((band) => (keys.includes(band.key) ? { ...band, collapsed: true } : band));
}

interface Fixture {
  query: string;
  results: ProjectSwitcherRow[];
  bands?: ProjectSwitcherBrowseBand[];
  scratches: SearchableScratch[];
  ranked: boolean;
}

function fixture(): Fixture {
  switch (state) {
    case "search": {
      const scratchRow: ProjectSwitcherScratchRow = {
        kind: "scratch",
        ...scratch("design-spike", "Design spike: tokens", 0.1, {
          activeAgentCount: 1,
          processCount: 1,
        }),
      };
      const rows: ProjectSwitcherRow[] = [
        PROJECTS[0]!,
        PROJECTS[6]!,
        scratchRow,
        PROJECTS[7]!,
        PROJECTS[1]!,
      ];
      return {
        query: "d",
        results: rows,
        scratches: SCRATCHES,
        ranked: true,
      };
    }
    case "nomatch":
      return {
        query: "kubernetes",
        results: [],
        scratches: SCRATCHES,
        ranked: true,
      };
    case "empty":
      return { query: "", results: [], bands: [], scratches: [], ranked: false };
    case "archived-open":
      return {
        query: "",
        results: [...GROUPED_PROJECTS, ...ARCHIVED_ROWS],
        bands: GROUPED_BANDS.map((band) =>
          band.key === "archived" ? { ...band, collapsed: false, itemCount: 3 } : band
        ),
        scratches: SCRATCHES,
        ranked: false,
      };
    case "groups":
    case "new-group":
    case "manage-groups":
    case "delete-group":
      return {
        query: "",
        results: GROUPED_PROJECTS,
        bands: GROUPED_BANDS,
        scratches: SCRATCHES,
        ranked: false,
      };
    case "groups-search":
      return {
        query: "crisp",
        results: GROUP_SEARCH_ROWS,
        scratches: SCRATCHES,
        ranked: true,
      };
    // Nothing here matches; another host's project does, and takes Enter.
    case "hosts-search":
      return { query: "hub", results: [], scratches: SCRATCHES, ranked: true };
    // The query names a host that isn't connected, and nothing else.
    case "hosts-search-host":
      return { query: "studio-02", results: [], scratches: SCRATCHES, ranked: true };
    case "collapsed": {
      const collapsedKeys: ProjectBandKey[] = ["other", "pinned"];
      return {
        query: "",
        results: PROJECTS.filter((p) => !collapsedKeys.includes(p.section)),
        bands: withCollapsed(BANDS, collapsedKeys),
        scratches: SCRATCHES,
        ranked: false,
      };
    }
    default:
      return {
        query: "",
        results: PROJECTS,
        bands: BANDS,
        scratches: SCRATCHES,
        ranked: false,
      };
  }
}

if (state === "collapsed") {
  usePreferencesStore.getState().setProjectSwitcherBandCollapsed("scratch", true);
}

function Surface() {
  const data = fixture();
  const [query, setQuery] = useState(data.query);
  const results = data.results;
  const [selectedIndex, setSelectedIndex] = useState(results.length > 1 ? 1 : 0);
  // Mirrors the app: the ⌘⌥P modal (`ModalHostLayer`) mounts without the
  // project commands, the toolbar dropdown carries settings, open and clone.
  const dropdown = state === "dropdown" || state === "dropdown-menu";

  return (
    <ProjectSwitcherPalette
      isOpen
      mode={dropdown ? "dropdown" : "modal"}
      query={query}
      results={results}
      browseBands={data.bands}
      selectedIndex={selectedIndex}
      onQueryChange={setQuery}
      onSelectPrevious={() => setSelectedIndex((i) => Math.max(0, i - 1))}
      onSelectNext={() => setSelectedIndex((i) => Math.min(results.length - 1, i + 1))}
      onSelect={noop}
      onClose={noop}
      onHoverRow={(id) => setSelectedIndex(results.findIndex((r) => r.id === id))}
      rankedSearch={data.ranked}
      scratchResults={data.scratches}
      onSelectScratch={noop}
      onCreateScratch={noop}
      onRenameScratch={noop}
      onRequestDeleteScratch={noop}
      onRequestDeleteAllScratches={noop}
      onSaveAsProject={noop}
      onAddProject={dropdown ? noop : undefined}
      onCloneRepo={dropdown ? noop : undefined}
      onOpenProjectSettings={dropdown ? noop : undefined}
      onStopProject={noop}
      onCloseProject={noop}
      onSleepProject={noop}
      onLocateProject={noop}
      onMoveOrRenameProject={noop}
      onTogglePinProject={noop}
      onCopyPath={noop}
      onSelectNewWindow={noop}
      fleetLiveness={
        data.results.length > 0 ? { runningAgentCount: 6, workingAssistantCount: 0 } : undefined
      }
    >
      <Button variant="outline" className="m-4 w-64 h-12 justify-start">
        🌳 daintree
      </Button>
    </ProjectSwitcherPalette>
  );
}

function OtherHostsReader() {
  useOtherHostsReader();
  return null;
}

/** With other hosts, the palette mounts once their listings have settled. */
function Root() {
  const [ready, setReady] = useState(hostsFixture === null);
  useEffect(() => {
    if (!hostsFixture) return;
    settleOtherHosts().then(
      () => setReady(true),
      (error: unknown) => {
        document.body.dataset.hostsError = String(error);
      }
    );
  }, []);
  return (
    <>
      {hostsFixture && <OtherHostsReader />}
      {ready && <Surface />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <div data-preview-frame className="h-screen w-screen">
        <Root />
        {isGroupsState && <ProjectGroupDialogs />}
      </div>
    </TooltipProvider>
  </StrictMode>
);
