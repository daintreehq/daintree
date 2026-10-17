import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaintFabricCompositor } from "../PaintFabricCompositor";
import { GRID_RESIZE_COALESCE_MS, type ManagedTerminal } from "../../types";
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

  it("keeps a terminal's input epoch on the plane that owns it", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});
    b.getUserInputEpoch.mockReturnValue(3);

    compositor.notifyUserInput("t1-b", "", { automatic: true });
    compositor.noteUserInput("t1-b");

    expect(b.notifyUserInput).toHaveBeenCalledWith("t1-b", "", { automatic: true });
    expect(b.noteUserInput).toHaveBeenCalledWith("t1-b");
    expect(compositor.getUserInputEpoch("t1-b")).toBe(3);
    expect(a.noteUserInput).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "carries the resync options through to the owning plane and returns its verdict (%s)",
    async (verdict) => {
      const { compositor, a, b } = makeCompositor();
      await compositor.getOrCreate("t1-b", undefined, {});
      b.resetRenderer.mockReturnValue(verdict);

      // The delegation seam forwards only what it names. Dropping the options
      // here would silently downgrade an explicit Redraw back to the deferring
      // path with nothing failing to notice (#11638). Both verdicts are pinned
      // so a hardcoded `return true` can't satisfy the contract either — the
      // #10632 suppression-clear reads this boolean.
      expect(compositor.resetRenderer("t1-b", { force: true })).toBe(verdict);
      expect(b.resetRenderer).toHaveBeenCalledWith("t1-b", { force: true });
      expect(a.resetRenderer).not.toHaveBeenCalled();
    }
  );

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

