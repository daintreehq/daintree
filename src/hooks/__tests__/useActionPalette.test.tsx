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
    useActionMruStore.setState({ actionFrecencyEntries: new Map() });
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

  it("sorts enabled actions alphabetically with no frecency and empty query", async () => {
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

  it("boosts frecency actions to the top with empty query", async () => {
    listMock.mockReturnValue([
      makeEntry("c.action", "Charlie"),
      makeEntry("a.action", "Alpha"),
      makeEntry("b.action", "Bravo"),
    ]);

    useActionMruStore.getState().hydrateActionMru(["b.action", "c.action"]);

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => {
      expect(result.current.results.length).toBe(3);
    });

    expect(result.current.results.map((r) => r.id)).toEqual(["b.action", "c.action", "a.action"]);
  });

  it("keeps disabled actions below enabled actions regardless of frecency", async () => {
    listMock.mockReturnValue([
      makeEntry("a.action", "Alpha", true),
      makeEntry("b.action", "Bravo", false),
      makeEntry("c.action", "Charlie", true),
    ]);

    useActionMruStore.getState().hydrateActionMru(["b.action"]);

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => {
      expect(result.current.results.length).toBe(3);
    });

    expect(result.current.results[0]!.id).toBe("a.action");
    expect(result.current.results[1]!.id).toBe("c.action");
    expect(result.current.results[2]!.id).toBe("b.action");
  });

  it("records frecency when executeAction is called on enabled item", async () => {
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

    const sorted = useActionMruStore.getState().getSortedActionMruList();
    expect(sorted.length).toBe(1);
    expect(sorted[0]!.id).toBe("a.action");
    expect(dispatchMock).toHaveBeenCalledWith("a.action", {}, { source: "user" });
  });

  it("does NOT record frecency when executeAction is called on disabled item", async () => {
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

    expect(useActionMruStore.getState().getSortedActionMruList().length).toBe(0);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("uses frecency as tiebreaker in non-empty query results", async () => {
    listMock.mockReturnValue([
      makeEntry("action.terminal.open", "Terminal Open"),
      makeEntry("action.terminal.close", "Terminal Close"),
    ]);

    useActionMruStore.getState().hydrateActionMru(["action.terminal.close"]);

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    act(() => {
      result.current.setQuery("terminal");
    });

    await waitFor(
      () => {
        expect(result.current.results.length).toBe(2);
      },
      { timeout: 2000 }
    );

    expect(result.current.results[0]!.id).toBe("action.terminal.close");
  });
});
