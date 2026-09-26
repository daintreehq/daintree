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

const menuCloseHook = vi.hoisted(() => ({
  current: undefined as ((event: Event) => void) | undefined,
}));

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
    ContextMenuContent: ({
      children,
      onCloseAutoFocus,
    }: {
      children?: React.ReactNode;
      onCloseAutoFocus?: (event: Event) => void;
    }) => {
      // Captured so a test can play the close Radix runs once the menu is gone.
      menuCloseHook.current = onCloseAutoFocus;
      return <div data-testid="context-menu-content">{children}</div>;
    },
    ContextMenuItem: Item,
    ContextMenuActionItem: Item,
    ContextMenuCheckboxItem: Item,
    ContextMenuRadioGroup: Passthrough,
    ContextMenuRadioItem: Item,
    ContextMenuSeparator: () => <hr />,
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
const layoutState = vi.hoisted(() => ({
  current: {
    maximizeTarget: null as { type: "panel" | "group"; id: string } | null,
    group: undefined as { id: string; panelIds: string[] } | undefined,
  },
}));

vi.mock("@/store", () => ({
  usePanelStore: (
    selector: (s: {
      panelsById: Record<string, unknown>;
      maximizeTarget: { type: "panel" | "group"; id: string } | null;
      getPanelGroup: () => { id: string; panelIds: string[] } | undefined;
      watchedPanels: Set<string>;
    }) => unknown
  ) =>
    selector({
      panelsById: panelsById.current,
      maximizeTarget: layoutState.current.maximizeTarget,
      getPanelGroup: () => layoutState.current.group,
      watchedPanels: new Set<string>(),
    }),
}));

const keybindingDisplays = vi.hoisted(() => ({ current: {} as Record<string, string> }));

vi.mock("@/hooks/useKeybinding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useKeybinding")>()),
  useKeybindingDisplay: (actionId: string) => keybindingDisplays.current[actionId] ?? "",
}));

import {
  getPanelKindConfig,
  panelKindIsDockable,
  registerPanelKind,
  unregisterPanelKind,
} from "@shared/config/panelKindRegistry";
import { registerTour } from "@/components/Tour/tourRegistry";
import { publishRegisteredPluginActions } from "@/services/plugin/registeredPluginActions";
import type { PanelLocation } from "@/types";
import { TerminalContextMenu } from "../TerminalContextMenu";
import {
  canReloadPanelKind,
  getGenericPanelMenuGroups,
  type GenericPanelMenuInput,
} from "@/components/Panel/genericPanelMenu";
import {
  __resetPanelCloseGuardsForTests,
  registerPanelCloseGuard,
} from "@/services/panelCloseGuard";

// A PTY-backed plugin kind. Registered so the real `panelKindHasPty` reports
// `hasPty: true` for it, which is what keeps such a panel on the terminal menu
// despite carrying a `pluginId`.
const PTY_PLUGIN_KIND = "acme.shell";
const VIEW_PLUGIN_KIND = "acme.dashboard";

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

type Row = "---" | { label: string; disabled: boolean; destructive: boolean };

/** A row's label: all of its text but the shortcut hint. */
function rowLabel(node: Element): string {
  return Array.from(node.childNodes)
    .filter((child) => !(child instanceof Element && child.tagName === "KBD"))
    .map((child) => child.textContent ?? "")
    .join("")
    .trim();
}

/** The menu's rows in order, submenu triggers and separators included. */
function menuRows(): Row[] {
  return Array.from(
    screen.getByTestId("context-menu-content").querySelectorAll("button, [data-subtrigger], hr")
  ).map((node) =>
    node.tagName === "HR"
      ? "---"
      : {
          label: rowLabel(node),
          disabled: node.hasAttribute("disabled"),
          destructive: node.hasAttribute("data-destructive"),
        }
  );
}

/** The shared list, drawn the way the menu should draw it. */
function sharedRows(input: Partial<GenericPanelMenuInput> = {}): Row[] {
  return getGenericPanelMenuGroups({
    location: "grid",
    isMaximized: false,
    isDockable: true,
    canMoveToWorktree: false,
    canReload: true,
    ...input,
  }).flatMap((group, index) => [
    ...(index > 0 ? ["---" as const] : []),
    ...group.map((command) => ({
      label: command.label,
      disabled: command.disabled ?? false,
      destructive: command.destructive ?? false,
    })),
  ]);
}