// Phase 1 watch-list: "subscription rebinding on placement". Per-id
// subscriptions made before a terminal is placed materialize on the default
// surface; when the terminal is created on (or moved to) another surface the
// compositor must rebind them, or they stay stranded and never fire.
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

  it("rebinds padding paint subscriptions with the terminal (#13160)", async () => {
    const { compositor, a, b } = makeCompositor();
    const unsubOnA = vi.fn();
    a.addPaddingPaintListener.mockReturnValue(unsubOnA);

    const callback = vi.fn();
    compositor.addPaddingPaintListener("t1-b", callback);
    expect(a.addPaddingPaintListener).toHaveBeenCalledWith("t1-b", callback);

    await compositor.getOrCreate("t1-b", undefined, {});
    expect(unsubOnA).toHaveBeenCalledTimes(1);
    expect(b.addPaddingPaintListener).toHaveBeenCalledWith("t1-b", callback);
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

// The cross-surface re-parent behind Phase 1 drag-drop: dispose on the source,
// re-create on the target from the captured creation args, restore the
// pty-host's canonical scrollback, carry visibility/tier/agent/focus state,
// rebind subscriptions. The pty never stops; only the renderer instance moves.
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

  it("carries an explicit clearAgentPromotion: the target is re-cleared, not re-promoted", async () => {
    const { compositor, a, b } = makeCompositor();
    // Created WITH a launch agent — the target's getOrCreate re-promotes from
    // launchAgentId, so the explicit demotion must be re-applied after it.
    await compositor.getOrCreate("t1-b", "claude", {});
    compositor.applyAgentPromotion("t1-b", "agent-x");
    compositor.clearAgentPromotion("t1-b");

    b.get.mockReturnValue({ id: "t1-b" } as unknown as ManagedTerminal);
    await compositor.transferTerminal("t1-b", "a");
    expect(a.applyAgentPromotion).not.toHaveBeenCalled();
    expect(a.clearAgentPromotion).toHaveBeenCalledWith("t1-b");
  });

  it("a transfer during an in-flight create cancels the doomed build and keeps the new placement", async () => {
    const { compositor, b } = makeCompositor();

    let rejectCreate: (error: Error) => void = () => {};
    b.getOrCreate.mockImplementationOnce(
      () => new Promise<ManagedTerminal>((_, reject) => (rejectCreate = reject))
    );
    const doomed = compositor.getOrCreate("t1-b", undefined, {});

    // No live instance on b yet → placement-only move, but the in-flight
    // build on b is cancelled via destroy-during-create.
    await compositor.transferTerminal("t1-b", "a");
    expect(b.destroy).toHaveBeenCalledWith("t1-b");
    expect(compositor.getRegistryForTests().surfaceFor("t1-b")!.id).toBe("a");

    // The doomed create's cleanup must NOT release the placement that now
    // belongs to surface a.
    rejectCreate(new Error("cancelled"));
    await expect(doomed).rejects.toThrow("cancelled");
    expect(compositor.getRegistryForTests().surfaceFor("t1-b")!.id).toBe("a");
  });

  it("rebuilds with current options after updateOptions and applyGlobalOptions", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, { fontSize: 13, scrollback: 1000 });
    compositor.updateOptions("t1-b", { fontSize: 18 });
    compositor.applyGlobalOptions({ fontFamily: "Hack" });

    b.get.mockReturnValue({ id: "t1-b" } as unknown as ManagedTerminal);
    await compositor.transferTerminal("t1-b", "a");
    expect(a.getOrCreate).toHaveBeenCalledWith(
      "t1-b",
      undefined,
      { fontSize: 18, scrollback: 1000, fontFamily: "Hack" },
      undefined,
      undefined,
      undefined
    );
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
    // The source gets a defensive destroy (cancels an in-flight create; a
    // no-op for a genuinely unknown id) but the target builds nothing.
    expect(a.destroy).toHaveBeenCalledWith("ghost");
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

// Phase 1 watch-list: "cross-surface resize-pass coordination". One logical
// pass can span every surface, while scoped passes must not discard pending
// fresh-measurement obligations on surfaces outside their id set.
describe("PaintFabricCompositor resize coordination", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst into ONE logical pass partitioned across surfaces", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});
    await compositor.getOrCreate("t2-a", undefined, {});

    compositor.scheduleBatchResize(["t1-b"]);
    compositor.scheduleBatchResize(["t2-a"]);
    expect(a.runResizePass).not.toHaveBeenCalled();
    expect(b.runResizePass).not.toHaveBeenCalled();

    // Trailing-edge debounce + the frame hop (setTimeout fallback in Node).
    vi.advanceTimersByTime(GRID_RESIZE_COALESCE_MS + 16);

    expect(b.runResizePass).toHaveBeenCalledWith(["t1-b"]);
    expect(a.runResizePass).toHaveBeenCalledWith(["t2-a"]);
    // Shards of the SAME logical pass never cancel each other.
    expect(a.cancelActiveResizePass).not.toHaveBeenCalled();
    expect(b.cancelActiveResizePass).not.toHaveBeenCalled();
  });

  it("leads a burst with an immediate pass and coalesces the rest behind it", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});
    await compositor.getOrCreate("t2-a", undefined, {});

    compositor.scheduleBatchResize(["t1-b"], { leading: true });
    expect(b.runResizePass).toHaveBeenCalledWith(["t1-b"], { immediate: true });

    compositor.scheduleBatchResize(["t2-a"], { leading: true });
    expect(a.runResizePass).not.toHaveBeenCalled();

    vi.advanceTimersByTime(GRID_RESIZE_COALESCE_MS + 16);
    expect(a.runResizePass).toHaveBeenCalledWith(["t2-a"], { immediateIds: new Set(["t2-a"]) });
    expect(b.runResizePass).toHaveBeenCalledTimes(1);
  });

  it("keeps leading requests inside a burst immediate in the trailing pass", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});
    await compositor.getOrCreate("t2-a", undefined, {});

    compositor.scheduleBatchResize(["t1-b"]);
    vi.advanceTimersByTime(GRID_RESIZE_COALESCE_MS);
    // The trailing pass is waiting on its frame: still the same burst.
    compositor.scheduleBatchResize(["t2-a"], { leading: true });
    expect(a.runResizePass).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16 + GRID_RESIZE_COALESCE_MS + 16);
    expect(b.runResizePass).toHaveBeenCalledWith(["t1-b"]);
    expect(a.runResizePass).toHaveBeenCalledWith(["t2-a"], {
      immediateIds: new Set(["t2-a"]),
    });
  });

  it("a scoped pass preserves active work on surfaces outside the pass", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});
    await compositor.getOrCreate("t2-a", undefined, {});

    // Pass 1 hits only surface b; its chunked work is now in flight.
    compositor.runResizePass(["t1-b"]);
    expect(b.runResizePass).toHaveBeenCalledWith(["t1-b"]);
    expect(a.cancelActiveResizePass).not.toHaveBeenCalled();

    // Pass 2 is independently scoped to surface a. Surface b's pending work is
    // still valid and remains owned until it completes or is explicitly
    // cancelled.
    compositor.runResizePass(["t2-a"]);
    expect(a.runResizePass).toHaveBeenCalledWith(["t2-a"]);
    expect(b.cancelActiveResizePass).not.toHaveBeenCalled();
  });

  it("an empty pass is a no-op and cancels nothing", () => {
    const { compositor, a, b } = makeCompositor();
    compositor.runResizePass([]);
    expect(a.runResizePass).not.toHaveBeenCalled();
    expect(b.runResizePass).not.toHaveBeenCalled();
    expect(a.cancelActiveResizePass).not.toHaveBeenCalled();
    expect(b.cancelActiveResizePass).not.toHaveBeenCalled();
  });

  it("issues no cross-surface cancels at surface-count 1 (Phase 0 parity)", () => {
    const only = makeSurface("only");
    const compositor = new PaintFabricCompositor({ surfaces: [only.surface] });
    compositor.runResizePass(["t1", "t2"]);
    expect(only.plane.runResizePass).toHaveBeenCalledWith(["t1", "t2"]);
    expect(only.plane.cancelActiveResizePass).not.toHaveBeenCalled();
  });

  it("cancelActiveResizePass fans out to every surface", () => {
    const { compositor, a, b } = makeCompositor();
    compositor.cancelActiveResizePass();
    expect(a.cancelActiveResizePass).toHaveBeenCalledTimes(1);
    expect(b.cancelActiveResizePass).toHaveBeenCalledTimes(1);
  });

  it("dispose clears a pending coalesced pass", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});
    compositor.scheduleBatchResize(["t1-b"]);
    compositor.dispose();
    vi.advanceTimersByTime(GRID_RESIZE_COALESCE_MS + 32);
    expect(a.runResizePass).not.toHaveBeenCalled();
    expect(b.runResizePass).not.toHaveBeenCalled();
  });
});

