// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { MenuItemContribution } from "@shared/types/plugin";

const { menuItemsMock, onMenuItemsChangedMock } = vi.hoisted(() => ({
  menuItemsMock: vi.fn(),
  onMenuItemsChangedMock: vi.fn(),
}));

interface MenuEntry {
  pluginId: string;
  item: MenuItemContribution;
}

function entry(
  pluginId: string,
  location: MenuItemContribution["location"],
  overrides: Partial<MenuItemContribution> = {}
): MenuEntry {
  return {
    pluginId,
    item: { label: "Do thing", actionId: `${pluginId}.do`, location, ...overrides },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { window: unknown }).window = Object.assign(globalThis.window ?? {}, {
    electron: {
      plugin: {
        menuItems: menuItemsMock,
        onMenuItemsChanged: onMenuItemsChangedMock,
      },
    },
  });
  vi.resetModules();
  menuItemsMock.mockResolvedValue([]);
  onMenuItemsChangedMock.mockReturnValue(() => {});
});

describe("usePluginMenuItems", () => {
  it("exposes mount-time pull items filtered to the requested location", async () => {
    menuItemsMock.mockResolvedValue([
      entry("acme", "terminal"),
      entry("acme", "help"),
      entry("beta", "terminal"),
    ]);
    const { usePluginMenuItems } = await import("../usePluginMenuItems");

    const { result } = renderHook(() => usePluginMenuItems("terminal"));

    await waitFor(() => {
      expect(result.current).toHaveLength(2);
    });
    expect(result.current.map((e) => e.pluginId)).toEqual(["acme", "beta"]);
  });

  it("replaces state from an authoritative push", async () => {
    let emit: ((p: { items: MenuEntry[] }) => void) | null = null;
    onMenuItemsChangedMock.mockImplementation((cb: (p: { items: MenuEntry[] }) => void) => {
      emit = cb;
      return () => {};
    });
    const { usePluginMenuItems } = await import("../usePluginMenuItems");
    const { result } = renderHook(() => usePluginMenuItems("terminal"));

    await waitFor(() => expect(emit).not.toBeNull());
    emit!({ items: [entry("acme", "terminal"), entry("acme", "view")] });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });
    expect(result.current[0]?.item.actionId).toBe("acme.do");
  });

  it("drops a late-resolving pull once a push has arrived", async () => {
    let resolvePull: ((entries: MenuEntry[]) => void) | null = null;
    menuItemsMock.mockReturnValue(
      new Promise<MenuEntry[]>((resolve) => {
        resolvePull = resolve;
      })
    );
    let emit: ((p: { items: MenuEntry[] }) => void) | null = null;
    onMenuItemsChangedMock.mockImplementation((cb: (p: { items: MenuEntry[] }) => void) => {
      emit = cb;
      return () => {};
    });
    const { usePluginMenuItems } = await import("../usePluginMenuItems");
    const { result } = renderHook(() => usePluginMenuItems("terminal"));

    await waitFor(() => expect(emit).not.toBeNull());
    // Push wins: authoritative snapshot lands first.
    emit!({ items: [entry("beta", "terminal")] });
    await waitFor(() => expect(result.current).toHaveLength(1));

    // Stale pull resolves afterward and must be ignored.
    resolvePull!([entry("acme", "terminal"), entry("acme", "terminal")]);
    await Promise.resolve();
    expect(result.current.map((e) => e.pluginId)).toEqual(["beta"]);
  });

  it("passes through items with a `when` clause unfiltered (pre-#9273)", async () => {
    menuItemsMock.mockResolvedValue([entry("acme", "terminal", { when: "view == 'terminal'" })]);
    const { usePluginMenuItems } = await import("../usePluginMenuItems");

    const { result } = renderHook(() => usePluginMenuItems("terminal"));

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });
    expect(result.current[0]?.item.when).toBe("view == 'terminal'");
  });

  it("clears items immediately when the location changes", async () => {
    menuItemsMock.mockImplementation(() => new Promise<MenuEntry[]>(() => {}));
    onMenuItemsChangedMock.mockImplementation((cb: (p: { items: MenuEntry[] }) => void) => {
      // Seed terminal items via push so there is something to clear.
      cb({ items: [entry("acme", "terminal")] });
      return () => {};
    });
    const { usePluginMenuItems } = await import("../usePluginMenuItems");
    const { result, rerender } = renderHook(
      ({ loc }: { loc: MenuItemContribution["location"] }) => usePluginMenuItems(loc),
      { initialProps: { loc: "terminal" as MenuItemContribution["location"] } }
    );

    await waitFor(() => expect(result.current).toHaveLength(1));

    // Switching location tears down the old effect; the new pull never resolves.
    onMenuItemsChangedMock.mockReturnValue(() => {});
    rerender({ loc: "help" as MenuItemContribution["location"] });
    expect(result.current).toHaveLength(0);
  });

  it("survives a malformed push payload without throwing", async () => {
    let emit: ((p: { items: MenuEntry[] }) => void) | null = null;
    onMenuItemsChangedMock.mockImplementation((cb: (p: { items: MenuEntry[] }) => void) => {
      emit = cb;
      return () => {};
    });
    const { usePluginMenuItems } = await import("../usePluginMenuItems");
    const { result } = renderHook(() => usePluginMenuItems("terminal"));

    await waitFor(() => expect(emit).not.toBeNull());
    expect(() => emit!({ items: undefined as unknown as MenuEntry[] })).not.toThrow();
    expect(result.current).toHaveLength(0);
  });

  it("unsubscribes from the push channel on unmount", async () => {
    const cleanup = vi.fn();
    onMenuItemsChangedMock.mockReturnValue(cleanup);
    const { usePluginMenuItems } = await import("../usePluginMenuItems");

    const { unmount } = renderHook(() => usePluginMenuItems("terminal"));
    await waitFor(() => expect(onMenuItemsChangedMock).toHaveBeenCalled());
    unmount();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
