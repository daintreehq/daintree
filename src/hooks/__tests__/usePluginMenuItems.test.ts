// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { MenuItemContribution, MenuItemLocation } from "@shared/types/plugin";

const { menuItemsMock, onMenuItemsChangedMock } = vi.hoisted(() => ({
  menuItemsMock: vi.fn(),
  onMenuItemsChangedMock: vi.fn(),
}));

function entry(
  pluginId: string,
  label: string,
  location: MenuItemLocation,
  extras: Partial<MenuItemContribution> = {}
): { pluginId: string; item: MenuItemContribution } {
  return {
    pluginId,
    item: {
      label,
      actionId: `${pluginId}.${label}`,
      location,
      ...extras,
    },
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
  it("exposes plugin menu items matching the requested location from the mount-time pull", async () => {
    menuItemsMock.mockResolvedValue([
      entry("acme", "Foo", "terminal"),
      entry("acme", "Bar", "view"),
    ]);
    const { usePluginMenuItems } = await import("../usePluginMenuItems");

    const { result } = renderHook(() => usePluginMenuItems("terminal"));

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });
    expect(result.current[0]?.item.label).toBe("Foo");
  });

  it("updates entries when a push arrives", async () => {
    let emit:
      | ((p: {
          items: Array<{ pluginId: string; item: MenuItemContribution }>;
          complete: boolean;
        }) => void)
      | null = null;
    onMenuItemsChangedMock.mockImplementation(
      (
        cb: (p: {
          items: Array<{ pluginId: string; item: MenuItemContribution }>;
          complete: boolean;
        }) => void
      ) => {
        emit = cb;
        return () => {};
      }
    );
    const { usePluginMenuItems } = await import("../usePluginMenuItems");
    const { result } = renderHook(() => usePluginMenuItems("view"));

    await waitFor(() => expect(emit).not.toBeNull());
    act(() => {
      emit!({ items: [entry("acme", "ViewItem", "view")], complete: false });
    });

    expect(result.current).toHaveLength(1);
    expect(result.current[0]?.item.label).toBe("ViewItem");
  });

  it("filters out items whose location does not match", async () => {
    let emit:
      | ((p: {
          items: Array<{ pluginId: string; item: MenuItemContribution }>;
          complete: boolean;
        }) => void)
      | null = null;
    onMenuItemsChangedMock.mockImplementation(
      (
        cb: (p: {
          items: Array<{ pluginId: string; item: MenuItemContribution }>;
          complete: boolean;
        }) => void
      ) => {
        emit = cb;
        return () => {};
      }
    );
    const { usePluginMenuItems } = await import("../usePluginMenuItems");
    const { result } = renderHook(() => usePluginMenuItems("terminal"));

    await waitFor(() => expect(emit).not.toBeNull());
    act(() => {
      emit!({
        items: [
          entry("acme", "Term", "terminal"),
          entry("acme", "ViewOnly", "view"),
          entry("acme", "HelpOnly", "help"),
        ],
        complete: true,
      });
    });

    expect(result.current.map((e) => e.item.label)).toEqual(["Term"]);
  });

  it("drops the mount-time pull if a push has already resolved (pushReceived guard)", async () => {
    let resolvePull: ((v: Array<{ pluginId: string; item: MenuItemContribution }>) => void) | null =
      null;
    menuItemsMock.mockImplementation(
      () =>
        new Promise<Array<{ pluginId: string; item: MenuItemContribution }>>((res) => {
          resolvePull = res;
        })
    );
    let emit:
      | ((p: {
          items: Array<{ pluginId: string; item: MenuItemContribution }>;
          complete: boolean;
        }) => void)
      | null = null;
    onMenuItemsChangedMock.mockImplementation(
      (
        cb: (p: {
          items: Array<{ pluginId: string; item: MenuItemContribution }>;
          complete: boolean;
        }) => void
      ) => {
        emit = cb;
        return () => {};
      }
    );
    const { usePluginMenuItems } = await import("../usePluginMenuItems");
    const { result } = renderHook(() => usePluginMenuItems("terminal"));

    await waitFor(() => expect(emit).not.toBeNull());
    // Push arrives with the canonical state before the pull resolves.
    act(() => {
      emit!({ items: [entry("acme", "PushWins", "terminal")], complete: true });
    });
    // The late-resolving pull (which would return an empty initial set) must
    // be dropped — otherwise it would roll the renderer back to []/stale.
    act(() => {
      resolvePull!([]);
    });
    await waitFor(() => {
      expect(result.current.map((e) => e.item.label)).toEqual(["PushWins"]);
    });
  });

  it("includes items without a when clause", async () => {
    menuItemsMock.mockResolvedValue([entry("acme", "Always", "terminal")]);
    const { usePluginMenuItems } = await import("../usePluginMenuItems");
    const { result } = renderHook(() => usePluginMenuItems("terminal"));

    await waitFor(() => expect(result.current).toHaveLength(1));
  });

  it("includes items whose when clause evaluates truthy", async () => {
    menuItemsMock.mockResolvedValue([entry("acme", "Truthy", "terminal", { when: "true" })]);
    const { usePluginMenuItems } = await import("../usePluginMenuItems");
    const { result } = renderHook(() => usePluginMenuItems("terminal"));

    await waitFor(() => expect(result.current).toHaveLength(1));
  });

  it("excludes items whose when clause evaluates falsy", async () => {
    menuItemsMock.mockResolvedValue([
      entry("acme", "Hidden", "terminal", { when: "false" }),
      entry("acme", "Unset", "terminal", { when: "missingContextKey" }),
    ]);
    const { usePluginMenuItems } = await import("../usePluginMenuItems");
    const { result } = renderHook(() => usePluginMenuItems("terminal"));

    // Pull resolves to [] of filtered items — wait for any state settling
    // then assert the filtered set is empty.
    await waitFor(() => expect(menuItemsMock).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });

  it("excludes items whose when clause fails to parse (fail-closed)", async () => {
    menuItemsMock.mockResolvedValue([entry("acme", "Malformed", "terminal", { when: "&& bad" })]);
    const { usePluginMenuItems } = await import("../usePluginMenuItems");
    const { result } = renderHook(() => usePluginMenuItems("terminal"));

    await waitFor(() => expect(menuItemsMock).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });

  it("cleans up the push subscription on unmount", async () => {
    const cleanupMock = vi.fn();
    onMenuItemsChangedMock.mockReturnValue(cleanupMock);
    const { usePluginMenuItems } = await import("../usePluginMenuItems");
    const { unmount } = renderHook(() => usePluginMenuItems("terminal"));

    unmount();
    expect(cleanupMock).toHaveBeenCalled();
  });
});
