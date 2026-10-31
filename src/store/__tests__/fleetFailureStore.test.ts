// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useFleetFailureStore, subscribeFleetFailureAutoClear } from "../fleetFailureStore";
import { useFleetArmingStore } from "../fleetArmingStore";
import { usePanelStore } from "../panelStore";
import type { PtyPanelData } from "@shared/types/panel";

function resetStores() {
  useFleetFailureStore.getState().clear();
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
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    resetStores();
    // Subscribe AFTER resetting so the factory's `prevArmed` closure captures
    // the empty baseline. This mirrors the `subscribeFleetArmingPanelPruning`
    // direct-call pattern in `fleetArmingStore.test.ts` — the subscription
    // only fires on subsequent state changes (#9923).
    unsubscribe = subscribeFleetFailureAutoClear();
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
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

  it("keeps what a retry needs to send each failed target what it was sent", () => {
    const images = ["/tmp/one.png", "/tmp/two.png"];
    const overrides = { b: "just one /tmp/one.png", c: "for c only" };
    useFleetFailureStore
      .getState()
      .recordFailure("draft", ["a", "b"], 0, { imagePaths: images, perTargetOverrides: overrides });
    images.push("/tmp/later.png");
    overrides.b = "changed afterwards";

    const s = useFleetFailureStore.getState();
    expect(s.imagePaths).toEqual(["/tmp/one.png", "/tmp/two.png"]);
    // Only a failed target's own text is worth keeping.
    expect(s.perTargetOverrides).toEqual({ b: "just one /tmp/one.png" });
  });

  it("forgets a dismissed target's own text, and everything once the last one goes", () => {
    useFleetFailureStore.getState().recordFailure("draft", ["a", "b"], 0, {
      imagePaths: ["/tmp/one.png"],
      perTargetOverrides: { a: "for a", b: "for b" },
    });
    useFleetFailureStore.getState().dismissId("a");
    expect(useFleetFailureStore.getState().perTargetOverrides).toEqual({ b: "for b" });
    expect(useFleetFailureStore.getState().imagePaths).toEqual(["/tmp/one.png"]);

    useFleetFailureStore.getState().dismissId("b");
    expect(useFleetFailureStore.getState().perTargetOverrides).toEqual({});
    expect(useFleetFailureStore.getState().imagePaths).toEqual([]);
  });

  it.each([
    ["a text-only broadcast's", "plain words"],
    ["a keystroke's", null],
  ])("drops an earlier broadcast's images when %s failure replaces it", (_, payload) => {
    useFleetFailureStore.getState().recordFailure("draft", ["a"], 0, {
      imagePaths: ["/tmp/one.png"],
      perTargetOverrides: { a: "for a" },
    });
    useFleetFailureStore.getState().recordFailure(payload, ["a"]);
    expect(useFleetFailureStore.getState().payload).toBe(payload);
    expect(useFleetFailureStore.getState().imagePaths).toEqual([]);
    expect(useFleetFailureStore.getState().perTargetOverrides).toEqual({});
  });

  it.each([
    ["cleared", () => useFleetFailureStore.getState().clear()],
    ["recorded with nothing failed", () => useFleetFailureStore.getState().recordFailure("x", [])],
  ])("forgets the images and edits when %s", (_, reset) => {
    useFleetFailureStore.getState().recordFailure("draft", ["a"], 0, {
      imagePaths: ["/tmp/one.png"],
      perTargetOverrides: { a: "for a" },
    });
    reset();
    expect(useFleetFailureStore.getState().imagePaths).toEqual([]);
    expect(useFleetFailureStore.getState().perTargetOverrides).toEqual({});
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

  it("halts auto-clear once the returned unsubscribe is invoked", () => {
    usePanelStore.setState({
      panelsById: { a: makeAgent("a"), b: makeAgent("b") },
      panelIds: ["a", "b"],
    });
    useFleetArmingStore.getState().armIds(["a", "b"]);
    useFleetFailureStore.getState().recordFailure("p", ["a", "b"]);

    // Tear down the subscription explicitly. The factory is the only thing
    // wiring `useFleetArmingStore` → `useFleetFailureStore`, so once it's
    // gone the failure set is frozen until the caller mutates it directly.
    unsubscribe?.();
    unsubscribe = null;

    useFleetArmingStore.getState().clear();
    expect(useFleetFailureStore.getState().failedIds).toEqual(new Set(["a", "b"]));
    expect(useFleetFailureStore.getState().payload).toBe("p");
  });
});
