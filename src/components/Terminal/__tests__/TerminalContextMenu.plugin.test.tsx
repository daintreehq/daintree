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
import { act, render, screen, cleanup } from "@testing-library/react";

// Render menu content synchronously. Radix only mounts it behind a real
// right-click into a portal, which tells us nothing about which branch ran —
// the branch choice is the whole contract under test here.
vi.mock("@/components/ui/context-menu", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Item = ({
    children,
    onSelect,
    disabled,
    destructive,
  }: {
    children?: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
    destructive?: boolean;
  }) => (
    <button
      disabled={disabled}
      data-destructive={destructive || undefined}
      onClick={() => onSelect?.()}
    >
      {children}
    </button>
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
    ContextMenuShortcut: ({ children }: { children?: React.ReactNode }) => <kbd>{children}</kbd>,
    ContextMenuGroup: Passthrough,
    ContextMenuPortal: Passthrough,
    ContextMenuSub: Passthrough,
    // The worktree rows are the submenu's business, not the panel commands'.
    ContextMenuSubContent: () => null,
    ContextMenuSubTrigger: ({ children }: { children?: React.ReactNode }) => (
      <div data-subtrigger>{children}</div>
    ),
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

const worktreeList = vi.hoisted(() => ({
  current: [] as Array<{ id: string; path: string; name: string }>,
}));

vi.mock("@/hooks/useSidebarWorktreeOrder", () => ({
  useSidebarWorktreeOrder: () => worktreeList.current,
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

import { registerPanelKind, unregisterPanelKind } from "@shared/config/panelKindRegistry";
import { TerminalContextMenu } from "../TerminalContextMenu";
import { getGenericPanelMenuGroups } from "@/components/Panel/genericPanelMenu";

// A PTY-backed plugin kind. Registered so the real `panelKindHasPty` reports
// `hasPty: true` for it, which is what keeps such a panel on the terminal menu
// despite carrying a `pluginId`.
const PTY_PLUGIN_KIND = "acme.shell";

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

/** A row's own label: its text, without the icon or the shortcut hint. */
function ownText(node: Element): string {
  return Array.from(node.childNodes)
    .filter((child) => child.nodeType === Node.TEXT_NODE)
    .map((child) => child.textContent)
    .join("")
    .trim();
}

/** The menu's command rows in order, submenu triggers included. */
function commandLabels(): string[] {
  return Array.from(document.querySelectorAll("button, [data-subtrigger]")).map(ownText);
}

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
    worktreeList.current = [];
    unregisterPanelKind(PTY_PLUGIN_KIND);
  });

  it.each(GENERIC_PANEL_LABELS)("offers %s on a plugin panel", (label) => {
    renderMenuFor(pluginPanel);

    expect(screen.getByText(label)).toBeTruthy();
  });

  it.each(TERMINAL_ONLY_LABELS)("never offers %s on a plugin panel", (label) => {
    renderMenuFor(pluginPanel);

    expect(screen.queryByText(label)).toBeNull();
  });

  it("routes a generic item to the panel the menu was opened on with the panel action", () => {
    renderMenuFor(pluginPanel);

    screen.getByText("Trash panel").click();

    expect(dispatch).toHaveBeenCalledTimes(1);
    // Assert BOTH halves: the action id proves it's the panel action, not a
    // mislabeled terminal one, and the explicit id proves it doesn't fall back
    // to `focusedId` — the exact misrouting this issue is about.
    const [actionId, args] = dispatch.mock.calls[0]!;
    expect(actionId).toBe("terminal.trash");
    expect(args).toMatchObject({ terminalId: "panel-1" });
  });

  it("lists the shared panel commands verbatim, in the shared order (#12606)", () => {
    // The header's overflow menu is held to this same list; asserting both
    // against it is what keeps the two menus from drifting apart again.
    worktreeList.current = [
      { id: "wt-1", path: "/repo", name: "main" },
      { id: "wt-2", path: "/repo-feature", name: "feature" },
    ];
    renderMenuFor(pluginPanel);

    const expected = getGenericPanelMenuGroups({
      location: "grid",
      isMaximized: false,
      // Unregistered here, so the dock can't render it.
      isDockable: false,
      canMoveToWorktree: true,
    })
      .flat()
      .map((command) => command.label);
    expect(commandLabels()).toEqual(expected);
    expect(commandLabels()).toContain("Move to worktree…");
    expect(commandLabels()).not.toContain("Duplicate panel");
  });

  it("disables Move to dock and marks only Remove panel destructive", () => {
    renderMenuFor(pluginPanel);

    const row = (label: string) =>
      Array.from(document.querySelectorAll("button")).find((button) => ownText(button) === label);
    expect(row("Move to dock")?.disabled).toBe(true);
    expect(
      Array.from(document.querySelectorAll("[data-destructive]")).map((node) => ownText(node))
    ).toEqual(["Remove panel"]);
  });

  it("offers Move to worktree… to a panel whose worktree has gone", () => {
    worktreeList.current = [{ id: "wt-2", path: "/repo-feature", name: "feature" }];
    renderMenuFor({ ...pluginPanel, worktreeId: "wt-gone" });

    expect(commandLabels()[0]).toBe("Move to worktree…");
  });

  it("offers no Move to worktree… when the panel's own worktree is the only one", () => {
    worktreeList.current = [{ id: "wt-1", path: "/repo", name: "main" }];
    renderMenuFor(pluginPanel);

    expect(commandLabels()).not.toContain("Move to worktree…");
  });

  it.each([
    ["Maximize", "terminal.toggleMaximize"],
    ["Send to background", "terminal.background"],
    ["Remove panel", "terminal.kill"],
  ])("routes %s to %s for this panel", (label, actionId) => {
    renderMenuFor(pluginPanel);

    screen.getByText(label).click();

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [calledId, args] = dispatch.mock.calls[0]!;
    expect(calledId).toBe(actionId);
    expect(args).toMatchObject({ terminalId: "panel-1" });
  });

  it("offers a docked plugin panel Move to grid", () => {
    renderMenuFor({ ...pluginPanel, location: "dock" });

    screen.getByText("Move to grid").click();

    expect(dispatch.mock.calls[0]?.[0]).toBe("terminal.moveToGrid");
    expect(screen.queryByText("Maximize")).toBeNull();
  });

  it("still gives a built-in terminal the terminal menu", () => {
    // Guards the discriminator: keying off `pluginId` must not drag an ordinary
    // terminal into the generic branch.
    renderMenuFor({
      id: "panel-1",
      title: "Agent",
      kind: "terminal",
      worktreeId: "wt-1",
    });

    expect(screen.queryByText("Rename panel")).toBeNull();
    expect(screen.getByText("Rename terminal")).toBeTruthy();
    expect(screen.getByText("Duplicate terminal")).toBeTruthy();
  });

  it("moves to the terminal menu when the plugin registers a PTY kind after mount", () => {
    renderMenuFor({
      id: "panel-1",
      title: "Acme Shell",
      kind: PTY_PLUGIN_KIND,
      pluginId: "acme",
      worktreeId: "wt-1",
    });
    expect(screen.getByText("Rename panel")).toBeTruthy();

    act(() =>
      registerPanelKind({
        id: PTY_PLUGIN_KIND,
        name: "Acme Shell",
        iconId: "terminal",
        color: "#abcdef",
        hasPty: true,
        canRestart: true,
        canConvert: false,
        extensionId: "acme",
      })
    );

    expect(screen.queryByText("Rename panel")).toBeNull();
    expect(screen.getByText("Rename terminal")).toBeTruthy();
  });

  it("gives a PTY-backed plugin panel the terminal menu, not the generic one", () => {
    // The load-bearing case behind `&& !hasPty`: a plugin can contribute a
    // PTY-backed kind that renders through TerminalPane and is stamped with
    // pluginId. It's a genuine terminal, so keying off pluginId alone would
    // strip its copy/paste/redraw/restart — the regression this guards.
    registerPanelKind({
      id: PTY_PLUGIN_KIND,
      name: "Acme Shell",
      iconId: "terminal",
      color: "#abcdef",
      hasPty: true,
      canRestart: true,
      canConvert: false,
      extensionId: "acme",
    });
    try {
      renderMenuFor({
        id: "panel-1",
        title: "Acme Shell",
        kind: PTY_PLUGIN_KIND,
        pluginId: "acme",
        worktreeId: "wt-1",
      });

      expect(screen.queryByText("Rename panel")).toBeNull();
      expect(screen.getByText("Rename terminal")).toBeTruthy();
      // Its kind has no duplicate recipe, so a Duplicate here would throw.
      expect(screen.queryByText("Duplicate terminal")).toBeNull();
    } finally {
      unregisterPanelKind(PTY_PLUGIN_KIND);
    }
  });
});