// Phase 3 resilience: a crash-looping surface is retired by co-locating its
// terminals onto siblings — degradation moves toward the single-surface view,
// never toward dropping terminals.
function makeRetireCompositor() {
  const a = makeSurface("a");
  const b = makeSurface("b");
  const c = makeSurface("c");
  const compositor = new PaintFabricCompositor({
    surfaces: [a.surface, b.surface, c.surface],
    choosePlacement: (terminalId, registry) => {
      const suffix = terminalId.slice(-1);
      return registry.surfaces().find((s) => s.id === suffix) ?? registry.defaultSurface();
    },
  });
  return { compositor, a: a.plane, b: b.plane, c: c.plane };
}

describe("PaintFabricCompositor.retireSurface", () => {
  it("re-homes every terminal onto least-loaded siblings and unregisters the surface", async () => {
    const { compositor, a, b, c } = makeRetireCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});
    await compositor.getOrCreate("t2-b", undefined, {});
    await compositor.getOrCreate("t3-c", undefined, {});
    b.get.mockImplementation((id: string) => ({ id }) as unknown as ManagedTerminal);

    const evacuated = await compositor.retireSurface("b");
    expect(evacuated.sort()).toEqual(["t1-b", "t2-b"]);

    // Nothing dropped: every evacuee is placed on a surviving surface.
    const registry = compositor.getRegistryForTests();
    expect(registry.surfaceById("b")).toBeNull();
    for (const id of evacuated) {
      expect(registry.surfaceFor(id)).not.toBeNull();
      expect(registry.surfaceFor(id)!.id).not.toBe("b");
    }

    // Least-loaded per evacuee: a(0) beats c(1) for the first; the resulting
    // tie (a=1, c=1) resolves to the first-registered sibling, a again.
    expect(registry.surfaceFor("t1-b")!.id).toBe("a");
    expect(registry.surfaceFor("t2-b")!.id).toBe("a");
    expect(a.getOrCreate).toHaveBeenCalledWith(
      "t1-b",
      undefined,
      {},
      undefined,
      undefined,
      undefined
    );
    expect(a.getOrCreate).toHaveBeenCalledWith(
      "t2-b",
      undefined,
      {},
      undefined,
      undefined,
      undefined
    );
    // c only saw its own setup create (t3-c) — no evacuee landed there.
    expect(c.getOrCreate).toHaveBeenCalledTimes(1);
    expect(c.getOrCreate).toHaveBeenCalledWith(
      "t3-c",
      undefined,
      {},
      undefined,
      undefined,
      undefined
    );

    // The dead surface is disposed and its forwarder detached.
    expect(b.dispose).toHaveBeenCalledTimes(1);
    const listener = vi.fn();
    compositor.subscribeScrollbackRestoreState(listener);
    b.notifyScrollbackRestoreListeners();
    expect(listener).not.toHaveBeenCalled();
  });

  it("rebuilds terminals from a crashed source surface instead of dropping them", async () => {
    const { compositor, a, b } = makeRetireCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});
    b.get.mockImplementation(() => {
      throw new Error("surface is gone");
    });
    b.dispose.mockImplementation(() => {
      throw new Error("surface is gone");
    });

    const evacuated = await compositor.retireSurface("b");
    expect(evacuated).toEqual(["t1-b"]);
    const registry = compositor.getRegistryForTests();
    expect(registry.surfaceFor("t1-b")).not.toBeNull();
    expect(registry.surfaceFor("t1-b")!.id).not.toBe("b");

    // The crashed plane could not answer get(), but the fabric created this
    // terminal — so it is REBUILT on the sibling, not just re-pointed.
    expect(a.getOrCreate).toHaveBeenCalledWith(
      "t1-b",
      undefined,
      {},
      undefined,
      undefined,
      undefined
    );
    expect(a.fetchAndRestore).toHaveBeenCalledWith("t1-b");
  });

  it("refuses to retire the default surface", async () => {
    const { compositor } = makeRetireCompositor();
    await expect(compositor.retireSurface("a")).rejects.toThrow(/default paint surface/);
  });

  it("throws for an unknown surface", async () => {
    const { compositor } = makeRetireCompositor();
    await expect(compositor.retireSurface("nope")).rejects.toThrow(/Unknown paint surface/);
  });

  it("reports per-surface diagnostics with the default flagged", async () => {
    const { compositor, b } = makeRetireCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});
    b.getScrollbackRestorePendingCount.mockReturnValue(2);

    const diagnostics = compositor.getSurfaceDiagnostics();
    expect(diagnostics).toHaveLength(3);
    const byId = new Map(diagnostics.map((d) => [d.surfaceId, d]));
    expect(byId.get("a")!.isDefault).toBe(true);
    expect(byId.get("b")!.isDefault).toBe(false);
    expect(byId.get("b")!.terminalCount).toBe(1);
    expect(byId.get("b")!.scrollbackRestorePendingCount).toBe(2);
  });
});