function commandLabel(input: Partial<GenericPanelMenuInput>, id: string): string {
  const command = getGenericPanelMenuGroups({
    location: "grid",
    isMaximized: false,
    isDockable: true,
    canMoveToWorktree: false,
    canReload: true,
    ...input,
  })
    .flat()
    .find((entry) => entry.id === id);
  if (!command) throw new Error(`no ${id} command`);
  return command.label;
}

function findRow(label: string): HTMLButtonElement | undefined {
  return Array.from(screen.getByTestId("context-menu-content").querySelectorAll("button")).find(
    (button) => rowLabel(button) === label
  );
}

function renderMenuFor(panel: Record<string, unknown>, forceLocation?: PanelLocation) {
  panelsById.current = { "panel-1": panel };
  return render(
    <TerminalContextMenu terminalId="panel-1" forceLocation={forceLocation}>
      <div>Panel body</div>
    </TerminalContextMenu>
  );
}

function registerPluginKind(
  id: string,
  options: {
    hasPty?: boolean;
    dockable?: boolean;
    name?: string;
    tourId?: string;
    hasPluginSettings?: boolean;
    hasPluginDatabases?: boolean;
    pluginMenu?: Array<{ actionId: string; label?: string }>;
  } = {}
) {
  registerPanelKind({
    ...(options.hasPluginSettings ? { hasPluginSettings: true } : {}),
    ...(options.hasPluginDatabases ? { hasPluginDatabases: true } : {}),
    ...(options.pluginMenu ? { pluginMenu: options.pluginMenu } : {}),
    id,
    name: options.name ?? id,
    iconId: "terminal",
    color: "#abcdef",
    hasPty: options.hasPty ?? false,
    canRestart: options.hasPty ?? false,
    canConvert: false,
    extensionId: "acme",
    ...(options.dockable !== undefined ? { dockable: options.dockable } : {}),
    ...(options.tourId !== undefined ? { tourId: options.tourId } : {}),
  });
}

const tourCleanups: Array<() => void> = [];

/** Registers a tour under `id` so a kind declaring it has something to play. */
function registerPlayableTour(id: string) {
  tourCleanups.push(
    registerTour({
      summary: { id, title: "Acme Tour", minutes: 1, chapterTitles: ["One"] },
      load: () => Promise.reject(new Error("not under test")),
    })
  );
}

const pluginPanel = {
  id: "panel-1",
  title: "Dashboard",
  kind: VIEW_PLUGIN_KIND,
  pluginId: "acme",
  worktreeId: "wt-1",
};

