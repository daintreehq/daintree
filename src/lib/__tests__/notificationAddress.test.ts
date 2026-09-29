import { afterEach, describe, expect, it } from "vitest";
import { setPanelStoreAccessor, type PanelStoreSnapshot } from "@/store/storeAccessors";
import { panelNotificationAddress } from "../notificationAddress";

function withPanels(panelsById: Record<string, { worktreeId?: string }>): void {
  setPanelStoreAccessor(
    () =>
      ({
        panelsById,
        panelIds: Object.keys(panelsById),
        tabGroups: new Map(),
      }) as unknown as PanelStoreSnapshot
  );
}

afterEach(() => {
  withPanels({});
});

describe("panelNotificationAddress", () => {
  it("adds the worktree the panel lives in", () => {
    withPanels({ "term-1": { worktreeId: "/repo/wt-a" } });
    expect(panelNotificationAddress("term-1")).toEqual({
      panelId: "term-1",
      worktreeId: "/repo/wt-a",
    });
  });

  it("returns the panel alone when the panel has no worktree", () => {
    withPanels({ "term-1": {} });
    expect(panelNotificationAddress("term-1")).toEqual({ panelId: "term-1" });
  });

  it("returns the panel alone when the panel is unknown", () => {
    expect(panelNotificationAddress("gone")).toEqual({ panelId: "gone" });
  });
});
