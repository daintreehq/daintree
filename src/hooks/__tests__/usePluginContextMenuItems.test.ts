// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { ContextMenuContribution, ContextMenuLocation } from "@shared/types/plugin";
import type { WhenClauseContext } from "@shared/utils/whenClause";

const { contextMenuItemsMock, onContextMenuItemsChangedMock, onContextKeysChangedMock } =
  vi.hoisted(() => ({
    contextMenuItemsMock: vi.fn(),
    onContextMenuItemsChangedMock: vi.fn(),
    onContextKeysChangedMock: vi.fn(),
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
        onContextKeysChanged: onContextKeysChangedMock,
      },
    },
  });
  vi.resetModules();
  contextMenuItemsMock.mockResolvedValue([]);
  onContextMenuItemsChangedMock.mockReturnValue(() => {});
  onContextKeysChangedMock.mockReturnValue(() => {});
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

  it("drops the mount-time pull if a push has already resolved (pushReceived guard)", async () => {
    let resolvePull:
      ((v: Array<{ pluginId: string; item: ContextMenuContribution }>) => void) | null = null;
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

  it("each mounted consumer independently filters one shared push", async () => {
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
    const term = renderHook(() => usePluginContextMenuItems("terminal"));
    const wt = renderHook(() => usePluginContextMenuItems("worktree"));
    const file = renderHook(() => usePluginContextMenuItems("file"));

    await waitFor(() => expect(emit).not.toBeNull());
    act(() => {
      emit!({
        items: [
          entry("acme", "T", "terminal"),
          entry("acme", "W", "worktree"),
          entry("acme", "F", "file"),
        ],
        complete: true,
      });
    });

    expect(term.result.current.map((e) => e.item.label)).toEqual(["T"]);
    expect(wt.result.current.map((e) => e.item.label)).toEqual(["W"]);
    expect(file.result.current.map((e) => e.item.label)).toEqual(["F"]);
  });

  it("a remounted consumer sees current data without a second subscription", async () => {
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
    const first = renderHook(() => usePluginContextMenuItems("terminal"));
    await waitFor(() => expect(emit).not.toBeNull());
    first.unmount();

    // A push lands through the retained listener while no consumer is mounted —
    // mirrors an LRU-evicted view's state advancing before it restores.
    act(() => {
      emit!({ items: [entry("acme", "Live", "terminal")], complete: true });
    });

    const second = renderHook(() => usePluginContextMenuItems("terminal"));
    expect(second.result.current.map((e) => e.item.label)).toEqual(["Live"]);
    // No re-subscription: the module-level listener was never torn down.
    expect(onContextMenuItemsChangedMock).toHaveBeenCalledTimes(1);
  });

  it("re-filters on plugin context keys, with the caller's own keys winning a clash", async () => {
    let emitKeys:
      ((p: { pluginId: string; keys: Record<string, boolean | string> | null }) => void) | null =
      null;
    onContextKeysChangedMock.mockImplementation(
      (cb: (p: { pluginId: string; keys: Record<string, boolean | string> | null }) => void) => {
        emitKeys = cb;
        return () => {};
      }
    );
    contextMenuItemsMock.mockResolvedValue([
      entry("acme.beads", "Answer", "terminal", { when: "acme.beads.needsYou" }),
      entry("acme.beads", "Mine", "terminal", { when: "panelKind == 'terminal'" }),
      entry("acme.other", "Clash", "terminal", { when: "acme.other.on" }),
    ]);
    const { usePluginContextMenuItems } = await import("../usePluginContextMenuItems");
    // The caller's own `acme` key shadows the whole plugin namespace under it.
    const ctx: WhenClauseContext = { panelKind: "terminal", acme: { other: { on: false } } };
    const { result } = renderHook(() => usePluginContextMenuItems("terminal", ctx));

    await waitFor(() => expect(result.current.map((e) => e.item.label)).toEqual(["Mine"]));
    expect(emitKeys).not.toBeNull();

    act(() => emitKeys!({ pluginId: "acme.other", keys: { on: true } }));
    expect(result.current.map((e) => e.item.label)).toEqual(["Mine"]);

    const { result: uncontested } = renderHook(() =>
      usePluginContextMenuItems("terminal", { panelKind: "terminal" })
    );
    act(() => emitKeys!({ pluginId: "acme.beads", keys: { needsYou: true } }));
    expect(uncontested.current.map((e) => e.item.label)).toEqual(["Answer", "Mine", "Clash"]);

    act(() => emitKeys!({ pluginId: "acme.beads", keys: null }));
    expect(uncontested.current.map((e) => e.item.label)).toEqual(["Mine", "Clash"]);
  });
});
