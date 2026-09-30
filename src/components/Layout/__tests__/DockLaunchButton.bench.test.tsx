// @vitest-environment jsdom
/**
 * Benchmark: what agent-state churn costs the two always-mounted launcher
 * buttons (toolbar + dock) while their menus are closed, and what opening and
 * searching costs afterwards. Model builds are counted at the panel-kind
 * registry read `buildDockLaunchModel` makes once per build; Fuse indexes at
 * the constructor. Prints a table; the assertions pin the gated result. The
 * count gates are soft, so a run against the ungated code still prints every
 * row of the table to compare.
 *
 *   npx vitest run src/components/Layout/__tests__/DockLaunchButton.bench.test.tsx
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import {
  getPanelKindConfig,
  getPanelKindIds,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";

const counters = vi.hoisted(() => ({ builds: 0, fuse: 0 }));

vi.mock("fuse.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fuse.js")>();
  const Real = actual.default;
  class CountingFuse<T> extends Real<T> {
    constructor(...args: ConstructorParameters<typeof Real<T>>) {
      super(...args);
      counters.fuse += 1;
    }
  }
  return { ...actual, default: CountingFuse };
});

vi.mock("@/registry", () => ({
  getSpawnablePanelKinds: (): PanelKindConfig[] => {
    counters.builds += 1;
    return getPanelKindIds()
      .filter((id) => id !== "agent")
      .map((id) => getPanelKindConfig(id))
      .filter((c): c is PanelKindConfig => c !== undefined && c.showInPalette !== false);
  },
  subscribeToPanelKindDefinitions: () => () => {},
  getPanelKindDefinitionsSnapshot: () => 0,
}));

// A real Zustand store, so the launcher's selector subscribes and re-renders
// exactly as it does against the production panel store.
vi.mock("@/store/panelStore", async () => {
  const { create } = await import("zustand");
  return {
    usePanelStore: create(() => ({
      panelsById: {} as Record<string, unknown>,
      panelIds: [] as string[],
      addPanel: () => {},
    })),
  };
});

vi.mock("@/store/recipeStore", () => {
  const state = {
    recipes: [
      { id: "r1", name: "Review", projectId: "p1" },
      { id: "r2", name: "Deploy", projectId: "p1" },
    ],
    currentProjectId: "p1",
    runRecipeWithResults: () => Promise.resolve([]),
  };
  return {
    useRecipeStore: Object.assign((sel: (s: typeof state) => unknown) => sel(state), {
      getState: () => state,
    }),
  };
});

vi.mock("@/store/actionMruStore", () => {
  const now = Date.now();
  const entries = [
    { id: "agent:codex", score: 3, lastAccessedAt: now - 1000 },
    { id: "agent:claude", score: 2, lastAccessedAt: now - 2000 },
    { id: "agent:gemini", score: 1, lastAccessedAt: now - 3000 },
  ];
  const getSortedActionMruList = () => entries;
  const usage = new Map([["seed", { uses: [1] }]]);
  const state = {
    getSortedActionMruList,
    actionUsageEntries: usage,
    recordActionMru: () => {},
  };
  return {
    useActionMruStore: Object.assign((sel: (s: typeof state) => unknown) => sel(state), {
      getState: () => state,
    }),
  };
});

vi.mock("@/components/PanelPalette/PanelKindIcon", () => ({ PanelKindIcon: () => <span /> }));

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

vi.mock("@/store/agentSettingsStore", () => {
  const state = {
    settings: { agents: {} },
    setAgentPinned: () => {},
    updateWorktreePreset: () => Promise.resolve(),
    updateAgent: () => Promise.resolve(),
  };
  return {
    useAgentSettingsStore: Object.assign((sel: (s: typeof state) => unknown) => sel(state), {
      getState: () => state,
    }),
  };
});

vi.mock("@/config/agents", () => ({
  getMergedPresets: (agentId: string) =>
    agentId === "claude"
      ? [
          { id: "fast", name: "Fast" },
          { id: "deep", name: "Deep" },
        ]
      : [],
  getAgentConfig: (id: string) => ({ id, name: id, icon: undefined }),
  getAgentIds: () => [],
}));

vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useKeybindingDisplay: () => "",
  useEffectiveCombo: () => undefined,
}));

vi.mock("@/components/KeyboardShortcuts", () => ({ AgentShortcutCapture: () => null }));

vi.mock("@/store/cliAvailabilityStore", () => {
  const state = {
    availability: {} as Record<string, string>,
    hasRealData: true,
    refresh: () => Promise.resolve(),
  };
  return {
    useCliAvailabilityStore: Object.assign((sel: (s: typeof state) => unknown) => sel(state), {
      getState: () => state,
    }),
  };
});

// Stable references, as the real store-backed hook returns: fresh ones would
// re-derive the discovery set, and with it the model, on every render.
vi.mock("@/hooks/app/useAgentDiscoveryOnboarding", () => {
  const onboarding = {
    loaded: true,
    seenAgentIds: [],
    availabilityFirstSeen: {},
    welcomeCardDismissed: true,
    markAgentsSeen: () => {},
    recordAgentFirstSeen: () => {},
  };
  return {
    NEW_AGENT_TTL_MS: 14 * 24 * 60 * 60 * 1000,
    useAgentDiscoveryOnboarding: () => onboarding,
  };
});

vi.mock("@/store/toolbarPreferencesStore", () => {
  const state = {
    layout: { pinnedButtons: {}, leftButtons: [], rightButtons: [] },
    setPanelButtonOnToolbar: () => {},
    setLauncherItemOnToolbar: () => {},
    positionAgentButton: () => {},
    toggleButtonVisibility: () => {},
  };
  return {
    useToolbarPreferencesStore: Object.assign((sel: (s: typeof state) => unknown) => sel(state), {
      getState: () => state,
    }),
  };
});

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// Content mounts only while open, as Radix's does, so the closed launchers are
// measured as they actually sit in the app.
const openChange = vi.hoisted(() => new Map<string, (open: boolean) => void>());
vi.mock("@/components/ui/popover", async () => {
  const { createContext, useContext } = await import("react");
  const OpenContext = createContext(false);
  return {
    Popover: ({
      children,
      open,
      onOpenChange,
    }: {
      children: ReactNode;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    }) => {
      openChange.set("current", onOpenChange ?? (() => {}));
      return <OpenContext.Provider value={Boolean(open)}>{children}</OpenContext.Provider>;
    },
    PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    PopoverContent: ({ children }: { children: ReactNode }) =>
      useContext(OpenContext) ? <div data-testid="launcher-content">{children}</div> : null,
  };
});

vi.mock("@/components/ui/AppPaletteDialog", () => ({
  AppPaletteDialog: {
    Header: ({ children }: { children: ReactNode }) => <div data-palette-header="">{children}</div>,
    Input: ({
      inputRef,
      ...props
    }: {
      inputRef?: React.Ref<HTMLInputElement>;
    } & React.InputHTMLAttributes<HTMLInputElement>) => (
      <input ref={inputRef} type="text" {...props} />
    ),
    Body: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Empty: () => <div>nothing</div>,
  },
  PALETTE_SURFACE_WIDTHS: { anchored: "w", command: "w" },
}));

import { DockLaunchButton } from "../DockLaunchButton";
import type { DockLaunchAgent } from "../dockLaunchItems";
import { usePanelStore } from "@/store/panelStore";

const AGENT_IDS = [
  "claude",
  "codex",
  "gemini",
  "opencode",
  "cursor",
  "amp",
  "aider",
  "goose",
  "qwen",
  "kimi",
  "copilot",
  "crush",
  "droid",
  "kiro",
  "auggie",
  "cline",
  "roo",
  "pi",
];
const AGENTS: DockLaunchAgent[] = AGENT_IDS.map((id) => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  availability: "ready",
}));
const WORKTREE = "wt-1";
const FLIPS = 100;
const REPEATS = 5;

/** The mocked store's own shape, not the production panel store's. */
const panelStore = usePanelStore as unknown as {
  getState: () => { panelsById: Record<string, { agentState: string }> };
  setState: (partial: { panelsById: Record<string, unknown>; panelIds?: string[] }) => void;
};

