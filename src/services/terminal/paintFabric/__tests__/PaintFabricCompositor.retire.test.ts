import { describe, expect, it, vi } from "vitest";
import { PaintFabricCompositor } from "../PaintFabricCompositor";
import type { ManagedTerminal } from "../../types";
import { makeSurface } from "./fakePaintPlane";

// Phase 3 resilience: a crash-looping surface is retired by co-locating its
// terminals onto siblings — degradation moves toward the single-surface view,
// never toward dropping terminals.
function makeCompositor() {
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
    const { compositor, a, b, c } = makeCompositor();
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

  it("tolerates a crashed source surface (best-effort reads) without dropping placements", async () => {
    const { compositor, b } = makeCompositor();
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
  });

  it("refuses to retire the default surface", async () => {
    const { compositor } = makeCompositor();
    await expect(compositor.retireSurface("a")).rejects.toThrow(/default paint surface/);
  });

  it("throws for an unknown surface", async () => {
    const { compositor } = makeCompositor();
    await expect(compositor.retireSurface("nope")).rejects.toThrow(/Unknown paint surface/);
  });

  it("reports per-surface diagnostics with the default flagged", async () => {
    const { compositor, b } = makeCompositor();
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
