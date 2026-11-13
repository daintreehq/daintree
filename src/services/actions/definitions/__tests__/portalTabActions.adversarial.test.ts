// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { PortalTab } from "@shared/types";
import type { ActionContext } from "@shared/types/actions";
import { _resetCopyFlashForTests, getCopyFlash } from "@/lib/copyFlash";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

const portalStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const pendingRequestMock = vi.hoisted(() => vi.fn());
const pendingCloseStoreMock = vi.hoisted(() => ({
  getState: vi.fn(() => ({ request: pendingRequestMock, pending: null, clear: vi.fn() })),
}));
const clearPortalPendingIfMock = vi.hoisted(() => vi.fn());
const activatePortalTabMock = vi.hoisted(() => vi.fn());

vi.mock("@/clients", () => ({ systemClient: { openExternal: vi.fn() } }));
vi.mock("@/store/portalStore", () => ({ usePortalStore: portalStoreMock }));
vi.mock("@/store/portalPendingCloseStore", () => ({
  usePortalPendingCloseStore: pendingCloseStoreMock,
}));
vi.mock("../portalHelpers", () => ({
  // parseConfirmed is pure; mirror the real implementation so the gate behaves.
  parseConfirmed: (args: unknown) =>
    !!args && typeof args === "object" && (args as { confirmed?: unknown }).confirmed === true,
  clearPortalPendingIf: clearPortalPendingIfMock,
  activatePortalTab: activatePortalTabMock,
}));

import { registerPortalTabActions } from "../portalTabActions";

function setupActions() {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {} as unknown as ActionCallbacks;
  registerPortalTabActions(actions, callbacks);
  return async (id: string, args?: unknown, ctx: ActionContext = {}): Promise<unknown> => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    const def = factory() as AnyActionDefinition;
    return def.run(args, ctx);
  };
}

const closeTabsAfterMock = vi.fn();

function setTabs(count: number, activeTabId: string) {
  const tabs: PortalTab[] = Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    url: `https://x/${i}`,
    title: `T${i}`,
  }));
  portalStoreMock.getState.mockReturnValue({
    tabs,
    activeTabId,
    closeTabsAfter: closeTabsAfterMock,
  });
}

const mainClipboardWriteMock = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  vi.clearAllMocks();
  mainClipboardWriteMock.mockResolvedValue(undefined);
  Object.defineProperty(globalThis, "window", {
    value: {
      electron: {
        portal: { hide: vi.fn().mockResolvedValue(undefined) },
        clipboard: { writeText: mainClipboardWriteMock },
      },
    },
    configurable: true,
  });
});

describe("portal.closeToRight escalation", () => {
  it("is a no-op when the anchor is the rightmost tab (nothing to close)", async () => {
    setTabs(3, "t2"); // anchor t2 has no tabs to its right
    const run = setupActions();
    await run("portal.closeToRight", { tabId: "t2" });

    expect(pendingRequestMock).not.toHaveBeenCalled();
    expect(closeTabsAfterMock).not.toHaveBeenCalled();
  });

  it("closes immediately below the 3-tab threshold without a confirm", async () => {
    setTabs(4, "t1"); // t2, t3 to the right => 2 tabs, below threshold
    const run = setupActions();
    await run("portal.closeToRight", { tabId: "t1" });

    expect(pendingRequestMock).not.toHaveBeenCalled();
    expect(clearPortalPendingIfMock).toHaveBeenCalledWith("closeToRight");
    expect(closeTabsAfterMock).toHaveBeenCalledWith("t1");
  });

  it("escalates to a confirm at 3+ tabs and does not close yet", async () => {
    setTabs(5, "t1"); // t2, t3, t4 to the right => 3 tabs
    const run = setupActions();
    await run("portal.closeToRight", { tabId: "t1" });

    expect(pendingRequestMock).toHaveBeenCalledTimes(1);
    expect(pendingRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "closeToRight", keepTabId: "t1" })
    );
    const snapshot = pendingRequestMock.mock.calls[0]![0] as { tabsToClose: PortalTab[] };
    expect(snapshot.tabsToClose.map((t) => t.id)).toEqual(["t2", "t3", "t4"]);
    expect(closeTabsAfterMock).not.toHaveBeenCalled();
  });

  it("closes when the confirmed dispatch arrives, clearing the pending request", async () => {
    setTabs(5, "t1");
    const run = setupActions();
    await run("portal.closeToRight", { tabId: "t1", confirmed: true });

    expect(pendingRequestMock).not.toHaveBeenCalled();
    expect(clearPortalPendingIfMock).toHaveBeenCalledWith("closeToRight");
    expect(closeTabsAfterMock).toHaveBeenCalledWith("t1");
  });

  it("is a no-op when the target tab id is not found", async () => {
    setTabs(4, "t0");
    const run = setupActions();
    await run("portal.closeToRight", { tabId: "missing" });

    expect(pendingRequestMock).not.toHaveBeenCalled();
    expect(closeTabsAfterMock).not.toHaveBeenCalled();
  });
});

