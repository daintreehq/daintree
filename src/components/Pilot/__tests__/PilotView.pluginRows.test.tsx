// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import type { PluginAttentionRow } from "@/lib/pluginPanelAttention";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
  });
});

afterAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: originalScrollIntoView,
    configurable: true,
  });
});

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));

const pluginRows = vi.hoisted(() => ({ current: [] as PluginAttentionRow[] }));
vi.mock("@/hooks/usePluginPanelAttentionRows", () => ({
  usePluginPanelAttentionRows: () => pluginRows.current,
}));

const openPanelMock = vi.hoisted(() => vi.fn((_panelId: string) => Promise.resolve(true)));
vi.mock("@/components/PluginAttention/openPluginAttentionPanel", () => ({
  openPluginAttentionPanel: (panelId: string) => openPanelMock(panelId),
}));

import { PilotView } from "../PilotView";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { usePilotStore } from "@/store/pilotStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import {
  _resetPluginPanelAttentionStoreForTest,
  usePluginPanelAttentionStore,
} from "@/store/pluginPanelAttentionStore";

const NOW = 1_830_000_000_000;

/**
 * A run. Every approval wait here is an agent asking the user something, which
 * only a Canopy reading says: it carries an unread ask unless a test gives it
 * a reading of its own.
 */
function run(overrides: Partial<FleetSnapshot["runs"][number]> = {}) {
  const asking = overrides.agentState === "waiting" && overrides.waitingReason === "approval";
  return {
    runId: "t1",
    workspaceId: "p1",
    spawnedAt: NOW - 3_600_000,
    cwd: "/repo/feature-x",
    ...(asking
      ? { canopy: { kind: "asked" as const, quote: "Which branch?", readAt: NOW, seen: false } }
      : {}),
    ...overrides,
  };
}

function seed(runs: FleetSnapshot["runs"]) {
  useFleetSnapshotStore.setState({
    snapshot: { runs, changedAt: NOW, degraded: false, lastSuccessfulAt: NOW },
  });
}

function pluginRow(overrides: Partial<PluginAttentionRow> = {}): PluginAttentionRow {
  return {
    panelId: "board-1",
    pluginId: "acme",
    pluginName: "Acme Board",
    title: "Sync board",
    kind: "acme.board",
    worktreeId: null,
    band: "needs-you",
    shown: "waiting",
    reason: "Pick a branch",
    description: "Reported by Acme Board: Waiting — Pick a branch",
    revision: 5,
    ...overrides,
  };
}

const selected = () => document.querySelector('[aria-selected="true"]');

beforeEach(() => {
  dispatchMock.mockClear();
  openPanelMock.mockClear();
  pluginRows.current = [];
  _resetPluginPanelAttentionStoreForTest();
  (window as { __DAINTREE_INITIAL_PROJECT__?: unknown }).__DAINTREE_INITIAL_PROJECT__ = {
    id: "p1",
  };
  usePilotStore.setState({ isOpen: true, scope: { kind: "fleet" }, fellBackFrom: null });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: only id/name/lastOpened are read
  useProjectStore.setState({
    projects: [
      { id: "p1", name: "daintree", lastOpened: NOW },
      { id: "p2", name: "spike", lastOpened: NOW - 60_000 },
    ],
  } as Partial<ReturnType<typeof useProjectStore.getState>>);
  useScratchStore.setState({ scratches: [] });
});