function seedPanels() {
  const panelsById: Record<string, unknown> = {};
  const panelIds: string[] = [];
  AGENT_IDS.slice(0, 6).forEach((agentId, i) => {
    const id = `p${i}`;
    panelsById[id] = {
      id,
      kind: "terminal",
      location: "grid",
      worktreeId: WORKTREE,
      detectedAgentId: agentId,
      launchAgentId: agentId,
      agentState: "working",
    };
    panelIds.push(id);
  });
  panelStore.setState({ panelsById, panelIds });
}

/** One `updateAgentState` write: a new panel object and a new `panelsById`. */
function flip(i: number) {
  const id = `p${i % 6}`;
  const state = panelStore.getState();
  const prev = state.panelsById[id]!;
  panelStore.setState({
    panelsById: {
      ...state.panelsById,
      [id]: { ...prev, agentState: prev.agentState === "working" ? "waiting" : "working" },
    },
  });
}

let renders = 0;
const onRender = () => {
  renders += 1;
};

function Launchers({ only, agents = AGENTS }: { only?: "toolbar"; agents?: DockLaunchAgent[] }) {
  return (
    <>
      <Profiler id="toolbar" onRender={onRender}>
        <DockLaunchButton
          agents={agents}
          onLaunchAgent={() => {}}
          activeWorktreeId={WORKTREE}
          cwd="/tmp"
          placement="toolbar"
          hasWorkspace
          hasProject
        />
      </Profiler>
      {only ? null : (
        <Profiler id="dock" onRender={onRender}>
          <DockLaunchButton
            agents={agents}
            onLaunchAgent={() => {}}
            activeWorktreeId={WORKTREE}
            cwd="/tmp"
            placement="dock"
            hasWorkspace
            hasProject
          />
        </Profiler>
      )}
    </>
  );
}

