import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ActionRegistry } from "../../actionTypes";
import { useCanopyStore } from "@/store/canopyStore";

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

describe("canopy actions", () => {
  const registry: ActionRegistry = new Map();

  beforeAll(async () => {
    const { registerCanopyActions } = await import("../canopyActions");
    registerCanopyActions(registry);
  });

  afterEach(() => useCanopyStore.setState({ mode: "unset", isOpen: false }));

  const definition = (id: string) => registry.get(id)!();

  it.each(["canopy.toggle", "canopy.markAllRead"])(
    "%s is listed and runs until the user hides Canopy, and then says where to show it",
    (id) => {
      for (const mode of ["unset", "on"] as const) {
        useCanopyStore.setState({ mode });
        expect(definition(id).isVisible?.({})).toBe(true);
        expect(definition(id).isEnabled?.({})).toBe(true);
        expect(definition(id).disabledReason?.({})).toBeUndefined();
      }
      useCanopyStore.setState({ mode: "hidden" });
      expect(definition(id).isVisible?.({})).toBe(false);
      expect(definition(id).isEnabled?.({})).toBe(false);
      expect(definition(id).disabledReason?.({})).toBe(
        "Canopy is hidden. Show it from Settings > Canopy."
      );
    }
  );

  it("opens nothing from a run let through while hidden", async () => {
    useCanopyStore.setState({ mode: "hidden" });
    await definition("canopy.toggle").run(undefined, {});
    expect(useCanopyStore.getState().isOpen).toBe(false);
  });
});
