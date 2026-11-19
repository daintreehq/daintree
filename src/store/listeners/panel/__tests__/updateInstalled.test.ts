// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";
import { setupUpdateInstalledListeners } from "../updateInstalled";
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

  it("leaves a pane mid-restart alone", () => {
    usePanelStore.setState({ panelsById: { t1: pane({ isRestarting: true }) }, panelIds: ["t1"] });

    emit("agent:update-installed-changed", {
      terminalId: "t1",
      updateInstalled: { observedAt: 1_000, namesRestart: false },
      timestamp: 1_000,
    });

    expect(observation()).toBeUndefined();
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
