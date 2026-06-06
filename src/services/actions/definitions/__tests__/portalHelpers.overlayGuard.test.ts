// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const portalStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const uiStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const getPortalPlaceholderBoundsMock = vi.hoisted(() => vi.fn());

vi.mock("@/store/portalStore", () => ({ usePortalStore: portalStoreMock }));
vi.mock("@/store/uiStore", () => ({ useUIStore: uiStoreMock }));
vi.mock("@/store/portalPendingCloseStore", () => ({
  usePortalPendingCloseStore: { getState: vi.fn(() => ({ pending: null, clear: vi.fn() })) },
}));
vi.mock("@/lib/portalBounds", () => ({
  getPortalPlaceholderBounds: getPortalPlaceholderBoundsMock,
}));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { activatePortalTab, showPortalTabIfNoOverlay } from "../portalHelpers";

const BOUNDS = { x: 0, y: 0, width: 800, height: 600 };
const showMock = vi.fn(async () => ({}));
const createMock = vi.fn(async () => ({}));
const hideMock = vi.fn(async () => ({}));
const setActiveTabMock = vi.fn();
const markTabCreatedMock = vi.fn();

function setOverlay(active: boolean) {
  uiStoreMock.getState.mockReturnValue({ overlayStack: active ? ["settings"] : [] });
}

beforeEach(() => {
  vi.clearAllMocks();
  getPortalPlaceholderBoundsMock.mockReturnValue(BOUNDS);
  setOverlay(false);
  Object.defineProperty(globalThis, "window", {
    value: { electron: { portal: { show: showMock, create: createMock, hide: hideMock } } },
    configurable: true,
  });
});

describe("showPortalTabIfNoOverlay", () => {
  it("shows the tab when no overlay is active", async () => {
    await showPortalTabIfNoOverlay("tab-1", BOUNDS);
    expect(showMock).toHaveBeenCalledWith({ tabId: "tab-1", bounds: BOUNDS });
  });

  it("skips the show when an overlay owns the viewport", async () => {
    setOverlay(true);
    await showPortalTabIfNoOverlay("tab-1", BOUNDS);
    expect(showMock).not.toHaveBeenCalled();
  });
});

describe("activatePortalTab overlay guard", () => {
  beforeEach(() => {
    portalStoreMock.getState.mockReturnValue({
      tabs: [{ id: "tab-1", url: "https://example.com", partition: undefined }],
      createdTabs: new Set<string>(),
      setActiveTab: setActiveTabMock,
      markTabCreated: markTabCreatedMock,
    });
  });

  it("creates and shows the tab when no overlay is active", async () => {
    await activatePortalTab("tab-1");
    expect(setActiveTabMock).toHaveBeenCalledWith("tab-1");
    expect(createMock).toHaveBeenCalledOnce();
    expect(markTabCreatedMock).toHaveBeenCalledWith("tab-1");
    expect(showMock).toHaveBeenCalledWith({ tabId: "tab-1", bounds: BOUNDS });
  });

  it("still creates the tab but suppresses the show when an overlay is active", async () => {
    setOverlay(true);
    await activatePortalTab("tab-1");
    // Store-side activation and backend creation still happen; only the show is gated.
    expect(setActiveTabMock).toHaveBeenCalledWith("tab-1");
    expect(createMock).toHaveBeenCalledOnce();
    expect(markTabCreatedMock).toHaveBeenCalledWith("tab-1");
    expect(showMock).not.toHaveBeenCalled();
  });
});
