// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantSlotKey } from "@shared/config/assistantSlots";
import {
  isReplaceableKeptLane,
  pickNewSessionSlot,
  readKeptLanes,
  withMirroredLanes,
  type KeptLane,
} from "../keptLanes";

function lane(slot: number, overrides: Partial<KeptLane> = {}): KeptLane {
  return {
    slot,
    agentId: "claude",
    agentSessionId: `conv-${slot}`,
    live: false,
    panelWasOpen: false,
    ...overrides,
  };
}

describe("readKeptLanes", () => {
  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it("tells a running assistant from a captured conversation, dropping a slot gone since the listing", async () => {
    (window as unknown as { electron: unknown }).electron = {
      help: {
        listPendingHibernationSlots: vi.fn(async () => [1, 2, 3]),
        peekPendingHibernation: vi.fn(async (_projectId: string, slot: number) => {
          if (slot === 3) return null;
          return {
            agentId: "claude",
            agentSessionId: slot === 2 ? "" : "conv-1",
            cwd: "/help",
            panelWasOpen: slot === 1,
            ...(slot === 2 ? { live: true } : {}),
          };
        }),
      },
    };

    expect(await readKeptLanes("proj-1")).toEqual([
      lane(1, { agentSessionId: "conv-1", panelWasOpen: true }),
      lane(2, { agentSessionId: "", live: true }),
    ]);
  });

  it("is null without the bindings, and rejects when a read fails", async () => {
    (window as unknown as { electron: unknown }).electron = { help: {} };
    expect(await readKeptLanes("proj-1")).toBeNull();

    (window as unknown as { electron: unknown }).electron = {
      help: {
        listPendingHibernationSlots: vi.fn(async () => [1]),
        peekPendingHibernation: vi.fn(async () => {
          throw new Error("ipc down");
        }),
      },
    };
    await expect(readKeptLanes("proj-1")).rejects.toThrow("ipc down");
  });
});

describe("isReplaceableKeptLane", () => {
  it("only lets a new session replace a stopped conversation past sessions can bring back", () => {
    expect(isReplaceableKeptLane(lane(1))).toBe(true);
    expect(isReplaceableKeptLane(lane(1, { agentId: "codex" }))).toBe(true);
    expect(isReplaceableKeptLane(lane(1, { live: true }))).toBe(false);
    expect(isReplaceableKeptLane(lane(1, { agentSessionId: "" }))).toBe(false);
    expect(isReplaceableKeptLane(lane(1, { agentId: "gemini" }))).toBe(false);
  });
});

describe("pickNewSessionSlot", () => {
  const tabs =
    (...open: number[]) =>
    (slot: number) =>
      open.includes(slot);

  it("takes the lowest slot with no tab that nothing is kept for", () => {
    expect(pickNewSessionSlot([lane(1), lane(2)], tabs(0))).toEqual({
      slot: 3,
      replacesKept: false,
    });
  });

  it("falls back to the lowest replaceable kept slot, passing over the ones it may not replace", () => {
    const kept = [
      lane(1, { live: true }),
      lane(2, { agentId: "gemini" }),
      lane(3),
      lane(4),
      lane(5),
    ];
    expect(pickNewSessionSlot(kept, tabs(0))).toEqual({ slot: 3, replacesKept: true });
  });

  it("never takes a slot with a tab, and is null when nothing is left", () => {
    expect(pickNewSessionSlot([lane(3)], tabs(0, 1, 2, 4, 5))).toEqual({
      slot: 3,
      replacesKept: true,
    });
    expect(pickNewSessionSlot([lane(3, { live: true })], tabs(0, 1, 2, 4, 5))).toBeNull();
  });
});

describe("withMirroredLanes", () => {
  it("adds the slots only this view's mirror holds, and lets main's entry win", () => {
    const merged = withMirroredLanes([lane(1, { agentId: "codex" })], "proj-1", {
      [assistantSlotKey("proj-1", 1)]: { sessionId: "mirror-1", cwd: "/help", agentId: "claude" },
      [assistantSlotKey("proj-1", 2)]: { sessionId: "mirror-2", cwd: "/help", agentId: "claude" },
      [assistantSlotKey("proj-2", 3)]: { sessionId: "other", cwd: "/help", agentId: "claude" },
    });

    expect(merged).toEqual([
      lane(1, { agentId: "codex" }),
      lane(2, { agentSessionId: "mirror-2" }),
    ]);
  });
});
