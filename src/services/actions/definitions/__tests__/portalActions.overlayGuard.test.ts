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
vi.mock("@/lib/aiAgentDetection", () => ({ getAIAgentInfo: vi.fn(() => null) }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

// Use the REAL portalHelpers (showPortalTabIfNoOverlay) so the guard's read of
// useUIStore is exercised end-to-end — that is the regression this file pins.
import { registerPortalActions } from "../portalActions";

const BOUNDS = { x: 0, y: 0, width: 800, height: 600 };
const showMock = vi.fn(async () => ({}));
const createMock = vi.fn(async () => ({}));
const duplicateTabMock = vi.fn(() => "tab-2");
const markTabCreatedMock = vi.fn();
const closeTabMock = vi.fn();

function setOverlay(active: boolean) {
  uiStoreMock.getState.mockReturnValue({ overlayStack: active ? ["settings"] : [] });
}

function runDuplicate(): Promise<unknown> {
  const actions: ActionRegistry = new Map();
  registerPortalActions(actions, {} as unknown as ActionCallbacks);
  const factory = actions.get("portal.duplicateTab");
  if (!factory) throw new Error("missing portal.duplicateTab");
  const def = factory() as AnyActionDefinition;
  return def.run({ tabId: "tab-1" }, {} as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  getPortalPlaceholderBoundsMock.mockReturnValue(BOUNDS);
  setOverlay(false);
  portalStoreMock.getState.mockReturnValue({
    tabs: [{ id: "tab-1", url: "https://example.com", title: "One" }],
    activeTabId: "tab-1",
    duplicateTab: duplicateTabMock,
    markTabCreated: markTabCreatedMock,
    closeTab: closeTabMock,
  });
  Object.defineProperty(globalThis, "window", {
    value: { electron: { portal: { show: showMock, create: createMock } } },
    configurable: true,
  });
});

describe("portal.duplicateTab overlay guard", () => {
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
