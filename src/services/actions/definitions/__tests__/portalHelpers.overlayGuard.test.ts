// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

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
vi.mock("@/lib/aiAgentDetection", () => ({ getAIAgentInfo: vi.fn(() => null) }));

import { activatePortalTab, showPortalTabIfNoOverlay } from "../portalHelpers";
// The REAL portalHelpers, so the portal actions' read of useUIStore is exercised end-to-end.
import { registerPortalActions } from "../portalActions";

const BOUNDS = { x: 0, y: 0, width: 800, height: 600 };
const showMock = vi.fn<(payload: unknown) => Promise<unknown>>(async () => ({}));
const createMock = vi.fn(async () => ({}));
const hideMock = vi.fn(async () => ({}));
const setActiveTabMock = vi.fn();
const markTabCreatedMock = vi.fn();
const duplicateTabMock = vi.fn(() => "tab-2");
const closeTabMock = vi.fn();

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
  beforeEach(() => {
    portalStoreMock.getState.mockReturnValue({ isOpen: true });
  });

  it("shows the tab when no overlay is active", async () => {
    await showPortalTabIfNoOverlay("tab-1", BOUNDS);
    expect(showMock).toHaveBeenCalledWith({ tabId: "tab-1", bounds: BOUNDS });
  });

  it("skips the show when an overlay owns the viewport", async () => {
    setOverlay(true);
    await showPortalTabIfNoOverlay("tab-1", BOUNDS);
    expect(showMock).not.toHaveBeenCalled();
  });

  it("skips the show when the Portal closed while the tab was being created", async () => {
    // Opening the Assistant closes the Portal; a late show must not re-cover it.
    portalStoreMock.getState.mockReturnValue({ isOpen: false });
    await showPortalTabIfNoOverlay("tab-1", BOUNDS);
    expect(showMock).not.toHaveBeenCalled();
  });
});

describe("activatePortalTab overlay guard", () => {
  beforeEach(() => {
    portalStoreMock.getState.mockReturnValue({
      isOpen: true,
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

describe("activatePortalTab with a tab main released (#14537)", () => {
  const unmarkTabCreatedMock = vi.fn();
  const tabs = [{ id: "tab-1", url: "https://example.com/latest", partition: "persist:p" }];
  const stateWith = (created: string[]) => ({
    isOpen: true,
    tabs,
    createdTabs: new Set(created),
    setActiveTab: setActiveTabMock,
    markTabCreated: markTabCreatedMock,
    unmarkTabCreated: unmarkTabCreatedMock,
  });

  it("creates a tab whose eviction notice landed during the bounds wait", async () => {
    portalStoreMock.getState.mockReturnValueOnce(stateWith(["tab-1"]));
    portalStoreMock.getState.mockReturnValue(stateWith([]));

    await activatePortalTab("tab-1");

    expect(createMock).toHaveBeenCalledWith({
      tabId: "tab-1",
      url: "https://example.com/latest",
      partition: "persist:p",
    });
    expect(showMock).toHaveBeenCalledWith({ tabId: "tab-1", bounds: BOUNDS });
  });

  it("hands a tab main no longer holds back for recreation instead of leaving it blank", async () => {
    portalStoreMock.getState.mockReturnValue(stateWith(["tab-1"]));
    showMock.mockResolvedValueOnce(false);

    await activatePortalTab("tab-1");

    expect(createMock).not.toHaveBeenCalled();
    expect(unmarkTabCreatedMock).toHaveBeenCalledWith("tab-1");
  });

  it("leaves a shown tab marked created", async () => {
    portalStoreMock.getState.mockReturnValue(stateWith(["tab-1"]));
    showMock.mockResolvedValueOnce(true);

    await activatePortalTab("tab-1");

    expect(unmarkTabCreatedMock).not.toHaveBeenCalled();
  });
});

function runDuplicate(): Promise<unknown> {
  const actions: ActionRegistry = new Map();
  registerPortalActions(actions, {} as unknown as ActionCallbacks);
  const factory = actions.get("portal.duplicateTab");
  if (!factory) throw new Error("missing portal.duplicateTab");
  const def = factory() as AnyActionDefinition;
  return def.run({ tabId: "tab-1" }, {} as never);
}

describe("portal.duplicateTab overlay guard", () => {
  beforeEach(() => {
    portalStoreMock.getState.mockReturnValue({
      isOpen: true,
      tabs: [{ id: "tab-1", url: "https://example.com", title: "One" }],
      activeTabId: "tab-1",
      duplicateTab: duplicateTabMock,
      markTabCreated: markTabCreatedMock,
      closeTab: closeTabMock,
    });
  });

  it("creates and shows the duplicated tab when no overlay is active", async () => {
    await runDuplicate();
    expect(createMock).toHaveBeenCalledOnce();
    expect(markTabCreatedMock).toHaveBeenCalledWith("tab-2");
    expect(showMock).toHaveBeenCalledWith({ tabId: "tab-2", bounds: BOUNDS });
  });

  it("still creates the duplicated tab but suppresses the show when an overlay is active", async () => {
    setOverlay(true);
    await runDuplicate();
    // The duplicate is created in the backend; only the WebContentsView show is gated.
    expect(createMock).toHaveBeenCalledOnce();
    expect(markTabCreatedMock).toHaveBeenCalledWith("tab-2");
    expect(showMock).not.toHaveBeenCalled();
    expect(closeTabMock).not.toHaveBeenCalled();
  });
});
