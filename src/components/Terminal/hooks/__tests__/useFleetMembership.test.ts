// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useFleetMembership } from "../useFleetMembership";
import { useFleetArmingStore } from "@/store/fleetArmingStore";

function mount(id: string, options?: { isolated?: boolean }) {
  const counter = { renders: 0 };
  const hook = renderHook(() => {
    counter.renders++;
    return useFleetMembership(id, options);
  });
  return { counter, hook };
}

const arm = (ids: string[]) => act(() => useFleetArmingStore.getState().armIds(ids));

describe("useFleetMembership", () => {
  beforeEach(() => {
    useFleetArmingStore.getState().clear();
  });

  afterEach(() => {
    cleanup();
    useFleetArmingStore.getState().clear();
  });

  it("reports membership and whether the fleet has two or more members", () => {
    const { hook } = mount("a");
    expect(hook.result.current).toEqual({ isArmed: false, isFleetComposing: false });

    arm(["a"]);
    expect(hook.result.current).toEqual({ isArmed: true, isFleetComposing: false });

    arm(["a", "b"]);
    expect(hook.result.current).toEqual({ isArmed: true, isFleetComposing: true });

    arm(["a"]);
    expect(hook.result.current).toEqual({ isArmed: true, isFleetComposing: false });

    arm([]);
    expect(hook.result.current).toEqual({ isArmed: false, isFleetComposing: false });
  });

  it("is never armed or composing when isolated", () => {
    const { hook } = mount("a", { isolated: true });
    arm(["a", "b"]);
    expect(hook.result.current).toEqual({ isArmed: false, isFleetComposing: false });
  });

  it("re-renders a pane only when its own armed or composing state changes", () => {
    const member = mount("a");
    const bystander = mount("z");
    const isolated = mount("a", { isolated: true });
    const [memberBase, bystanderBase, isolatedBase] = [
      member.counter.renders,
      bystander.counter.renders,
      isolated.counter.renders,
    ];

    // 0 -> 1: the member arms; nobody else's state moves.
    arm(["a"]);
    expect(member.counter.renders).toBe(memberBase + 1);

    // 1 -> 2 with another pane: the member now broadcasts; the bystander is
    // still outside the fleet, so crossing the threshold is not its business.
    arm(["a", "b"]);
    expect(member.counter.renders).toBe(memberBase + 2);

    // 2 -> 3: the member's own state is unchanged.
    arm(["a", "b", "c"]);
    expect(member.counter.renders).toBe(memberBase + 2);

    // 3 -> 3 with a different third member.
    arm(["a", "b", "d"]);
    expect(member.counter.renders).toBe(memberBase + 2);

    // 3 -> 2 -> 1 -> 0.
    arm(["a", "b"]);
    expect(member.counter.renders).toBe(memberBase + 2);
    arm(["a"]);
    expect(member.counter.renders).toBe(memberBase + 3);
    arm([]);
    expect(member.counter.renders).toBe(memberBase + 4);

    expect(bystander.counter.renders).toBe(bystanderBase);
    expect(isolated.counter.renders).toBe(isolatedBase);
  });
});
