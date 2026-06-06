// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { useFleetFailureStore } from "../fleetFailureStore";
import { useFleetArmingStore } from "../fleetArmingStore";
import { usePanelStore } from "../panelStore";
import type { PtyPanelData } from "@shared/types/panel";

function resetStores() {
  useFleetFailureStore.setState({ failedIds: new Set(), payload: null });
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
}

function makeAgent(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    agentId: "claude",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState: "waiting",
    hasPty: true,
    ...(overrides as object),
  } as PtyPanelData;
}

describe("useFleetFailureStore", () => {
  beforeEach(() => {
    resetStores();
  });

  it("starts empty", () => {
    const s = useFleetFailureStore.getState();
    expect(s.failedIds.size).toBe(0);
    expect(s.payload).toBeNull();
  });

  it("recordFailure populates ids and payload", () => {
    useFleetFailureStore.getState().recordFailure("hello", ["a", "b"]);
    const s = useFleetFailureStore.getState();
    expect(s.failedIds).toEqual(new Set(["a", "b"]));
    expect(s.payload).toBe("hello");
  });

  it("recordFailure with empty ids resets state", () => {
    useFleetFailureStore.getState().recordFailure("hello", ["a"]);
    useFleetFailureStore.getState().recordFailure("ignored", []);
    const s = useFleetFailureStore.getState();
    expect(s.failedIds.size).toBe(0);
    expect(s.payload).toBeNull();
  });

  it("recordFailure accepts a null payload for non-replayable failures", () => {
    // Raw-input broadcasts use null to signal "no meaningful retry" — the
    // `Retry failed` action checks `payload == null` and skips the IPC
    // write. Using "" here would slip through that guard (#8705).
    useFleetFailureStore.getState().recordFailure(null, ["a", "b"]);
    const s = useFleetFailureStore.getState();
    expect(s.failedIds).toEqual(new Set(["a", "b"]));
    expect(s.payload).toBeNull();
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
  });

  it("clear resets everything", () => {
    useFleetFailureStore.getState().recordFailure("p", ["a", "b"]);
    useFleetFailureStore.getState().clear();
    const s = useFleetFailureStore.getState();
    expect(s.failedIds.size).toBe(0);
    expect(s.payload).toBeNull();
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
