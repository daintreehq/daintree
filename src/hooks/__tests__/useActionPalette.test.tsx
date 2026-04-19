// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listMock, dispatchMock, getDisplayComboMock, getContextMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  dispatchMock: vi.fn(),
  getDisplayComboMock: vi.fn(() => ""),
  getContextMock: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    list: listMock,
    dispatch: dispatchMock,
    getContext: getContextMock,
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
    getContextMock.mockReturnValue({});
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

  describe("context-aware ranking", () => {
    it("boosts terminal and panel categories when a terminal panel is focused", async () => {
      // Fixture order puts non-boosted browser.close first — boost must reshuffle.
      listMock.mockReturnValue([
        makeEntry("browser.close", "Close", true, "browser"),
        makeEntry("terminal.close", "Close", true, "terminal"),
        makeEntry("panel.close", "Close", true, "panel"),
      ]);
      getContextMock.mockReturnValue({ focusedTerminalKind: "terminal" });

      const { result } = renderHook(() => useActionPalette());
      act(() => result.current.open());
      act(() => result.current.setQuery("close"));

      await waitFor(() => expect(result.current.results.length).toBe(3), { timeout: 2000 });

      const ids = result.current.results.map((r) => r.id);
      expect(ids.indexOf("terminal.close")).toBeLessThan(ids.indexOf("browser.close"));
      expect(ids.indexOf("panel.close")).toBeLessThan(ids.indexOf("browser.close"));
    });

    it("boosts terminal, agent, and panel categories when an agent panel is focused", async () => {
      // Fixture order puts browser.close first so the boost must actually move it to the back.
      listMock.mockReturnValue([
        makeEntry("browser.close", "Close", true, "browser"),
        makeEntry("agent.close", "Close", true, "agent"),
        makeEntry("terminal.close", "Close", true, "terminal"),
        makeEntry("panel.close", "Close", true, "panel"),
      ]);
      getContextMock.mockReturnValue({ focusedTerminalKind: "agent" });

      const { result } = renderHook(() => useActionPalette());
      act(() => result.current.open());
      act(() => result.current.setQuery("close"));

      await waitFor(() => expect(result.current.results.length).toBe(4), { timeout: 2000 });

      const ids = result.current.results.map((r) => r.id);
      expect(ids.indexOf("browser.close")).toBe(3);
      expect(ids.indexOf("agent.close")).toBeLessThan(3);
      expect(ids.indexOf("terminal.close")).toBeLessThan(3);
      expect(ids.indexOf("panel.close")).toBeLessThan(3);
    });

    it("boosts browser and panel categories when a browser panel is focused", async () => {
      listMock.mockReturnValue([
        makeEntry("terminal.close", "Close", true, "terminal"),
        makeEntry("browser.close", "Close", true, "browser"),
      ]);
      getContextMock.mockReturnValue({ focusedTerminalKind: "browser" });

      const { result } = renderHook(() => useActionPalette());
      act(() => result.current.open());
      act(() => result.current.setQuery("close"));

      await waitFor(() => expect(result.current.results.length).toBe(2), { timeout: 2000 });

      expect(result.current.results[0]!.id).toBe("browser.close");
    });

    it("boosts notes and panel categories when a notes panel is focused", async () => {
      listMock.mockReturnValue([
        makeEntry("terminal.close", "Close", true, "terminal"),
        makeEntry("notes.close", "Close", true, "notes"),
      ]);
      getContextMock.mockReturnValue({ focusedTerminalKind: "notes" });

      const { result } = renderHook(() => useActionPalette());
      act(() => result.current.open());
      act(() => result.current.setQuery("close"));

      await waitFor(() => expect(result.current.results.length).toBe(2), { timeout: 2000 });

      expect(result.current.results[0]!.id).toBe("notes.close");
    });

    it("boosts worktree, git, and github categories when a worktree is focused", async () => {
      // Fixture order puts browser.open first so only the boost can push it to the back.
      listMock.mockReturnValue([
        makeEntry("browser.open", "Open", true, "browser"),
        makeEntry("worktree.open", "Open", true, "worktree"),
        makeEntry("git.open", "Open", true, "git"),
        makeEntry("github.open", "Open", true, "github"),
      ]);
      getContextMock.mockReturnValue({ focusedWorktreeId: "wt-1" });

      const { result } = renderHook(() => useActionPalette());
      act(() => result.current.open());
      act(() => result.current.setQuery("open"));

      await waitFor(() => expect(result.current.results.length).toBe(4), { timeout: 2000 });

      const ids = result.current.results.map((r) => r.id);
      expect(ids.indexOf("browser.open")).toBe(3);
      expect(ids.indexOf("worktree.open")).toBeLessThan(3);
      expect(ids.indexOf("git.open")).toBeLessThan(3);
      expect(ids.indexOf("github.open")).toBeLessThan(3);
    });

    it("boosts settings and preferences categories when settings panel is open", async () => {
      // Fixture order puts terminal.open first — the boost must push it to the back.
      listMock.mockReturnValue([
        makeEntry("terminal.open", "Open", true, "terminal"),
        makeEntry("settings.open", "Open", true, "settings"),
        makeEntry("preferences.open", "Open", true, "preferences"),
      ]);
      getContextMock.mockReturnValue({ isSettingsOpen: true });

      const { result } = renderHook(() => useActionPalette());
      act(() => result.current.open());
      act(() => result.current.setQuery("open"));

      await waitFor(() => expect(result.current.results.length).toBe(3), { timeout: 2000 });

      const ids = result.current.results.map((r) => r.id);
      expect(ids.indexOf("settings.open")).toBeLessThan(ids.indexOf("terminal.open"));
      expect(ids.indexOf("preferences.open")).toBeLessThan(ids.indexOf("terminal.open"));
    });

    it("lets MRU + context boost stack on the same item", async () => {
      listMock.mockReturnValue([
        makeEntry("terminal.close", "Close", true, "terminal"),
        makeEntry("browser.close", "Close", true, "browser"),
        makeEntry("worktree.close", "Close", true, "worktree"),
      ]);
      // browser.close is in MRU but not context-boosted
      // terminal.close is context-boosted but not in MRU
      useActionMruStore.getState().hydrateActionMru(["browser.close"]);
      getContextMock.mockReturnValue({ focusedTerminalKind: "terminal" });

      const { result } = renderHook(() => useActionPalette());
      act(() => result.current.open());
      act(() => result.current.setQuery("close"));

      await waitFor(() => expect(result.current.results.length).toBe(3), { timeout: 2000 });

      // terminal.close gets 0.08 context boost, greater than browser.close's max 0.05 MRU boost
      expect(result.current.results[0]!.id).toBe("terminal.close");
    });

    it("does not exclude non-matching categories from the results", async () => {
      listMock.mockReturnValue([
        makeEntry("terminal.close", "Close", true, "terminal"),
        makeEntry("browser.close", "Close", true, "browser"),
      ]);
      getContextMock.mockReturnValue({ focusedTerminalKind: "terminal" });

      const { result } = renderHook(() => useActionPalette());
      act(() => result.current.open());
      act(() => result.current.setQuery("close"));

      await waitFor(() => expect(result.current.results.length).toBe(2), { timeout: 2000 });

      const ids = result.current.results.map((r) => r.id);
      expect(ids).toContain("browser.close");
    });

    it("leaves ordering unchanged when context is empty", async () => {
      listMock.mockReturnValue([
        makeEntry("terminal.close", "Close", true, "terminal"),
        makeEntry("browser.close", "Close", true, "browser"),
      ]);
      useActionMruStore.getState().hydrateActionMru(["browser.close"]);
      getContextMock.mockReturnValue({});

      const { result } = renderHook(() => useActionPalette());
      act(() => result.current.open());
      act(() => result.current.setQuery("close"));

      await waitFor(() => expect(result.current.results.length).toBe(2), { timeout: 2000 });

      // Without context, MRU-boosted browser.close should win
      expect(result.current.results[0]!.id).toBe("browser.close");
    });

    it("ignores unknown focusedTerminalKind without throwing", async () => {
      listMock.mockReturnValue([
        makeEntry("terminal.close", "Close", true, "terminal"),
        makeEntry("browser.close", "Close", true, "browser"),
      ]);
      useActionMruStore.getState().hydrateActionMru(["browser.close"]);
      getContextMock.mockReturnValue({ focusedTerminalKind: "custom-kind" });

      const { result } = renderHook(() => useActionPalette());
      act(() => result.current.open());
      act(() => result.current.setQuery("close"));

      await waitFor(() => expect(result.current.results.length).toBe(2), { timeout: 2000 });

      // No context boost — MRU-boosted browser.close still wins
      expect(result.current.results[0]!.id).toBe("browser.close");
    });

    it("reads context fresh on each filter call (no stale closure)", async () => {
      listMock.mockReturnValue([
        makeEntry("terminal.close", "Close", true, "terminal"),
        makeEntry("browser.close", "Close", true, "browser"),
      ]);
      getContextMock.mockReturnValue({ focusedTerminalKind: "terminal" });

      const { result } = renderHook(() => useActionPalette());
      act(() => result.current.open());
      act(() => result.current.setQuery("close"));

      await waitFor(() => expect(result.current.results[0]!.id).toBe("terminal.close"), {
        timeout: 2000,
      });

      // Flip context to browser focus and use a different query so the filter memo re-runs
      // without any query round-tripping (no reliance on useDeferredValue coalescing).
      getContextMock.mockReturnValue({ focusedTerminalKind: "browser" });
      act(() => result.current.setQuery("clos"));

      await waitFor(() => expect(result.current.results[0]!.id).toBe("browser.close"), {
        timeout: 2000,
      });
    });

    it("applies all three boost dimensions when terminal, worktree, and settings are active", async () => {
      // A regression that drops one branch of the union in getBoostedCategories
      // would leave the corresponding action unboosted.
      listMock.mockReturnValue([
        makeEntry("browser.open", "Open", true, "browser"),
        makeEntry("terminal.open", "Open", true, "terminal"),
        makeEntry("worktree.open", "Open", true, "worktree"),
        makeEntry("settings.open", "Open", true, "settings"),
      ]);
      getContextMock.mockReturnValue({
        focusedTerminalKind: "terminal",
        focusedWorktreeId: "wt-1",
        isSettingsOpen: true,
      });

      const { result } = renderHook(() => useActionPalette());
      act(() => result.current.open());
      act(() => result.current.setQuery("open"));

      await waitFor(() => expect(result.current.results.length).toBe(4), { timeout: 2000 });

      const ids = result.current.results.map((r) => r.id);
      expect(ids.indexOf("browser.open")).toBe(3);
      expect(ids.indexOf("terminal.open")).toBeLessThan(3);
      expect(ids.indexOf("worktree.open")).toBeLessThan(3);
      expect(ids.indexOf("settings.open")).toBeLessThan(3);
    });

    it("boosts dev-preview categories when a dev-preview panel is focused", async () => {
      listMock.mockReturnValue([
        makeEntry("browser.close", "Close", true, "browser"),
        makeEntry("devServer.close", "Close", true, "devServer"),
        makeEntry("panel.close", "Close", true, "panel"),
      ]);
      getContextMock.mockReturnValue({ focusedTerminalKind: "dev-preview" });

      const { result } = renderHook(() => useActionPalette());
      act(() => result.current.open());
      act(() => result.current.setQuery("close"));

      await waitFor(() => expect(result.current.results.length).toBe(3), { timeout: 2000 });

      const ids = result.current.results.map((r) => r.id);
      expect(ids.indexOf("devServer.close")).toBeLessThan(ids.indexOf("browser.close"));
      expect(ids.indexOf("panel.close")).toBeLessThan(ids.indexOf("browser.close"));
    });

    it.each(["   ", "\t\n", " \t\n "])(
      "does not boost worktree categories when focusedWorktreeId is whitespace (%j)",
      async (whitespace) => {
        listMock.mockReturnValue([
          makeEntry("browser.open", "Open", true, "browser"),
          makeEntry("worktree.open", "Open", true, "worktree"),
        ]);
        useActionMruStore.getState().hydrateActionMru(["browser.open"]);
        getContextMock.mockReturnValue({ focusedWorktreeId: whitespace });

        const { result } = renderHook(() => useActionPalette());
        act(() => result.current.open());
        act(() => result.current.setQuery("open"));

        await waitFor(() => expect(result.current.results.length).toBe(2), { timeout: 2000 });

        // No context boost on worktree — MRU on browser keeps it first
        expect(result.current.results[0]!.id).toBe("browser.open");
      }
    );

    it("keeps disabled context-boosted items below enabled items", async () => {
      listMock.mockReturnValue([
        makeEntry("terminal.close", "Close", false, "terminal"),
        makeEntry("browser.close", "Close", true, "browser"),
      ]);
      getContextMock.mockReturnValue({ focusedTerminalKind: "terminal" });

      const { result } = renderHook(() => useActionPalette());
      act(() => result.current.open());
      act(() => result.current.setQuery("close"));

      await waitFor(() => expect(result.current.results.length).toBe(2), { timeout: 2000 });

      // Enabled browser.close must appear before disabled terminal.close, context boost notwithstanding
      expect(result.current.results[0]!.id).toBe("browser.close");
      expect(result.current.results[1]!.id).toBe("terminal.close");
    });
  });

  describe("keyword search", () => {
    it("finds actions by keyword when term is not in title or description", async () => {
      listMock.mockReturnValue([
        {
          id: "terminal.stashInput",
          title: "Stash Input",
          description: "Park the current hybrid input draft to a temporary stash slot",
          category: "terminal",
          kind: "command",
          enabled: true,
          keywords: ["save", "draft", "store", "park"],
        },
        makeEntry("other.action", "Other Action"),
      ]);

      const { result } = renderHook(() => useActionPalette());
      act(() => result.current.open());
      act(() => result.current.setQuery("park"));

      await waitFor(() => expect(result.current.results.length).toBeGreaterThan(0), {
        timeout: 2000,
      });

      expect(result.current.results.some((r) => r.id === "terminal.stashInput")).toBe(true);
    });

    it("ranks title matches above keyword-only matches", async () => {
      listMock.mockReturnValue([
        {
          id: "terminal.saveOutput",
          title: "Save Output",
          description: "Save terminal output to a file",
          category: "terminal",
          kind: "command",
          enabled: true,
          keywords: [],
        },
        {
          id: "terminal.stashInput",
          title: "Stash Input",
          description: "Park the current hybrid input draft to a temporary stash slot",
          category: "terminal",
          kind: "command",
          enabled: true,
          keywords: ["save", "draft", "store"],
        },
      ]);

      const { result } = renderHook(() => useActionPalette());
      act(() => result.current.open());
      act(() => result.current.setQuery("save"));

      await waitFor(() => expect(result.current.results.length).toBe(2), { timeout: 2000 });

      // Title match "Save Output" should rank above keyword-only "Stash Input"
      expect(result.current.results[0]!.id).toBe("terminal.saveOutput");
    });

    it("handles actions without keywords gracefully", async () => {
      listMock.mockReturnValue([
        {
          id: "action.noKeywords",
          title: "No Keywords",
          description: "An action without keywords",
          category: "General",
          kind: "command",
          enabled: true,
        },
        makeEntry("other.action", "Other Action"),
      ]);

      const { result } = renderHook(() => useActionPalette());
      act(() => result.current.open());
      act(() => result.current.setQuery("no keywords"));

      await waitFor(() => expect(result.current.results.length).toBeGreaterThan(0), {
        timeout: 2000,
      });

      // Should not throw, and the action should be findable via title
      expect(result.current.results.some((r) => r.id === "action.noKeywords")).toBe(true);
    });
  });
});
