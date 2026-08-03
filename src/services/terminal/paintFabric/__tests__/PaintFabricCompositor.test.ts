import { describe, expect, it, vi } from "vitest";
import { PaintFabricCompositor } from "../PaintFabricCompositor";
import type { ManagedTerminal } from "../../types";
import { makeSurface } from "./fakePaintPlane";

function makeCompositor() {
  const a = makeSurface("a");
  const b = makeSurface("b");
  const compositor = new PaintFabricCompositor({
    surfaces: [a.surface, b.surface],
    // Deterministic policy: ids ending in "-b" land on surface b.
    choosePlacement: (terminalId, registry) =>
      registry.surfaces().find((s) => s.id === (terminalId.endsWith("-b") ? "b" : "a")) ??
      registry.defaultSurface(),
  });
  return { compositor, a: a.plane, b: b.plane };
}

describe("PaintFabricCompositor", () => {
  it("requires at least one surface", () => {
    expect(() => new PaintFabricCompositor({ surfaces: [] })).toThrow(/at least one surface/);
  });

  it("claims placement at creation and routes subsequent per-terminal calls to the owner", async () => {
    const { compositor, a, b } = makeCompositor();

    await compositor.getOrCreate("t1-b", undefined, {});
    expect(b.getOrCreate).toHaveBeenCalledTimes(1);
    expect(a.getOrCreate).not.toHaveBeenCalled();

    compositor.focus("t1-b");
    compositor.notifyUserInput("t1-b", "x");
    expect(b.focus).toHaveBeenCalledWith("t1-b");
    expect(b.notifyUserInput).toHaveBeenCalledWith("t1-b", "x");
    expect(a.focus).not.toHaveBeenCalled();
  });

  it("carries the resync options through to the owning plane and returns its verdict", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});
    b.resetRenderer.mockReturnValue(true);

    // The delegation seam forwards only what it names. Dropping the options
    // here would silently downgrade an explicit Redraw back to the deferring
    // path with nothing failing to notice (#11638).
    expect(compositor.resetRenderer("t1-b", { force: true })).toBe(true);
    expect(b.resetRenderer).toHaveBeenCalledWith("t1-b", { force: true });
    expect(a.resetRenderer).not.toHaveBeenCalled();
  });

  it("routes unplaced terminals to the default surface", () => {
    const { compositor, a, b } = makeCompositor();
    compositor.focus("never-created");
    expect(a.focus).toHaveBeenCalledWith("never-created");
    expect(b.focus).not.toHaveBeenCalled();
  });

  it("keeps the existing placement when getOrCreate is called again", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});
    await compositor.getOrCreate("t1-b", undefined, {});
    expect(b.getOrCreate).toHaveBeenCalledTimes(2);
    expect(a.getOrCreate).not.toHaveBeenCalled();
  });

  it("releases a claimed placement when creation fails, but keeps pre-existing ones", async () => {
    const { compositor, a, b } = makeCompositor();

    b.getOrCreate.mockRejectedValueOnce(new Error("boom"));
    await expect(compositor.getOrCreate("t1-b", undefined, {})).rejects.toThrow("boom");
    // Placement was released → the id now routes to the default surface.
    compositor.focus("t1-b");
    expect(a.focus).toHaveBeenCalledWith("t1-b");

    // Successful creation, then a failed re-create: placement survives.
    await compositor.getOrCreate("t2-b", undefined, {});
    b.get.mockReturnValue({ id: "t2-b" } as unknown as ManagedTerminal);
    b.getOrCreate.mockRejectedValueOnce(new Error("boom again"));
    await expect(compositor.getOrCreate("t2-b", undefined, {})).rejects.toThrow("boom again");
    compositor.focus("t2-b");
    expect(b.focus).toHaveBeenCalledWith("t2-b");
  });

  it("releases a failed claim even when the surface has become unreadable", async () => {
    const { compositor, a, b } = makeCompositor();
    b.getOrCreate.mockRejectedValueOnce(new Error("create boom"));
    b.get.mockImplementation(() => {
      throw new Error("surface is gone");
    });

    // The original create error surfaces (not the probe's), and the stale
    // claim is released so the id routes to the default surface again.
    await expect(compositor.getOrCreate("t1-b", undefined, {})).rejects.toThrow("create boom");
    expect(compositor.getRegistryForTests().surfaceFor("t1-b")).toBeNull();
    compositor.focus("t1-b");
    expect(a.focus).toHaveBeenCalledWith("t1-b");
  });

  it("keeps a live terminal placed when a failed overlapping create releases the claim", async () => {
    const { compositor, b } = makeCompositor();

    let rejectFirst: (error: Error) => void = () => {};
    let resolveSecond: (managed: ManagedTerminal) => void = () => {};
    b.getOrCreate
      .mockImplementationOnce(
        () => new Promise<ManagedTerminal>((_, reject) => (rejectFirst = reject))
      )
      .mockImplementationOnce(
        () => new Promise<ManagedTerminal>((resolve) => (resolveSecond = resolve))
      );

    const first = compositor.getOrCreate("t1-b", undefined, {});
    const second = compositor.getOrCreate("t1-b", undefined, {});

    // First build aborted (destroy-during-create shape) → its catch releases
    // the placement it claimed; the second, piggybacked call then succeeds.
    rejectFirst(new Error("aborted"));
    await expect(first).rejects.toThrow("aborted");

    const managed = { id: "t1-b" } as unknown as ManagedTerminal;
    b.get.mockReturnValue(managed);
    resolveSecond(managed);
    await expect(second).resolves.toBe(managed);

    // The surviving terminal must still be owned by its surface.
    compositor.focus("t1-b");
    expect(b.focus).toHaveBeenCalledWith("t1-b");
  });

  it("destroy routes to the owner and releases the placement", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});

    compositor.destroy("t1-b");
    expect(b.destroy).toHaveBeenCalledWith("t1-b");

    compositor.focus("t1-b");
    expect(a.focus).toHaveBeenCalledWith("t1-b");
  });

  it("partitions multi-id calls by owning surface, preserving per-surface order", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});
    await compositor.getOrCreate("t2-a", undefined, {});
    await compositor.getOrCreate("t3-b", undefined, {});

    compositor.suppressResizesDuringLayoutTransition(["t1-b", "t2-a", "t3-b", "unplaced"], 200);
    expect(b.suppressResizesDuringLayoutTransition).toHaveBeenCalledWith(["t1-b", "t3-b"], 200);
    expect(a.suppressResizesDuringLayoutTransition).toHaveBeenCalledWith(["t2-a", "unplaced"], 200);
  });

  it("groups settle waits per surface and resolves when all resolve", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});
    await compositor.getOrCreate("t2-a", undefined, {});

    await compositor.waitForAllFullySettled(["t1-b", "t2-a"], { timeoutMs: 5 });
    expect(b.waitForAllFullySettled).toHaveBeenCalledWith(["t1-b"], { timeoutMs: 5 });
    expect(a.waitForAllFullySettled).toHaveBeenCalledWith(["t2-a"], { timeoutMs: 5 });
  });

  it("fans whole-project calls out to every surface and sums numeric aggregates", () => {
    const { compositor, a, b } = makeCompositor();

    compositor.applyGlobalOptions({ fontSize: 13 });
    expect(a.applyGlobalOptions).toHaveBeenCalledWith({ fontSize: 13 });
    expect(b.applyGlobalOptions).toHaveBeenCalledWith({ fontSize: 13 });

    a.getScrollbackRestorePendingCount.mockReturnValue(2);
    b.getScrollbackRestorePendingCount.mockReturnValue(3);
    expect(compositor.getScrollbackRestorePendingCount()).toBe(5);
  });

  it("owns the aggregate scrollback-restore listener set: one logical change fires once", () => {
    const { compositor, a, b } = makeCompositor();
    // The compositor subscribed one forwarder per surface at construction.
    expect(a.subscribeScrollbackRestoreState).toHaveBeenCalledTimes(1);
    expect(b.subscribeScrollbackRestoreState).toHaveBeenCalledTimes(1);

    const listener = vi.fn();
    const unsubscribe = compositor.subscribeScrollbackRestoreState(listener);
    // The caller's listener is compositor-owned, never fanned to surfaces.
    expect(a.subscribeScrollbackRestoreState).toHaveBeenCalledTimes(1);
    expect(b.subscribeScrollbackRestoreState).toHaveBeenCalledTimes(1);

    // External notify (the scheduler path): exactly once, not once per surface.
    compositor.notifyScrollbackRestoreListeners();
    expect(listener).toHaveBeenCalledTimes(1);

    // Plane-internal notify (destroy-during-restore path) forwards: once.
    a.notifyScrollbackRestoreListeners();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    compositor.notifyScrollbackRestoreListeners();
    b.notifyScrollbackRestoreListeners();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  // Fleet broadcast bytes go terminalClient.broadcast → pty-host fan-out and
  // never pass through this seam, so surface count cannot reorder or drop
  // them. What the fabric routes are the per-terminal UI side-effects — each
  // must land on the owning surface only, with the caller-side focused-origin
  // exemption (fleetRawInputBroadcast skips notifyUserInput for the origin)
  // expressed as simply not calling for that id.
  it("routes broadcast side-effects per owning surface (fleet fan-out shape)", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("origin-a", undefined, {});
    await compositor.getOrCreate("t1-b", undefined, {});
    await compositor.getOrCreate("t2-a", undefined, {});

    // The fleet fan-out: origin exempt from notifyUserInput, everyone gets
    // notifyEnterPressed (matching fleetRawInputBroadcast's contract).
    for (const id of ["t1-b", "t2-a"]) compositor.notifyUserInput(id, "x");
    for (const id of ["origin-a", "t1-b", "t2-a"]) compositor.notifyEnterPressed(id);

    expect(b.notifyUserInput).toHaveBeenCalledTimes(1);
    expect(b.notifyUserInput).toHaveBeenCalledWith("t1-b", "x");
    expect(a.notifyUserInput).toHaveBeenCalledTimes(1);
    expect(a.notifyUserInput).toHaveBeenCalledWith("t2-a", "x");

    expect(a.notifyEnterPressed).toHaveBeenCalledTimes(2);
    expect(b.notifyEnterPressed).toHaveBeenCalledTimes(1);
    expect(b.notifyEnterPressed).toHaveBeenCalledWith("t1-b");
  });

  it("keeps focus authority per-id: focus routes to the owner only", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});

    compositor.setFocused("t1-b", true);
    compositor.focus("t1-b");
    expect(b.setFocused).toHaveBeenCalledWith("t1-b", true);
    expect(b.focus).toHaveBeenCalledWith("t1-b");
    expect(a.setFocused).not.toHaveBeenCalled();
    expect(a.focus).not.toHaveBeenCalled();

    b.isFocused.mockReturnValue(true);
    expect(compositor.isFocused("t1-b")).toBe(true);
    expect(a.isFocused).not.toHaveBeenCalled();
  });

  it("dispose fans out and clears all placements", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});

    compositor.dispose();
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).toHaveBeenCalledTimes(1);

    compositor.focus("t1-b");
    expect(a.focus).toHaveBeenCalledWith("t1-b");
  });
});
