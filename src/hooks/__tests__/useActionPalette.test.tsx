// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listMock, dispatchMock, getDisplayComboMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  dispatchMock: vi.fn(),
  getDisplayComboMock: vi.fn(() => ""),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    list: listMock,
    dispatch: dispatchMock,
  },
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getDisplayCombo: getDisplayComboMock,
  },
}));

vi.mock("@/clients/appClient", () => ({
  appClient: {
    setState: vi.fn(),
  },
}));

import { usePaletteStore } from "@/store/paletteStore";
import { useActionMruStore } from "@/store/actionMruStore";
import { useActionPalette } from "../useActionPalette";

function makeEntry(
  id: string,
  title: string,
  enabled = true,
  category = "General"
): {
  id: string;
  title: string;
  description: string;
  category: string;
  kind: string;
  enabled: boolean;
  requiresArgs?: boolean;
} {
  return { id, title, description: "", category, kind: "command", enabled };
}

describe("useActionPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePaletteStore.setState({ activePaletteId: null });
    useActionMruStore.setState({ actionMruList: [] });
  });

  it("tolerates malformed action manifest entries with missing title", async () => {
    listMock.mockReturnValue([
      {
        id: "ok.action",
        title: "Okay",
        description: "valid",
        category: "General",
        kind: "command",
        enabled: true,
      },
      {
        id: "bad.action",
        title: undefined,
        description: undefined,
        category: undefined,
        kind: "command",
        enabled: true,
      },
    ]);

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => {
      expect(result.current.results.length).toBeGreaterThan(0);
    });
  });

  it("sorts enabled actions alphabetically with no MRU and empty query", async () => {
    listMock.mockReturnValue([
      makeEntry("c.action", "Charlie"),
      makeEntry("a.action", "Alpha"),
      makeEntry("b.action", "Bravo"),
    ]);

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => {
      expect(result.current.results.length).toBe(3);
    });

    expect(result.current.results.map((r) => r.id)).toEqual(["a.action", "b.action", "c.action"]);
  });

  it("boosts MRU actions to the top with empty query", async () => {
    listMock.mockReturnValue([
      makeEntry("c.action", "Charlie"),
      makeEntry("a.action", "Alpha"),
      makeEntry("b.action", "Bravo"),
    ]);

    useActionMruStore.setState({ actionMruList: ["b.action", "c.action"] });

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => {
      expect(result.current.results.length).toBe(3);
    });

    expect(result.current.results.map((r) => r.id)).toEqual(["b.action", "c.action", "a.action"]);
  });

  it("keeps disabled actions below enabled actions regardless of MRU", async () => {
    listMock.mockReturnValue([
      makeEntry("a.action", "Alpha", true),
      makeEntry("b.action", "Bravo", false),
      makeEntry("c.action", "Charlie", true),
    ]);

    // b.action is most recent in MRU but disabled
    useActionMruStore.setState({ actionMruList: ["b.action"] });

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => {
      expect(result.current.results.length).toBe(3);
    });

    // Enabled actions first (alphabetical since neither is in MRU), then disabled
    expect(result.current.results[0]!.id).toBe("a.action");
    expect(result.current.results[1]!.id).toBe("c.action");
    expect(result.current.results[2]!.id).toBe("b.action");
  });

  it("records MRU when executeAction is called on enabled item", async () => {
    dispatchMock.mockResolvedValue({ ok: true });
    listMock.mockReturnValue([makeEntry("a.action", "Alpha")]);

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => {
      expect(result.current.results.length).toBe(1);
    });

    act(() => {
      result.current.executeAction(result.current.results[0]!);
    });

    expect(useActionMruStore.getState().actionMruList).toEqual(["a.action"]);
    expect(dispatchMock).toHaveBeenCalledWith("a.action", {}, { source: "user" });
  });

  it("does NOT record MRU when executeAction is called on disabled item", async () => {
    listMock.mockReturnValue([makeEntry("a.action", "Alpha", false)]);

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => {
      expect(result.current.results.length).toBe(1);
    });

    act(() => {
      result.current.executeAction(result.current.results[0]!);
    });

    expect(useActionMruStore.getState().actionMruList).toEqual([]);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("boosts MRU actions in non-empty query results", async () => {
    // Two actions with similar titles so Fuse scores them similarly
    listMock.mockReturnValue([
      makeEntry("terminal.open", "Open Terminal"),
      makeEntry("terminal.close", "Close Terminal"),
    ]);

    // "close" is in MRU, "open" is not
    useActionMruStore.setState({ actionMruList: ["terminal.close"] });

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    // Type "terminal" — both should match
    act(() => {
      result.current.setQuery("terminal");
    });

    // Wait for debounce to settle and results to update
    await waitFor(
      () => {
        expect(result.current.results.length).toBe(2);
      },
      { timeout: 2000 }
    );

    // MRU-boosted item should appear first when scores are similar
    expect(result.current.results[0]!.id).toBe("terminal.close");
  });
});
