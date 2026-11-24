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
const REMOTE = "host-fleet:studio:r-1";
const armRemote = (key = REMOTE) =>
  act(() =>
    useFleetArmingStore.getState().armCrossHostTarget({
      key,
      hostId: "studio",
      hostName: "Studio",
      terminalId: key.slice(key.lastIndexOf(":") + 1),
      title: "remote",
    })
  );
const disarmRemote = (key = REMOTE) =>
  act(() => useFleetArmingStore.getState().disarmCrossHostTarget(key));

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

  it("counts another host's agents as fleet members (#17182)", () => {
    const { hook } = mount("a");
    arm(["a"]);
    armRemote();
    expect(hook.result.current).toEqual({ isArmed: true, isFleetComposing: true });

    disarmRemote();
    expect(hook.result.current).toEqual({ isArmed: true, isFleetComposing: false });
  });

  it("never composes an unarmed pane because another host's agents are armed", () => {
    const { hook } = mount("a");
    armRemote();
    armRemote("host-fleet:studio:r-2");
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

  it("re-renders on another host's agents only when they move the pane across two members", () => {
    arm(["a"]);
    const member = mount("a");
    const bystander = mount("z");
    const [memberBase, bystanderBase] = [member.counter.renders, bystander.counter.renders];

    armRemote();
    expect(member.counter.renders).toBe(memberBase + 1);

    armRemote("host-fleet:studio:r-2");
    expect(member.counter.renders).toBe(memberBase + 1);

    disarmRemote("host-fleet:studio:r-2");
    expect(member.counter.renders).toBe(memberBase + 1);
    disarmRemote();
    expect(member.counter.renders).toBe(memberBase + 2);

    expect(bystander.counter.renders).toBe(bystanderBase);
  });
});
