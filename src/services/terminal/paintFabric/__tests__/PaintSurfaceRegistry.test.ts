import { describe, expect, it } from "vitest";
import { PaintSurfaceRegistry, type PaintSurface } from "../PaintSurfaceRegistry";
import type { TerminalPaintPlane } from "../../TerminalInstanceService";

function makeSurface(id: string): PaintSurface {
  return { id, plane: {} as TerminalPaintPlane };
}

describe("PaintSurfaceRegistry", () => {
  it("uses the first registered surface as default until an explicit default arrives", () => {
    const registry = new PaintSurfaceRegistry();
    const a = makeSurface("a");
    const b = makeSurface("b");
    registry.registerSurface(a);
    expect(registry.defaultSurface()).toBe(a);
    registry.registerSurface(b, { isDefault: true });
    expect(registry.defaultSurface()).toBe(b);
  });

  it("rejects duplicate surface registration", () => {
    const registry = new PaintSurfaceRegistry();
    registry.registerSurface(makeSurface("a"));
    expect(() => registry.registerSurface(makeSurface("a"))).toThrow(/already registered/);
  });

  it("throws when no default surface exists", () => {
    const registry = new PaintSurfaceRegistry();
    expect(() => registry.defaultSurface()).toThrow(/no default surface/);
  });

  it("enforces single ownership: re-placing on another surface throws until released", () => {
    const registry = new PaintSurfaceRegistry();
    registry.registerSurface(makeSurface("a"));
    registry.registerSurface(makeSurface("b"));

    registry.place("t1", "a");
    registry.place("t1", "a");
    expect(() => registry.place("t1", "b")).toThrow(/already placed/);

    registry.release("t1");
    registry.place("t1", "b");
    expect(registry.surfaceFor("t1")?.id).toBe("b");
  });

  it("rejects placement on an unknown surface", () => {
    const registry = new PaintSurfaceRegistry();
    registry.registerSurface(makeSurface("a"));
    expect(() => registry.place("t1", "ghost")).toThrow(/Unknown paint surface/);
  });

  it("returns null for unplaced terminals", () => {
    const registry = new PaintSurfaceRegistry();
    registry.registerSurface(makeSurface("a"));
    expect(registry.surfaceFor("t1")).toBeNull();
  });

  it("unregistering a surface returns its orphaned terminals and clears their placements", () => {
    const registry = new PaintSurfaceRegistry();
    registry.registerSurface(makeSurface("a"));
    registry.registerSurface(makeSurface("b"));
    registry.place("t1", "b");
    registry.place("t2", "b");
    registry.place("t3", "a");

    const orphaned = registry.unregisterSurface("b");
    expect(orphaned.sort()).toEqual(["t1", "t2"]);
    expect(registry.surfaceFor("t1")).toBeNull();
    expect(registry.surfaceFor("t3")?.id).toBe("a");
    expect(registry.surfaceCount()).toBe(1);
  });

  it("refuses to unregister the default surface", () => {
    const registry = new PaintSurfaceRegistry();
    registry.registerSurface(makeSurface("a"));
    expect(() => registry.unregisterSurface("a")).toThrow(/default paint surface/);
  });

  it("counts placements per surface and clears them all on releaseAll", () => {
    const registry = new PaintSurfaceRegistry();
    registry.registerSurface(makeSurface("a"));
    registry.registerSurface(makeSurface("b"));
    registry.place("t1", "a");
    registry.place("t2", "a");
    registry.place("t3", "b");

    expect(registry.placementCount("a")).toBe(2);
    expect(registry.placementCount("b")).toBe(1);

    registry.releaseAll();
    expect(registry.placementCount("a")).toBe(0);
    expect(registry.surfaceFor("t1")).toBeNull();
  });
});
