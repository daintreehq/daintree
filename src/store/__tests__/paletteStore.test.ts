import { describe, it, expect, beforeEach } from "vitest";
import { usePaletteStore } from "../paletteStore";

describe("paletteStore", () => {
  beforeEach(() => {
    usePaletteStore.setState({ activePaletteId: null, promptHistoryHosts: 0 });
  });

  it("openPalette replaces a previously open palette (mutual exclusion)", () => {
    usePaletteStore.getState().openPalette("panel");
    usePaletteStore.getState().openPalette("action");
    expect(usePaletteStore.getState().activePaletteId).toBe("action");
  });

  it("closePalette clears when id matches", () => {
    usePaletteStore.getState().openPalette("theme");
    usePaletteStore.getState().closePalette("theme");
    expect(usePaletteStore.getState().activePaletteId).toBeNull();
  });

  it("closePalette is a no-op when id does not match (stale close guard)", () => {
    usePaletteStore.getState().openPalette("action");
    usePaletteStore.getState().closePalette("panel");
    expect(usePaletteStore.getState().activePaletteId).toBe("action");
  });

  it("counts prompt-history hosts without opening, closing or requesting a palette", () => {
    usePaletteStore.getState().openPalette("action");
    const { openRequestId } = usePaletteStore.getState();

    const first = usePaletteStore.getState().registerPromptHistoryHost();
    const second = usePaletteStore.getState().registerPromptHistoryHost();
    expect(usePaletteStore.getState().promptHistoryHosts).toBe(2);

    first();
    first();
    expect(usePaletteStore.getState().promptHistoryHosts).toBe(1);

    second();
    expect(usePaletteStore.getState().promptHistoryHosts).toBe(0);
    expect(usePaletteStore.getState().activePaletteId).toBe("action");
    expect(usePaletteStore.getState().openRequestId).toBe(openRequestId);
  });
});
