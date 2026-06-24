// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ContextMenuContribution, ContextMenuLocation } from "@shared/types/plugin";

type Entry = { pluginId: string; item: ContextMenuContribution };
type ChangedPayload = { items: Entry[]; complete: boolean };

const { contextMenuItemsMock, onChangedMock } = vi.hoisted(() => ({
  contextMenuItemsMock: vi.fn(),
  onChangedMock: vi.fn(),
}));

let changedCb: ((p: ChangedPayload) => void) | null = null;

function entry(label: string, location: ContextMenuLocation): Entry {
  return { pluginId: "acme", item: { label, actionId: `acme.${label}`, location } };
}

beforeEach(() => {
  vi.clearAllMocks();
  changedCb = null;
  contextMenuItemsMock.mockResolvedValue([]);
  onChangedMock.mockImplementation((cb: (p: ChangedPayload) => void) => {
    changedCb = cb;
    return () => {};
  });
  (globalThis as unknown as { window: unknown }).window = Object.assign(globalThis.window ?? {}, {
    electron: {
      plugin: {
        contextMenuItems: contextMenuItemsMock,
        onContextMenuItemsChanged: onChangedMock,
      },
    },
  });
});

async function load() {
  const mod = await import("../pluginContextMenuItemsStore");
  mod._resetPluginContextMenuItemsStoreForTest();
  mod.usePluginContextMenuItemsStore.getState().init();
  return mod;
}

describe("pluginContextMenuItemsStore", () => {
  it("pulls once and subscribes once on init", async () => {
    await load();
    expect(contextMenuItemsMock).toHaveBeenCalledTimes(1);
    expect(onChangedMock).toHaveBeenCalledTimes(1);
  });

  it("init is idempotent — does not double-pull or double-subscribe", async () => {
    const mod = await load();
    mod.usePluginContextMenuItemsStore.getState().init();
    mod.usePluginContextMenuItemsStore.getState().init();
    expect(contextMenuItemsMock).toHaveBeenCalledTimes(1);
    expect(onChangedMock).toHaveBeenCalledTimes(1);
  });

  it("populates entries from the mount-time pull", async () => {
    contextMenuItemsMock.mockResolvedValue([entry("Foo", "terminal")]);
    const mod = await load();
    await vi.waitFor(() => {
      expect(mod.usePluginContextMenuItemsStore.getState().entries).toHaveLength(1);
    });
    expect(mod.usePluginContextMenuItemsStore.getState().entries[0]?.item.label).toBe("Foo");
  });

  it("updates entries when a push arrives", async () => {
    const mod = await load();
    changedCb!({ items: [entry("Pushed", "worktree")], complete: false });
    expect(mod.usePluginContextMenuItemsStore.getState().entries.map((e) => e.item.label)).toEqual([
      "Pushed",
    ]);
  });

  it("a push received before the pull resolves wins (stale pull is dropped)", async () => {
    let resolvePull: ((v: Entry[]) => void) | null = null;
    contextMenuItemsMock.mockImplementation(
      () =>
        new Promise<Entry[]>((res) => {
          resolvePull = res;
        })
    );
    const mod = await load();

    // Push lands first while the pull is still in flight.
    changedCb!({ items: [entry("PushWins", "terminal")], complete: true });
    // Now the older pull resolves with different data — it must be ignored.
    resolvePull!([entry("StalePull", "terminal")]);

    await vi.waitFor(() => {
      expect(
        mod.usePluginContextMenuItemsStore.getState().entries.map((e) => e.item.label)
      ).toEqual(["PushWins"]);
    });
  });

  it("a pull that resolves before any push populates entries", async () => {
    contextMenuItemsMock.mockResolvedValue([entry("FromPull", "terminal")]);
    const mod = await load();
    await vi.waitFor(() => {
      expect(
        mod.usePluginContextMenuItemsStore.getState().entries.map((e) => e.item.label)
      ).toEqual(["FromPull"]);
    });
  });

  it("a failed initial pull does not block later pushes", async () => {
    contextMenuItemsMock.mockRejectedValue(new Error("ipc down"));
    const mod = await load();
    await vi.waitFor(() => expect(onChangedMock).toHaveBeenCalledTimes(1));
    expect(mod.usePluginContextMenuItemsStore.getState().entries).toEqual([]);

    // The permanent listener rescues the empty set on the next broadcast.
    changedCb!({ items: [entry("Rescued", "terminal")], complete: true });
    expect(mod.usePluginContextMenuItemsStore.getState().entries.map((e) => e.item.label)).toEqual([
      "Rescued",
    ]);
  });

  it("tolerates an absent bridge and stays retryable once a real bridge appears", async () => {
    const win = globalThis as unknown as {
      window: { electron: { plugin: Record<string, unknown> } };
    };
    win.window.electron.plugin = {}; // no plugin context-menu methods yet
    const mod = await import("../pluginContextMenuItemsStore");
    mod._resetPluginContextMenuItemsStoreForTest();
    expect(() => mod.usePluginContextMenuItemsStore.getState().init()).not.toThrow();
    expect(contextMenuItemsMock).not.toHaveBeenCalled();
    expect(onChangedMock).not.toHaveBeenCalled();

    // A later init with the real bridge present must still subscribe — the
    // absent-bridge early return did not latch `initialized`.
    win.window.electron.plugin = {
      contextMenuItems: contextMenuItemsMock,
      onContextMenuItemsChanged: onChangedMock,
    };
    mod.usePluginContextMenuItemsStore.getState().init();
    expect(contextMenuItemsMock).toHaveBeenCalledTimes(1);
    expect(onChangedMock).toHaveBeenCalledTimes(1);
  });

  it("reset unsubscribes, clears entries, and resets the init guard", async () => {
    const cleanup = vi.fn();
    onChangedMock.mockImplementation((cb: (p: ChangedPayload) => void) => {
      changedCb = cb;
      return cleanup;
    });
    const mod = await load();
    changedCb!({ items: [entry("Foo", "terminal")], complete: false });
    expect(mod.usePluginContextMenuItemsStore.getState().entries).toHaveLength(1);

    mod._resetPluginContextMenuItemsStoreForTest();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(mod.usePluginContextMenuItemsStore.getState().entries).toEqual([]);

    // Guard reset ⇒ a fresh init subscribes again.
    mod.usePluginContextMenuItemsStore.getState().init();
    expect(onChangedMock).toHaveBeenCalledTimes(2);
  });
});
