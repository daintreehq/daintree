import { afterEach, describe, expect, it } from "vitest";
import { isDockPanelRendered, type DockPanelScope } from "../dockPanelVisibility";
import type { PanelInstance, PtyPanelData, ReviewPanelData } from "@shared/types/panel";
import {
  clearPanelKindRegistry,
  registerPanelKind,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";

function createDockPanel(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/project",
    cols: 80,
    rows: 24,
    location: "dock",
    worktreeId: "wt-a",
    ...overrides,
  } as PtyPanelData;
}

function createScope(overrides: Partial<DockPanelScope> = {}): DockPanelScope {
  return {
    // The store keeps trash as a Map; `has` is all the predicate needs.
    trashedTerminals: new Map<string, unknown>(),
    helpTerminalId: null,
    activeWorktreeId: "wt-a",
    ...overrides,
  };
}

describe("isDockPanelRendered", () => {
  it("renders a docked panel belonging to the active worktree", () => {
    expect(isDockPanelRendered(createDockPanel("dock-1"), createScope())).toBe(true);
  });

  it("renders a global panel regardless of the active worktree", () => {
    const panel = createDockPanel("dock-1", { worktreeId: undefined });

    expect(isDockPanelRendered(panel, createScope({ activeWorktreeId: "wt-b" }))).toBe(true);
  });

  // #11065 — the dock filters other worktrees' panels out, but the offscreen
  // watchdog keeps `activeDockTerminalId` pointing at them so the popover can
  // reopen on the way back. Reading that stale pointer as a live popover strands
  // focus outside the maximized group.
  it("does not render a panel owned by a different worktree", () => {
    const panel = createDockPanel("dock-1", { worktreeId: "wt-a" });

    expect(isDockPanelRendered(panel, createScope({ activeWorktreeId: "wt-b" }))).toBe(false);
  });

  // Layout undo can restore a panel's location and the dock pointer without
  // lifting it out of the trash, so the trash check has to be part of "rendered".
  it("does not render a trashed panel", () => {
    const scope = createScope({ trashedTerminals: new Map([["dock-1", {}]]) });

    expect(isDockPanelRendered(createDockPanel("dock-1"), scope)).toBe(false);
  });

  it("does not render the help panel, which owns its own surface", () => {
    const scope = createScope({ helpTerminalId: "dock-1" });

    expect(isDockPanelRendered(createDockPanel("dock-1"), scope)).toBe(false);
  });

  it("does not render a panel that has moved back to the grid", () => {
    const panel = createDockPanel("dock-1", { location: "grid" });

    expect(isDockPanelRendered(panel, createScope())).toBe(false);
  });

  it("does not render a panel that no longer exists", () => {
    expect(isDockPanelRendered(undefined, createScope())).toBe(false);
  });

  it("does not render a panel kind the dock cannot host", () => {
    const panel: ReviewPanelData = {
      id: "dock-1",
      kind: "review",
      title: "Review",
      location: "dock",
      worktreeId: "wt-a",
    };

    expect(isDockPanelRendered(panel, createScope())).toBe(false);
  });
});

describe("isDockPanelRendered — plugin kinds follow the registry (#11332)", () => {
  const makePluginConfig = (id: string, dockable?: boolean): PanelKindConfig => ({
    id,
    name: `Plugin ${id}`,
    iconId: "puzzle",
    color: "#123456",
    hasPty: false,
    canRestart: false,
    canConvert: false,
    extensionId: "ext-a",
    ...(dockable !== undefined ? { dockable } : {}),
  });

  const makePluginPanel = (id: string, kind: string): PanelInstance => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- plugin kinds are cast into the closed PanelInstance union (mirrors addPanel.ts)
    return { id, kind, title: "Plugin", location: "dock", worktreeId: "wt-a" } as PanelInstance;
  };

  afterEach(() => {
    clearPanelKindRegistry();
  });

  it("renders a docked panel of a default-dockable plugin kind", () => {
    registerPanelKind(makePluginConfig("ext-a.viewer"));

    expect(isDockPanelRendered(makePluginPanel("dock-1", "ext-a.viewer"), createScope())).toBe(
      true
    );
  });

  it("does not render a docked panel of a plugin kind that opts out (dockable:false)", () => {
    registerPanelKind(makePluginConfig("ext-a.viewer", false));

    expect(isDockPanelRendered(makePluginPanel("dock-1", "ext-a.viewer"), createScope())).toBe(
      false
    );
  });

  it("does not render a docked panel whose plugin kind is not registered yet", () => {
    // Registration hasn't landed (or the plugin is disabled): an unknown kind
    // is never dockable, so it stays out of the dock render path.
    expect(
      isDockPanelRendered(makePluginPanel("dock-1", "ext-a.unregistered"), createScope())
    ).toBe(false);
  });
});
