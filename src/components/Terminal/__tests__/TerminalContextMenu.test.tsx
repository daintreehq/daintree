// @vitest-environment jsdom
/**
 * TerminalContextMenu with the menu primitives rendered inline, so each test reads
 * which branch the component chose rather than what Radix mounted behind a real
 * right-click. Covers a backgrounded or off-worktree panel, "Open in file browser"
 * on a hovered path (#11483), the fleet's Park/Unpark (#13236) and Snooze
 * (#11783) items, and which rows sit at the top level and which in a submenu
 * (#15526).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import type React from "react";

vi.mock("@/components/ui/context-menu", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Item = ({
    children,
    onSelect,
    disabled,
  }: {
    children?: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <button aria-disabled={disabled || undefined} onClick={() => onSelect?.()}>
      {children}
    </button>
  );
  return {
    ContextMenu: Passthrough,
    ContextMenuTrigger: Passthrough,
    ContextMenuContent: ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="context-menu-content">{children}</div>
    ),
    ContextMenuItem: Item,
    ContextMenuActionItem: Item,
    ContextMenuCheckboxItem: Item,
    ContextMenuRadioGroup: Passthrough,
    ContextMenuRadioItem: Item,
    ContextMenuSeparator: () => <hr />,
    ContextMenuLabel: Passthrough,
    ContextMenuShortcut: Passthrough,
    ContextMenuGroup: Passthrough,
    ContextMenuPortal: Passthrough,
    ContextMenuSub: Passthrough,
    ContextMenuSubContent: ({ children }: { children?: React.ReactNode }) => (
      <div data-submenu>{children}</div>
    ),
    ContextMenuSubTrigger: ({ children }: { children?: React.ReactNode }) => (
      <div data-subtrigger>{children}</div>
    ),
  };
});

const {
  dispatch,
  hoveredUrl,
  hoveredUrlPlugin,
  liveHoveredLink,
  liveSelection,
  openLink,
  hoveredFilePath,
  hoveredFileKind,
  reportFileLinkFailure,
  worktreeList,
  fleetEligible,
  snapshotState,
  panelsById,
  voiceState,
  armed,
  collectEligibleIds,
  watchedIds,
  presetChoices,
  handOverCandidates,
  selectWorktree,
  trackTerminalFocus,
  restoreBackgroundTerminal,
  activateTerminal,
  pingTerminal,
} = vi.hoisted(() => ({
  dispatch: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  hoveredUrl: { current: null as string | null },
  hoveredUrlPlugin: { current: null as string | null },
  liveHoveredLink: { current: null as Record<string, unknown> | null },
  liveSelection: { current: "" },
  openLink: vi.fn(),
  hoveredFilePath: { current: null as string | null },
  hoveredFileKind: { current: "file" as "file" | "directory" | null },
  reportFileLinkFailure: vi.fn(),
  // `name`/`branch` are carried because the "Move to worktree" submenu labels
  // every entry from them and throws on a bare {id, path}.
  worktreeList: {
    current: [] as Array<{ id: string; path: string; name: string; branch?: string }>,
  },
  fleetEligible: { current: false },
  snapshotState: {
    current: null as { runs: Array<Record<string, unknown>>; degraded?: boolean } | null,
  },
  panelsById: { current: {} as Record<string, unknown> },
  voiceState: {
    lockedTarget: null as { panelId: string } | null,
    recentTargets: [] as Array<Record<string, unknown>>,
  },
  armed: {
    armedIds: new Set<string>(),
    armId: vi.fn(),
    armIds: vi.fn(),
    toggleId: vi.fn(),
  },
  collectEligibleIds: vi.fn((): string[] => []),
  watchedIds: { current: new Set<string>() },
  presetChoices: { current: [] as Array<{ id: string; name: string }> },
  handOverCandidates: { current: [] as string[] },
  selectWorktree: vi.fn(),
  trackTerminalFocus: vi.fn(),
  restoreBackgroundTerminal: vi.fn(),
  activateTerminal: vi.fn(),
  pingTerminal: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch, get: () => undefined, list: () => [] },
}));

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    // A live xterm is what unlocks the hovered-path branch; without it
    // `handleContextMenu` bails and clears every hover field.
    get: () => ({
      terminal: { getSelection: () => liveSelection.current },
      hoveredLink: liveHoveredLink.current,
    }),
    getTerminal: () => undefined,
    getSelection: () => "",
    getHoveredLinkText: () => hoveredUrl.current,
    getHoveredLinkPluginName: () => hoveredUrlPlugin.current,
    openLink,
    getHoveredFilePath: () => hoveredFilePath.current,
    getHoveredFileKind: () => (hoveredFilePath.current ? hoveredFileKind.current : null),
    // Reads the live hover, as the real service does: by the time an item is
    // chosen it is already gone.
    openHoveredLink: () =>
      void (liveHoveredLink.current as { activate?: () => void } | null)?.activate?.(),
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

vi.mock("@/services/terminal/FileLinksAddon", () => ({ reportFileLinkFailure }));

vi.mock("@/hooks/useSidebarWorktreeOrder", () => ({
  useSidebarWorktreeOrder: () => worktreeList.current,
}));
vi.mock("@/hooks/useIsHibernated", () => ({ useIsHibernated: () => false }));
vi.mock("@/hooks/usePluginContextMenuItems", () => ({ usePluginContextMenuItems: () => [] }));

vi.mock("@/store/voiceRecordingStore", () => ({
  useVoiceRecordingStore: (selector: (s: unknown) => unknown) => selector(voiceState),
}));

// Fleet eligibility only means "live PTY in a grid location" — it says nothing
// about the terminal being an agent. It gets the fleet items rendered; Park and
// Snooze need the run on the snapshot as well.
vi.mock("@/store/fleetArmingStore", () => ({
  useFleetArmingStore: Object.assign(
    (selector: (s: { armedIds: Set<string> }) => unknown) => selector(armed),
    { getState: () => armed }
  ),
  isFleetArmEligible: () => fleetEligible.current,
  collectEligibleIds,
}));

vi.mock("@/store/fleetSnapshotStore", () => ({
  useFleetSnapshotStore: (selector: (s: { snapshot: unknown }) => unknown) =>
    selector({ snapshot: snapshotState.current }),
}));

vi.mock("@/store/worktreeStore", () => {
  const state = () => ({ activeWorktreeId: "wt-1", selectWorktree, trackTerminalFocus });
  const useWorktreeSelectionStore = (selector: (s: ReturnType<typeof state>) => unknown) =>
    selector(state());
  useWorktreeSelectionStore.getState = state;
  return { useWorktreeSelectionStore };
});

vi.mock("@/store", () => {
  const state = () => ({
    panelsById: panelsById.current,
    maximizeTarget: null,
    getPanelGroup: () => undefined,
    watchedPanels: watchedIds.current,
    restoreBackgroundTerminal,
    activateTerminal,
    pingTerminal,
  });
  // `getState` too, not just the hook: `handleContextMenu` reads the store
  // imperatively to resolve recent dictation targets.
  const usePanelStore = (selector: (s: ReturnType<typeof state>) => unknown) => selector(state());
  usePanelStore.getState = state;
  return { usePanelStore };
});

// The real choices come from the agent's saved presets; these tests only ask
// where the submenu lands when there are some.
vi.mock("@/components/Terminal/restartOnPresetChoices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Terminal/restartOnPresetChoices")>()),
  useRestartPresetChoices: () => presetChoices.current,
}));

vi.mock("@/components/Terminal/TerminalHandOver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Terminal/TerminalHandOver")>()),
  useOrchestratorCandidates: () => ({
    candidateIds: handOverCandidates.current,
    refresh: () => {},
  }),
}));

import { TerminalContextMenu } from "../TerminalContextMenu";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { AGENT_SNOOZE_LABEL } from "@shared/utils/agentSnoozeDurations";
import { load as loadTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";

const agentPanel = {
  id: "panel-1",
  title: "Claude",
  kind: "terminal",
  launchAgentId: "claude",
  worktreeId: "wt-1",
};

function renderMenu(panel: { id: string } & Record<string, unknown> = agentPanel) {
  panelsById.current = { [panel.id]: panel };
  return render(
    <TerminalContextMenu terminalId={panel.id}>
      <div>Panel body</div>
    </TerminalContextMenu>
  );
}

beforeEach(() => {
  fleetEligible.current = false;
  snapshotState.current = null;
});

afterEach(() => {
  cleanup();
  dispatch.mockReset();
  worktreeList.current = [];
});

/**
 * The panel menu opened from a row that stands for a pane the user cannot see:
 * a backgrounded panel (the dock's Background popover) or a pane in another
 * worktree (the dock's Waiting popover). Every item must still act on that
 * panel correctly from there.
 */
