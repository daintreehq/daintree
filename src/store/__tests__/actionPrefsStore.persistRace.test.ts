import { describe, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => ({
  writes: [] as string[][],
  holding: false,
  pending: [] as (() => void)[],
}));

vi.mock("@/clients/appClient", () => ({
  appClient: {
    setState: (updates: { actionHiddenIds?: string[] }) => {
      if (updates.actionHiddenIds) disk.writes.push(updates.actionHiddenIds);
      if (!disk.holding) return Promise.resolve();
      // Held open until the test settles it, as a slow disk write would be.
      return new Promise<void>((resolve) => disk.pending.push(resolve));
    },
  },
}));

describe("actionPrefsStore persistence — an undo while the reset is still writing", () => {
  it("persists the restored list, not the reset it undid", async () => {
    const { useActionPrefsStore } = await import("../actionPrefsStore");
    useActionPrefsStore.getState().hydrateActionPrefs({ hiddenIds: ["a", "b"] });
    await vi.waitFor(() => expect(disk.writes.length).toBeGreaterThan(0));
    disk.writes.length = 0;
    disk.holding = true;

    // Reset, then Undo one command at a time, with every earlier write still
    // pending: the last step puts back exactly what disk held before the reset.
    useActionPrefsStore.getState().resetHiddenActions();
    await vi.waitFor(() => expect(disk.writes).toEqual([[]]));
    useActionPrefsStore.getState().hideAction("a");
    await vi.waitFor(() => expect(disk.writes).toEqual([[], ["a"]]));
    useActionPrefsStore.getState().hideAction("b");

    disk.holding = false;
    for (const settle of disk.pending.splice(0)) settle();

    await vi.waitFor(() => expect(disk.writes.at(-1)).toEqual(["a", "b"]), { timeout: 5_000 });
  });
});
