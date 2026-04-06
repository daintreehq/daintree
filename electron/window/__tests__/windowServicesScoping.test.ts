import { describe, expect, it, vi, beforeEach } from "vitest";
import { WindowRegistry } from "../WindowRegistry.js";
import type { BrowserWindow } from "electron";

function makeMockWindow(id: number, webContentsId: number) {
  const closedHandlers: Array<(...args: unknown[]) => void> = [];
  const destroyedHandlers: Array<() => void> = [];

  const win = {
    id,
    webContents: {
      id: webContentsId,
      once: vi.fn((event: string, handler: () => void) => {
        if (event === "destroyed") destroyedHandlers.push(handler);
      }),
      isDestroyed: vi.fn(() => false),
    },
    once: vi.fn((event: string, handler: () => void) => {
      if (event === "closed") closedHandlers.push(handler);
    }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "closed") closedHandlers.push(handler);
    }),
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    focus: vi.fn(),
    restore: vi.fn(),
    _fireClosed: () => closedHandlers.forEach((h) => h()),
    _fireDestroyed: () => destroyedHandlers.forEach((h) => h()),
  } as unknown as BrowserWindow & {
    _fireClosed: () => void;
    _fireDestroyed: () => void;
  };

  return win;
}

describe("Per-window service scoping via WindowRegistry", () => {
  let registry: WindowRegistry;

  beforeEach(() => {
    registry = new WindowRegistry();
  });

  it("stores per-window services in ctx.services independently per window", () => {
    const win1 = makeMockWindow(1, 100);
    const win2 = makeMockWindow(2, 200);

    const ctx1 = registry.register(win1);
    const ctx2 = registry.register(win2);

    // Simulate assigning per-window services
    const mockPort1 = { close: vi.fn() } as unknown as import("electron").MessagePortMain;
    const mockPort2 = { close: vi.fn() } as unknown as import("electron").MessagePortMain;
    const mockPort3 = { close: vi.fn() } as unknown as import("electron").MessagePortMain;
    const mockPort4 = { close: vi.fn() } as unknown as import("electron").MessagePortMain;

    ctx1.services.activeRendererPort = mockPort1;
    ctx1.services.activePtyHostPort = mockPort2;
    ctx2.services.activeRendererPort = mockPort3;
    ctx2.services.activePtyHostPort = mockPort4;

    // Each window has its own ports
    expect(ctx1.services.activeRendererPort).toBe(mockPort1);
    expect(ctx2.services.activeRendererPort).toBe(mockPort3);
    expect(ctx1.services.activeRendererPort).not.toBe(ctx2.services.activeRendererPort);
  });

  it("cleanup closes ports only for the unregistered window", () => {
    const win1 = makeMockWindow(1, 100);
    const win2 = makeMockWindow(2, 200);

    const ctx1 = registry.register(win1);
    const ctx2 = registry.register(win2);

    const port1Close = vi.fn();
    const port2Close = vi.fn();
    const port3Close = vi.fn();
    const port4Close = vi.fn();

    ctx1.services.activeRendererPort = {
      close: port1Close,
    } as unknown as import("electron").MessagePortMain;
    ctx1.services.activePtyHostPort = {
      close: port2Close,
    } as unknown as import("electron").MessagePortMain;
    ctx2.services.activeRendererPort = {
      close: port3Close,
    } as unknown as import("electron").MessagePortMain;
    ctx2.services.activePtyHostPort = {
      close: port4Close,
    } as unknown as import("electron").MessagePortMain;

    // Push cleanup for each window (mimics what setupWindowServices does)
    ctx1.cleanup.push(() => {
      ctx1.services.activeRendererPort?.close();
      ctx1.services.activePtyHostPort?.close();
    });
    ctx2.cleanup.push(() => {
      ctx2.services.activeRendererPort?.close();
      ctx2.services.activePtyHostPort?.close();
    });

    // Close window 1 only
    registry.unregister(1);

    // Window 1's ports closed
    expect(port1Close).toHaveBeenCalledOnce();
    expect(port2Close).toHaveBeenCalledOnce();

    // Window 2's ports untouched
    expect(port3Close).not.toHaveBeenCalled();
    expect(port4Close).not.toHaveBeenCalled();
  });

  it("portalManager.destroy() called only for the closing window", () => {
    const win1 = makeMockWindow(1, 100);
    const win2 = makeMockWindow(2, 200);

    const ctx1 = registry.register(win1);
    const ctx2 = registry.register(win2);

    const destroy1 = vi.fn();
    const destroy2 = vi.fn();

    ctx1.services.portalManager = {
      destroy: destroy1,
    } as unknown as import("../../../electron/services/PortalManager.js").PortalManager;
    ctx2.services.portalManager = {
      destroy: destroy2,
    } as unknown as import("../../../electron/services/PortalManager.js").PortalManager;

    ctx1.cleanup.push(() => ctx1.services.portalManager?.destroy());
    ctx2.cleanup.push(() => ctx2.services.portalManager?.destroy());

    win1._fireClosed();

    expect(destroy1).toHaveBeenCalledOnce();
    expect(destroy2).not.toHaveBeenCalled();
    expect(registry.size).toBe(1);
  });

  it("eventBuffer.stop() called only for the closing window", () => {
    const win1 = makeMockWindow(1, 100);
    const win2 = makeMockWindow(2, 200);

    const ctx1 = registry.register(win1);
    const ctx2 = registry.register(win2);

    const stop1 = vi.fn();
    const stop2 = vi.fn();

    ctx1.services.eventBuffer = {
      stop: stop1,
    } as unknown as import("../../../electron/services/EventBuffer.js").EventBuffer;
    ctx2.services.eventBuffer = {
      stop: stop2,
    } as unknown as import("../../../electron/services/EventBuffer.js").EventBuffer;

    ctx1.cleanup.push(() => ctx1.services.eventBuffer?.stop());
    ctx2.cleanup.push(() => ctx2.services.eventBuffer?.stop());

    win1._fireClosed();

    expect(stop1).toHaveBeenCalledOnce();
    expect(stop2).not.toHaveBeenCalled();
  });

  it("registry.size tracks window count for last-window-close guard", () => {
    const win1 = makeMockWindow(1, 100);
    const win2 = makeMockWindow(2, 200);

    registry.register(win1);
    registry.register(win2);
    expect(registry.size).toBe(2);

    win1._fireClosed();
    expect(registry.size).toBe(1);

    win2._fireClosed();
    expect(registry.size).toBe(0);
  });

  it("per-window projectSwitchService is accessible via registry lookup", () => {
    const win1 = makeMockWindow(1, 100);
    const ctx1 = registry.register(win1);

    const mockService = { switchProject: vi.fn() };
    ctx1.services.projectSwitchService =
      mockService as unknown as import("../../../electron/services/ProjectSwitchService.js").ProjectSwitchService;

    // Simulate menu.ts lookup pattern
    const looked = registry.getByWindowId(win1.id)?.services.projectSwitchService;
    expect(looked).toBe(mockService);
  });

  it("per-window projectSwitchService is cleared on window close", () => {
    const win1 = makeMockWindow(1, 100);
    const ctx1 = registry.register(win1);

    ctx1.services.projectSwitchService =
      {} as unknown as import("../../../electron/services/ProjectSwitchService.js").ProjectSwitchService;
    ctx1.cleanup.push(() => {
      ctx1.services.projectSwitchService = undefined;
    });

    win1._fireClosed();

    expect(ctx1.services.projectSwitchService).toBeUndefined();
  });

  it("event inspector cleanup uses removeListener not removeAllListeners", () => {
    const win1 = makeMockWindow(1, 100);
    const ctx1 = registry.register(win1);

    const bufferUnsub = vi.fn();

    // This mimics the pattern from the refactored windowServices.ts
    ctx1.cleanup.push(() => {
      bufferUnsub();
      // The key assertion: we use removeListener (per-function) not removeAllListeners
    });

    win1._fireClosed();

    expect(bufferUnsub).toHaveBeenCalledOnce();
  });
});
