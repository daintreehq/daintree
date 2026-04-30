// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { useFleetFailureStore } from "../fleetFailureStore";
import { useFleetArmingStore } from "../fleetArmingStore";
import { usePanelStore } from "../panelStore";
import type { TerminalInstance } from "@shared/types";

function resetStores() {
  useFleetFailureStore.setState({ failedIds: new Set(), payload: null, recordedAt: null });
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
}

function makeAgent(id: string, overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id,
    title: id,
    type: "terminal",
    kind: "terminal",
    agentId: "claude",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState: "waiting",
    hasPty: true,
    ...(overrides as object),
  } as TerminalInstance;
}

describe("useFleetFailureStore", () => {
  beforeEach(() => {
    resetStores();
  });

  it("starts empty", () => {
    const s = useFleetFailureStore.getState();
    expect(s.failedIds.size).toBe(0);
    expect(s.payload).toBeNull();
    expect(s.recordedAt).toBeNull();
  });

  it("recordFailure populates ids, payload, and timestamp", () => {
    useFleetFailureStore.getState().recordFailure("hello", ["a", "b"]);
    const s = useFleetFailureStore.getState();
    expect(s.failedIds).toEqual(new Set(["a", "b"]));
    expect(s.payload).toBe("hello");
    expect(s.recordedAt).toBeGreaterThan(0);
  });

  it("recordFailure with empty ids resets state", () => {
    useFleetFailureStore.getState().recordFailure("hello", ["a"]);
    useFleetFailureStore.getState().recordFailure("ignored", []);
    const s = useFleetFailureStore.getState();
    expect(s.failedIds.size).toBe(0);
    expect(s.payload).toBeNull();
    expect(s.recordedAt).toBeNull();
  });

  it("dismissId removes a single id and preserves the rest", () => {
    useFleetFailureStore.getState().recordFailure("p", ["a", "b", "c"]);
    useFleetFailureStore.getState().dismissId("b");
    expect(useFleetFailureStore.getState().failedIds).toEqual(new Set(["a", "c"]));
    expect(useFleetFailureStore.getState().payload).toBe("p");
  });

  it("dismissId resets fully when last id leaves", () => {
    useFleetFailureStore.getState().recordFailure("p", ["a"]);
    useFleetFailureStore.getState().dismissId("a");
    const s = useFleetFailureStore.getState();
    expect(s.failedIds.size).toBe(0);
    expect(s.payload).toBeNull();
    expect(s.recordedAt).toBeNull();
  });

  it("clear resets everything", () => {
    useFleetFailureStore.getState().recordFailure("p", ["a", "b"]);
    useFleetFailureStore.getState().clear();
    const s = useFleetFailureStore.getState();
    expect(s.failedIds.size).toBe(0);
    expect(s.payload).toBeNull();
    expect(s.recordedAt).toBeNull();
  });

  it("auto-clears when the whole fleet drains", () => {
    usePanelStore.setState({
      panelsById: { a: makeAgent("a"), b: makeAgent("b") },
      panelIds: ["a", "b"],
    });
    useFleetArmingStore.getState().armIds(["a", "b"]);
    useFleetFailureStore.getState().recordFailure("p", ["a", "b"]);
    useFleetArmingStore.getState().clear();
    expect(useFleetFailureStore.getState().failedIds.size).toBe(0);
    expect(useFleetFailureStore.getState().payload).toBeNull();
  });

  it("dismisses individual failures when a pane leaves the armed set", () => {
    usePanelStore.setState({
      panelsById: { a: makeAgent("a"), b: makeAgent("b") },
      panelIds: ["a", "b"],
    });
    useFleetArmingStore.getState().armIds(["a", "b"]);
    useFleetFailureStore.getState().recordFailure("p", ["a", "b"]);
    useFleetArmingStore.getState().disarmId("a");
    expect(useFleetFailureStore.getState().failedIds).toEqual(new Set(["b"]));
    expect(useFleetFailureStore.getState().payload).toBe("p");
  });
});
