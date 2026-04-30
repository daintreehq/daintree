import { describe, it, expect, beforeEach } from "vitest";
import { usePaletteStore } from "../paletteStore";

describe("paletteStore", () => {
  beforeEach(() => {
    usePaletteStore.setState({ activePaletteId: null });
  });

  it("starts with no active palette", () => {
    expect(usePaletteStore.getState().activePaletteId).toBeNull();
  });

  it("openPalette sets the active palette", () => {
    usePaletteStore.getState().openPalette("new-terminal");
    expect(usePaletteStore.getState().activePaletteId).toBe("new-terminal");
  });

  it("openPalette replaces a previously open palette (mutual exclusion)", () => {
    usePaletteStore.getState().openPalette("new-terminal");
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
    usePaletteStore.getState().closePalette("new-terminal");
    expect(usePaletteStore.getState().activePaletteId).toBe("action");
  });

  it("closePalette is a no-op when no palette is open", () => {
    usePaletteStore.getState().closePalette("new-terminal");
    expect(usePaletteStore.getState().activePaletteId).toBeNull();
  });

  it("rapid open sequence only leaves the last palette active", () => {
    const { openPalette } = usePaletteStore.getState();
    openPalette("new-terminal");
    openPalette("quick-switcher");
    openPalette("theme");
    openPalette("action");
    expect(usePaletteStore.getState().activePaletteId).toBe("action");
  });
});
