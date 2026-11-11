// @vitest-environment jsdom
/**
 * A grid tab group re-renders its shown pane only when something its tab strip
 * draws changes (#16801). Background tabs stream status every frame while an
 * agent works; the pane in front, and the strip inside it, must not pay for
 * fields no tab shows. `GridPanel` is a memoized spy, so every call it records
 * is a render the real one would have done. The group's attention still
 * reaches the pane by context, which a memoized parent never blocks.
 */
import { StrictMode, useContext } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { PanelInstance, PtyPanelData, TabGroup } from "@shared/types/panel";
import type { AgentState } from "@shared/types/agent";
import type { GridPanelProps } from "../GridPanel";

const gridPanel = vi.hoisted(() => ({
  renders: [] as GridPanelProps[],
  ambient: [] as (AgentState | undefined)[],
}));

vi.mock("../GridPanel", async () => {
  const { memo } = await import("react");
  return {
    GridPanel: memo(function GridPanelSpy(props: GridPanelProps) {
      gridPanel.renders.push(props);
      return <AttentionProbe />;
    }),
  };
});

// The real preferences store, the one GridTabGroup reads, so a test that sets
// it is setting what the group sees.
vi.mock("@/store", async () => {
  const { usePanelStore } = await import("@/store/panelStore");
  const { usePreferencesStore } = await import("@/store/preferencesStore");
  return { usePanelStore, usePreferencesStore };
});

vi.mock("@/services/terminal/optimisticPanelClose", () => ({ requestPanelClose: vi.fn() }));
vi.mock("@/services/layout/reorderGroupTabs", () => ({ reorderGroupTabsWithUndo: vi.fn() }));
vi.mock("../useContentGridContext", () => ({ addTabForPanel: vi.fn() }));

import { GridTabGroup } from "../GridTabGroup";
import { GridGroupAttentionContext } from "@/components/Panel/gridGroupAttention";
import { isPtyPanel } from "@shared/types/panel";
import { usePanelStore } from "@/store/panelStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import {
  cancelPanelStatusBuffer,
  enqueueActivityUpdate,
  enqueueFlowStatusUpdate,
  enqueueHeldDurationUpdate,
  flushPanelStatusBuffer,
} from "@/store/panelStatusBuffer";
import { requestPanelClose } from "@/services/terminal/optimisticPanelClose";

function AttentionProbe() {
  gridPanel.ambient.push(useContext(GridGroupAttentionContext)?.ambientAgentState);
  return null;
}

const initialPanelState = usePanelStore.getState();
const initialPreferences = usePreferencesStore.getState();

const GROUP = "g-1";
const SHOWN = "shown";
const BACK = "back";
const MIDDLE = "middle";
const OUTSIDE = "outside";

function pty(id: string, fields: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: id,
    location: "grid",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    launchAgentId: "claude",
    detectedAgentId: "claude",
    agentState: "working",
    runtimeStatus: "running",
    flowStatus: "running",
    flowStatusTimestamp: 1,
    agentLaunchFlags: ["--model", "opus"],
    ...fields,
  };
}

const group: TabGroup = {
  id: GROUP,
  location: "grid",
  activeTabId: SHOWN,
  panelIds: [SHOWN, BACK],
};

function seed(
  fields: { shown?: Partial<PtyPanelData>; back?: Partial<PtyPanelData> } = {},
  tabGroup: TabGroup = group
) {
  const panelsById: Record<string, PanelInstance> = {
    [SHOWN]: pty(SHOWN, fields.shown),
    [BACK]: pty(BACK, fields.back),
    [MIDDLE]: pty(MIDDLE),
    [OUTSIDE]: pty(OUTSIDE),
  };
  usePanelStore.setState({
    panelsById,
    panelIds: [SHOWN, BACK, MIDDLE, OUTSIDE],
    tabGroups: new Map([[GROUP, tabGroup]]),
    focusedId: SHOWN,
  });
}

function patch(id: string, fields: Partial<PtyPanelData>) {
  act(() => {
    usePanelStore.setState((state) => {
      const current = state.panelsById[id];
      if (!current || !isPtyPanel(current)) throw new Error(`no terminal ${id}`);
      const next: PtyPanelData = { ...current, ...fields };
      return { panelsById: { ...state.panelsById, [id]: next } };
    });
  });
}

function setTaskTitles(show: boolean) {
  act(() => {
    void usePreferencesStore.setState({ showAgentTaskTitles: show });
  });
}

function closeAndApprove(tabId: string) {
  lastProps().onTabClose?.(tabId);
  const request = vi.mocked(requestPanelClose).mock.calls.at(-1)![0];
  act(() => request.onOutcome?.(true));
}

function flush(enqueue: () => void) {
  act(() => {
    enqueue();
    flushPanelStatusBuffer();
  });
}