const terminal = {
  id: "panel-1",
  title: "npm run storybook",
  kind: "terminal",
  worktreeId: "wt-1",
  hasPty: true,
};

// The service mock never evaluates the real module, so nothing registers it;
// loading caches the mock for the synchronous peek() call sites.
beforeAll(async () => {
  await loadTerminalService();
});

describe("TerminalContextMenu — a backgrounded panel", () => {
  beforeEach(() => {
    worktreeList.current = [
      { id: "wt-1", name: "one", path: "/one", branch: "one" },
      { id: "wt-2", name: "two", path: "/two", branch: "two" },
    ];
  });

  afterEach(() => {
    restoreBackgroundTerminal.mockReset();
    activateTerminal.mockReset();
    pingTerminal.mockReset();
    selectWorktree.mockReset();
    trackTerminalFocus.mockReset();
  });

  it("offers its way back instead of moves that would strand its background bookkeeping", () => {
    renderMenu({ ...terminal, location: "background" });

    expect(screen.queryByText("Send to background")).toBeNull();
    expect(screen.queryByText("Move to grid")).toBeNull();
    expect(screen.queryByText("Move to dock")).toBeNull();
    expect(screen.queryByText("Move to worktree")).toBeNull();

    fireEvent.click(screen.getByText("Restore from background"));
    expect(restoreBackgroundTerminal).toHaveBeenCalledWith("panel-1");
    expect(dispatch).not.toHaveBeenCalledWith(
      "terminal.moveToGrid",
      expect.anything(),
      expect.anything()
    );
  });

  it("restores like the row's own Restore: to the pane's worktree, focused", () => {
    renderMenu({ ...terminal, location: "background", worktreeId: "wt-2" });
    fireEvent.click(screen.getByText("Restore from background"));
    expect(selectWorktree).toHaveBeenCalledWith("wt-2");
    expect(trackTerminalFocus).toHaveBeenCalledWith("wt-2", "panel-1");
    expect(restoreBackgroundTerminal).toHaveBeenCalledWith("panel-1");
    expect(activateTerminal).toHaveBeenCalledWith("panel-1");
  });

  it("keeps the ordinary layout items for a panel that is not backgrounded", () => {
    renderMenu({ ...terminal, location: "grid" });
    expect(screen.queryByText("Restore from background")).toBeNull();
    expect(screen.getByText("Send to background")).toBeTruthy();
    expect(screen.getByText("Move to dock")).toBeTruthy();
  });
});

describe("TerminalContextMenu — a pane in another worktree", () => {
  beforeEach(() => {
    worktreeList.current = [
      { id: "wt-1", name: "one", path: "/one", branch: "one" },
      { id: "wt-2", name: "two", path: "/two", branch: "two" },
    ];
  });

  it("does not offer to maximize a pane the grid in front of the user is not showing", () => {
    renderMenu({ ...terminal, location: "grid", worktreeId: "wt-2" });
    expect(screen.queryByText("Maximize")).toBeNull();
  });

  it("offers maximize for the same pane in the active worktree", () => {
    renderMenu({ ...terminal, location: "grid", worktreeId: "wt-1" });
    expect(screen.getByText("Maximize")).toBeTruthy();
  });
});

/**
 * "Open in file browser" on a hovered terminal file path (#11483).
 *
 * Left-clicking a directory link already opened the file browser, but the
 * right-click menu only offered the OS file manager. The contract under test is
 * the argument translation: the menu holds an *absolute* path while
 * `worktree.openFileBrowser` wants a worktree id plus a worktree-*relative*
 * path, and the worktree has to come from the live list rather than the
 * panel's stamped `worktreeId` (#11276).
 */
