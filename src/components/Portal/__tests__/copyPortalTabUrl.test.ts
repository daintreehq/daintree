// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalTab } from "@shared/types";

const { portalState, notifyMock } = vi.hoisted(() => ({
  portalState: { tabs: [] as PortalTab[] },
  notifyMock: vi.fn((_payload: unknown) => "toast-1"),
}));

vi.mock("@/store/portalStore", () => ({ usePortalStore: { getState: () => portalState } }));
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

import { _resetCopyFlashForTests, getCopyFlash, type CopyFlashTicket } from "@/lib/copyFlash";
import { copyPortalTabUrl } from "../copyPortalTabUrl";

const mainWrite = vi.fn<(text: string) => Promise<void>>();
// The page holds focus, so the renderer's own clipboard refuses every write.
const rendererWrite = vi.fn(() =>
  Promise.reject(new DOMException("Document is not focused.", "NotAllowedError"))
);
// Taken by the tab, in the toolbar, before the menu closed.
const BY_THE_TAB: CopyFlashTicket = {
  origin: { kind: "rect", left: 120, top: 80, right: 220, bottom: 112 },
  generation: 0,
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  _resetCopyFlashForTests();
  notifyMock.mockClear();
  mainWrite.mockReset().mockResolvedValue(undefined);
  rendererWrite.mockClear();
  portalState.tabs = [
    { id: "a", url: "https://claude.ai/", title: "Claude" },
    { id: "b", url: null, title: "New Tab" },
  ];
  Object.defineProperty(window, "electron", {
    value: { clipboard: { writeText: mainWrite } },
    configurable: true,
  });
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: rendererWrite },
    configurable: true,
  });
});

afterEach(() => _resetCopyFlashForTests());

describe("copyPortalTabUrl", () => {
  it("writes the tab's URL through main and confirms where the menu was asked", async () => {
    copyPortalTabUrl("a", BY_THE_TAB);
    await settle();

    expect(mainWrite).toHaveBeenCalledWith("https://claude.ai/");
    expect(rendererWrite).not.toHaveBeenCalled();
    expect(getCopyFlash()?.origin).toEqual(BY_THE_TAB.origin);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("offers a Retry that copies the same URL after the tab has navigated", async () => {
    mainWrite.mockRejectedValueOnce(new Error("clipboard unavailable"));
    copyPortalTabUrl("a", BY_THE_TAB);
    await settle();

    expect(getCopyFlash()).toBeNull();
    const toast = notifyMock.mock.calls[0]![0] as {
      action: { label: string; onClick: () => void };
    };
    expect(toast.action.label).toBe("Retry");

    portalState.tabs = [{ id: "a", url: "https://claude.ai/new", title: "Claude" }];
    toast.action.onClick();
    await settle();

    expect(mainWrite).toHaveBeenLastCalledWith("https://claude.ai/");
    expect(rendererWrite).not.toHaveBeenCalled();
  });

  it("does nothing for a tab with no page", async () => {
    copyPortalTabUrl("b", BY_THE_TAB);
    copyPortalTabUrl("missing", BY_THE_TAB);
    await settle();

    expect(mainWrite).not.toHaveBeenCalled();
    expect(getCopyFlash()).toBeNull();
  });
});
