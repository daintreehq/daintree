// @vitest-environment jsdom
/**
 * A grid tab group draws its hidden agent tab's amber and red edges on the tab
 * it shows, whatever that tab's kind (#16151). The group, its panel and the
 * pane chrome are real; the shown pane is a stand-in that renders
 * `ContentPanel` with its own prop list and forwards nothing group-related, as
 * the browser, dev-preview, file and diff panes do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { PanelInstance, PtyPanelData, TabGroup } from "@shared/types/panel";
import { HAND_BACK_SEEN_DWELL_MS } from "@shared/utils/runHandBack";

vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
  useWorktreeStoreOptional: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
}));

vi.mock("@/hooks/useWorktreeColorMap", () => ({
  useWorktreeColorMap: () => undefined,
}));

vi.mock("@/components/DragDrop", () => ({
  useIsDragging: () => false,
}));

vi.mock("@/components/Terminal/SubagentChip", () => ({
  SubagentChip: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

vi.mock("@/store", async () => {
  const { usePanelStore } = await import("@/store/panelStore");
  return {
    usePanelStore,
    usePreferencesStore: (
      selector: (s: { showGridAgentHighlights: boolean; showAgentTaskTitles: boolean }) => unknown
    ) => selector({ showGridAgentHighlights: false, showAgentTaskTitles: false }),
  };
});

vi.mock("@/services/terminal/panelDuplicationService", () => ({
  canDuplicatePanelKind: () => false,
}));
vi.mock("@/services/terminal/optimisticPanelClose", () => ({ requestPanelClose: vi.fn() }));
vi.mock("@/services/layout/reorderGroupTabs", () => ({ reorderGroupTabsWithUndo: vi.fn() }));
vi.mock("../useContentGridContext", () => ({ addTabForPanel: vi.fn() }));

// Filled once the real ContentPanel has loaded: a factory that imported it
// would wait on itself, since the pane chrome reaches the registry too.
const registry = vi.hoisted(() => ({ definitions: {} as Record<string, unknown> }));

vi.mock("@/registry", () => ({
  getPanelKindDefinitionsSnapshot: () => registry.definitions,
  subscribeToPanelKindDefinitions: () => () => {},
}));

import { GridTabGroup } from "../GridTabGroup";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import type { TabInfo } from "@/components/Panel/TabButton";
import { usePanelStore } from "@/store/panelStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import {
  _resetPanelFailureStoreForTest,
  observePanelFailures,
  usePanelFailureStore,
} from "@/store/panelFailureStore";

interface PaneProps {
  id: string;
  title: string;
  isFocused: boolean;
  location?: "grid" | "dock" | "dialog";
  isMultiPanelGrid?: boolean;
  onFocus: () => void;
  onClose: () => void;
  tabs?: TabInfo[];
  onTabClick?: (id: string) => void;
  agentState?: PtyPanelData["agentState"];
}

const standIn = (kind: string) =>
  function StandInPane(props: PaneProps) {
    return (
      <ContentPanel
        id={props.id}
        title={props.title}
        kind={kind}
        isFocused={props.isFocused}
        location={props.location}
        isMultiPanelGrid={props.isMultiPanelGrid}
        onFocus={props.onFocus}
        onClose={props.onClose}
        tabs={props.tabs}
        onTabClick={props.onTabClick}
      >
        <div />
      </ContentPanel>
    );
  };

function TerminalStandIn(props: PaneProps) {
  const panel = usePanelStore((s) => s.panelsById[props.id]) as PtyPanelData | undefined;
  return (
    <ContentPanel
      id={props.id}
      title={props.title}
      kind="terminal"
      agentId="claude"
      agentState={props.agentState}
      isExited={panel?.runtimeStatus === "exited"}
      exitCode={panel?.exitCode}
      isFocused={props.isFocused}
      location={props.location}
      isMultiPanelGrid={props.isMultiPanelGrid}
      onFocus={props.onFocus}
      onClose={props.onClose}
    >
      <div />
    </ContentPanel>
  );
}

registry.definitions = {
  terminal: { component: TerminalStandIn },
  browser: { component: standIn("browser") },
  "dev-preview": { component: standIn("dev-preview") },
  file: { component: standIn("file") },
  diff: { component: standIn("diff") },
};

const GROUP = "g-1";
const SHOWN = "shown";
const AGENT = "agent";

type ShownKind = "browser" | "dev-preview" | "file" | "diff";

function shownPanel(kind: ShownKind): PanelInstance {
  return { id: SHOWN, kind, title: kind, location: "grid" } as PanelInstance;
}

function agentTab(fields: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: AGENT,
    kind: "terminal",
    title: "Claude",
    location: "grid",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    launchAgentId: "claude",
    agentState: "working",
    ...fields,
  };
}

const group = (activeTabId: string): TabGroup => ({
  id: GROUP,
  location: "grid",
  activeTabId,
  panelIds: [SHOWN, AGENT],
});

let prevRecords: Record<string, PanelInstance> | undefined;

/** One panel-store write, read for failures the way the store orchestrator reads it. */
function records(
  shown: PanelInstance,
  agent: PtyPanelData,
  view: { active?: string; focused?: string | null } = {}
) {
  const panelsById = { [SHOWN]: shown, [AGENT]: agent };
  act(() => {
    usePanelStore.setState({
      panelsById,
      panelIds: [SHOWN, AGENT],
      tabGroups: new Map([[GROUP, group(view.active ?? SHOWN)]]),
      ...(view.focused !== undefined ? { focusedId: view.focused } : {}),
    });
    observePanelFailures(panelsById, prevRecords);
  });
  prevRecords = panelsById;
}