const LABEL = "Open in file browser";

function worktree(id: string, path: string) {
  return { id, path, name: id, branch: id };
}

function openMenu(options: {
  hovered: string | null;
  kind?: "file" | "directory";
  worktrees?: Array<{ id: string; path: string; name: string }>;
  panelWorktreeId?: string;
}) {
  hoveredFilePath.current = options.hovered;
  hoveredFileKind.current = options.kind ?? "file";
  worktreeList.current = options.worktrees ?? [];
  panelsById.current = {
    "panel-1": {
      id: "panel-1",
      title: "Agent",
      kind: "terminal",
      worktreeId: options.panelWorktreeId ?? "wt-1",
      cwd: "/repo",
    },
  };
  const result = render(
    <TerminalContextMenu terminalId="panel-1">
      <div>Panel body</div>
    </TerminalContextMenu>
  );
  // Populates the hover fields the way a real right-click does.
  act(() => {
    result.container
      .querySelector('[data-context-trigger="panel-1"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });
  return result;
}

describe("TerminalContextMenu — open in file browser (#11483)", () => {
  afterEach(() => {
    reportFileLinkFailure.mockReset();
    hoveredFilePath.current = null;
    hoveredFileKind.current = "file";
  });

  it("dispatches the containing worktree with a relative path and a file reveal kind", async () => {
    dispatch.mockResolvedValue({ ok: true, result: undefined });
    openMenu({ hovered: "/repo/src/index.ts", worktrees: [worktree("wt-1", "/repo")] });

    await act(async () => {
      screen.getByText(LABEL).click();
    });

    expect(dispatch).toHaveBeenCalledWith(
      "worktree.openFileBrowser",
      { worktreeId: "wt-1", revealPath: "src/index.ts", revealKind: "file" },
      { source: "user" }
    );
  });

  // The panel's stamped worktreeId names whichever worktree was active when the
  // terminal was created, which need not be the one the path lives in (#11276).
  it("resolves against the live worktree list, not the panel's stamped id", async () => {
    dispatch.mockResolvedValue({ ok: true, result: undefined });
    openMenu({
      hovered: "/repo/src/index.ts",
      worktrees: [worktree("wt-stamped", "/other"), worktree("wt-real", "/repo")],
      panelWorktreeId: "wt-stamped",
    });

    await act(async () => {
      screen.getByText(LABEL).click();
    });

    expect(dispatch).toHaveBeenCalledWith(
      "worktree.openFileBrowser",
      expect.objectContaining({ worktreeId: "wt-real" }),
      { source: "user" }
    );
  });

  it("opens the deepest worktree when one is nested inside another", async () => {
    dispatch.mockResolvedValue({ ok: true, result: undefined });
    openMenu({
      hovered: "/repo/nested/src/a.ts",
      worktrees: [worktree("wt-outer", "/repo"), worktree("wt-inner", "/repo/nested")],
    });

    await act(async () => {
      screen.getByText(LABEL).click();
    });

    expect(dispatch).toHaveBeenCalledWith(
      "worktree.openFileBrowser",
      { worktreeId: "wt-inner", revealPath: "src/a.ts", revealKind: "file" },
      { source: "user" }
    );
  });

  // The file browser is worktree-scoped, so an uncontained path has nothing to
  // open — the item is hidden rather than dispatching a silent no-op.
  it("hides the item for a path in no known worktree, keeping the OS reveal", () => {
    openMenu({ hovered: "/elsewhere/a.ts", worktrees: [worktree("wt-1", "/repo")] });

    expect(screen.queryByText(LABEL)).toBeNull();
    expect(screen.queryByText(/Reveal in Finder|Show in Explorer|Show in folder/)).toBeTruthy();
  });

  // A sibling root that merely extends the worktree name is not inside it; a
  // raw startsWith would open /repo at the mangled path "-other/src/a.ts".
  it("hides the item for a sibling directory sharing the root prefix", () => {
    openMenu({ hovered: "/repo-other/src/a.ts", worktrees: [worktree("wt-1", "/repo")] });

    expect(screen.queryByText(LABEL)).toBeNull();
  });

  it("offers nothing when no path is hovered", () => {
    openMenu({ hovered: null, worktrees: [worktree("wt-1", "/repo")] });

    expect(screen.queryByText(LABEL)).toBeNull();
  });

  // The worktree root itself resolves to an empty relative path, which must be
  // dropped rather than sent as "" — the action treats "" as "reveal nothing".
  it("omits revealPath when the hovered path is the worktree root", async () => {
    dispatch.mockResolvedValue({ ok: true, result: undefined });
    openMenu({ hovered: "/repo", worktrees: [worktree("wt-1", "/repo")] });

    await act(async () => {
      screen.getByText(LABEL).click();
    });

    expect(dispatch).toHaveBeenCalledWith(
      "worktree.openFileBrowser",
      { worktreeId: "wt-1", revealPath: undefined, revealKind: "file" },
      { source: "user" }
    );
  });

  // dispatch() resolves an ActionDispatchResult and never rejects, so a failure
  // vanishes entirely unless the result is inspected.
  it("reports a failed dispatch through the file-link failure channel", async () => {
    dispatch.mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "gone", details: "worktree removed" },
    });
    openMenu({ hovered: "/repo/src/index.ts", worktrees: [worktree("wt-1", "/repo")] });

    await act(async () => {
      screen.getByText(LABEL).click();
    });

    // The reason string is diagnostic copy; what matters is that the failure
    // reached the channel carrying the real details and the offending path.
    expect(reportFileLinkFailure).toHaveBeenCalledWith(
      expect.any(String),
      "worktree removed",
      "/repo/src/index.ts",
      "file"
    );
  });

  // The failure copy is subject-aware, so a folder that fails to open must not
  // be reported as a file the way the default argument would have it.
  it("reports a failed directory dispatch as a folder", async () => {
    dispatch.mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "gone", details: "worktree removed" },
    });
    openMenu({
      hovered: "/repo/src/components",
      kind: "directory",
      worktrees: [worktree("wt-1", "/repo")],
    });

    await act(async () => {
      screen.getByText(LABEL).click();
    });

    expect(reportFileLinkFailure).toHaveBeenCalledWith(
      expect.any(String),
      "worktree removed",
      "/repo/src/components",
      "folder"
    );
  });

  // A directory is expanded as well as selected, so the hovered link's kind has
  // to survive the trip — guessing "file" leaves a right-clicked folder
  // collapsed while left-clicking the very same link opens it.
  it("passes a directory reveal kind through for a hovered directory link", async () => {
    dispatch.mockResolvedValue({ ok: true, result: undefined });
    openMenu({
      hovered: "/repo/src/components",
      kind: "directory",
      worktrees: [worktree("wt-1", "/repo")],
    });

    await act(async () => {
      screen.getByText(LABEL).click();
    });

    expect(dispatch).toHaveBeenCalledWith(
      "worktree.openFileBrowser",
      { worktreeId: "wt-1", revealPath: "src/components", revealKind: "directory" },
      { source: "user" }
    );
  });
});

