// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listMock, dispatchMock, getDisplayComboMock, getContextMock, notifyMock } = vi.hoisted(
  () => ({
    listMock: vi.fn(),
    dispatchMock: vi.fn(),
    getDisplayComboMock: vi.fn(() => ""),
    getContextMock: vi.fn(),
    notifyMock: vi.fn(),
  })
);

vi.mock("@/services/ActionService", () => ({
  actionService: {
    list: listMock,
    dispatch: dispatchMock,
    getContext: getContextMock,
  },
}));

vi.mock("@/lib/notify", () => ({
  notify: notifyMock,
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
import { useActionPrefsStore } from "@/store/actionPrefsStore";
import { useActionPalette } from "../useActionPalette";

function makeEntry(
  id: string,
  title: string,
  enabled = true,
  category = "General",
  danger: "safe" | "confirm" | "restricted" = "safe"
): {
  id: string;
  title: string;
  description: string;
  category: string;
  kind: string;
  enabled: boolean;
  danger: "safe" | "confirm" | "restricted";
  requiresArgs?: boolean;
} {
  return { id, title, description: "", category, kind: "command", enabled, danger };
}

describe("useActionPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getContextMock.mockReturnValue({});
    usePaletteStore.setState({ activePaletteId: null });
    useActionMruStore.setState({ actionFrecencyEntries: new Map() });
    useActionPrefsStore.setState({ pinnedActionIds: [], hiddenActionIds: [] });
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

    useActionMruStore.getState().hydrateActionMru(["ok.action", "bad.action"]);

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => {
      expect(result.current.results.length).toBeGreaterThan(0);
    });
  });

  it("returns empty results with empty query and empty MRU so the hint can render", async () => {
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
      expect(result.current.isOpen).toBe(true);
    });

    expect(result.current.results).toEqual([]);
    expect(result.current.totalResults).toBe(0);
    expect(result.current.isShowingRecentlyUsed).toBe(false);
  });

  it("surfaces only recently-used actions on the empty query state", async () => {
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
      expect(result.current.results.length).toBe(2);
    });

    expect(result.current.results.map((r) => r.id)).toEqual(["b.action", "c.action"]);
    expect(result.current.isShowingRecentlyUsed).toBe(true);
  });

  it("keeps disabled MRU actions below enabled MRU actions on the empty state", async () => {
    listMock.mockReturnValue([
      makeEntry("a.action", "Alpha", true),
      makeEntry("b.action", "Bravo", false),
      makeEntry("c.action", "Charlie", true),
    ]);

    // Seed all three into MRU so the recently-used filter has them to surface.
    // MRU order is b, c, a — but the disabled entry b must drop below the enabled ones.
    useActionMruStore.getState().hydrateActionMru(["b.action", "c.action", "a.action"]);

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => {
      expect(result.current.results.length).toBe(3);
    });

    expect(result.current.results.map((r) => r.id)).toEqual(["c.action", "a.action", "b.action"]);
  });

  it("ignores stale MRU ids that no longer exist in the action manifest", async () => {
    listMock.mockReturnValue([makeEntry("a.action", "Alpha"), makeEntry("b.action", "Bravo")]);

    useActionMruStore
      .getState()
      .hydrateActionMru(["missing.action", "b.action", "also-missing.action", "a.action"]);

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => {
      expect(result.current.results.length).toBe(2);
    });

    expect(result.current.results.map((r) => r.id)).toEqual(["b.action", "a.action"]);
  });

  it("caps recently-used results at 10 entries", async () => {
    const entries = Array.from({ length: 15 }, (_, i) =>
      makeEntry(`action.${i.toString().padStart(2, "0")}`, `Action ${i}`)
    );
    listMock.mockReturnValue(entries);

    useActionMruStore.getState().hydrateActionMru(entries.map((e) => e.id));

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => {
      expect(result.current.results.length).toBe(10);
    });

    expect(result.current.isShowingRecentlyUsed).toBe(true);
  });

  it("does not let disabled MRU entries crowd out enabled ones at the cap boundary", async () => {
    const disabled = Array.from({ length: 8 }, (_, i) =>
      makeEntry(`disabled.${i}`, `Disabled ${i}`, false)
    );
    const enabled = Array.from({ length: 7 }, (_, i) =>
      makeEntry(`enabled.${i}`, `Enabled ${i}`, true)
    );
    listMock.mockReturnValue([...disabled, ...enabled]);

    // Order disabled first in MRU so the partition has to do real work to put
    // enabled items above them within the 10-slot cap.
    useActionMruStore
      .getState()
      .hydrateActionMru([...disabled.map((e) => e.id), ...enabled.map((e) => e.id)]);

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => {
      expect(result.current.results.length).toBe(10);
    });

    // All 7 enabled entries must appear (no disabled item displaces them),
    // followed by the first 3 disabled by MRU order.
    const ids = result.current.results.map((r) => r.id);
    expect(ids.slice(0, 7)).toEqual(enabled.map((e) => e.id));
    expect(ids.slice(7)).toEqual(disabled.slice(0, 3).map((e) => e.id));
  });

  it("treats whitespace-only query as the recently-used branch", async () => {
    listMock.mockReturnValue([makeEntry("a.action", "Alpha"), makeEntry("b.action", "Bravo")]);
    useActionMruStore.getState().hydrateActionMru(["b.action", "a.action"]);

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    act(() => {
      result.current.setQuery("   ");
    });

    await waitFor(() => {
      expect(result.current.results.length).toBe(2);
    });

    expect(result.current.results.map((r) => r.id)).toEqual(["b.action", "a.action"]);
    expect(result.current.isShowingRecentlyUsed).toBe(true);
  });

  it("clears the recently-used flag once the user starts typing", async () => {
    listMock.mockReturnValue([makeEntry("a.action", "Alpha"), makeEntry("b.action", "Bravo")]);
    useActionMruStore.getState().hydrateActionMru(["a.action"]);

    const { result } = renderHook(() => useActionPalette());

    act(() => result.current.open());

    await waitFor(() => expect(result.current.isShowingRecentlyUsed).toBe(true));

    act(() => result.current.setQuery("brav"));

    await waitFor(() => expect(result.current.isShowingRecentlyUsed).toBe(false), {
      timeout: 2000,
    });
  });

  it("records frecency when executeAction is called on enabled item", async () => {
    dispatchMock.mockResolvedValue({ ok: true });
    listMock.mockReturnValue([makeEntry("a.action", "Alpha")]);

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    act(() => {
      result.current.setQuery("alpha");
    });

    await waitFor(
      () => {
        expect(result.current.results.length).toBe(1);
      },
      { timeout: 2000 }
    );

    act(() => {
      result.current.executeAction(result.current.results[0]!);
    });

    const sorted = useActionMruStore.getState().getSortedActionMruList();
    expect(sorted.length).toBe(1);
    expect(sorted[0]!.id).toBe("a.action");
    expect(dispatchMock).toHaveBeenCalledWith("a.action", {}, { source: "user" });
  });

  // The palette owns a generic `{ ok: false }` failure toast, but plugin
  // actions self-notify (via usePluginActions) only on EXECUTION_ERROR. These
  // lock in the precise suppression so plugin EXECUTION_ERRORs don't
  // double-toast while every other failure still surfaces.
  async function runFailingPaletteAction(
    entry: ReturnType<typeof makeEntry> & { pluginId?: string },
    query: string,
    error: { code: string; message: string }
  ): Promise<void> {
    dispatchMock.mockResolvedValue({ ok: false, error });
    listMock.mockReturnValue([entry]);
    const { result } = renderHook(() => useActionPalette());
    act(() => result.current.open());
    act(() => result.current.setQuery(query));
    await waitFor(() => expect(result.current.results.length).toBe(1));
    act(() => result.current.executeAction(result.current.results[0]!));
    // Flush the void dispatch().then() microtask chain.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("suppresses the palette toast for a plugin action EXECUTION_ERROR (already self-notified)", async () => {
    await runFailingPaletteAction(
      { ...makeEntry("acme.thing", "Acmething"), pluginId: "acme.plugin" },
      "acmething",
      { code: "EXECUTION_ERROR", message: "handler exploded" }
    );
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("still toasts a plugin action that failed without self-notifying (e.g. NOT_FOUND on a stale row)", async () => {
    await runFailingPaletteAction(
      { ...makeEntry("acme.thing", "Acmething"), pluginId: "acme.plugin" },
      "acmething",
      { code: "NOT_FOUND", message: "action was unregistered" }
    );
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Couldn't run 'Acmething'" })
    );
  });

  it("still toasts a built-in action EXECUTION_ERROR (no pluginId, never self-notifies)", async () => {
    await runFailingPaletteAction(makeEntry("builtin.thing", "Builtinthing"), "builtinthing", {
      code: "EXECUTION_ERROR",
      message: "boom",
    });
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("excludes paletteHidden commands from the palette", async () => {
    listMock.mockReturnValue([
      makeEntry("visible.action", "Visible thing"),
      { ...makeEntry("hidden.action", "Hidden thing"), paletteHidden: true },
    ]);

    const { result } = renderHook(() => useActionPalette());

    act(() => result.current.open());
    act(() => result.current.setQuery("thing"));

    await waitFor(() => {
      expect(result.current.results.length).toBe(1);
    });
    expect(result.current.results.map((r) => r.id)).toEqual(["visible.action"]);
  });

  it("shows a redirect command and dispatches its target instead of itself", async () => {
    dispatchMock.mockResolvedValue({ ok: true });
    listMock.mockReturnValue([
      {
        // requiresArgs is true, but a redirect must still surface — it runs its
        // sibling, not itself, so its own args are irrelevant.
        ...makeEntry("worktree.createWithRecipe", "Create Worktree with Recipe"),
        requiresArgs: true,
        paletteRedirectTo: "worktree.createDialog.open",
      },
    ]);

    const { result } = renderHook(() => useActionPalette());

    act(() => result.current.open());
    act(() => result.current.setQuery("recipe"));

    await waitFor(
      () => {
        expect(result.current.results.length).toBe(1);
      },
      { timeout: 2000 }
    );

    act(() => {
      result.current.executeAction(result.current.results[0]!);
    });

    expect(dispatchMock).toHaveBeenCalledWith("worktree.createDialog.open", {}, { source: "user" });
    expect(dispatchMock).not.toHaveBeenCalledWith(
      "worktree.createWithRecipe",
      expect.anything(),
      expect.anything()
    );
  });

  it("renders a requireContext (paletteDisabled) row as disabled-with-reason and no-ops on Enter", async () => {
    dispatchMock.mockResolvedValue({ ok: true });
    listMock.mockReturnValue([
      {
        ...makeEntry("copyTree.generateAndCopyFile", "Generate And Copy Context"),
        paletteDisabled: true,
        paletteDisabledReason: "Open a worktree to generate its context",
      },
    ]);

    const { result } = renderHook(() => useActionPalette());

    act(() => result.current.open());
    act(() => result.current.setQuery("context"));

    await waitFor(
      () => {
        expect(result.current.results.length).toBe(1);
      },
      { timeout: 2000 }
    );

    const row = result.current.results[0]!;
    expect(row.enabled).toBe(false);
    expect(row.disabledReason).toBe("Open a worktree to generate its context");

    act(() => {
      result.current.executeAction(row);
    });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("excludes confirm-danger ids persisted in MRU from the Recently used rail", async () => {
    // Pre-fix sessions could have written confirm-danger ids into MRU. After
    // the fix they must not surface on the empty-query rail even though the
    // ids are still in the persisted store (issue #7481).
    listMock.mockReturnValue([
      makeEntry("a.action", "Alpha"),
      makeEntry("worktree.delete", "Delete worktree", true, "worktree", "confirm"),
      makeEntry("b.action", "Bravo"),
    ]);

    useActionMruStore.getState().hydrateActionMru(["worktree.delete", "a.action", "b.action"]);

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => {
      expect(result.current.results.length).toBe(2);
    });

    const ids = result.current.results.map((r) => r.id);
    expect(ids).not.toContain("worktree.delete");
    expect(ids).toEqual(["a.action", "b.action"]);
  });

  it("does not give a search-rank MRU bonus to confirm-danger items", async () => {
    // Even with a stale confirm-danger id in MRU, a typed-query result must
    // not get an MRU rank boost — pairs with the rail filter above.
    // Both entries share the same title so their base scores tie; without
    // the filter the MRU bonus would lift the danger entry above the safe
    // one, with the filter the stable-sort tiebreak keeps insertion order.
    listMock.mockReturnValue([
      makeEntry("safe.close", "Close", true, "terminal"),
      makeEntry("danger.close", "Close", true, "terminal", "confirm"),
    ]);

    useActionMruStore.getState().hydrateActionMru(["danger.close"]);

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    act(() => {
      result.current.setQuery("close");
    });

    await waitFor(
      () => {
        expect(result.current.results.length).toBe(2);
      },
      { timeout: 2000 }
    );

    expect(result.current.results[0]!.id).toBe("safe.close");
  });

  it("does NOT record frecency when executeAction is called on confirm-danger item", async () => {
    dispatchMock.mockResolvedValue({ ok: true });
    listMock.mockReturnValue([
      makeEntry("worktree.delete", "Delete worktree", true, "worktree", "confirm"),
    ]);

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    act(() => {
      result.current.setQuery("delete");
    });

    await waitFor(
      () => {
        expect(result.current.results.length).toBe(1);
      },
      { timeout: 2000 }
    );

    act(() => {
      result.current.executeAction(result.current.results[0]!);
    });

    // Dispatch still runs so ActionService can show the confirmation dialog,
    // but MRU stays clean — destructive actions must not land in the
    // "Recently used" rail (issue #7481).
    expect(useActionMruStore.getState().getSortedActionMruList().length).toBe(0);
    expect(dispatchMock).toHaveBeenCalledWith("worktree.delete", {}, { source: "user" });
  });

  it("is a silent no-op when executeAction is called on a disabled item (#8814)", async () => {
    listMock.mockReturnValue([makeEntry("a.action", "Alpha", false)]);

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    act(() => {
      result.current.setQuery("alpha");
    });

    await waitFor(
      () => {
        expect(result.current.results.length).toBe(1);
      },
      { timeout: 2000 }
    );

    act(() => {
      result.current.executeAction(result.current.results[0]!);
    });

    // Enter on a disabled row is a silent no-op: palette stays open, no
    // dispatch fires, MRU stays clean, no toast (issue #8814).
    expect(useActionMruStore.getState().getSortedActionMruList().length).toBe(0);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(result.current.isOpen).toBe(true);
  });

  it("confirmSelection (Enter) on a disabled item is a silent no-op (#8814)", async () => {
    listMock.mockReturnValue([makeEntry("a.action", "Alpha", false)]);

    const { result } = renderHook(() => useActionPalette());

    act(() => {
      result.current.open();
    });

    act(() => {
      result.current.setQuery("alpha");
    });

    await waitFor(
      () => {
        expect(result.current.results.length).toBe(1);
        expect(result.current.isStale).toBe(false);
      },
      { timeout: 2000 }
    );

    act(() => {
      result.current.confirmSelection();
    });

    // The real Enter-key path runs through confirmSelection -> executeAction.
    // Same expectation: no dispatch, palette stays open, MRU untouched.
    expect(useActionMruStore.getState().getSortedActionMruList().length).toBe(0);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(result.current.isOpen).toBe(true);
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

    it("boosts worktree, git, and forge categories when a worktree is focused", async () => {
      // Fixture order puts browser.open first so only the boost can push it to the back.
      listMock.mockReturnValue([
        makeEntry("browser.open", "Open", true, "browser"),
        makeEntry("worktree.open", "Open", true, "worktree"),
        makeEntry("git.open", "Open", true, "git"),
        makeEntry("forge.open", "Open", true, "forge"),
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
      expect(ids.indexOf("forge.open")).toBeLessThan(3);
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

      // terminal.close gets CONTEXT_BOOST (80); browser.close gets MRU tanh bonus
      // (≤ MRU_BONUS_CAP = 50) — the context-boosted item must win.
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

  describe("pin & hide affordances", () => {
    it("prepends pinned actions ahead of Recently used on the empty-query rail", async () => {
      listMock.mockReturnValue([
        makeEntry("a.action", "Alpha"),
        makeEntry("b.action", "Bravo"),
        makeEntry("c.action", "Charlie"),
      ]);

      useActionMruStore.getState().hydrateActionMru(["b.action", "c.action"]);
      useActionPrefsStore.getState().pinAction("a.action");

      const { result } = renderHook(() => useActionPalette());

      act(() => {
        result.current.open();
      });

      await waitFor(() => {
        expect(result.current.results.length).toBe(3);
      });

      expect(result.current.results.map((r) => r.id)).toEqual(["a.action", "b.action", "c.action"]);
      expect(result.current.pinnedCount).toBe(1);
    });

    it("does not duplicate a pinned id that also appears in MRU", async () => {
      listMock.mockReturnValue([makeEntry("a.action", "Alpha"), makeEntry("b.action", "Bravo")]);

      useActionMruStore.getState().hydrateActionMru(["a.action", "b.action"]);
      useActionPrefsStore.getState().pinAction("a.action");

      const { result } = renderHook(() => useActionPalette());

      act(() => result.current.open());

      await waitFor(() => expect(result.current.results.length).toBe(2));

      expect(result.current.results.map((r) => r.id)).toEqual(["a.action", "b.action"]);
      expect(result.current.pinnedCount).toBe(1);
    });

    it("hides actions from the Recently used rail while keeping them in MRU", async () => {
      listMock.mockReturnValue([
        makeEntry("a.action", "Alpha"),
        makeEntry("b.action", "Bravo"),
        makeEntry("c.action", "Charlie"),
      ]);

      useActionMruStore.getState().hydrateActionMru(["a.action", "b.action", "c.action"]);
      useActionPrefsStore.getState().hideAction("b.action");

      const { result } = renderHook(() => useActionPalette());

      act(() => result.current.open());

      await waitFor(() => expect(result.current.results.length).toBe(2));

      const ids = result.current.results.map((r) => r.id);
      expect(ids).not.toContain("b.action");
      expect(ids).toEqual(["a.action", "c.action"]);
    });

    it("refuses to pin a danger:'confirm' action and returns false", async () => {
      listMock.mockReturnValue([
        makeEntry("worktree.delete", "Delete worktree", true, "worktree", "confirm"),
      ]);

      const { result } = renderHook(() => useActionPalette());

      act(() => result.current.open());

      await waitFor(() => expect(result.current.isOpen).toBe(true));

      let returned = true;
      act(() => {
        returned = result.current.pinAction(
          result.current.results[0] ?? {
            id: "worktree.delete",
            title: "Delete worktree",
            description: "",
            category: "worktree",
            enabled: true,
            danger: "confirm",
            kind: "command",
            titleLower: "delete worktree",
            categoryLower: "worktree",
            descriptionLower: "",
            titleAcronym: "DW",
            keywordsLower: [],
          }
        );
      });

      expect(returned).toBe(false);
      expect(useActionPrefsStore.getState().pinnedActionIds).toEqual([]);
    });

    it("strips danger:'confirm' ids from pinned even when persisted from a pre-fix session", async () => {
      listMock.mockReturnValue([
        makeEntry("a.action", "Alpha"),
        makeEntry("worktree.delete", "Delete worktree", true, "worktree", "confirm"),
      ]);

      // Simulate a stale persisted state file with a danger id pinned.
      useActionPrefsStore
        .getState()
        .hydrateActionPrefs({ pinnedIds: ["worktree.delete", "a.action"] });

      const { result } = renderHook(() => useActionPalette());

      act(() => result.current.open());

      await waitFor(() => expect(result.current.results.length).toBe(1));

      const ids = result.current.results.map((r) => r.id);
      expect(ids).not.toContain("worktree.delete");
      expect(ids).toEqual(["a.action"]);
    });

    it("ignores hidden ids during typed search (only the empty-query rail evicts)", async () => {
      listMock.mockReturnValue([makeEntry("a.action", "Alpha"), makeEntry("b.action", "Bravo")]);
      useActionPrefsStore.getState().hideAction("a.action");

      const { result } = renderHook(() => useActionPalette());

      act(() => result.current.open());
      act(() => result.current.setQuery("alpha"));

      await waitFor(() => expect(result.current.results.length).toBeGreaterThan(0), {
        timeout: 2000,
      });

      // Hidden action still surfaces during search — the eviction only applies
      // to the empty-query "Recently used" rail.
      expect(result.current.results.map((r) => r.id)).toContain("a.action");
    });

    it("pinnedCount is 0 during typed search even when pinned items are in results", async () => {
      listMock.mockReturnValue([makeEntry("a.action", "Alpha"), makeEntry("b.action", "Bravo")]);
      useActionPrefsStore.getState().pinAction("a.action");

      const { result } = renderHook(() => useActionPalette());

      act(() => result.current.open());
      act(() => result.current.setQuery("alpha"));

      await waitFor(() => expect(result.current.results.length).toBeGreaterThan(0), {
        timeout: 2000,
      });

      expect(result.current.pinnedCount).toBe(0);
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
