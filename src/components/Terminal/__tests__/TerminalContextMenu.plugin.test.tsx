// @vitest-environment jsdom
/**
 * Plugin panels get the generic panel menu, not the terminal one (#11228).
 *
 * A plugin-contributed kind matches none of the built-in panel type guards, so
 * before this it fell through to the terminal-flavored default branch and was
 * offered "Duplicate terminal", "Kill terminal" and friends — none of which mean
 * anything for a plugin view. `hasPty` gated only some of those items, so the
 * mislabeled ones survived.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// Render menu content synchronously. Radix only mounts it behind a real
// right-click into a portal, which tells us nothing about which branch ran —
// the branch choice is the whole contract under test here.
vi.mock("@/components/ui/context-menu", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Item = ({ children, onSelect }: { children?: React.ReactNode; onSelect?: () => void }) => (
    <button onClick={() => onSelect?.()}>{children}</button>
  );
  return {
    ContextMenu: Passthrough,
    ContextMenuTrigger: Passthrough,
    ContextMenuContent: Passthrough,
    ContextMenuItem: Item,
    ContextMenuActionItem: Item,
    ContextMenuCheckboxItem: Item,
    ContextMenuRadioGroup: Passthrough,
    ContextMenuRadioItem: Item,
    ContextMenuSeparator: () => null,
    ContextMenuLabel: Passthrough,
    ContextMenuShortcut: Passthrough,
    ContextMenuGroup: Passthrough,
    ContextMenuPortal: Passthrough,
    ContextMenuSub: Passthrough,
    ContextMenuSubContent: Passthrough,
    ContextMenuSubTrigger: Passthrough,
  };
});

const dispatch = vi.hoisted(() => vi.fn());

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch,
    get: () => undefined,
    list: () => [],
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    getTerminal: () => undefined,
    getSelection: () => "",
  },
}));

vi.mock("@/hooks/useWorktrees", () => ({
  useWorktrees: () => ({ worktrees: [] }),
}));

vi.mock("@/hooks/useIsHibernated", () => ({
  useIsHibernated: () => false,
}));

vi.mock("@/hooks/usePluginContextMenuItems", () => ({
  usePluginContextMenuItems: () => [],
}));

vi.mock("@/store/voiceRecordingStore", () => ({
  useVoiceRecordingStore: (selector: (s: unknown) => unknown) =>
    selector({ lockedTarget: null, recentTargets: [] }),
}));

vi.mock("@/store/fleetArmingStore", () => ({
  useFleetArmingStore: (selector: (s: { armedIds: Set<string> }) => unknown) =>
    selector({ armedIds: new Set<string>() }),
  isFleetArmEligible: () => false,
}));

const panelsById = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("@/store", () => ({
  usePanelStore: (
    selector: (s: {
      panelsById: Record<string, unknown>;
      maximizeTarget: null;
      getPanelGroup: () => undefined;
      watchedPanels: Set<string>;
    }) => unknown
  ) =>
    selector({
      panelsById: panelsById.current,
      maximizeTarget: null,
      getPanelGroup: () => undefined,
      watchedPanels: new Set<string>(),
    }),
}));

import { TerminalContextMenu } from "../TerminalContextMenu";

// Terminal-only labels that must never reach a plugin panel. "Rename terminal"
// and "Trash terminal" are the sharp ones: the generic branch offers its own
// "Rename panel"/"Trash panel", so a regression here shows up as the wrong noun
// rather than a missing item.
const TERMINAL_ONLY_LABELS = [
  "Duplicate terminal",
  "Rename terminal",
  "Trash terminal",
  "Kill terminal",
  "View terminal info",
];

const GENERIC_PANEL_LABELS = ["Rename panel", "Send to background", "Trash panel", "Remove panel"];

function renderMenuFor(panel: Record<string, unknown>) {
  panelsById.current = { "panel-1": panel };
  return render(
    <TerminalContextMenu terminalId="panel-1">
      <div>Panel body</div>
    </TerminalContextMenu>
  );
}

const pluginPanel = {
  id: "panel-1",
  title: "Dashboard",
  kind: "acme.dashboard",
  pluginId: "acme",
  worktreeId: "wt-1",
};

describe("TerminalContextMenu — plugin panels (#11228)", () => {
  afterEach(() => {
    cleanup();
    dispatch.mockReset();
  });

  it.each(GENERIC_PANEL_LABELS)("offers %s on a plugin panel", (label) => {
    renderMenuFor(pluginPanel);

    expect(screen.getByText(label)).toBeTruthy();
  });

  it.each(TERMINAL_ONLY_LABELS)("never offers %s on a plugin panel", (label) => {
    renderMenuFor(pluginPanel);

    expect(screen.queryByText(label)).toBeNull();
  });

  it("routes a generic item to the panel the menu was opened on", () => {
    renderMenuFor(pluginPanel);

    screen.getByText("Trash panel").click();

    expect(dispatch).toHaveBeenCalledTimes(1);
    // The explicit id matters: panel-scoped actions otherwise fall back to
    // `focusedId`, which is the exact misrouting this issue is about.
    const [, args] = dispatch.mock.calls[0]!;
    expect(args).toMatchObject({ terminalId: "panel-1" });
  });

  it("still gives a PTY panel the terminal menu", () => {
    // Guards the discriminator itself: keying off `pluginId` must not drag any
    // ordinary terminal into the generic branch.
    renderMenuFor({
      id: "panel-1",
      title: "Agent",
      kind: "terminal",
      worktreeId: "wt-1",
    });

    expect(screen.queryByText("Rename panel")).toBeNull();
    expect(screen.getByText("Rename terminal")).toBeTruthy();
  });
});
