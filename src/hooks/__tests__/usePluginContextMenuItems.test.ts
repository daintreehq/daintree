// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { ContextMenuContribution, ContextMenuLocation } from "@shared/types/plugin";
import type { WhenClauseContext } from "@shared/utils/whenClause";

const { contextMenuItemsMock, onContextMenuItemsChangedMock } = vi.hoisted(() => ({
  contextMenuItemsMock: vi.fn(),
  onContextMenuItemsChangedMock: vi.fn(),
}));

function entry(
  pluginId: string,
  label: string,
  location: ContextMenuLocation,
  extras: Partial<ContextMenuContribution> = {}
): { pluginId: string; item: ContextMenuContribution } {
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
        contextMenuItems: contextMenuItemsMock,
        onContextMenuItemsChanged: onContextMenuItemsChangedMock,
      },
    },
  });
  vi.resetModules();
  contextMenuItemsMock.mockResolvedValue([]);
  onContextMenuItemsChangedMock.mockReturnValue(() => {});
});

describe("usePluginContextMenuItems", () => {
  it("exposes plugin items matching the requested location from the mount-time pull", async () => {
    contextMenuItemsMock.mockResolvedValue([
      entry("acme", "Foo", "terminal"),
      entry("acme", "Bar", "worktree"),
    ]);
    const { usePluginContextMenuItems } = await import("../usePluginContextMenuItems");

    const { result } = renderHook(() => usePluginContextMenuItems("terminal"));

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });
    expect(result.current[0]?.item.label).toBe("Foo");
  });

  it("updates entries when a push arrives", async () => {
    let emit:
      | ((p: {
          items: Array<{ pluginId: string; item: ContextMenuContribution }>;
          complete: boolean;
        }) => void)
      | null = null;
    onContextMenuItemsChangedMock.mockImplementation(
      (
        cb: (p: {
          items: Array<{ pluginId: string; item: ContextMenuContribution }>;
          complete: boolean;
        }) => void
      ) => {
        emit = cb;
        return () => {};
      }
    );
    const { usePluginContextMenuItems } = await import("../usePluginContextMenuItems");
    const { result } = renderHook(() => usePluginContextMenuItems("worktree"));

    await waitFor(() => expect(emit).not.toBeNull());
    act(() => {
      emit!({ items: [entry("acme", "WorktreeItem", "worktree")], complete: false });
    });

    expect(result.current).toHaveLength(1);
    expect(result.current[0]?.item.label).toBe("WorktreeItem");
  });

  it("filters out items whose location does not match", async () => {
    let emit:
      | ((p: {
          items: Array<{ pluginId: string; item: ContextMenuContribution }>;
          complete: boolean;
        }) => void)
      | null = null;
    onContextMenuItemsChangedMock.mockImplementation(
      (
        cb: (p: {
          items: Array<{ pluginId: string; item: ContextMenuContribution }>;
          complete: boolean;
        }) => void
      ) => {
        emit = cb;
        return () => {};
      }
    );
    const { usePluginContextMenuItems } = await import("../usePluginContextMenuItems");
    const { result } = renderHook(() => usePluginContextMenuItems("terminal"));

    await waitFor(() => expect(emit).not.toBeNull());
    act(() => {
      emit!({
        items: [
          entry("acme", "Term", "terminal"),
          entry("acme", "WorktreeOnly", "worktree"),
          entry("acme", "FileOnly", "file"),
        ],
        complete: true,
      });
    });

    expect(result.current.map((e) => e.item.label)).toEqual(["Term"]);
  });

  it("drops the mount-time pull if a push has already resolved (pushReceived guard)", async () => {
    let resolvePull:
      | ((v: Array<{ pluginId: string; item: ContextMenuContribution }>) => void)
      | null = null;
    contextMenuItemsMock.mockImplementation(
      () =>
        new Promise<Array<{ pluginId: string; item: ContextMenuContribution }>>((res) => {
          resolvePull = res;
        })
    );
    let emit:
      | ((p: {
          items: Array<{ pluginId: string; item: ContextMenuContribution }>;
          complete: boolean;
        }) => void)
      | null = null;
    onContextMenuItemsChangedMock.mockImplementation(
      (
        cb: (p: {
          items: Array<{ pluginId: string; item: ContextMenuContribution }>;
          complete: boolean;
        }) => void
      ) => {
        emit = cb;
        return () => {};
      }
    );
    const { usePluginContextMenuItems } = await import("../usePluginContextMenuItems");
    const { result } = renderHook(() => usePluginContextMenuItems("terminal"));

    await waitFor(() => expect(emit).not.toBeNull());
    act(() => {
      emit!({ items: [entry("acme", "PushWins", "terminal")], complete: true });
    });
    act(() => {
      resolvePull!([]);
    });
    await waitFor(() => {
      expect(result.current.map((e) => e.item.label)).toEqual(["PushWins"]);
    });
  });

  it("includes items without a when clause", async () => {
    contextMenuItemsMock.mockResolvedValue([entry("acme", "Always", "terminal")]);
    const { usePluginContextMenuItems } = await import("../usePluginContextMenuItems");
    const { result } = renderHook(() => usePluginContextMenuItems("terminal"));

    await waitFor(() => expect(result.current).toHaveLength(1));
  });

  it("filters when clauses around a positive control (truthy keeps, falsy/unset/malformed drop)", async () => {
    contextMenuItemsMock.mockResolvedValue([
      entry("acme", "Visible", "terminal", { when: "true" }),
      entry("acme", "Hidden", "terminal", { when: "false" }),
      entry("acme", "Unset", "terminal", { when: "missingContextKey" }),
      entry("acme", "Malformed", "terminal", { when: "&& bad" }),
    ]);
    const { usePluginContextMenuItems } = await import("../usePluginContextMenuItems");
    const { result } = renderHook(() => usePluginContextMenuItems("terminal"));

    await waitFor(() => {
      expect(result.current.map((e) => e.item.label)).toEqual(["Visible"]);
    });
  });

  it("evaluates when clauses against the supplied context (keeps on match, drops on mismatch)", async () => {
    contextMenuItemsMock.mockResolvedValue([
      entry("acme", "ForFoo", "worktree", { when: "worktreeId == 'foo'" }),
    ]);
    const { usePluginContextMenuItems } = await import("../usePluginContextMenuItems");

    const matchCtx: WhenClauseContext = { worktreeId: "foo" };
    const { result: matched } = renderHook(() => usePluginContextMenuItems("worktree", matchCtx));
    await waitFor(() => {
      expect(matched.current.map((e) => e.item.label)).toEqual(["ForFoo"]);
    });

    const missCtx: WhenClauseContext = { worktreeId: "bar" };
    const { result: missed } = renderHook(() => usePluginContextMenuItems("worktree", missCtx));
    await waitFor(() => {
      expect(missed.current).toHaveLength(0);
    });
  });

  it("re-evaluates when clauses when ctx changes without a new push", async () => {
    contextMenuItemsMock.mockResolvedValue([
      entry("acme", "ForB", "worktree", { when: "worktreeId == 'b'" }),
    ]);
    const { usePluginContextMenuItems } = await import("../usePluginContextMenuItems");

    const { result, rerender } = renderHook(
      ({ ctx }: { ctx: WhenClauseContext }) => usePluginContextMenuItems("worktree", ctx),
      { initialProps: { ctx: { worktreeId: "a" } as WhenClauseContext } }
    );

    await waitFor(() => {
      expect(result.current).toHaveLength(0);
    });

    rerender({ ctx: { worktreeId: "b" } });
    expect(result.current.map((e) => e.item.label)).toEqual(["ForB"]);
  });

  it("shares one pull and one subscription across multiple mounted instances", async () => {
    const { usePluginContextMenuItems } = await import("../usePluginContextMenuItems");
    renderHook(() => usePluginContextMenuItems("terminal"));
    renderHook(() => usePluginContextMenuItems("worktree"));
    renderHook(() => usePluginContextMenuItems("file"));

    await waitFor(() => expect(onContextMenuItemsChangedMock).toHaveBeenCalledTimes(1));
    expect(contextMenuItemsMock).toHaveBeenCalledTimes(1);
  });

  it("does not tear down the shared subscription when an instance unmounts", async () => {
    const cleanupMock = vi.fn();
    onContextMenuItemsChangedMock.mockReturnValue(cleanupMock);
    const { usePluginContextMenuItems } = await import("../usePluginContextMenuItems");
    const a = renderHook(() => usePluginContextMenuItems("terminal"));
    renderHook(() => usePluginContextMenuItems("worktree"));

    a.unmount();
    // The store owns the subscription for the renderer's lifetime — unmounting a
    // consumer must not unsubscribe, or remaining/future consumers go stale.
    expect(cleanupMock).not.toHaveBeenCalled();
  });
});