describe("TerminalContextMenu — plugin panels (#11228)", () => {
  afterEach(() => {
    // Unmounted first: dropping a kind while the menu still listens would
    // notify it outside act().
    cleanup();
    for (const cleanupTour of tourCleanups.splice(0)) cleanupTour();
    dispatch.mockReset();
    worktreeList.current = [];
    layoutState.current = { maximizeTarget: null, group: undefined };
    keybindingDisplays.current = {};
    unregisterPanelKind(PTY_PLUGIN_KIND);
    unregisterPanelKind(VIEW_PLUGIN_KIND);
    publishRegisteredPluginActions([]);
    __resetPanelCloseGuardsForTests();
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

  it("draws the shared list row for row, the worktree move first (#12606)", () => {
    // The header's overflow menu is held to this same list; asserting both
    // against it is what keeps the two menus from drifting apart again.
    registerPluginKind(VIEW_PLUGIN_KIND);
    worktreeList.current = [
      { id: "wt-1", path: "/repo", name: "main" },
      { id: "wt-2", path: "/repo-feature", name: "feature" },
    ];
    renderMenuFor(pluginPanel);

    expect(menuRows()).toEqual(
      sharedRows({ canMoveToWorktree: true, isDockable: panelKindIsDockable(VIEW_PLUGIN_KIND) })
    );
    expect(findRow("Remove panel")).toBeDefined();
  });

  it.each([
    ["an unregistered plugin", { kind: VIEW_PLUGIN_KIND, pluginId: "acme" }],
    ["file", { kind: "file", filePath: "/repo/README.md" }],
    ["file-browser", { kind: "file-browser" }],
    ["diff", { kind: "diff" }],
  ] as const)("draws the shared list for %s panels", (_label, fields) => {
    renderMenuFor({ ...pluginPanel, pluginId: undefined, ...fields });

    expect(menuRows()).toEqual(
      sharedRows({
        isDockable: panelKindIsDockable(fields.kind),
        canReload: canReloadPanelKind(fields.kind),
      })
    );
  });

  it("offers the worktree move to a panel whose worktree has gone", () => {
    worktreeList.current = [{ id: "wt-2", path: "/repo-feature", name: "feature" }];
    renderMenuFor({ ...pluginPanel, worktreeId: "wt-gone" });

    const moveLabel = commandLabel({ canMoveToWorktree: true }, "move-to-worktree");
    expect(menuRows()[0]).toEqual({ label: moveLabel, disabled: false, destructive: false });
  });

  it("offers no worktree move when the panel's own worktree is the only one", () => {
    worktreeList.current = [{ id: "wt-1", path: "/repo", name: "main" }];
    renderMenuFor(pluginPanel);

    const moveLabel = commandLabel({ canMoveToWorktree: true }, "move-to-worktree");
    expect(document.querySelector("[data-subtrigger]")).toBeNull();
    expect(menuRows()).not.toContainEqual(expect.objectContaining({ label: moveLabel }));
  });

  it("follows a forced dock location over the stored one", () => {
    renderMenuFor({ ...pluginPanel, location: "grid" }, "dock");

    expect(menuRows()).toEqual(sharedRows({ location: "dock" }));
    findRow(commandLabel({ location: "dock" }, "move-to-grid"))!.click();
    expect(dispatch).toHaveBeenCalledWith(
      "terminal.moveToGrid",
      { terminalId: "panel-1" },
      expect.anything()
    );
  });

  it("offers Restore when the panel's tab group is the one maximized", () => {
    layoutState.current = {
      maximizeTarget: { type: "group", id: "group-1" },
      group: { id: "group-1", panelIds: ["panel-2", "panel-1"] },
    };
    registerPluginKind(VIEW_PLUGIN_KIND);
    renderMenuFor(pluginPanel);

    expect(menuRows()).toEqual(sharedRows({ isMaximized: true }));
  });

  it("shows the maximize keybinding on the maximize row alone", () => {
    keybindingDisplays.current = { "terminal.maximize": "⌃⇧F" };
    registerPluginKind(VIEW_PLUGIN_KIND);
    renderMenuFor(pluginPanel);

    const hints = Array.from(
      screen.getByTestId("context-menu-content").querySelectorAll("button kbd")
    ).map((kbd) => [rowLabel(kbd.closest("button")!), kbd.textContent]);
    expect(hints).toEqual([[commandLabel({}, "toggle-maximize"), "⌃⇧F"]]);
  });

  it.each([
    ["move-to-dock", "terminal.moveToDock"],
    ["toggle-maximize", "terminal.toggleMaximize"],
    ["rename", "terminal.rename"],
    ["background", "terminal.background"],
    ["trash", "terminal.trash"],
    ["kill", "terminal.kill"],
  ])("routes %s to %s for this panel", (commandId, actionId) => {
    registerPluginKind(VIEW_PLUGIN_KIND);
    renderMenuFor(pluginPanel);

    findRow(commandLabel({}, commandId))!.click();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(actionId, { terminalId: "panel-1" }, expect.anything());
  });

  it("reloads this panel by id, never the focused one (#12611)", () => {
    registerPluginKind(VIEW_PLUGIN_KIND);
    renderMenuFor(pluginPanel);

    findRow(commandLabel({}, "reload"))!.click();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      "plugin.reloadPanel",
      { panelId: "panel-1" },
      expect.anything()
    );
  });

  it("offers a kind's declared tour in the shared list and plays it by id (#12774)", () => {
    registerPluginKind(VIEW_PLUGIN_KIND, { name: "Dashboard", tourId: "acme.dashboard-intro" });
    registerPlayableTour("acme.dashboard-intro");
    renderMenuFor(pluginPanel);

    expect(menuRows()).toEqual(sharedRows({ tourLabel: "Dashboard Welcome Tour" }));
    findRow("Dashboard Welcome Tour")!.click();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      "help.tour.show",
      { tourId: "acme.dashboard-intro" },
      expect.anything()
    );
  });

  it("offers a declared tour only once it is registered (#12774)", () => {
    registerPluginKind(VIEW_PLUGIN_KIND, { name: "Dashboard", tourId: "acme.dashboard-intro" });
    renderMenuFor(pluginPanel);
    expect(menuRows()).toEqual(sharedRows());
    cleanup();

    registerPlayableTour("acme.dashboard-intro");
    renderMenuFor(pluginPanel);
    expect(menuRows()).toEqual(sharedRows({ tourLabel: "Dashboard Welcome Tour" }));
  });

  it("asks a panel holding unsaved work before removing it", async () => {
    let verdict: "proceed" | "cancel" = "cancel";
    const guard = vi.fn(async () => verdict);
    registerPanelCloseGuard("panel-1", guard);
    renderMenuFor(pluginPanel);
    const remove = findRow(commandLabel({}, "kill"))!;

    remove.click();
    await act(async () => {});
    expect(guard).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();

    verdict = "proceed";
    remove.click();
    await act(async () => {});
    expect(dispatch).toHaveBeenCalledWith(
      "terminal.kill",
      { terminalId: "panel-1" },
      expect.anything()
    );
  });

  it("removes once when Remove is picked again while the prompt is up", async () => {
    let answer: (verdict: "proceed" | "cancel") => void = () => {};
    const guard = vi.fn(() => new Promise<"proceed" | "cancel">((resolve) => (answer = resolve)));
    registerPanelCloseGuard("panel-1", guard);
    renderMenuFor(pluginPanel);
    const remove = findRow(commandLabel({}, "kill"))!;

    remove.click();
    await act(async () => {});
    remove.click();
    await act(async () => answer("proceed"));

    expect(guard).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
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

    act(() => registerPluginKind(PTY_PLUGIN_KIND, { hasPty: true }));

    expect(screen.queryByText("Rename panel")).toBeNull();
    expect(screen.getByText("Rename terminal")).toBeTruthy();
  });

  it("gives a PTY-backed plugin panel the terminal menu, not the generic one", () => {
    // The load-bearing case behind `&& !hasPty`: a plugin can contribute a
    // PTY-backed kind that renders through TerminalPane and is stamped with
    // pluginId. It's a genuine terminal, so keying off pluginId alone would
    // strip its copy/paste/redraw/restart — the regression this guards.
    registerPluginKind(PTY_PLUGIN_KIND, { hasPty: true });
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
    expect(screen.queryByText(/Welcome Tour$/)).toBeNull();
  });

  it("offers a tour a built-in kind declares, with no menu changes (#12774)", () => {
    const browser = getPanelKindConfig("browser")!;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerPanelKind({ ...browser, tourId: "browser-intro" });
    registerPlayableTour("browser-intro");
    try {
      renderMenuFor({
        id: "panel-1",
        title: "Docs",
        kind: "browser",
        browserUrl: "https://example.com",
        worktreeId: "wt-1",
      });

      findRow(`${browser.name} Welcome Tour`)!.click();

      expect(dispatch).toHaveBeenCalledWith(
        "help.tour.show",
        { tourId: "browser-intro" },
        expect.anything()
      );
    } finally {
      cleanup();
      registerPanelKind(browser);
      warnSpy.mockRestore();
    }
  });

  it("offers a PTY-backed plugin kind's tour on the terminal menu (#12774)", () => {
    registerPluginKind(PTY_PLUGIN_KIND, {
      hasPty: true,
      name: "Shell",
      tourId: "acme.shell-intro",
    });
    registerPlayableTour("acme.shell-intro");
    renderMenuFor({
      id: "panel-1",
      title: "Acme Shell",
      kind: PTY_PLUGIN_KIND,
      pluginId: "acme",
      worktreeId: "wt-1",
    });

    findRow("Shell Welcome Tour")!.click();

    expect(dispatch).toHaveBeenCalledWith(
      "help.tour.show",
      { tourId: "acme.shell-intro" },
      expect.anything()
    );
  });

  /** Plays the close Radix runs once the menu is gone, then the next task turn. */
  async function closeMenu(): Promise<Event> {
    const event = new Event("closeAutoFocus", { cancelable: true });
    act(() => menuCloseHook.current?.(event));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return event;
  }

  it.each([
    ["a view panel's generic menu", VIEW_PLUGIN_KIND, false],
    ["a PTY-backed panel's terminal menu", PTY_PLUGIN_KIND, true],
  ] as const)(
    "opens the plugin's settings from %s after focus is back on the pane",
    async (_label, kind, hasPty) => {
      registerPluginKind(kind, { hasPty, hasPluginSettings: true });
      renderMenuFor({
        id: "panel-1",
        title: "Acme",
        kind,
        pluginId: "acme",
        worktreeId: "wt-1",
      });

      findRow("Plugin settings…")!.click();
      expect(dispatch).not.toHaveBeenCalledWith(
        "plugin.openSettings",
        expect.anything(),
        expect.anything()
      );
      const event = await closeMenu();

      // Restoration was left to the primitive, and the settings home opened after.
      expect(event.defaultPrevented).toBe(false);
      expect(dispatch).toHaveBeenCalledWith(
        "plugin.openSettings",
        { pluginId: "acme" },
        expect.anything()
      );
    }
  );

  it("renders Back up data… and the plugin's own items as the shared list does", () => {
    registerPluginKind(VIEW_PLUGIN_KIND, {
      hasPluginDatabases: true,
      hasPluginSettings: true,
      pluginMenu: [{ actionId: "acme.refresh" }, { actionId: "acme.missing" }],
    });
    act(() => publishRegisteredPluginActions([["acme.refresh", "Refresh data"]]));
    renderMenuFor(pluginPanel);

    expect(menuRows()).toEqual(
      sharedRows({
        canMoveToWorktree: false,
        isDockable: panelKindIsDockable(VIEW_PLUGIN_KIND),
        hasPluginDatabases: true,
        hasPluginSettings: true,
        pluginMenuItems: [{ actionId: "acme.refresh", label: "Refresh data" }],
      })
    );
    expect(findRow("Back up data…")).toBeDefined();
  });

  it("dispatches a plugin's own item with the panel it was opened on, after focus is back", async () => {
    registerPluginKind(VIEW_PLUGIN_KIND, { pluginMenu: [{ actionId: "acme.refresh" }] });
    act(() => publishRegisteredPluginActions([["acme.refresh", "Refresh data"]]));
    renderMenuFor(pluginPanel);

    findRow("Refresh data")!.click();
    expect(dispatch).not.toHaveBeenCalledWith("acme.refresh", expect.anything(), expect.anything());
    await closeMenu();

    expect(dispatch).toHaveBeenCalledWith(
      "acme.refresh",
      { panelId: "panel-1" },
      expect.anything()
    );
  });

  it.each([
    ["a view panel's generic menu", VIEW_PLUGIN_KIND, false],
    ["a PTY-backed panel's terminal menu", PTY_PLUGIN_KIND, true],
  ] as const)("backs up the plugin's data from %s", async (_label, kind, hasPty) => {
    registerPluginKind(kind, { hasPty, hasPluginDatabases: true });
    renderMenuFor({ id: "panel-1", title: "Acme", kind, pluginId: "acme", worktreeId: "wt-1" });

    findRow("Back up data…")!.click();
    await closeMenu();

    expect(dispatch).toHaveBeenCalledWith(
      "plugin.backupDatabases",
      { pluginId: "acme" },
      expect.anything()
    );
  });

  it("offers no settings entry for a kind whose plugin has none", () => {
    registerPluginKind(VIEW_PLUGIN_KIND);
    renderMenuFor({ id: "panel-1", title: "Acme", kind: VIEW_PLUGIN_KIND, worktreeId: "wt-1" });
    expect(findRow("Plugin settings…")).toBeUndefined();
  });
});