// Phase 1V sync-read mirrors: the sync half of TerminalPaintPlane (`get`,
// `captureBufferText`, `getAgentState`, `isFocused`, `fit`, `resize`) cannot
// cross a process boundary, so terminals owned by view-hosted surfaces answer
// those calls from compositor-side mirrors — written on control paths and via
// applyMirrorPatch, never per output chunk. Local surfaces keep delegating to
// their plane, byte-identical to the pre-1V path.
function makeViewCompositor() {
  const local = makeSurface("local");
  const view = makeSurface("view-1", "view");
  const compositor = new PaintFabricCompositor({
    surfaces: [local.surface, view.surface],
    choosePlacement: (terminalId, registry) =>
      registry
        .surfaces()
        .find((s) => s.id === (terminalId.startsWith("v-") ? "view-1" : "local")) ??
      registry.defaultSurface(),
  });
  return { compositor, local: local.plane, view: view.plane };
}

describe("PaintFabricCompositor sync-read mirrors", () => {
  it("answers view-owned sync reads from the mirror, never the plane", async () => {
    const { compositor, view } = makeViewCompositor();
    await compositor.getOrCreate("v-1", undefined, {});

    compositor.applyMirrorPatch("v-1", {
      agentState: "working",
      focused: true,
      bufferText: "hello world",
    });

    expect(compositor.getAgentState("v-1")).toBe("working");
    expect(compositor.isFocused("v-1")).toBe(true);
    expect(compositor.captureBufferText("v-1")).toBe("hello world");
    expect(view.getAgentState).not.toHaveBeenCalled();
    expect(view.isFocused).not.toHaveBeenCalled();
    expect(view.captureBufferText).not.toHaveBeenCalled();
  });

  it("tail-truncates mirrored buffer text to maxChars like the bare service", async () => {
    const { compositor } = makeViewCompositor();
    await compositor.getOrCreate("v-1", undefined, {});
    compositor.applyMirrorPatch("v-1", { bufferText: "0123456789" });

    expect(compositor.captureBufferText("v-1", 4)).toBe("6789");
    // Boundary semantics match the bare service: nothing for a non-positive
    // budget (`slice(-0)` would otherwise return the full text).
    expect(compositor.captureBufferText("v-1", 0)).toBe("");
    expect(compositor.captureBufferText("v-1", -5)).toBe("");
  });

  it("drops mirror patches for ids not currently view-owned", async () => {
    const { compositor } = makeViewCompositor();
    // Unplaced id → default (local) surface owns it → patch dropped.
    compositor.applyMirrorPatch("ghost", { agentState: "working" });
    expect(compositor.getMirrorForTests("ghost")).toBeUndefined();

    // Destroyed view-owned terminal: a late patch must not resurrect state.
    await compositor.getOrCreate("v-1", undefined, {});
    compositor.applyMirrorPatch("v-1", { agentState: "working" });
    compositor.destroy("v-1");
    compositor.applyMirrorPatch("v-1", { agentState: "working" });
    expect(compositor.getMirrorForTests("v-1")).toBeUndefined();
  });

  it("defaults view-owned reads when no mirror state has arrived", async () => {
    const { compositor } = makeViewCompositor();
    await compositor.getOrCreate("v-1", undefined, {});

    expect(compositor.getAgentState("v-1")).toBeUndefined();
    expect(compositor.isFocused("v-1")).toBe(false);
    expect(compositor.captureBufferText("v-1")).toBe("");
  });

  it("skips undefined fields in a patch so partial pushes never erase state", async () => {
    const { compositor } = makeViewCompositor();
    await compositor.getOrCreate("v-1", undefined, {});
    compositor.applyMirrorPatch("v-1", { agentState: "working", focused: true });
    compositor.applyMirrorPatch("v-1", { bufferText: "text" });

    expect(compositor.getAgentState("v-1")).toBe("working");
    expect(compositor.isFocused("v-1")).toBe(true);
    expect(compositor.captureBufferText("v-1")).toBe("text");
  });

  it("keeps the mirror fresh from compositor control paths", async () => {
    const { compositor, view } = makeViewCompositor();
    await compositor.getOrCreate("v-1", undefined, {});

    compositor.setAgentState("v-1", "waiting");
    compositor.setFocused("v-1", true);

    expect(compositor.getAgentState("v-1")).toBe("waiting");
    expect(compositor.isFocused("v-1")).toBe(true);
    // Control writes still forward to the owning plane (the future remote
    // adapter relays them to the surface renderer).
    expect(view.setAgentState).toHaveBeenCalledWith("v-1", "waiting");
    expect(view.setFocused).toHaveBeenCalledWith("v-1", true);
  });

  it("returns null/undefined for cross-process handles on view-owned terminals", async () => {
    const { compositor, view } = makeViewCompositor();
    await compositor.getOrCreate("v-1", undefined, {});
    view.get.mockReturnValue({ id: "v-1" } as unknown as ManagedTerminal);

    expect(compositor.get("v-1")).toBeNull();
    expect(compositor.getInstanceForE2E("v-1")).toBeUndefined();
    expect(compositor.fit("v-1")).toBeNull();
    expect(compositor.resize("v-1", 800, 600)).toBeNull();
  });

  it("answers the remaining sync reads with safe defaults for view-owned terminals", async () => {
    const { compositor } = makeViewCompositor();
    await compositor.getOrCreate("v-1", undefined, {});

    expect(compositor.getHoveredLinkText("v-1")).toBeNull();
    expect(compositor.getHoveredFilePath("v-1")).toBeNull();
    expect(compositor.getCachedSelection("v-1")).toBe("");
    expect(compositor.getAttachGeneration("v-1")).toBe(0);
    expect(compositor.getAltBufferState("v-1")).toBe(false);
    expect(compositor.getSynchronizedOutputMode("v-1")).toBeNull();
    expect(compositor.isHibernated("v-1")).toBe(false);
    expect(compositor.isWebGLActive("v-1")).toBe(false);
  });

  it("releases a failed first create's claim on a view surface", async () => {
    const { compositor, view } = makeViewCompositor();
    view.getOrCreate.mockRejectedValueOnce(new Error("boot failed"));

    await expect(compositor.getOrCreate("v-1", undefined, {})).rejects.toThrow(/boot failed/);
    // Nothing keeps routing to a terminal that never existed; the next
    // create claims cleanly.
    expect(compositor.getRegistryForTests().surfaceFor("v-1")).toBeNull();
  });

  it("keeps the claim when an overlapping create already succeeded on the view surface", async () => {
    const { compositor, view } = makeViewCompositor();
    let rejectFirst!: (error: Error) => void;
    view.getOrCreate
      .mockImplementationOnce(
        () =>
          new Promise<ManagedTerminal>((_, reject) => {
            rejectFirst = reject;
          })
      )
      .mockImplementationOnce(async (id: string) => ({ id }) as unknown as ManagedTerminal);

    const first = compositor.getOrCreate("v-1", undefined, {});
    const second = compositor.getOrCreate("v-1", undefined, {});
    await second;
    rejectFirst(new Error("aborted"));
    await expect(first).rejects.toThrow(/aborted/);

    // The sibling's success marked the id live in the compositor ledger, so
    // the failed claimant must not strip the live terminal's placement.
    expect(compositor.getRegistryForTests().surfaceFor("v-1")?.id).toBe("view-1");
  });

  it("drops the mirror when a transfer fails after the source was destroyed", async () => {
    const { compositor, local, view } = makeViewCompositor();
    await compositor.getOrCreate("v-1", undefined, {});
    compositor.applyMirrorPatch("v-1", { agentState: "working", bufferText: "state" });
    local.getOrCreate.mockRejectedValueOnce(new Error("target build failed"));

    await expect(compositor.transferTerminal("v-1", "local")).rejects.toThrow(
      /target build failed/
    );
    // The terminal exists nowhere; stale mirror state must not answer for it.
    expect(compositor.getMirrorForTests("v-1")).toBeUndefined();
    expect(view.destroy).toHaveBeenCalledWith("v-1");
  });

  it("routes DOM attach/detach to the bounds protocol (no-op) for view-owned terminals", async () => {
    const { compositor, view, local } = makeViewCompositor();
    await compositor.getOrCreate("v-1", undefined, {});
    await compositor.getOrCreate("l-1", undefined, {});
    const container = {} as HTMLElement;

    expect(compositor.attach("v-1", container)).toBeNull();
    compositor.detach("v-1", container);
    expect(view.attach).not.toHaveBeenCalled();
    expect(view.detach).not.toHaveBeenCalled();

    compositor.attach("l-1", container);
    compositor.detach("l-1", container);
    expect(local.attach).toHaveBeenCalledWith("l-1", container);
    expect(local.detach).toHaveBeenCalledWith("l-1", container);
  });

  it("keeps local-owned sync reads delegating to the plane", async () => {
    const { compositor, local } = makeViewCompositor();
    await compositor.getOrCreate("l-1", undefined, {});
    local.getAgentState.mockReturnValue("idle");
    local.isFocused.mockReturnValue(true);
    local.captureBufferText.mockReturnValue("local text");

    // A stale mirror for a local terminal must not shadow the plane.
    compositor.applyMirrorPatch("l-1", { agentState: "working", bufferText: "stale" });

    expect(compositor.getAgentState("l-1")).toBe("idle");
    expect(compositor.isFocused("l-1")).toBe(true);
    expect(compositor.captureBufferText("l-1")).toBe("local text");
  });

  it("seeds the mirror on transfer to a view surface and drops it on transfer back", async () => {
    const { compositor, local, view } = makeViewCompositor();
    await compositor.getOrCreate("l-1", undefined, {});
    local.get.mockReturnValue({ id: "l-1" } as unknown as ManagedTerminal);
    local.getAgentState.mockReturnValue("working");
    local.isFocused.mockReturnValue(true);

    const moved = await compositor.transferTerminal("l-1", "view-1");
    expect(moved).toBe(true);
    // Sync reads now answer from the seeded mirror.
    expect(compositor.getAgentState("l-1")).toBe("working");
    expect(compositor.isFocused("l-1")).toBe(true);
    expect(compositor.getMirrorForTests("l-1")).toBeDefined();

    // Moving back to a local surface drops the mirror — the plane is
    // authoritative again.
    const movedBack = await compositor.transferTerminal("l-1", "local");
    expect(movedBack).toBe(true);
    expect(compositor.getMirrorForTests("l-1")).toBeUndefined();
    expect(view.destroy).toHaveBeenCalledWith("l-1");
  });

  it("rebuilds a view-owned terminal on transfer without a liveness probe", async () => {
    const { compositor, view, local } = makeViewCompositor();
    await compositor.getOrCreate("v-1", undefined, {});
    // A view-hosted plane cannot answer get(); the compositor must not ask.
    view.get.mockImplementation(() => {
      throw new Error("sync get cannot cross a process boundary");
    });

    const moved = await compositor.transferTerminal("v-1", "local");
    expect(moved).toBe(true);
    expect(view.get).not.toHaveBeenCalled();
    expect(local.getOrCreate).toHaveBeenCalledWith(
      "v-1",
      undefined,
      {},
      undefined,
      undefined,
      undefined
    );
  });

  it("clears every mirror on dispose", async () => {
    const { compositor } = makeViewCompositor();
    await compositor.getOrCreate("v-1", undefined, {});
    compositor.applyMirrorPatch("v-1", { agentState: "working" });

    compositor.dispose();
    expect(compositor.getMirrorForTests("v-1")).toBeUndefined();
  });
});
