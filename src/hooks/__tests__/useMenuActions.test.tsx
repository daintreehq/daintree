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

  it("ignores malformed non-string menu actions without throwing", async () => {
    let handler: ((action: string) => void) | undefined;
    Object.defineProperty(window, "electron", {
      value: {
        app: {
          onMenuAction: (cb: (action: string) => void) => {
            handler = cb;
            return () => {};
          },
        },
      },
      configurable: true,
      writable: true,
    });

    renderHook(() =>
      useMenuActions({
        onOpenSettings: vi.fn(),
        onToggleSidebar: vi.fn(),
        onOpenAgentPalette: vi.fn(),
        onLaunchAgent: vi.fn(),
        defaultCwd: "/tmp",
      })
    );

    expect(handler).toBeTruthy();
    await expect(async () => {
      await handler?.(null as unknown as string);
    }).not.toThrow();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("does not leak unhandled rejection when action dispatch throws", async () => {
    let handler: ((action: string) => Promise<void>) | undefined;
    Object.defineProperty(window, "electron", {
      value: {
        app: {
          onMenuAction: (cb: (action: string) => Promise<void>) => {
            handler = cb;
            return () => {};
          },
        },
      },
      configurable: true,
      writable: true,
    });

    dispatchMock.mockRejectedValueOnce(new Error("dispatch exploded"));

    renderHook(() =>
      useMenuActions({
        onOpenSettings: vi.fn(),
        onToggleSidebar: vi.fn(),
        onOpenAgentPalette: vi.fn(),
        onLaunchAgent: vi.fn(),
        defaultCwd: "/tmp",
      })
    );

    await expect(async () => {
      await handler?.("new-terminal");
    }).not.toThrow();
  });
});