function renderGroup(strict = false) {
  const tree = <GridTabGroup group={group} focusedId={SHOWN} isMultiPanelGrid />;
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  expect(gridPanel.renders.length).toBeGreaterThan(0);
}

const renderCount = () => gridPanel.renders.length;
const lastProps = () => gridPanel.renders[gridPanel.renders.length - 1]!;
const backTab = () => lastProps().tabs?.find((tab) => tab.id === BACK);

describe("GridTabGroup render isolation", () => {
  beforeEach(() => {
    gridPanel.renders.length = 0;
    gridPanel.ambient.length = 0;
    vi.mocked(requestPanelClose).mockClear();
  });

  afterEach(() => {
    cleanup();
    cancelPanelStatusBuffer();
    usePanelStore.setState(initialPanelState, true);
    usePreferencesStore.setState(initialPreferences, true);
    useProjectPresetsStore.getState().reset();
  });

  describe.each([
    ["", false],
    [" under StrictMode", true],
  ])("fields no tab draws%s", (_label, strict) => {
    beforeEach(() => {
      seed();
      renderGroup(strict);
    });

    it("leaves the shown pane alone when a panel outside the group streams status", () => {
      const before = renderCount();
      flush(() => {
        enqueueActivityUpdate(OUTSIDE, "Running tests", "working", "interactive", "npm test");
        enqueueHeldDurationUpdate(OUTSIDE, 2_000);
      });
      expect(usePanelStore.getState().panelsById[OUTSIDE]).toMatchObject({
        activityHeadline: "Running tests",
        heldDurationMs: 2_000,
      });
      expect(renderCount()).toBe(before);
    });

    it("leaves the shown pane alone when a background tab's activity changes", () => {
      const before = renderCount();
      flush(() =>
        enqueueActivityUpdate(BACK, "Running tests", "working", "interactive", "npm test")
      );
      flush(() => enqueueActivityUpdate(BACK, "Editing files", "working", "interactive", "vim"));
      expect(usePanelStore.getState().panelsById[BACK]).toMatchObject({
        activityHeadline: "Editing files",
      });
      expect(renderCount()).toBe(before);
    });

    it("leaves the shown pane alone when a background tab's held-duration gauge ticks", () => {
      const before = renderCount();
      for (const ms of [2_000, 4_000, 6_000]) {
        flush(() => enqueueHeldDurationUpdate(BACK, ms));
      }
      expect(usePanelStore.getState().panelsById[BACK]).toMatchObject({ heldDurationMs: 6_000 });
      expect(renderCount()).toBe(before);
    });

    it("leaves the shown pane alone when a background tab's flow timestamp moves", () => {
      const before = renderCount();
      flush(() => enqueueFlowStatusUpdate(BACK, "running", 2));
      expect(usePanelStore.getState().panelsById[BACK]).toMatchObject({ flowStatusTimestamp: 2 });
      expect(renderCount()).toBe(before);
      patch(BACK, { flowStatusTimestamp: 3 });
      expect(usePanelStore.getState().panelsById[BACK]).toMatchObject({
        flowStatus: "running",
        flowStatusTimestamp: 3,
        runtimeStatus: "running",
      });
      expect(renderCount()).toBe(before);
    });

    it("leaves the shown pane alone when a background tab's fields are replaced with equal ones", () => {
      patch(BACK, {
        runtimeIdentity: { kind: "agent", id: "claude", iconId: "claude", agentId: "claude" },
      });
      const before = renderCount();
      patch(BACK, {
        agentLaunchFlags: ["--model", "opus"],
        runtimeIdentity: { kind: "agent", id: "claude", iconId: "claude", agentId: "claude" },
      });
      expect(renderCount()).toBe(before);
    });

    it("stays put on the status writes that follow a background tab's rename", () => {
      patch(BACK, { title: "Renamed" });
      const renamed = lastProps().tabs;
      const before = renderCount();
      flush(() =>
        enqueueActivityUpdate(BACK, "Running tests", "working", "interactive", "npm test")
      );
      flush(() => enqueueHeldDurationUpdate(BACK, 2_000));
      expect(renderCount()).toBe(before);
      expect(lastProps().tabs).toBe(renamed);
      expect(backTab()?.fullTitle).toBe("Renamed");
    });
  });

  describe("fields a tab draws", () => {
    it("re-renders with the background tab's new title", () => {
      seed();
      renderGroup();
      const before = renderCount();
      patch(BACK, { title: "Renamed" });
      expect(renderCount()).toBeGreaterThan(before);
      expect(backTab()?.fullTitle).toBe("Renamed");
    });

    it("re-renders with the background tab's observed task title", () => {
      setTaskTitles(true);
      seed();
      renderGroup();
      const before = renderCount();
      patch(BACK, { lastObservedTitle: "Fix the auth tests" });
      expect(renderCount()).toBeGreaterThan(before);
      expect(backTab()?.title).toBe("Fix the auth tests");
    });

    it("re-renders with the identity title once task titles are turned off", () => {
      setTaskTitles(true);
      seed({ back: { lastObservedTitle: "Fix the auth tests" } });
      renderGroup();
      expect(backTab()?.title).toBe("Fix the auth tests");
      setTaskTitles(false);
      expect(backTab()?.title).toBe(BACK);
    });

    it("re-renders with the background tab's new agent state", () => {
      seed();
      renderGroup();
      expect(backTab()?.agentState).toBe("working");
      patch(BACK, { agentState: "waiting" });
      expect(backTab()?.agentState).toBe("waiting");
    });

    it("re-renders with the background tab's exit in its chrome", () => {
      seed();
      renderGroup();
      expect(backTab()?.chrome.hasExited).toBe(false);
      patch(BACK, { runtimeStatus: "exited" });
      expect(backTab()?.chrome.hasExited).toBe(true);
    });

    it("re-renders with the background tab's exit code in its chrome", () => {
      seed();
      renderGroup();
      patch(BACK, { exitCode: 1 });
      expect(backTab()?.chrome.hasExited).toBe(true);
    });

    it("re-renders with the background tab's permission-bypass flag, on and off", () => {
      seed();
      renderGroup();
      expect(backTab()?.hasDangerousFlags).toBe(false);
      patch(BACK, { agentLaunchFlags: ["--dangerously-skip-permissions"] });
      expect(backTab()?.hasDangerousFlags).toBe(true);
      patch(BACK, { agentLaunchFlags: [] });
      expect(backTab()?.hasDangerousFlags).toBe(false);
    });

    it("re-renders with the background tab's renamed preset", () => {
      act(() =>
        useProjectPresetsStore.setState({
          presetsByAgent: { claude: [{ id: "team", name: "Team", color: "#ff0000" }] },
        })
      );
      seed({ back: { agentPresetId: "team" } });
      renderGroup();
      expect(backTab()?.presetName).toBe("Team");
      act(() =>
        useProjectPresetsStore.setState({
          presetsByAgent: { claude: [{ id: "team", name: "Team review", color: "#00ff00" }] },
        })
      );
      expect(backTab()?.presetName).toBe("Team review");
      expect(backTab()?.presetColor).toBe("#00ff00");
    });
  });

  it("hands a background tab's new activity to the pane by context, not a re-render", () => {
    seed({ shown: { agentState: "idle" }, back: { agentState: "idle" } });
    renderGroup();
    expect(gridPanel.ambient.at(-1)).toBeUndefined();
    const before = renderCount();
    flush(() => enqueueActivityUpdate(BACK, "Thinking", "working", "interactive", undefined));
    expect(gridPanel.ambient.at(-1)).toBe("working");
    expect(renderCount()).toBe(before);
  });

  it("keeps the strip's tab objects for tabs that didn't change", () => {
    seed();
    renderGroup();
    const shownTab = lastProps().tabs?.find((tab) => tab.id === SHOWN);
    const back = backTab();
    patch(BACK, { title: "Renamed" });
    expect(backTab()).not.toBe(back);
    expect(backTab()?.fullTitle).toBe("Renamed");
    expect(lastProps().tabs?.find((tab) => tab.id === SHOWN)).toBe(shownTab);
  });

  describe("closing the shown tab", () => {
    const activeTab = () => usePanelStore.getState().tabGroups.get(GROUP)?.activeTabId;

    it("lands on its neighbour after background churn", () => {
      seed();
      renderGroup();
      flush(() =>
        enqueueActivityUpdate(BACK, "Running tests", "working", "interactive", "npm test")
      );
      closeAndApprove(SHOWN);
      expect(activeTab()).toBe(BACK);
      expect(usePanelStore.getState().focusedId).toBe(BACK);
    });

    it("lands on its neighbour in the group's current order", () => {
      seed();
      const { rerender } = render(
        <GridTabGroup group={group} focusedId={SHOWN} isMultiPanelGrid />
      );
      const reordered: TabGroup = { ...group, panelIds: [SHOWN, MIDDLE, BACK] };
      act(() => usePanelStore.setState({ tabGroups: new Map([[GROUP, reordered]]) }));
      rerender(<GridTabGroup group={reordered} focusedId={SHOWN} isMultiPanelGrid />);
      closeAndApprove(SHOWN);
      expect(activeTab()).toBe(MIDDLE);
      expect(usePanelStore.getState().focusedId).toBe(MIDDLE);
    });

    it("lands on the tab before it when it is the last", () => {
      const lastShown: TabGroup = { ...group, panelIds: [BACK, MIDDLE, SHOWN] };
      seed({}, lastShown);
      render(<GridTabGroup group={lastShown} focusedId={SHOWN} isMultiPanelGrid />);
      closeAndApprove(SHOWN);
      expect(activeTab()).toBe(MIDDLE);
    });
  });
});
