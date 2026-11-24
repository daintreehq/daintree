import { describe, it, expect, beforeEach } from "vitest";
import { usePaletteStore } from "../paletteStore";

describe("paletteStore", () => {
  beforeEach(() => {
    usePaletteStore.setState({
      activePaletteId: null,
      promptHistoryHosts: 0,
      quickSwitcherScope: null,
    });
  });

  it("opens the quick switcher already scoped, as one fresh opening", () => {
    const before = usePaletteStore.getState().openRequestId;
    usePaletteStore.getState().openQuickSwitcher({ kind: "files" });
    const state = usePaletteStore.getState();
    expect(state.activePaletteId).toBe("quick-switcher");
    expect(state.quickSwitcherScope).toEqual({ kind: "files" });
    expect(state.openRequestId).toBe(before + 1);
  });

  it("drops the switcher's scope on any other opening, a plain reopen, and its close", () => {
    const { openQuickSwitcher, openPalette, closePalette } = usePaletteStore.getState();

    openQuickSwitcher({ kind: "files" });
    openPalette("quick-switcher");
    expect(usePaletteStore.getState().quickSwitcherScope).toBeNull();

    // ⌘P and agent.palette reach the store through the callback with no scope.
    openQuickSwitcher({ kind: "files" });
    const before = usePaletteStore.getState().openRequestId;
    openQuickSwitcher();
    expect(usePaletteStore.getState().quickSwitcherScope).toBeNull();
    expect(usePaletteStore.getState().openRequestId).toBe(before + 1);

    openQuickSwitcher({ kind: "plugin", key: "acme.notes.notes" });
    openPalette("action");
    expect(usePaletteStore.getState().quickSwitcherScope).toBeNull();

    openQuickSwitcher({ kind: "files" });
    closePalette("action");
    expect(usePaletteStore.getState().quickSwitcherScope).toEqual({ kind: "files" });
    closePalette("quick-switcher");
    expect(usePaletteStore.getState().quickSwitcherScope).toBeNull();
  });

  it("only scopes a switcher that is open", () => {
    usePaletteStore.getState().openPalette("action");
    usePaletteStore.getState().setQuickSwitcherScope({ kind: "files" });
    expect(usePaletteStore.getState().quickSwitcherScope).toBeNull();

    usePaletteStore.getState().openPalette("quick-switcher");
    usePaletteStore.getState().setQuickSwitcherScope({ kind: "files" });
    expect(usePaletteStore.getState().quickSwitcherScope).toEqual({ kind: "files" });
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