describe("PilotView plugin panel rows (#13821)", () => {
  it("files plugin panels after every agent group, attributed to the plugin", () => {
    seed([
      run({ runId: "a", workspaceId: "p1", agentState: "working", since: NOW - 60_000 }),
      run({
        runId: "b",
        workspaceId: "p2",
        agentState: "waiting",
        waitingReason: "approval",
        since: NOW - 60_000,
      }),
    ]);
    pluginRows.current = [pluginRow()];
    render(<PilotView />);

    const groups = screen.getAllByRole("group");
    expect(groups[groups.length - 1]?.getAttribute("aria-label")).toMatch(/^Plugin panels/);
    const row = screen.getByTestId("pilot-plugin-row");
    expect(row.textContent).toContain("Reported by Acme Board");
    expect(row.getAttribute("aria-label")).toContain("Reported by Acme Board");
  });

  it("starts on an agent asking, even under a worse plugin report", () => {
    seed([
      run({
        runId: "a",
        workspaceId: "p2",
        agentState: "waiting",
        waitingReason: "approval",
        title: "Fix auth",
      }),
    ]);
    pluginRows.current = [pluginRow({ band: "blocked", shown: "failed" })];
    render(<PilotView />);

    expect(selected()?.getAttribute("data-testid")).toBe("pilot-row");
  });

  it("starts on a plugin row only when no agent is asking", () => {
    seed([run({ runId: "a", agentState: "working", since: NOW - 60_000 })]);
    pluginRows.current = [pluginRow()];
    render(<PilotView />);

    expect(selected()?.getAttribute("data-testid")).toBe("pilot-plugin-row");
  });

  it("opens the plugin's panel on Enter and closes once it took focus", async () => {
    seed([]);
    pluginRows.current = [pluginRow()];
    render(<PilotView />);

    fireEvent.keyDown(screen.getByTestId("pilot-search"), { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
    });

    expect(openPanelMock).toHaveBeenCalledWith("board-1");
    expect(dispatchMock).not.toHaveBeenCalledWith("pilot.openRun", expect.anything());
    expect(usePilotStore.getState().isOpen).toBe(false);
  });

  it("parks a plugin row with the park key, in this view and with no fleet behind it", () => {
    seed([]);
    pluginRows.current = [pluginRow()];
    render(<PilotView />);

    fireEvent.keyDown(screen.getByTestId("pilot-search"), { key: "Enter", altKey: true });

    expect(usePluginPanelAttentionStore.getState().shelfByPanelId["board-1"]).toMatchObject({
      kind: "parked",
      pluginId: "acme",
      revision: 5,
    });
    expect(screen.queryByTestId("pilot-park-note")).toBeNull();
  });

  it("names plugin demand apart from agents in the footer", () => {
    seed([
      run({ runId: "a", agentState: "waiting", waitingReason: "approval", since: NOW - 60_000 }),
    ]);
    pluginRows.current = [pluginRow()];
    const { unmount } = render(<PilotView />);
    expect(screen.getByText("1 agent and 1 plugin panel need you")).toBeTruthy();
    unmount();

    seed([run({ runId: "a", agentState: "working", since: NOW - 60_000 })]);
    render(<PilotView />);
    expect(screen.getByText("Plugin panel needs you")).toBeTruthy();
  });

  it("leaves plugin rows out when scoped to another project", () => {
    seed([
      run({ runId: "a", workspaceId: "p2", agentState: "working", worktreeId: "/spike/a" }),
      run({ runId: "b", workspaceId: "p2", agentState: "working", worktreeId: "/spike/b" }),
    ]);
    pluginRows.current = [pluginRow()];
    usePilotStore.setState({ scope: { kind: "project", workspaceId: "p2" } });
    render(<PilotView />);

    expect(screen.queryByTestId("pilot-plugin-row")).toBeNull();
  });

  it("stays open when the panel could not take focus", async () => {
    seed([]);
    pluginRows.current = [pluginRow()];
    openPanelMock.mockResolvedValueOnce(false);
    render(<PilotView />);

    fireEvent.keyDown(screen.getByTestId("pilot-search"), { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
    });

    expect(openPanelMock).toHaveBeenCalledWith("board-1");
    expect(usePilotStore.getState().isOpen).toBe(true);
  });

  it("keeps plugin panels last when an agent group arrives during a pointer hold", () => {
    seed([run({ runId: "a", workspaceId: "p1", agentState: "working", since: NOW - 60_000 })]);
    pluginRows.current = [pluginRow()];
    render(<PilotView />);

    // Aim the pointer at the plugin row: the order is now held.
    fireEvent.pointerMove(screen.getByTestId("pilot-plugin-row"));
    act(() =>
      seed([
        run({ runId: "a", workspaceId: "p1", agentState: "working", since: NOW - 60_000 }),
        run({
          runId: "b",
          workspaceId: "p2",
          agentState: "waiting",
          waitingReason: "approval",
          since: NOW - 60_000,
        }),
      ])
    );

    const labels = screen.getAllByRole("group").map((group) => group.getAttribute("aria-label"));
    expect(labels[labels.length - 1]).toMatch(/^Plugin panels/);
    expect(labels.some((label) => label?.startsWith("spike"))).toBe(true);
  });

  it("names plugin panels apart in the state segments, and hues them by their band", () => {
    seed([
      run({ runId: "a", agentState: "waiting", waitingReason: "approval", since: NOW - 60_000 }),
    ]);
    pluginRows.current = [pluginRow({ band: "blocked", shown: "failed" })];
    render(<PilotView />);

    const attention = screen.getByRole("radio", { name: /^Attention, / });
    expect(attention.getAttribute("aria-label")).toContain("1 agent, 1 plugin panel");
  });
});