function reset() {
  counters.builds = 0;
  counters.fuse = 0;
  renders = 0;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const results: Array<[string, string]> = [];
const report = (k: string, v: number | string) =>
  results.push([k, typeof v === "number" ? String(Math.round(v * 1000) / 1000) : v]);

function optionLabels(container: HTMLElement): string {
  return Array.from(container.querySelectorAll('[role="option"]'))
    .map((el) => el.getAttribute("aria-label"))
    .join("\n");
}

beforeEach(() => {
  seedPanels();
  reset();
});

afterEach(() => cleanup());

describe("dock launcher churn benchmark", () => {
  it(`both launchers closed: ${FLIPS} agent-state flips`, () => {
    const ms: number[] = [];
    let builds = 0;
    let fuse = 0;
    let renderCount = 0;
    for (let r = 0; r < REPEATS; r++) {
      seedPanels();
      const { unmount } = render(<Launchers />);
      reset();
      const start = performance.now();
      for (let i = 0; i < FLIPS; i++) act(() => flip(i));
      ms.push(performance.now() - start);
      builds = Math.max(builds, counters.builds);
      fuse = Math.max(fuse, counters.fuse);
      renderCount = Math.max(renderCount, renders);
      unmount();
    }
    report("closed: buildDockLaunchModel calls", builds);
    report("closed: Fuse constructions", fuse);
    report("closed: launcher renders", renderCount);
    report("closed: ms (median)", median(ms));
    expect.soft(builds).toBe(0);
    expect.soft(fuse).toBe(0);
    expect.soft(renderCount).toBe(0);
  });

  it(`toolbar launcher open: ${FLIPS} agent-state flips`, () => {
    const ms: number[] = [];
    let builds = 0;
    let fuse = 0;
    for (let r = 0; r < REPEATS; r++) {
      seedPanels();
      reset();
      const { unmount } = render(<Launchers only="toolbar" />);
      act(() => openChange.get("current")!(true));
      // Opening browses; only a query needs the index.
      expect.soft(counters.fuse).toBe(0);
      reset();
      const start = performance.now();
      for (let i = 0; i < FLIPS; i++) act(() => flip(i));
      ms.push(performance.now() - start);
      builds = Math.max(builds, counters.builds);
      fuse = Math.max(fuse, counters.fuse);
      unmount();
    }
    report("open: buildDockLaunchModel calls", builds);
    report("open: Fuse constructions", fuse);
    report("open: ms (median)", median(ms));
    expect.soft(builds).toBe(0);
    expect.soft(fuse).toBe(0);
  }, 120_000);

  it("open, then type a query: time to first results", () => {
    const openMs: number[] = [];
    const typeMs: number[] = [];
    let browse = "";
    let search = "";
    for (let r = 0; r < REPEATS; r++) {
      seedPanels();
      reset();
      const { container, unmount } = render(<Launchers only="toolbar" />);
      // Churn before the open, as in real multi-agent work.
      for (let i = 0; i < 25; i++) act(() => flip(i));
      let start = performance.now();
      act(() => openChange.get("current")!(true));
      openMs.push(performance.now() - start);
      browse = optionLabels(container);
      const input = container.querySelector("input")!;
      start = performance.now();
      act(() => {
        fireEvent.change(input, { target: { value: "cla" } });
      });
      typeMs.push(performance.now() - start);
      search = optionLabels(container);
      expect.soft(counters.fuse).toBe(1);
      act(() => {
        fireEvent.change(input, { target: { value: "clau" } });
      });
      expect.soft(counters.fuse).toBe(1);
      unmount();
    }
    report("open: ms to browse rows (median)", median(openMs));
    report("type 'cla': ms to results (median)", median(typeMs));
    // Content fingerprint, so a run can be diffed against another build.
    report("browse rows", browse.split("\n").length);
    report("browse labels hash", hash(browse));
    report("search labels hash", hash(search));
    expect(browse).toContain("Agent waiting");
    expect(search.split("\n")[0]).toContain("Claude");
  });

  it("updates an open row's pip and label live as its agent flips", () => {
    const { container } = render(<Launchers only="toolbar" />);
    act(() => openChange.get("current")!(true));
    const claudeLabel = () =>
      Array.from(container.querySelectorAll('[role="option"]'))
        .map((el) => el.getAttribute("aria-label") ?? "")
        .find((label) => label.startsWith("Claude"))!;
    expect(claudeLabel()).not.toContain("Agent waiting");
    act(() => flip(0));
    expect(claudeLabel()).toContain("Agent waiting");
    expect(container.querySelector('.toolbar-pip[data-visible="true"]')).not.toBeNull();
    act(() => flip(0));
    expect(claudeLabel()).not.toContain("Agent waiting");
  });

  it("re-indexes search when the inventory changes under an active query", () => {
    const labels = (container: HTMLElement) => optionLabels(container).split("\n");
    const { container, rerender } = render(<Launchers only="toolbar" />);
    act(() => openChange.get("current")!(true));
    act(() => {
      fireEvent.change(container.querySelector("input")!, { target: { value: "zed" } });
    });
    expect(labels(container).some((label) => label.startsWith("Zed"))).toBe(false);
    rerender(
      <Launchers
        only="toolbar"
        agents={[...AGENTS, { id: "zed", name: "Zed", availability: "ready" }]}
      />
    );
    expect(labels(container)[0]).toMatch(/^Zed/);
    rerender(<Launchers only="toolbar" />);
    expect(labels(container).some((label) => label.startsWith("Zed"))).toBe(false);
  });
});

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

afterAll(() => {
  process.stdout.write("\nBENCH\n" + results.map(([k, v]) => `${k}: ${v}`).join("\n") + "\n");
});
