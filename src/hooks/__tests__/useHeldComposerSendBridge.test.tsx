// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerHoldChange, HeldComposerSend } from "@shared/types/ipc/composerHold";

const client = vi.hoisted(() => ({
  push: undefined as ((change: ComposerHoldChange) => void) | undefined,
  list: vi.fn<() => Promise<HeldComposerSend[]>>(),
}));
vi.mock("@/clients/composerHoldClient", () => ({
  composerHoldClient: {
    onChanged: (callback: (change: ComposerHoldChange) => void) => {
      client.push = callback;
      return () => {
        client.push = undefined;
      };
    },
    list: client.list,
  },
}));

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify }));

type PanelsState = { panelsById: Record<string, { title?: string; location: string }> };
const panels = vi.hoisted(() => {
  const listeners = new Set<(state: PanelsState, previous: PanelsState) => void>();
  let state: PanelsState = { panelsById: {} };
  return {
    set(next: PanelsState) {
      const previous = state;
      state = next;
      for (const listener of listeners) listener(state, previous);
    },
    store: {
      getState: () => state,
      subscribe: (listener: (state: PanelsState, previous: PanelsState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
});
vi.mock("@/store/panelStore", () => ({ usePanelStore: panels.store }));

import { useHeldComposerSendBridge } from "../useHeldComposerSendBridge";
import { useHeldComposerSendStore } from "@/store/heldComposerSendStore";

function send(token: string, terminalId = "t1"): HeldComposerSend {
  return { terminalId, token, text: "x", imagePaths: [], heldAt: 1, expiresAt: 2, status: "held" };
}

function dropped(terminalId: string, token = "a"): ComposerHoldChange {
  return {
    terminalId,
    held: null,
    ended: { token, outcome: { kind: "dropped", reason: "closed" }, text: "held text" },
  };
}

beforeEach(() => {
  useHeldComposerSendStore.setState({ held: {}, dropped: {}, refused: {}, endedTokens: [] });
  client.list.mockReset().mockResolvedValue([]);
  notify.mockReset();
  panels.set({ panelsById: { t1: { title: "Gemini", location: "grid" } } });
  Reflect.set(window, "electron", { composerHold: {} });
});

describe("useHeldComposerSendBridge", () => {
  it("takes main's snapshot, but a push since is newer than it", async () => {
    let answer!: (sends: HeldComposerSend[]) => void;
    client.list.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    renderHook(() => useHeldComposerSendBridge());
    act(() => client.push?.({ terminalId: "t1", held: null, ended: dropped("t1").ended }));
    await act(async () => answer([send("a", "t1"), send("b", "t2")]));
    expect(Object.keys(useHeldComposerSendStore.getState().held)).toEqual(["t2"]);
    expect(useHeldComposerSendStore.getState().dropped.t1?.text).toBe("held text");
  });

  it("says in the inbox when a pane it can't show dropped a send", async () => {
    panels.set({ panelsById: { t1: { title: "Gemini", location: "trash" } } });
    renderHook(() => useHeldComposerSendBridge());
    await waitFor(() => expect(client.list).toHaveBeenCalled());
    act(() => client.push?.(dropped("t1")));
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Held message not sent", priority: "low" })
    );
    expect(notify.mock.calls[0]![0].message).toContain("Gemini");
    // Still in the trash, the pane can come back and show it.
    expect(useHeldComposerSendStore.getState().dropped.t1).toBeDefined();
  });

  it("stays out of the inbox while the pane can say it itself", async () => {
    renderHook(() => useHeldComposerSendBridge());
    await waitFor(() => expect(client.list).toHaveBeenCalled());
    act(() => client.push?.(dropped("t1")));
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps no text for a pane that is gone", async () => {
    renderHook(() => useHeldComposerSendBridge());
    await waitFor(() => expect(client.list).toHaveBeenCalled());
    act(() => client.push?.(dropped("gone")));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(useHeldComposerSendStore.getState().dropped.gone).toBeUndefined();

    act(() => client.push?.(dropped("t1")));
    act(() => panels.set({ panelsById: {} }));
    expect(useHeldComposerSendStore.getState().dropped).toEqual({});
  });
});
