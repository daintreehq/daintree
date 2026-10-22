import { describe, expect, it } from "vitest";
import type { PanelInstance } from "@shared/types/panel";
import { isQuickSwitchablePanel } from "../quickSwitcher";

// Plugin kinds sit outside the built-in `PanelInstance` union, as they do in the store.
function panel(fields: { kind: string } & Record<string, unknown>): PanelInstance {
  return { id: "p-1", title: "Panel", location: "grid", ...fields } as unknown as PanelInstance;
}

describe("isQuickSwitchablePanel", () => {
  it("accepts open non-PTY and plugin panels in every visible location", () => {
    expect(isQuickSwitchablePanel(panel({ kind: "browser" }))).toBe(true);
    expect(isQuickSwitchablePanel(panel({ kind: "acme.dashboard", location: "dock" }))).toBe(true);
    expect(isQuickSwitchablePanel(panel({ kind: "review", location: "background" }))).toBe(true);
  });

  it("rejects trashed and ephemeral panels of any kind", () => {
    expect(isQuickSwitchablePanel(panel({ kind: "browser", location: "trash" }))).toBe(false);
    expect(
      isQuickSwitchablePanel(
        panel({ kind: "file", location: "dialog", excludeFromPersistence: true })
      )
    ).toBe(false);
    expect(
      isQuickSwitchablePanel(
        panel({ kind: "terminal", location: "overlay", excludeFromPersistence: true })
      )
    ).toBe(false);
  });

  it("rejects a terminal whose PTY is gone, and only a terminal", () => {
    expect(isQuickSwitchablePanel(panel({ kind: "terminal", hasPty: false }))).toBe(false);
    expect(isQuickSwitchablePanel(panel({ kind: "terminal" }))).toBe(true);
    expect(isQuickSwitchablePanel(panel({ kind: "browser", hasPty: false }))).toBe(true);
  });
});
