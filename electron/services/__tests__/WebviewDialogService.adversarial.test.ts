import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockGuest {
  isDestroyed: ReturnType<typeof vi.fn<() => boolean>>;
  once: ReturnType<typeof vi.fn>;
  destroy: () => void;
}

const guestRegistry = vi.hoisted(() => new Map<number, MockGuest>());

function createGuest(initiallyDestroyed = false): MockGuest {
  let destroyed = initiallyDestroyed;
  let onDestroyed: (() => void) | null = null;

  return {
    isDestroyed: vi.fn(() => destroyed),
    once: vi.fn((event: string, callback: () => void) => {
      if (event === "destroyed") {
        onDestroyed = callback;
      }
    }),
    destroy: () => {
      destroyed = true;
      onDestroyed?.();
    },
  };
}

vi.mock("electron", () => ({
  webContents: {
    fromId: vi.fn((webContentsId: number) => guestRegistry.get(webContentsId)),
  },
}));

describe("WebviewDialogService adversarial", () => {
  beforeEach(() => {
    vi.resetModules();
    guestRegistry.clear();
  });

  it("DESTROY_CANCELS_ONLY_OWN_DIALOGS", async () => {
    const guestOne = createGuest();
    const guestTwo = createGuest();
    guestRegistry.set(1, guestOne);
    guestRegistry.set(2, guestTwo);

    const callbackOne = vi.fn();
    const callbackTwo = vi.fn();

    const { getWebviewDialogService } = await import("../WebviewDialogService.js");
    const service = getWebviewDialogService();

    service.registerPanel(1, "panel-1");
    service.registerPanel(2, "panel-2");
    service.registerDialog("dialog-1", 1, callbackOne);
    service.registerDialog("dialog-2", 2, callbackTwo);

    guestOne.destroy();

    expect(callbackOne).toHaveBeenCalledTimes(1);
    expect(callbackOne).toHaveBeenCalledWith(false);
    expect(callbackTwo).not.toHaveBeenCalled();

    service.resolveDialog("dialog-2", true, "confirmed");

    expect(callbackTwo).toHaveBeenCalledTimes(1);
    expect(callbackTwo).toHaveBeenCalledWith(true, "confirmed");
  });

  it("REGISTER_ON_DESTROYED_GUEST_REJECTS_FUTURE", async () => {
    guestRegistry.set(1, createGuest(true));

    const callback = vi.fn();
    const { getWebviewDialogService } = await import("../WebviewDialogService.js");
    const service = getWebviewDialogService();

    service.registerPanel(1, "panel-1");

    expect(service.getPanelId(1)).toBeUndefined();
    expect(service.registerDialog("dialog-1", 1, callback)).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
  });

  it("RE_REGISTER_SAME_WEBCONTENTS_LEAKS_OLD_OAUTH", async () => {
    const guest = createGuest();
    guestRegistry.set(1, guest);

    const { getWebviewDialogService } = await import("../WebviewDialogService.js");
    const service = getWebviewDialogService();

    service.registerPanel(1, "panel-a");
    service.storeOAuthSessionStorage("panel-a", [["key-a", "value-a"]]);

    service.registerPanel(1, "panel-b");
    service.storeOAuthSessionStorage("panel-b", [["key-b", "value-b"]]);

    guest.destroy();

    await expect(service.consumeOAuthSessionStorage("panel-a")).resolves.toEqual([]);
    await expect(service.consumeOAuthSessionStorage("panel-b")).resolves.toEqual([]);
  });

  it("DUPLICATE_DIALOG_ID_NO_LEAK", async () => {
    const guest = createGuest();
    guestRegistry.set(1, guest);

    const firstCallback = vi.fn();
    const secondCallback = vi.fn();

    const { getWebviewDialogService } = await import("../WebviewDialogService.js");
    const service = getWebviewDialogService();

    service.registerPanel(1, "panel-1");
    service.registerDialog("dialog-1", 1, firstCallback);
    service.registerDialog("dialog-1", 1, secondCallback);

    expect(firstCallback).toHaveBeenCalledTimes(1);
    expect(firstCallback).toHaveBeenCalledWith(false);

    service.resolveDialog("dialog-1", true, "ok");
    service.resolveDialog("dialog-1", false);

    expect(secondCallback).toHaveBeenCalledTimes(1);
    expect(secondCallback).toHaveBeenCalledWith(true, "ok");
  });

  it("REVERSE_ORDER_RESOLUTION_ISOLATED", async () => {
    const guest = createGuest();
    guestRegistry.set(1, guest);

    const firstCallback = vi.fn();
    const secondCallback = vi.fn();

    const { getWebviewDialogService } = await import("../WebviewDialogService.js");
    const service = getWebviewDialogService();

    service.registerPanel(1, "panel-1");
    service.registerDialog("dialog-1", 1, firstCallback);
    service.registerDialog("dialog-2", 1, secondCallback);

    service.resolveDialog("dialog-2", false, "no");
    service.resolveDialog("dialog-1", true, "yes");

    expect(secondCallback).toHaveBeenCalledTimes(1);
    expect(secondCallback).toHaveBeenCalledWith(false, "no");
    expect(firstCallback).toHaveBeenCalledTimes(1);
    expect(firstCallback).toHaveBeenCalledWith(true, "yes");
  });

  it("REJECTED_OAUTH_PROMISE_ONE_SHOT", async () => {
    const { getWebviewDialogService } = await import("../WebviewDialogService.js");
    const service = getWebviewDialogService();

    service.storeOAuthSessionStorage("panel-1", Promise.reject(new Error("boom")));

    await expect(service.consumeOAuthSessionStorage("panel-1")).resolves.toEqual([]);
    await expect(service.consumeOAuthSessionStorage("panel-1")).resolves.toEqual([]);
  });
});
