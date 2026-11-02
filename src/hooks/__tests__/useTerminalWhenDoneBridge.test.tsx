// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TerminalWhenDoneChange,
  TerminalWhenDoneEntry,
  TerminalWhenDoneFinishRequest,
  TerminalWhenDoneInUseQuery,
  TerminalWhenDoneInUseReply,
} from "@shared/types/ipc/terminalWhenDone";

const store = vi.hoisted(() => ({
  panelsById: {} as Record<string, unknown>,
  removePanel: vi.fn(),
  backgroundTerminal: vi.fn(),
  drafts: new Map<string, string>(),
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => store },
}));
vi.mock("@/store/terminalInputStore", () => ({
  useTerminalInputStore: { getState: () => ({ draftInputs: store.drafts }) },
}));

import {
  isTerminalPaneInUseHere,
  useTerminalWhenDoneBridge,
} from "@/hooks/useTerminalWhenDoneBridge";
import { useTerminalWhenDoneStore } from "@/store/terminalWhenDoneStore";

let pushChange: ((change: TerminalWhenDoneChange) => void) | null = null;
let askInUse: ((query: TerminalWhenDoneInUseQuery) => void) | null = null;
let requestFinish: ((request: TerminalWhenDoneFinishRequest) => void) | null = null;
let resolveList: ((entries: TerminalWhenDoneEntry[]) => void) | null = null;
const replies: TerminalWhenDoneInUseReply[] = [];
const unsubscribe = vi.fn();

function pane(location = "grid") {
  return { id: "terminal-1", kind: "terminal", location };
}

function focusPane(id: string): HTMLElement {
  const root = document.createElement("div");
  root.setAttribute("data-panel-id", id);
  const input = document.createElement("textarea");
  root.appendChild(input);
  document.body.appendChild(root);
  input.focus();
  return root;
}

beforeEach(() => {
  store.panelsById = {};
  store.drafts = new Map();
  store.removePanel.mockReset();
  store.backgroundTerminal.mockReset();
  unsubscribe.mockReset();
  replies.length = 0;
  useTerminalWhenDoneStore.setState({ choices: {} });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      terminalWhenDone: {
        list: () =>
          new Promise<TerminalWhenDoneEntry[]>((resolve) => {
            resolveList = resolve;
          }),
        onChanged: (cb: typeof pushChange) => {
          pushChange = cb;
          return unsubscribe;
        },
        onInUseQuery: (cb: typeof askInUse) => {
          askInUse = cb;
          return unsubscribe;
        },
        onFinishRequest: (cb: typeof requestFinish) => {
          requestFinish = cb;
          return unsubscribe;
        },
        sendInUseReply: (reply: TerminalWhenDoneInUseReply) => replies.push(reply),
      },
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  pushChange = askInUse = requestFinish = null;
  resolveList = null;
});

describe("useTerminalWhenDoneBridge (#16171)", () => {
  it("shows main's choices, keeping a change pushed before the snapshot answered", async () => {
    renderHook(() => useTerminalWhenDoneBridge());

    pushChange?.({ terminalId: "terminal-2", choice: "keep" });
    pushChange?.({ terminalId: "terminal-3", choice: "close" });
    await act(async () => {
      resolveList?.([
        { terminalId: "terminal-1", choice: "background" },
        { terminalId: "terminal-2", choice: "close" },
      ]);
    });

    expect(useTerminalWhenDoneStore.getState().choices).toEqual({
      "terminal-1": "background",
      "terminal-3": "close",
    });

    pushChange?.({ terminalId: "terminal-1", choice: "keep" });
    expect(useTerminalWhenDoneStore.getState().choices).toEqual({ "terminal-3": "close" });
  });

  it("answers whether the pane holds focus or a draft", () => {
    renderHook(() => useTerminalWhenDoneBridge());

    askInUse?.({ requestId: "r1", terminalId: "terminal-1" });
    const root = focusPane("terminal-1");
    askInUse?.({ requestId: "r2", terminalId: "terminal-1" });
    askInUse?.({ requestId: "r3", terminalId: "terminal-2" });
    root.remove();
    store.drafts.set("project-1:terminal-2", "half a thought");
    askInUse?.({ requestId: "r4", terminalId: "terminal-2" });

    expect(replies).toEqual([
      { requestId: "r1", inUse: false },
      { requestId: "r2", inUse: true },
      { requestId: "r3", inUse: false },
      { requestId: "r4", inUse: true },
    ]);
  });

  it("moves the pane to the background, or removes it without a second kill", () => {
    renderHook(() => useTerminalWhenDoneBridge());

    store.panelsById = { "terminal-1": pane("dock") };
    requestFinish?.({ terminalId: "terminal-1", action: "background" });
    store.panelsById = { "terminal-1": pane("trash") };
    requestFinish?.({ terminalId: "terminal-1", action: "background" });
    store.panelsById = { "terminal-1": pane("grid") };
    requestFinish?.({ terminalId: "terminal-1", action: "remove" });

    expect(store.backgroundTerminal).toHaveBeenCalledTimes(1);
    expect(store.removePanel).toHaveBeenCalledWith("terminal-1", { backendAlreadyClosed: true });
  });

  it("leaves a pane someone started using since main asked", () => {
    renderHook(() => useTerminalWhenDoneBridge());
    store.panelsById = { "terminal-1": pane("grid") };
    focusPane("terminal-1");

    requestFinish?.({ terminalId: "terminal-1", action: "background" });
    requestFinish?.({ terminalId: "terminal-1", action: "remove" });

    expect(store.backgroundTerminal).not.toHaveBeenCalled();
    expect(store.removePanel).not.toHaveBeenCalled();
  });

  it("stops listening on unmount", () => {
    const { unmount } = renderHook(() => useTerminalWhenDoneBridge());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(3);
  });
});

describe("isTerminalPaneInUseHere", () => {
  it("doesn't count focus in a window that doesn't have it", () => {
    focusPane("terminal-1");
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    expect(isTerminalPaneInUseHere("terminal-1")).toBe(false);
  });

  it("doesn't count a blank draft", () => {
    store.drafts.set("terminal-1", "  \n");
    expect(isTerminalPaneInUseHere("terminal-1")).toBe(false);
  });
});