/**
 * Open link on a hovered link (#14960). The hover ends as the pointer leaves
 * the terminal for the menu, so the item has to open the link the menu was
 * opened on, not whatever is under the pointer when it is chosen.
 */
describe("TerminalContextMenu — clean copy (#15525)", () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  });

  afterEach(() => {
    liveSelection.current = "";
  });

  function rowAfterCopy(): HTMLElement {
    const copy = screen.getByText("Copy").closest("button")!;
    return copy.nextElementSibling as HTMLElement;
  }

  it("sits right after Copy and copies the selection cleaned", async () => {
    liveSelection.current = "⏺ Release notes:   \n  - Added a clean copy\n    - next to Copy";
    openMenu({ hovered: null });
    const row = rowAfterCopy();
    expect(row.textContent).toBe("Copy clean text");
    expect(row.getAttribute("aria-disabled")).toBeNull();

    await act(async () => row.click());

    expect(writeText).toHaveBeenCalledWith("Release notes:\n- Added a clean copy\n  - next to Copy");
    expect(dispatch).not.toHaveBeenCalledWith("terminal.copy", expect.anything(), expect.anything());
  });

  it("leaves Copy verbatim", async () => {
    liveSelection.current = "  - Added a clean copy   ";
    openMenu({ hovered: null });
    await act(async () => screen.getByText("Copy").click());
    expect(dispatch).toHaveBeenCalledWith(
      "terminal.copy",
      { terminalId: "panel-1" },
      expect.anything()
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it("is disabled with Copy when nothing is selected", () => {
    openMenu({ hovered: null });
    expect(screen.getByText("Copy").closest("button")!.getAttribute("aria-disabled")).toBe("true");
    expect(rowAfterCopy().getAttribute("aria-disabled")).toBe("true");
  });
});

describe("TerminalContextMenu — Open link after the hover ends (#14960)", () => {
  const URL_TEXT = "https://example.com/docs";

  function link(text: string, kind: "url" | "file" | "directory" = "url") {
    return {
      kind,
      text,
      range: {},
      activate: vi.fn<(event: MouseEvent, text: string) => unknown>(),
    };
  }

  function hover(target: ReturnType<typeof link> | null) {
    liveHoveredLink.current = target;
    hoveredUrl.current = target?.text ?? null;
  }

  afterEach(() => {
    hover(null);
    hoveredFilePath.current = null;
    hoveredFileKind.current = "file";
    reportFileLinkFailure.mockReset();
  });

  it("opens the link the menu was opened on once the pointer has left it", async () => {
    const opened = link(URL_TEXT);
    hover(opened);
    openMenu({ hovered: null });
    hover(null);

    await act(async () => screen.getByText("Open link").click());

    expect(opened.activate).toHaveBeenCalledTimes(1);
    const [event, text] = opened.activate.mock.calls[0]!;
    expect(text).toBe(URL_TEXT);
    expect(event).toBeInstanceOf(MouseEvent);
    expect(event.metaKey || event.ctrlKey).toBe(false);
  });

  it("opens the link it was opened on, not another one the pointer crossed", async () => {
    const opened = link(URL_TEXT);
    const crossed = link("https://example.com/other");
    hover(opened);
    openMenu({ hovered: null });
    hover(crossed);

    await act(async () => screen.getByText("Open link").click());

    expect(opened.activate).toHaveBeenCalledTimes(1);
    expect(crossed.activate).not.toHaveBeenCalled();
  });

  it("opens a file link through its own activation", async () => {
    const opened = link("./src/main.ts:12", "file");
    hover(opened);
    openMenu({ hovered: "/repo/src/main.ts" });
    hover(null);

    await act(async () => screen.getByText("Open link").click());

    expect(opened.activate).toHaveBeenCalledTimes(1);
    expect(opened.activate.mock.calls[0]![1]).toBe("./src/main.ts:12");
  });

  it("follows the link under the pointer at each opening", async () => {
    const first = link(URL_TEXT);
    const second = link("https://example.com/second");
    hover(first);
    const { container } = openMenu({ hovered: null });
    hover(second);
    act(() => {
      container
        .querySelector('[data-context-trigger="panel-1"]')!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    hover(null);

    await act(async () => screen.getByText("Open link").click());

    expect(second.activate).toHaveBeenCalledTimes(1);
    expect(first.activate).not.toHaveBeenCalled();
  });

  it.each([
    [
      "rejects",
      (activate: ReturnType<typeof link>["activate"], failure: Error) =>
        activate.mockRejectedValue(failure),
    ],
    [
      "throws",
      (activate: ReturnType<typeof link>["activate"], failure: Error) =>
        activate.mockImplementation(() => {
          throw failure;
        }),
    ],
  ])("reports a link whose activation %s instead of dropping it", async (_how, fail) => {
    const failure = new Error("no handler");
    const opened = link(URL_TEXT);
    fail(opened.activate, failure);
    hover(opened);
    openMenu({ hovered: null });
    hover(null);

    await act(async () => screen.getByText("Open link").click());

    expect(reportFileLinkFailure).toHaveBeenCalledWith(expect.any(String), failure, URL_TEXT);
  });

  it("does nothing for a menu that was opened without a link behind its URL", async () => {
    hoveredUrl.current = URL_TEXT;
    openMenu({ hovered: null });

    await act(async () => screen.getByText("Open link").click());

    expect(reportFileLinkFailure).not.toHaveBeenCalled();
  });

  it("does not carry a link into a touch or pen opening, which captures no hover", () => {
    const earlier = link(URL_TEXT);
    hover(earlier);
    const { container } = openMenu({ hovered: null });
    expect(screen.getByText("Open link")).toBeTruthy();

    act(() => {
      container
        .querySelector('[data-context-trigger="panel-1"]')!
        .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    });

    expect(screen.queryByText("Open link")).toBeNull();
  });
});

/**
 * Park… and Unpark on an agent terminal's menu (#13236). Both read the fleet
 * snapshot: Park… needs the run on it (main rejects an id it can't see), and
 * Unpark needs a park on the row to lift.
 */
const parkRun = vi.fn(() => Promise.resolve({ parkedAt: 0 }));
const unparkRun = vi.fn(() => Promise.resolve(true));

describe("TerminalContextMenu — a URL a plugin claims (#13798)", () => {
  const URL_TEXT = "https://records.example.com/r/42";

  afterEach(() => {
    hoveredUrl.current = null;
    hoveredUrlPlugin.current = null;
    openLink.mockReset();
  });

  it("names the plugin and still offers the external browser, for the URL captured on open", () => {
    hoveredUrl.current = URL_TEXT;
    hoveredUrlPlugin.current = "Acme Records";
    openMenu({ hovered: null });
    // The hover ends once the pointer reaches the menu.
    hoveredUrl.current = null;

    act(() => screen.getByText("Open in external browser").click());
    expect(openLink).toHaveBeenLastCalledWith("panel-1", URL_TEXT, { external: true });

    act(() => screen.getByText("Open with Acme Records").click());
    expect(openLink).toHaveBeenLastCalledWith("panel-1", URL_TEXT);
    expect(screen.queryByText("Open link")).toBeNull();
  });

  it("keeps the plain Open link item for a URL no plugin claims", () => {
    hoveredUrl.current = URL_TEXT;
    openMenu({ hovered: null });
    expect(screen.getByText("Open link")).toBeTruthy();
    expect(screen.queryByText("Open in external browser")).toBeNull();
  });
});

describe("TerminalContextMenu — Park and Unpark", () => {
  beforeEach(() => {
    fleetEligible.current = true;
    snapshotState.current = { runs: [{ runId: "panel-1" }] };
    Object.defineProperty(window, "electron", {
      value: { fleet: { parkRun, unparkRun } },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    parkRun.mockClear();
    unparkRun.mockClear();
  });

  it("withholds Park… when the fleet has no row for this panel", () => {
    snapshotState.current = { runs: [{ runId: "panel-2" }] };
    renderMenu();

    expect(screen.queryByText("Park…")).toBeNull();
  });

  it("withholds Park… before any snapshot has landed", () => {
    snapshotState.current = null;
    renderMenu();

    expect(screen.queryByText("Park…")).toBeNull();
  });

  it("offers Park… for a run the fleet can see, without parking on the spot", () => {
    renderMenu();
    fireEvent.click(screen.getByText("Park…"));

    // The note and release live in the dialog the item opens.
    expect(parkRun).not.toHaveBeenCalled();
  });

  it("hides Unpark while the run is not parked", () => {
    renderMenu();

    expect(screen.queryByText("Unpark")).toBeNull();
  });

  it("does not offer Unpark for a park belonging to a different run", () => {
    snapshotState.current = {
      runs: [{ runId: "panel-1" }, { runId: "panel-2", park: { parkedAt: 1 } }],
    };
    renderMenu();

    expect(screen.queryByText("Unpark")).toBeNull();
  });

  it("keeps Park… beside Unpark on a parked run, so the park can be edited", () => {
    snapshotState.current = { runs: [{ runId: "panel-1", park: { parkedAt: 1 } }] };
    renderMenu();

    expect(screen.getByText("Park…")).toBeTruthy();
    expect(screen.getByText("Unpark")).toBeTruthy();
  });

  it("lifts the park for this run directly when Unpark is chosen", () => {
    snapshotState.current = { runs: [{ runId: "panel-1", park: { parkedAt: 1 } }] };
    renderMenu();
    fireEvent.click(screen.getByText("Unpark"));

    expect(unparkRun).toHaveBeenCalledWith("panel-1");
  });
  it("withholds Park… over a degraded snapshot but keeps Unpark", () => {
    // Main rejects a park against retained data; an unpark needs no current view.
    snapshotState.current = { runs: [{ runId: "panel-1", park: { parkedAt: 1 } }], degraded: true };
    renderMenu();

    expect(screen.queryByText("Park…")).toBeNull();
    expect(screen.getByText("Unpark")).toBeTruthy();
  });

  it("offers parking on an agent the fleet can't broadcast to (docked, exited)", () => {
    fleetEligible.current = false;
    snapshotState.current = { runs: [{ runId: "panel-1", park: { parkedAt: 1 } }] };
    renderMenu();

    expect(screen.getByText("Park…")).toBeTruthy();
    expect(screen.getByText("Unpark")).toBeTruthy();
    expect(screen.queryByText("Snooze")).toBeNull();
  });
});

/**
 * Covers the three things the component decides that nothing else can: whether
 * the submenu is offered at all, which durations it lists, and whether "Wake
 * now" is present. The first and last both read the fleet snapshot, so this is
 * the one place the "presence on the snapshot" contract is consumed rather than
 * produced — for membership (main rejects an id it can't see) and for snooze
 * state (main strips expired records before they ship).
 */
const snoozeRun = vi.fn(() => Promise.resolve({ snoozedAt: 0 }));
const unsnoozeRun = vi.fn(() => Promise.resolve(true));

describe("TerminalContextMenu — Snooze submenu (#11783)", () => {
  beforeEach(() => {
    fleetEligible.current = true;
    // The fleet can see this run, which is what makes it snoozable at all.
    snapshotState.current = { runs: [{ runId: "panel-1" }] };
    Object.defineProperty(window, "electron", {
      value: { fleet: { snoozeRun, unsnoozeRun } },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    snoozeRun.mockClear();
    unsnoozeRun.mockClear();
  });

  it("withholds the submenu when the fleet has no row for this panel", () => {
    // Fleet eligibility is satisfied (a plain shell terminal clears it), but
    // main rejects a snooze for an id the snapshot cannot see and the rejection
    // never reaches the user — so the offer must not be made in the first place.
    snapshotState.current = { runs: [{ runId: "panel-2" }] };
    renderMenu();

    expect(screen.queryByText("Snooze")).toBeNull();
    for (const label of Object.values(AGENT_SNOOZE_LABEL)) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("withholds the submenu before any snapshot has landed", () => {
    // Null is "nothing reported yet", not "fleet is empty" — either way there
    // is no row to validate against, so the menu waits.
    snapshotState.current = null;
    renderMenu();

    expect(screen.queryByText("Snooze")).toBeNull();
  });

  it("offers every duration on the ladder", () => {
    renderMenu();

    for (const label of Object.values(AGENT_SNOOZE_LABEL)) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("names the release condition on the unlimited option", () => {
    // The one option whose behaviour isn't obvious from a bare label — without
    // this it reads as "never".
    renderMenu();

    expect(screen.getByText(/until I interact/i)).toBeTruthy();
  });

  it("sends the picked duration to main rather than a resolved timestamp", () => {
    // Main owns expiry; a renderer-computed wake time would be a second clock.
    renderMenu();
    fireEvent.click(screen.getByText(AGENT_SNOOZE_LABEL["30m"]));

    expect(snoozeRun).toHaveBeenCalledWith("panel-1", "30m");
  });

  it("passes the unlimited option through unresolved", () => {
    renderMenu();
    fireEvent.click(screen.getByText(AGENT_SNOOZE_LABEL.unlimited));

    expect(snoozeRun).toHaveBeenCalledWith("panel-1", "unlimited");
  });

  it("hides Wake now while the run is not snoozed", () => {
    renderMenu();

    expect(screen.queryByText("Wake now")).toBeNull();
  });

  it("offers Wake now once the snapshot carries a snooze for this run", () => {
    // Presence on the row IS "currently snoozed" — main strips expired records
    // before they ship, so the menu never checks a clock.
    snapshotState.current = { runs: [{ runId: "panel-1", snooze: { snoozedAt: 1 } }] };
    renderMenu();

    expect(screen.getByText("Wake now")).toBeTruthy();
  });

  it("does not offer Wake now for a snooze belonging to a different run", () => {
    snapshotState.current = {
      runs: [{ runId: "panel-1" }, { runId: "panel-2", snooze: { snoozedAt: 1 } }],
    };
    renderMenu();

    expect(screen.queryByText("Wake now")).toBeNull();
  });

  it("lifts the snooze for this run when Wake now is chosen", () => {
    snapshotState.current = { runs: [{ runId: "panel-1", snooze: { snoozedAt: 1 } }] };
    renderMenu();
    fireEvent.click(screen.getByText("Wake now"));

    expect(unsnoozeRun).toHaveBeenCalledWith("panel-1");
  });
});

describe("TerminalContextMenu — dictation lock and recent targets (#14955)", () => {
  afterEach(() => {
    voiceState.lockedTarget = null;
    voiceState.recentTargets = [];
    armed.armedIds = new Set();
    useTerminalInputStore.setState({ hybridInputEnabled: true });
  });

  function openOn(panel: { id: string } & Record<string, unknown>, others: object[] = []) {
    panelsById.current = Object.fromEntries(
      [panel, ...others].map((p) => [(p as { id: string }).id, p])
    );
    const result = render(
      <TerminalContextMenu terminalId={panel.id}>
        <div>Panel body</div>
      </TerminalContextMenu>
    );
    act(() => {
      result.container
        .querySelector(`[data-context-trigger="${panel.id}"]`)!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    return result;
  }

  const shell = { id: "shell-1", title: "zsh", kind: "terminal", worktreeId: "wt-1" };

  it("offers the lock on a pane with a composer", () => {
    openOn(agentPanel);
    expect(screen.queryByText("Lock dictation to this panel")).not.toBeNull();
  });

  it.each([
    ["a plain shell", shell],
    ["an agent pane whose agent exited", { ...agentPanel, agentState: "exited" }],
  ])("doesn't offer the lock on %s", (_n, panel) => {
    openOn(panel);
    expect(screen.queryByText("Lock dictation to this panel")).toBeNull();
    expect(screen.queryByText("Unlock dictation")).toBeNull();
  });

  it("doesn't offer the lock on an agent pane while hybrid input is off", () => {
    useTerminalInputStore.setState({ hybridInputEnabled: false });
    openOn(agentPanel);
    expect(screen.queryByText("Lock dictation to this panel")).toBeNull();
  });

  it("still offers Unlock on a locked pane that has lost its composer", () => {
    voiceState.lockedTarget = { panelId: "shell-1" };
    openOn(shell);
    fireEvent.click(screen.getByText("Unlock dictation"));
    expect(dispatch).toHaveBeenCalledWith("voiceInput.unlockTarget", undefined, expect.anything());
  });

  it("lists only recent targets with a composer, matching a saved title to one that has", () => {
    const otherAgent = { id: "agent-2", title: "Codex", kind: "terminal", launchAgentId: "codex" };
    const twinShell = { id: "twin-shell", title: "Twin", kind: "terminal", worktreeId: "wt-1" };
    const twinAgent = { ...twinShell, id: "twin-agent", launchAgentId: "claude" };
    voiceState.recentTargets = [
      { panelId: "agent-2", panelTitle: "Codex" },
      { panelId: "shell-2", panelTitle: "Bash" },
      { worktreeId: "wt-1", panelTitle: "Twin" },
    ];
    openOn(agentPanel, [
      otherAgent,
      { id: "shell-2", title: "Bash", kind: "terminal" },
      twinShell,
      twinAgent,
    ]);

    expect(screen.queryByText("Codex")).not.toBeNull();
    expect(screen.queryByText("Bash")).toBeNull();
    fireEvent.click(screen.getByText("Twin"));
    expect(dispatch).toHaveBeenCalledWith(
      "voiceInput.recallRecentTarget",
      { panelId: "twin-agent" },
      expect.anything()
    );
  });

  it("offers the lock on a plain shell armed in a fleet of two, and not on one left out", () => {
    armed.armedIds = new Set(["shell-1", "agent-2"]);
    openOn(shell);
    expect(screen.queryByText("Lock dictation to this panel")).not.toBeNull();
    cleanup();

    armed.armedIds = new Set(["agent-2", "agent-3"]);
    openOn(shell);
    expect(screen.queryByText("Lock dictation to this panel")).toBeNull();
  });

  it("lists a recent shell target only while it is armed in the fleet", () => {
    const fleetShell = { id: "shell-2", title: "Bash", kind: "terminal" };
    voiceState.recentTargets = [{ panelId: "shell-2", panelTitle: "Bash" }];

    armed.armedIds = new Set(["shell-2", "panel-1"]);
    openOn(agentPanel, [fleetShell]);
    expect(screen.queryByText("Bash")).not.toBeNull();
    cleanup();

    armed.armedIds = new Set(["panel-1", "agent-3"]);
    openOn(agentPanel, [fleetShell]);
    expect(screen.queryByText("Bash")).toBeNull();
  });
});

type MenuRow = string | { submenu: string; rows: MenuRow[] };

/** The menu as drawn: its rows in order, each submenu's own rows under its trigger. */
function menuTree(root: Element = screen.getByTestId("context-menu-content")): MenuRow[] {
  const rows: MenuRow[] = [];
  for (const child of Array.from(root.children)) {
    if (child.tagName === "HR") rows.push("---");
    else if (child.tagName === "BUTTON") rows.push(child.textContent!.trim());
    else if (child.hasAttribute("data-subtrigger")) {
      rows.push({ submenu: child.textContent!.trim(), rows: menuTree(child.nextElementSibling!) });
    } else if (child.hasAttribute("data-submenu")) {
      if (!child.previousElementSibling?.hasAttribute("data-subtrigger")) {
        throw new Error("submenu content without its trigger");
      }
    } else rows.push(...menuTree(child));
  }
  return rows;
}

/** One level's rows, a submenu standing for itself by its label. */
function level(rows: MenuRow[]): string[] {
  return rows.map((row) => (typeof row === "string" ? row : `${row.submenu} ›`));
}

function submenu(rows: MenuRow[], label: string): MenuRow[] {
  const found = rows.find((row) => typeof row !== "string" && row.submenu === label);
  if (!found || typeof found === "string") throw new Error(`no ${label} submenu`);
  return found.rows;
}

/** Every level starts and ends on a row, never doubles a separator, and no submenu is empty. */
function expectTidy(rows: MenuRow[], path = "root"): void {
  const labels = level(rows);
  expect(labels.length, `${path} has rows`).toBeGreaterThan(0);
  expect(labels[0], `${path} leads with a row`).not.toBe("---");
  expect(labels.at(-1), `${path} ends on a row`).not.toBe("---");
  labels.forEach((label, i) => {
    if (label === "---") expect(labels[i + 1], `${path} doubles a separator`).not.toBe("---");
  });
  for (const row of rows) {
    if (typeof row !== "string") expectTidy(row.rows, `${path} › ${row.submenu}`);
  }
}

describe("TerminalContextMenu — grouped into submenus (#15526)", () => {
  const agentPane = {
    ...agentPanel,
    detectedAgentId: "claude",
    location: "grid",
    hasPty: true,
  };

  beforeEach(() => {
    worktreeList.current = [
      { id: "wt-1", name: "one", path: "/one", branch: "one" },
      { id: "wt-2", name: "two", path: "/two", branch: "two" },
    ];
  });

  afterEach(() => {
    watchedIds.current.clear();
    armed.armedIds = new Set();
    presetChoices.current = [];
    handOverCandidates.current = [];
    voiceState.recentTargets = [];
    armed.armIds.mockClear();
    armed.toggleId.mockClear();
    collectEligibleIds.mockClear();
  });

  it("keeps an agent pane's top level short, with everyday rows a click away", () => {
    fleetEligible.current = true;
    snapshotState.current = { runs: [{ runId: "panel-1", handBack: {} }] };
    renderMenu(agentPane);

    const tree = menuTree();
    expect(level(tree)).toEqual([
      "Copy",
      "Paste",
      "Send to agent",
      "---",
      "Watch terminal",
      "Fleet ›",
      "---",
      "Move ›",
      "Maximize",
      "---",
      "Restart terminal",
      "Session ›",
      "---",
      "Rename terminal",
      "Duplicate terminal",
      "View terminal info",
      "---",
      "Trash terminal",
      "Kill terminal",
    ]);
    expect(level(submenu(tree, "Fleet"))).toEqual([
      "Add to fleet",
      "Arm all in this worktree",
      "---",
      "Snooze ›",
      "Park…",
      "Mark as read",
    ]);
    expect(level(submenu(tree, "Move"))).toEqual([
      "Move to worktree ›",
      "Move to new worktree…",
      "Move to dock",
      "---",
      "Send to background",
    ]);
    expect(level(submenu(tree, "Session"))).toEqual([
      "Redraw terminal",
      "---",
      "Lock input",
      "Lock dictation to this panel",
    ]);
    expectTidy(tree);
  });

  it("keeps everything a session can offer under Session", () => {
    presetChoices.current = [{ id: "work", name: "Work" }];
    handOverCandidates.current = ["orchestrator-1"];
    voiceState.recentTargets = [{ panelId: "agent-2", panelTitle: "Codex" }];
    panelsById.current = {
      "panel-1": agentPane,
      "agent-2": { id: "agent-2", title: "Codex", kind: "terminal", launchAgentId: "codex" },
      "orchestrator-1": { id: "orchestrator-1", title: "Lead", kind: "terminal" },
    };
    const { container } = render(
      <TerminalContextMenu terminalId="panel-1">
        <div>Panel body</div>
      </TerminalContextMenu>
    );
    // Recent targets are resolved by the right-click itself.
    act(() => {
      container
        .querySelector('[data-context-trigger="panel-1"]')!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });

    const tree = menuTree();
    expect(level(submenu(tree, "Session"))).toEqual([
      "Redraw terminal",
      "Restart on preset ›",
      "---",
      "Lock input",
      "Lock dictation to this panel",
      "Recent dictation targets ›",
      "Hand to orchestrator ›",
    ]);
    expect(level(tree)).not.toContain("Restart on preset ›");
    expect(level(tree)).not.toContain("Hand to orchestrator ›");
    expectTidy(tree);
  });

  it.each([
    ["an agent the user is watching", "Cancel watch", "Watch terminal"],
    ["an agent nobody is watching", "Watch terminal", "Cancel watch"],
  ])("draws the watch toggle for %s at the top level", (_name, shown, hidden) => {
    fleetEligible.current = true;
    if (shown === "Cancel watch") watchedIds.current.add("panel-1");
    renderMenu(agentPane);

    const root = level(menuTree());
    expect(root.indexOf(shown)).toBe(root.indexOf("Fleet ›") - 1);
    expect(root).not.toContain(hidden);
  });

  it("runs the watch and fleet rows from where they now sit", () => {
    fleetEligible.current = true;
    armed.armedIds = new Set(["panel-1", "panel-2"]);
    collectEligibleIds.mockReturnValueOnce(["panel-1", "panel-3"]);
    renderMenu(agentPane);

    fireEvent.click(screen.getByText("Watch terminal"));
    expect(dispatch).toHaveBeenCalledWith(
      "terminal.watch",
      { terminalId: "panel-1" },
      expect.anything()
    );
    fireEvent.click(screen.getByText("Remove from fleet"));
    expect(armed.toggleId).toHaveBeenCalledWith("panel-1");
    fireEvent.click(screen.getByText("Arm all in this worktree"));
    expect(collectEligibleIds).toHaveBeenCalledWith("current", "wt-1");
    expect(armed.armIds).toHaveBeenCalledWith(["panel-1", "panel-3"]);
    fireEvent.click(screen.getByText("Clear fleet"));
    expect(dispatch).toHaveBeenCalledWith("terminal.disarmAll", undefined, expect.anything());
  });

  it.each([
    ["alone", ["panel-1"], ["Remove from fleet", "Arm all in this worktree"]],
    [
      "in a fleet of two",
      ["panel-1", "panel-2"],
      ["Remove from fleet", "Arm all in this worktree", "Clear fleet"],
    ],
  ])("lists an armed pane's membership rows %s", (_name, armedIds, rows) => {
    fleetEligible.current = true;
    armed.armedIds = new Set(armedIds);
    renderMenu(agentPane);

    expect(level(submenu(menuTree(), "Fleet"))).toEqual(rows);
  });

  it.each([
    ["unseen", {}, "Mark as read", "markRunRead"],
    ["seen", { seenAt: 1 }, "Mark as unread", "markRunUnread"],
  ] as const)("toggles an %s hand-back from inside Fleet", (_name, handBack, label, call) => {
    const fleet = {
      markRunRead: vi.fn(() => Promise.resolve()),
      markRunUnread: vi.fn(() => Promise.resolve()),
    };
    Object.defineProperty(window, "electron", {
      value: { fleet },
      writable: true,
      configurable: true,
    });
    fleetEligible.current = true;
    snapshotState.current = { runs: [{ runId: "panel-1", handBack }] };
    renderMenu(agentPane);

    expect(level(submenu(menuTree(), "Fleet")).at(-1)).toBe(label);
    fireEvent.click(screen.getByText(label));
    expect(fleet[call]).toHaveBeenCalledWith("panel-1");
  });

  it("still dispatches a row from inside a submenu", () => {
    renderMenu(agentPane);
    fireEvent.click(screen.getByText("Lock input"));

    expect(dispatch).toHaveBeenCalledWith(
      "terminal.toggleInputLock",
      { terminalId: "panel-1" },
      expect.anything()
    );
  });

  it("puts a paused session's Force resume beside Restart, not inside Session", () => {
    renderMenu({ ...agentPane, flowStatus: "paused-backpressure" });

    const root = level(menuTree());
    expect(root.indexOf("Force resume (paused)")).toBe(root.indexOf("Restart terminal") + 1);
  });

  it("gives a backgrounded pane its way back inline, with no Move submenu", () => {
    renderMenu({ ...agentPane, location: "background" });

    const tree = menuTree();
    expect(level(tree)).toContain("Restore from background");
    expect(level(tree)).not.toContain("Move ›");
    expectTidy(tree);
  });

  it("keeps Park under Fleet on an agent the fleet can't broadcast to", () => {
    snapshotState.current = { runs: [{ runId: "panel-1", park: { parkedAt: 1 } }] };
    renderMenu({ ...agentPane, location: "dock" });

    const tree = menuTree();
    expect(level(submenu(tree, "Fleet"))).toEqual(["Park…", "Unpark"]);
    expect(level(tree)).not.toContain("Park…");
    expectTidy(tree);
  });

  it.each([
    ["a plain shell the fleet can take", { ...terminal, location: "grid" }, true],
    ["a plain shell the fleet can't take", { ...terminal, location: "dock" }, false],
    ["a docked agent", { ...agentPane, location: "dock" }, false],
    ["an agent in another worktree", { ...agentPane, worktreeId: "wt-2" }, true],
  ])("leaves no orphan separator or empty submenu on %s", (_name, panel, eligible) => {
    fleetEligible.current = eligible;
    renderMenu(panel);

    const tree = menuTree();
    expectTidy(tree);
    expect(level(tree).slice(-2)).toEqual(["Trash terminal", "Kill terminal"]);
  });

  it("offers no Fleet submenu when there is nothing to put in it", () => {
    renderMenu({ ...terminal, location: "dock" });

    expect(level(menuTree())).not.toContain("Fleet ›");
  });
});
