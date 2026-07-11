/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PanelInstance } from "@shared/types/panel";

const addPanelMock = vi.fn();
const getPanelGroupMock = vi.fn();
const createTabGroupMock = vi.fn();
const addPanelToGroupMock = vi.fn();
const deleteTabGroupMock = vi.fn();
const trashPanelMock = vi.fn();
const setActiveTabMock = vi.fn();
const setFocusedMock = vi.fn();
const buildPanelDuplicateOptionsMock = vi.fn();

vi.mock("@/store/panelStore", () => ({
  panelStoreApi: {
    getState: () => ({
      getPanelGroup: getPanelGroupMock,
      createTabGroup: createTabGroupMock,
      addPanelToGroup: addPanelToGroupMock,
      deleteTabGroup: deleteTabGroupMock,
      addPanel: addPanelMock,
      trashPanel: trashPanelMock,
      setActiveTab: setActiveTabMock,
      setFocused: setFocusedMock,
    }),
  },
  usePanelStore: Object.assign(vi.fn(), { getState: () => ({}) }),
}));

vi.mock("@/services/terminal/panelDuplicationService", () => ({
  buildPanelDuplicateOptions: buildPanelDuplicateOptionsMock,
}));

const { addTabForPanel } = await import("../useContentGridContext");

function makePanel(overrides: Partial<PanelInstance> = {}): PanelInstance {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return {
    id: "p1",
    title: "Panel 1",
    kind: "terminal",
    location: "grid",
    worktreeId: "wt-1",
    ...overrides,
  } as PanelInstance;
}

beforeEach(() => {
  vi.clearAllMocks();
  buildPanelDuplicateOptionsMock.mockResolvedValue({ kind: "terminal", title: "Panel 1" });
  addPanelMock.mockResolvedValue("new-tab");
  addPanelToGroupMock.mockReturnValue(true);
  getPanelGroupMock.mockReturnValue({ id: "g1", panelIds: ["p1"], activeTabId: "p1" });
});

describe("addTabForPanel", () => {
  it("keeps the group fullscreen while adding a tab to it (#11060)", async () => {
    // The new tab joins the group only after addPanel commits, so without this
    // flag the store would read it as a plain new grid cell and drop the user out
    // of the fullscreen group they are adding the tab to.
    await addTabForPanel(makePanel());

    expect(addPanelMock).toHaveBeenCalledTimes(1);
    const options = addPanelMock.mock.calls[0]?.[0] as { preserveMaximize?: boolean };
    expect(options.preserveMaximize).toBe(true);
  });

  it("folds the new tab into the group and activates it", async () => {
    await addTabForPanel(makePanel());

    expect(addPanelToGroupMock).toHaveBeenCalledWith("g1", "new-tab");
    expect(setActiveTabMock).toHaveBeenCalledWith("g1", "new-tab");
    expect(setFocusedMock).toHaveBeenCalledWith("new-tab");
  });
});
