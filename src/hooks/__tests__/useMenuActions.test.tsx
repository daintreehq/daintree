// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dispatchMock, isElectronAvailableMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn().mockResolvedValue({ ok: true }),
  isElectronAvailableMock: vi.fn(() => true),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: dispatchMock,
  },
}));

vi.mock("../useElectron", () => ({
  isElectronAvailable: isElectronAvailableMock,
}));

import { useMenuActions } from "../useMenuActions";

describe("useMenuActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const setup = () => {
    let handler: ((payload: { actionId: string; args?: unknown }) => void) | undefined;
    Object.defineProperty(window, "electron", {
      value: {
        app: {
          onMenuAction: (cb: (payload: { actionId: string; args?: unknown }) => void) => {
            handler = cb;
            return () => {};
          },
        },
      },
      configurable: true,
      writable: true,
    });

    renderHook(() => useMenuActions());

    return {
      get handler() {
        return handler;
      },
    };
  };

  it("ignores malformed non-object payloads without throwing", async () => {
    const { handler } = setup();

    await expect(async () => {
      await handler?.(null as unknown as { actionId: string });
    }).not.toThrow();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("dispatches directly when payload has actionId and no args", async () => {
    const { handler } = setup();

    await handler?.({ actionId: "terminal.new" });
    expect(dispatchMock).toHaveBeenCalledWith("terminal.new", undefined, { source: "menu" });
  });

  it("dispatches directly when payload has actionId and args", async () => {
    const { handler } = setup();

    await handler?.({ actionId: "agent.launch", args: { agentId: "codex" } });
    expect(dispatchMock).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "codex" },
      { source: "menu" }
    );
  });

  it("dispatches plugin action IDs directly", async () => {
    const { handler } = setup();

    await handler?.({ actionId: "plugin.foo.bar" });
    expect(dispatchMock).toHaveBeenCalledWith("plugin.foo.bar", undefined, { source: "menu" });
  });

  it("dispatches terminal focus-next action from main-process shortcut", async () => {
    const { handler } = setup();

    await handler?.({ actionId: "terminal.focusNext" });
    await handler?.({ actionId: "terminal.focusPrevious" });

    expect(dispatchMock).toHaveBeenNthCalledWith(1, "terminal.focusNext", undefined, {
      source: "menu",
    });
    expect(dispatchMock).toHaveBeenNthCalledWith(2, "terminal.focusPrevious", undefined, {
      source: "menu",
    });
  });

  it("does not leak unhandled rejection when dispatch throws", async () => {
    const { handler } = setup();

    dispatchMock.mockRejectedValueOnce(new Error("dispatch exploded"));

    await expect(async () => {
      await handler?.({ actionId: "terminal.new" });
    }).not.toThrow();
  });

  it("unsubscribes on unmount", () => {
    let unsubscribed = false;
    Object.defineProperty(window, "electron", {
      value: {
        app: {
          onMenuAction: () => {
            return () => {
              unsubscribed = true;
            };
          },
        },
      },
      configurable: true,
      writable: true,
    });

    const { unmount } = renderHook(() => useMenuActions());
    unmount();
    expect(unsubscribed).toBe(true);
  });
});