function fleet(agent: Partial<FleetRunRow>) {
  act(() =>
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: [{ runId: AGENT, workspaceId: "p1", spawnedAt: 0, cwd: "/repo", ...agent }],
        changedAt: 0,
        degraded: false,
        lastSuccessfulAt: null,
      },
    })
  );
}

function mount(focusedId: string | null = null) {
  const view = render(
    <GridTabGroup
      group={usePanelStore.getState().tabGroups.get(GROUP)!}
      focusedId={focusedId}
      isMultiPanelGrid
    />
  );
  const frame = (id: string) =>
    view.container.querySelector<HTMLElement>(`[data-panel-id="${id}"]`);
  const edge = (id: string, state: "waiting" | "failed") =>
    frame(id)?.classList.contains(`panel-state-${state}`) ?? false;
  return { ...view, frame, edge };
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  prevRecords = undefined;
  _resetPanelFailureStoreForTest();
  useFleetSnapshotStore.setState({ snapshot: null });
});

afterEach(() => {
  cleanup();
  usePanelStore.setState({
    panelsById: {},
    panelIds: [],
    tabGroups: new Map(),
    focusedId: null,
  });
  useFleetSnapshotStore.setState({ snapshot: null });
  _resetPanelFailureStoreForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const KINDS: ShownKind[] = ["browser", "dev-preview", "file", "diff"];

describe("GridTabGroup edges for hidden tabs", () => {
  it.each(KINDS)(
    "draws a hidden agent's unseen ask on a shown %s pane, and lets it go once seen",
    (kind) => {
      records(shownPanel(kind), agentTab({ agentState: "waiting", waitingReason: "approval" }));
      fleet({ agentState: "waiting", waitingReason: "approval", wait: { stoppedAt: 0 } });
      const view = mount();
      expect(view.frame(SHOWN)).not.toBeNull();
      expect(view.edge(SHOWN, "waiting")).toBe(true);

      fleet({
        agentState: "waiting",
        waitingReason: "approval",
        wait: { stoppedAt: 0, seenAt: 1 },
      });
      expect(view.edge(SHOWN, "waiting")).toBe(false);
    }
  );

  it.each(KINDS)("draws a hidden agent's unread Canopy ask on a shown %s pane", (kind) => {
    records(shownPanel(kind), agentTab({ agentState: "waiting", waitingReason: "question" }));
    fleet({
      agentState: "waiting",
      waitingReason: "question",
      canopy: { kind: "asked", quote: "Ship it?", readAt: 0, seen: false },
    });
    const view = mount();
    expect(view.edge(SHOWN, "waiting")).toBe(true);
  });

  it.each(KINDS)(
    "draws a hidden agent's unseen failure on a shown %s pane, over its ask",
    (kind) => {
      records(
        shownPanel(kind),
        agentTab({
          agentState: "waiting",
          waitingReason: "approval",
          restartError: { message: "no", timestamp: 1, recoverable: false },
        })
      );
      fleet({ agentState: "waiting", waitingReason: "approval", wait: { stoppedAt: 0 } });
      const view = mount();
      expect(view.edge(SHOWN, "failed")).toBe(true);
      expect(view.edge(SHOWN, "waiting")).toBe(false);
    }
  );

  it("never marks a hidden failure seen while the shown pane is in front", () => {
    records(shownPanel("browser"), agentTab({ runtimeStatus: "exited", exitCode: 1 }), {
      focused: SHOWN,
    });
    const view = mount(SHOWN);
    expect(view.edge(SHOWN, "failed")).toBe(true);

    advance(HAND_BACK_SEEN_DWELL_MS * 3);
    expect(view.edge(SHOWN, "failed")).toBe(true);
    expect(usePanelFailureStore.getState().seen[AGENT]).toBeUndefined();
  });

  it("clears a hidden failure once its own tab has been in front, and raises a new one", () => {
    const browser = shownPanel("browser");
    const failed = agentTab({ runtimeStatus: "exited", exitCode: 1 });
    records(browser, failed, { focused: SHOWN });
    const view = mount(SHOWN);
    expect(view.edge(SHOWN, "failed")).toBe(true);

    // Shown and focused, the agent's own pane draws the failure until its look lands.
    records(browser, failed, { active: AGENT, focused: AGENT });
    view.rerender(<GridTabGroup group={group(AGENT)} focusedId={AGENT} isMultiPanelGrid />);
    expect(view.frame(SHOWN)).toBeNull();
    expect(view.edge(AGENT, "failed")).toBe(true);
    advance(HAND_BACK_SEEN_DWELL_MS);
    expect(view.edge(AGENT, "failed")).toBe(false);

    records(browser, failed, { active: SHOWN, focused: SHOWN });
    view.rerender(<GridTabGroup group={group(SHOWN)} focusedId={SHOWN} isMultiPanelGrid />);
    expect(view.edge(SHOWN, "failed")).toBe(false);

    // A restart that fails again is a new failure, hidden again.
    records(browser, agentTab({ agentState: "working" }), { focused: SHOWN });
    records(browser, agentTab({ runtimeStatus: "exited", exitCode: 2 }), { focused: SHOWN });
    expect(view.edge(SHOWN, "failed")).toBe(true);
  });
});
