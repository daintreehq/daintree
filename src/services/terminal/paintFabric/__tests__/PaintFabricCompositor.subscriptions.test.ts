import { describe, expect, it, vi } from "vitest";
import { PaintFabricCompositor } from "../PaintFabricCompositor";
import { makeSurface } from "./fakePaintPlane";

// Phase 1 watch-list: "subscription rebinding on placement". Per-id
// subscriptions made before a terminal is placed materialize on the default
// surface; when the terminal is created on (or moved to) another surface the
// compositor must rebind them, or they stay stranded and never fire.
function makeCompositor() {
  const a = makeSurface("a");
  const b = makeSurface("b");
  const compositor = new PaintFabricCompositor({
    surfaces: [a.surface, b.surface],
    choosePlacement: (terminalId, registry) =>
      registry.surfaces().find((s) => s.id === (terminalId.endsWith("-b") ? "b" : "a")) ??
      registry.defaultSurface(),
  });
  return { compositor, a: a.plane, b: b.plane };
}

describe("PaintFabricCompositor subscription rebinding", () => {
  it("rebinds a pre-placement subscription to the surface the terminal is created on", async () => {
    const { compositor, a, b } = makeCompositor();
    const unsubOnA = vi.fn();
    a.addExitListener.mockReturnValue(unsubOnA);

    const callback = vi.fn();
    compositor.addExitListener("t1-b", callback);
    // Unplaced → materialized on the default surface, like any per-id route.
    expect(a.addExitListener).toHaveBeenCalledWith("t1-b", callback);
    expect(b.addExitListener).not.toHaveBeenCalled();

    await compositor.getOrCreate("t1-b", undefined, {});
    // Placement landed on b → the stranded subscription moved with it.
    expect(unsubOnA).toHaveBeenCalledTimes(1);
    expect(b.addExitListener).toHaveBeenCalledWith("t1-b", callback);
  });

  it("does not rebind subscriptions for terminals placed on the default surface", async () => {
    const { compositor, a } = makeCompositor();
    const unsubOnA = vi.fn();
    a.subscribeUnseenOutput.mockReturnValue(unsubOnA);

    compositor.subscribeUnseenOutput("t1-a", vi.fn());
    await compositor.getOrCreate("t1-a", undefined, {});
    expect(unsubOnA).not.toHaveBeenCalled();
    expect(a.subscribeUnseenOutput).toHaveBeenCalledTimes(1);
  });

  it("caller unsubscribe releases the current binding and survives a rebind", async () => {
    const { compositor, a, b } = makeCompositor();
    const unsubOnA = vi.fn();
    const unsubOnB = vi.fn();
    a.addAgentStateListener.mockReturnValue(unsubOnA);
    b.addAgentStateListener.mockReturnValue(unsubOnB);

    const unsubscribe = compositor.addAgentStateListener("t1-b", vi.fn());
    await compositor.getOrCreate("t1-b", undefined, {});
    expect(unsubOnA).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(unsubOnB).toHaveBeenCalledTimes(1);
    // Idempotent: a second call must not double-release.
    unsubscribe();
    expect(unsubOnB).toHaveBeenCalledTimes(2);
  });

  it("destroy drops tracked subscriptions so a re-created id starts clean", async () => {
    const { compositor, a, b } = makeCompositor();
    const unsubOnB = vi.fn();
    b.addExitListener.mockReturnValue(unsubOnB);

    await compositor.getOrCreate("t1-b", undefined, {});
    compositor.addExitListener("t1-b", vi.fn());
    expect(b.addExitListener).toHaveBeenCalledTimes(1);

    compositor.destroy("t1-b");
    expect(unsubOnB).toHaveBeenCalledTimes(1);

    // Re-creating the id must not resurrect the old listener.
    await compositor.getOrCreate("t1-b", undefined, {});
    expect(b.addExitListener).toHaveBeenCalledTimes(1);
    expect(a.addExitListener).not.toHaveBeenCalled();
  });

  it("unregisterPostCompleteHook drops the tracked hook so a move cannot resurrect it", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});

    compositor.registerPostCompleteHook("t1-b", vi.fn());
    expect(b.registerPostCompleteHook).toHaveBeenCalledTimes(1);
    compositor.unregisterPostCompleteHook("t1-b");
    expect(b.unregisterPostCompleteHook).toHaveBeenCalledWith("t1-b");

    b.get.mockReturnValue({ id: "t1-b" } as never);
    await compositor.transferTerminal("t1-b", "a");
    expect(a.registerPostCompleteHook).not.toHaveBeenCalled();
  });
});
