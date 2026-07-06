import { describe, expect, it, vi } from "vitest";
import { PaintFabricCompositor } from "../PaintFabricCompositor";
import type { PaintSurface } from "../PaintSurfaceRegistry";
import type { TerminalPaintPlane } from "../../TerminalInstanceService";
import type { ManagedTerminal } from "../../types";

function makeFakePlane() {
  return {
    getOrCreate: vi.fn(async (id: string) => ({ id }) as unknown as ManagedTerminal),
    prewarmTerminal: vi.fn(async (id: string) => ({ id }) as unknown as ManagedTerminal),
    get: vi.fn((): ManagedTerminal | null => null),
    focus: vi.fn(),
    destroy: vi.fn(),
    dispose: vi.fn(),
    notifyUserInput: vi.fn(),
    scheduleBatchResize: vi.fn(),
    waitForAllFullySettled: vi.fn(async () => undefined),
    applyGlobalOptions: vi.fn(),
    getScrollbackRestorePendingCount: vi.fn(() => 0),
    subscribeScrollbackRestoreState: vi.fn(() => vi.fn()),
    suppressResizesDuringLayoutTransition: vi.fn(),
  };
}

type FakePlane = ReturnType<typeof makeFakePlane>;

function makeSurface(id: string): { surface: PaintSurface; plane: FakePlane } {
  const plane = makeFakePlane();
  return { surface: { id, plane: plane as unknown as TerminalPaintPlane }, plane };
}

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

    compositor.scheduleBatchResize(["t1-b", "t2-a", "t3-b", "unplaced"]);
    expect(b.scheduleBatchResize).toHaveBeenCalledWith(["t1-b", "t3-b"]);
    expect(a.scheduleBatchResize).toHaveBeenCalledWith(["t2-a", "unplaced"]);
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

  it("combines cross-surface subscriptions into one unsubscribe", () => {
    const { compositor, a, b } = makeCompositor();
    const unsubA = vi.fn();
    const unsubB = vi.fn();
    a.subscribeScrollbackRestoreState.mockReturnValue(unsubA);
    b.subscribeScrollbackRestoreState.mockReturnValue(unsubB);

    const listener = vi.fn();
    const unsubscribe = compositor.subscribeScrollbackRestoreState(listener);
    expect(a.subscribeScrollbackRestoreState).toHaveBeenCalledWith(listener);
    expect(b.subscribeScrollbackRestoreState).toHaveBeenCalledWith(listener);

    unsubscribe();
    expect(unsubA).toHaveBeenCalledTimes(1);
    expect(unsubB).toHaveBeenCalledTimes(1);
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
