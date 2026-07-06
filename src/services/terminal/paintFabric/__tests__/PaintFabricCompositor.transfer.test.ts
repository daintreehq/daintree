import { describe, expect, it, vi } from "vitest";
import { PaintFabricCompositor } from "../PaintFabricCompositor";
import type { ManagedTerminal } from "../../types";
import { makeSurface } from "./fakePaintPlane";

// The cross-surface re-parent behind Phase 1 drag-drop: dispose on the source,
// re-create on the target from the captured creation args, restore the
// pty-host's canonical scrollback, carry visibility/tier/agent/focus state,
// rebind subscriptions. The pty never stops; only the renderer instance moves.
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

describe("PaintFabricCompositor.transferTerminal", () => {
  it("re-creates on the target with the captured args, restores, carries state, and re-routes", async () => {
    const { compositor, a, b } = makeCompositor();
    const getRefreshTier = vi.fn();
    const onInput = vi.fn();
    const getCwd = vi.fn();
    const options = { fontSize: 13 };

    await compositor.getOrCreate("t1-b", "claude", options, getRefreshTier, onInput, getCwd);
    compositor.setVisible("t1-b", true);
    compositor.initializeBackendTier("t1-b", "active");
    compositor.applyAgentPromotion("t1-b", "agent-x");
    compositor.setInputLocked("t1-b", true);

    b.get.mockReturnValue({ id: "t1-b" } as unknown as ManagedTerminal);
    b.getAgentState.mockReturnValue("working" as never);
    b.isFocused.mockReturnValue(true);

    const moved = await compositor.transferTerminal("t1-b", "a");
    expect(moved).toBe(true);

    // Source teardown happened before the target re-create.
    expect(b.destroy).toHaveBeenCalledWith("t1-b");
    expect(b.destroy.mock.invocationCallOrder[0]!).toBeLessThan(
      a.getOrCreate.mock.invocationCallOrder[0]!
    );

    // Re-created from the exact captured args.
    expect(a.getOrCreate).toHaveBeenCalledWith(
      "t1-b",
      "claude",
      options,
      getRefreshTier,
      onInput,
      getCwd
    );
    // Byte-for-byte scrollback: restored from the pty-host's canonical state.
    expect(a.fetchAndRestore).toHaveBeenCalledWith("t1-b");

    // Carried state re-applied on the target.
    expect(a.initializeBackendTier).toHaveBeenCalledWith("t1-b", "active");
    expect(a.setVisible).toHaveBeenCalledWith("t1-b", true);
    expect(a.applyAgentPromotion).toHaveBeenCalledWith("t1-b", "agent-x");
    expect(a.setInputLocked).toHaveBeenCalledWith("t1-b", true);
    expect(a.setAgentState).toHaveBeenCalledWith("t1-b", "working");
    expect(a.setFocused).toHaveBeenCalledWith("t1-b", true);
    expect(a.focus).toHaveBeenCalledWith("t1-b");

    // Ownership moved: per-terminal routing goes to the target now.
    compositor.notifyUserInput("t1-b", "x");
    expect(a.notifyUserInput).toHaveBeenCalledWith("t1-b", "x");
    expect(b.notifyUserInput).not.toHaveBeenCalled();
  });

  it("does not resurrect an explicitly cleared agent promotion", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});
    compositor.applyAgentPromotion("t1-b", "agent-x");
    compositor.clearAgentPromotion("t1-b");

    b.get.mockReturnValue({ id: "t1-b" } as unknown as ManagedTerminal);
    await compositor.transferTerminal("t1-b", "a");
    expect(a.applyAgentPromotion).not.toHaveBeenCalled();
  });

  it("rebinds per-id subscriptions to the target surface", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});

    const unsubOnB = vi.fn();
    b.addExitListener.mockReturnValue(unsubOnB);
    const callback = vi.fn();
    compositor.addExitListener("t1-b", callback);

    b.get.mockReturnValue({ id: "t1-b" } as unknown as ManagedTerminal);
    await compositor.transferTerminal("t1-b", "a");

    expect(unsubOnB).toHaveBeenCalledTimes(1);
    expect(a.addExitListener).toHaveBeenCalledWith("t1-b", callback);
  });

  it("is a no-op for a same-surface transfer", async () => {
    const { compositor, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});
    b.get.mockReturnValue({ id: "t1-b" } as unknown as ManagedTerminal);

    await expect(compositor.transferTerminal("t1-b", "b")).resolves.toBe(false);
    expect(b.destroy).not.toHaveBeenCalled();
  });

  it("throws for an unknown target surface", async () => {
    const { compositor } = makeCompositor();
    await expect(compositor.transferTerminal("t1-b", "nope")).rejects.toThrow(
      /Unknown paint surface/
    );
  });

  it("moves placement only (no re-create) when there is no live instance", async () => {
    const { compositor, a, b } = makeCompositor();
    // Never created: routes to the default surface a, no live instance there.
    const moved = await compositor.transferTerminal("ghost", "b");
    expect(moved).toBe(false);
    expect(a.destroy).not.toHaveBeenCalled();
    expect(b.getOrCreate).not.toHaveBeenCalled();

    compositor.focus("ghost");
    expect(b.focus).toHaveBeenCalledWith("ghost");
  });

  it("releases the placement when the target re-create fails, so a retry claims cleanly", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});
    b.get.mockReturnValue({ id: "t1-b" } as unknown as ManagedTerminal);
    a.getOrCreate.mockRejectedValueOnce(new Error("target boom"));

    await expect(compositor.transferTerminal("t1-b", "a")).rejects.toThrow("target boom");
    expect(compositor.getRegistryForTests().surfaceFor("t1-b")).toBeNull();

    // A retry (the caller's recovery path) claims a fresh placement.
    await compositor.getOrCreate("t1-b", undefined, {});
    expect(compositor.getRegistryForTests().surfaceFor("t1-b")?.id).toBe("b");
  });
});
