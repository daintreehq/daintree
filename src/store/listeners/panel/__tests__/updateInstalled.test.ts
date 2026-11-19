// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";
import { setupUpdateInstalledListeners } from "../updateInstalled";
import {
  updateInstalledChangedSince,
  updateInstalledEventMark,
} from "@/store/updateInstalledEvents";
import type { DisposableStore } from "@/utils/disposable";

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

function emit(name: string, payload: unknown): void {
  for (const listener of listeners.get(name) ?? []) listener(payload);
}

function pane(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: "t1",
    kind: "terminal",
    title: "Claude",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    location: "grid",
    launchAgentId: "claude",
    ...overrides,
  };
}

function observation(id = "t1") {
  const panel = usePanelStore.getState().panelsById[id];
  return panel && isPtyPanel(panel) ? panel.updateInstalled : undefined;
}

describe("update-installed listener (#17905)", () => {
  let disposable: DisposableStore;

  beforeEach(() => {
    listeners.clear();
    (window as unknown as { electron: unknown }).electron = {
      events: {
        on: (name: string, listener: Listener) => {
          const set = listeners.get(name) ?? new Set<Listener>();
          set.add(listener);
          listeners.set(name, set);
          return () => set.delete(listener);
        },
      },
    };
    usePanelStore.setState({ panelsById: { t1: pane() }, panelIds: ["t1"] });
    disposable = setupUpdateInstalledListeners();
  });

  afterEach(() => {
    disposable.dispose();
    usePanelStore.setState({ panelsById: {}, panelIds: [] });
  });

  it("copies a set and a clear onto the pane, whatever its agent state", () => {
    usePanelStore.setState({
      panelsById: { t1: pane({ agentState: "working" }) },
      panelIds: ["t1"],
    });

    emit("agent:update-installed-changed", {
      terminalId: "t1",
      updateInstalled: { observedAt: 1_000, namesRestart: true },
      timestamp: 1_000,
    });
    expect(observation()).toEqual({ observedAt: 1_000, namesRestart: true });
    const panel = usePanelStore.getState().panelsById.t1;
    expect(panel && isPtyPanel(panel) ? panel.agentState : undefined).toBe("working");

    emit("agent:update-installed-changed", {
      terminalId: "t1",
      updateInstalled: null,
      timestamp: 2_000,
    });
    expect(observation()).toBeUndefined();
  });

  it.each([
    ["no terminal", { updateInstalled: { observedAt: 1, namesRestart: true } }],
    ["a malformed observation", { terminalId: "t1", updateInstalled: { observedAt: 1 } }],
    ["no payload", null],
  ])("ignores an event with %s", (_name, payload) => {
    emit("agent:update-installed-changed", payload);

    expect(observation()).toBeUndefined();
  });

  it("leaves a pane mid-restart alone, without marking it against a host read", () => {
    usePanelStore.setState({ panelsById: { t1: pane({ isRestarting: true }) }, panelIds: ["t1"] });
    const mark = updateInstalledEventMark();

    emit("agent:update-installed-changed", {
      terminalId: "t1",
      updateInstalled: { observedAt: 1_000, namesRestart: false },
      timestamp: 1_000,
    });

    expect(observation()).toBeUndefined();
    expect(updateInstalledChangedSince("t1", mark)).toBe(false);
  });

  it("applies an event that beat its pane in once the pane arrives", () => {
    usePanelStore.setState({ panelsById: {}, panelIds: [] });
    emit("agent:update-installed-changed", {
      terminalId: "t1",
      updateInstalled: { observedAt: 1_000, namesRestart: true },
      timestamp: 1_000,
    });

    // Restored from an inventory read taken before the footer showed.
    usePanelStore.setState({ panelsById: { t1: pane() }, panelIds: ["t1"] });

    expect(observation()).toEqual({ observedAt: 1_000, namesRestart: true });
  });

  it("marks an event that beat its pane in once it is applied, against a read in flight", () => {
    usePanelStore.setState({ panelsById: {}, panelIds: [] });
    const mark = updateInstalledEventMark();
    emit("agent:update-installed-changed", {
      terminalId: "t1",
      updateInstalled: null,
      timestamp: 1_000,
    });
    expect(updateInstalledChangedSince("t1", mark)).toBe(false);

    usePanelStore.setState({
      panelsById: { t1: pane({ updateInstalled: { observedAt: 500, namesRestart: true } }) },
      panelIds: ["t1"],
    });

    expect(observation()).toBeUndefined();
    expect(updateInstalledChangedSince("t1", mark)).toBe(true);
  });

  it("applies only the last event that beat its pane in, a clear included", () => {
    usePanelStore.setState({ panelsById: {}, panelIds: [] });
    emit("agent:update-installed-changed", {
      terminalId: "t1",
      updateInstalled: { observedAt: 1_000, namesRestart: true },
      timestamp: 1_000,
    });
    emit("agent:update-installed-changed", {
      terminalId: "t1",
      updateInstalled: null,
      timestamp: 2_000,
    });

    usePanelStore.setState({
      panelsById: { t1: pane({ updateInstalled: { observedAt: 1_000, namesRestart: true } }) },
      panelIds: ["t1"],
    });

    expect(observation()).toBeUndefined();
  });

  it("keeps a restored observation newer than a clear that beat its pane in", () => {
    // The clear ended an earlier run; the pane was restored from a read taken
    // after this run showed the footer again.
    usePanelStore.setState({ panelsById: {}, panelIds: [] });
    emit("agent:update-installed-changed", {
      terminalId: "t1",
      updateInstalled: null,
      timestamp: 1_000,
    });

    const restored = { observedAt: 5_000, namesRestart: false };
    usePanelStore.setState({
      panelsById: { t1: pane({ updateInstalled: restored }) },
      panelIds: ["t1"],
    });

    expect(observation()).toEqual(restored);
  });

  it("keeps a restored observation newer than a set that beat its pane in", () => {
    usePanelStore.setState({ panelsById: {}, panelIds: [] });
    emit("agent:update-installed-changed", {
      terminalId: "t1",
      updateInstalled: { observedAt: 1_000, namesRestart: true },
      timestamp: 1_000,
    });

    const restored = { observedAt: 5_000, namesRestart: false };
    usePanelStore.setState({
      panelsById: { t1: pane({ updateInstalled: restored }) },
      panelIds: ["t1"],
    });

    expect(observation()).toEqual(restored);
  });

  it("forgets an event for a terminal whose pane never arrives", () => {
    vi.useFakeTimers();
    try {
      usePanelStore.setState({ panelsById: {}, panelIds: [] });
      emit("agent:update-installed-changed", {
        terminalId: "t1",
        updateInstalled: { observedAt: 1_000, namesRestart: true },
        timestamp: 1_000,
      });
      vi.advanceTimersByTime(2 * 60_000);
      // Another terminal's event prunes the stale entry.
      emit("agent:update-installed-changed", {
        terminalId: "t9",
        updateInstalled: null,
        timestamp: 2_000,
      });

      usePanelStore.setState({ panelsById: { t1: pane() }, panelIds: ["t1"] });

      expect(observation()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies a change to one field alone", () => {
    emit("agent:update-installed-changed", {
      terminalId: "t1",
      updateInstalled: { observedAt: 1_000, namesRestart: true },
      timestamp: 1_000,
    });
    emit("agent:update-installed-changed", {
      terminalId: "t1",
      updateInstalled: { observedAt: 1_000, namesRestart: false },
      timestamp: 1_000,
    });
    expect(observation()).toEqual({ observedAt: 1_000, namesRestart: false });

    emit("agent:update-installed-changed", {
      terminalId: "t1",
      updateInstalled: { observedAt: 9_000, namesRestart: false },
      timestamp: 9_000,
    });
    expect(observation()).toEqual({ observedAt: 9_000, namesRestart: false });
  });

  it("marks the terminals an event reached since a host read began", () => {
    const mark = updateInstalledEventMark();
    expect(updateInstalledChangedSince("t1", mark)).toBe(false);

    emit("agent:update-installed-changed", {
      terminalId: "t1",
      updateInstalled: null,
      timestamp: 1_000,
    });

    expect(updateInstalledChangedSince("t1", mark)).toBe(true);
    expect(updateInstalledChangedSince("t2", mark)).toBe(false);
    expect(updateInstalledChangedSince("t1", updateInstalledEventMark())).toBe(false);
  });

  it("stops listening once disposed", () => {
    disposable.dispose();

    emit("agent:update-installed-changed", {
      terminalId: "t1",
      updateInstalled: { observedAt: 1_000, namesRestart: false },
      timestamp: 1_000,
    });

    expect(observation()).toBeUndefined();
  });
});