describe("portal URL copies while the page holds focus", () => {
  // A shortcut pressed inside the page reaches the action with the shell
  // document unfocused, where the renderer clipboard refuses every write.
  const rendererClipboardWrite = vi.fn(() =>
    Promise.reject(new DOMException("Document is not focused.", "NotAllowedError"))
  );

  beforeEach(() => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: rendererClipboardWrite },
      configurable: true,
    });
  });

  it.each([
    ["portal.copyUrl", undefined, "https://x/1"],
    ["portal.copyUrl", { tabId: "t2" }, "https://x/2"],
    ["portal.copyTabUrl", { tabId: "t0" }, "https://x/0"],
    ["portal.copyTabUrl", {}, "https://x/1"],
  ])("%s %j writes through the main process", async (id, args, url) => {
    setTabs(3, "t1");
    const run = setupActions();

    await expect(run(id, args)).resolves.toBeUndefined();

    expect(mainClipboardWriteMock).toHaveBeenCalledWith(url);
    expect(rendererClipboardWrite).not.toHaveBeenCalled();
  });

  it("fails the copy when the main process refuses the write", async () => {
    setTabs(2, "t0");
    mainClipboardWriteMock.mockRejectedValueOnce(new Error("clipboard unavailable"));
    const run = setupActions();

    await expect(run("portal.copyUrl")).rejects.toThrow("clipboard unavailable");
  });
});

describe("portal URL copies asked for from a key", () => {
  const politeMessage = () => useAnnouncerStore.getState().polite?.msg ?? null;

  // Where the dock draws the element the confirmation sits beside: its
  // toolbar, clear of the page view below it.
  function placeAnchor(id: string, rect: { left: number; top: number }) {
    const el = document.createElement("button");
    el.id = id;
    el.getBoundingClientRect = () =>
      ({
        left: rect.left,
        top: rect.top,
        right: rect.left + 26,
        bottom: rect.top + 26,
        width: 26,
        height: 26,
      }) as DOMRect;
    document.body.appendChild(el);
  }

  beforeEach(() => {
    _resetCopyFlashForTests();
    useAnnouncerStore.setState({ polite: null, assertive: null });
    document.body.innerHTML = "";
    placeAnchor("portal-copy-url", { left: 900, top: 60 });
    placeAnchor("portal-tab-t2", { left: 1000, top: 100 });
  });

  it.each(["keybinding", "menu"] as const)(
    "confirms a %s copy beside the toolbar's Copy URL",
    async (dispatchSource) => {
      setTabs(3, "t1");
      const run = setupActions();

      await run("portal.copyUrl", undefined, { dispatchSource });

      expect(mainClipboardWriteMock).toHaveBeenCalledWith("https://x/1");
      expect(politeMessage()).toBe("URL copied");
      expect(getCopyFlash()?.origin).toEqual({
        kind: "rect",
        left: 900,
        top: 60,
        right: 926,
        bottom: 86,
      });
    }
  );

  it("confirms a keyed tab copy beside that tab", async () => {
    setTabs(3, "t1");
    const run = setupActions();

    await run("portal.copyTabUrl", { tabId: "t2" }, { dispatchSource: "keybinding" });

    expect(mainClipboardWriteMock).toHaveBeenCalledWith("https://x/2");
    expect(politeMessage()).toBe("URL copied");
    expect(getCopyFlash()?.origin).toMatchObject({ kind: "rect", left: 1000, top: 100 });
  });

  const COPIES = [
    ["portal.copyUrl", undefined, "https://x/1"],
    ["portal.copyTabUrl", { tabId: "t2" }, "https://x/2"],
  ] as const;
  const UNCONFIRMED = ["agent", "user", "context-menu", "plugin", undefined] as const;

  it.each(
    COPIES.flatMap(([id, args, url]) => UNCONFIRMED.map((src) => [id, src, args, url] as const))
  )(
    "%s draws nothing for a %s copy, which is confirmed elsewhere or not watched",
    async (id, dispatchSource, args, url) => {
      setTabs(3, "t1");
      const run = setupActions();

      await run(id, args, { dispatchSource });

      expect(mainClipboardWriteMock).toHaveBeenCalledWith(url);
      expect(getCopyFlash()).toBeNull();
      expect(politeMessage()).toBeNull();
    }
  );

  it.each(COPIES)("%s confirms nothing when the write is refused", async (id, args) => {
    setTabs(3, "t1");
    mainClipboardWriteMock.mockRejectedValueOnce(new Error("clipboard unavailable"));
    const run = setupActions();

    await expect(run(id, args, { dispatchSource: "keybinding" })).rejects.toThrow(
      "clipboard unavailable"
    );

    expect(getCopyFlash()).toBeNull();
    expect(politeMessage()).toBeNull();
  });
});
