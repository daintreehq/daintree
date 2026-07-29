// @vitest-environment jsdom
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
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

// Render menu content synchronously — Radix only mounts it behind a real
// right-click into a portal, which tells us nothing about which items rendered.
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

const { dispatch, hoveredFilePath, reportFileLinkFailure, worktreeList } = vi.hoisted(() => ({
  dispatch: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  hoveredFilePath: { current: null as string | null },
  reportFileLinkFailure: vi.fn(),
  // `name`/`branch` are carried because the unrelated "Move to worktree"
  // submenu labels every entry from them and throws on a bare {id, path}.
  worktreeList: { current: [] as Array<{ id: string; path: string; name: string }> },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch, get: () => undefined, list: () => [] },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    // A live xterm is what unlocks the hovered-path branch; without it
    // `handleContextMenu` bails and clears every hover field.
    get: () => ({ terminal: { getSelection: () => "" } }),
    getHoveredLinkText: () => null,
    getHoveredFilePath: () => hoveredFilePath.current,
    openHoveredLink: vi.fn(),
  },
}));

vi.mock("@/services/terminal/FileLinksAddon", () => ({ reportFileLinkFailure }));

vi.mock("@/hooks/useWorktrees", () => ({
  useWorktrees: () => ({ worktrees: worktreeList.current }),
}));

vi.mock("@/hooks/useIsHibernated", () => ({ useIsHibernated: () => false }));
vi.mock("@/hooks/usePluginContextMenuItems", () => ({ usePluginContextMenuItems: () => [] }));

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

vi.mock("@/store", () => {
  const state = () => ({
    panelsById: panelsById.current,
    maximizeTarget: null,
    getPanelGroup: () => undefined,
    watchedPanels: new Set<string>(),
  });
  // `getState` too, not just the hook: `handleContextMenu` reads the store
  // imperatively to resolve recent dictation targets.
  const usePanelStore = (selector: (s: ReturnType<typeof state>) => unknown) => selector(state());
  usePanelStore.getState = state;
  return { usePanelStore };
});

import { TerminalContextMenu } from "../TerminalContextMenu";

const LABEL = "Open in file browser";

function worktree(id: string, path: string) {
  return { id, path, name: id, branch: id };
}

function openMenu(options: {
  hovered: string | null;
  worktrees?: Array<{ id: string; path: string; name: string }>;
  panelWorktreeId?: string;
}) {
  hoveredFilePath.current = options.hovered;
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
    cleanup();
    dispatch.mockReset();
    reportFileLinkFailure.mockReset();
    hoveredFilePath.current = null;
    worktreeList.current = [];
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
      worktrees: [
        worktree("wt-stamped", "/other"),
        worktree("wt-real", "/repo"),
      ],
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
      worktrees: [
        worktree("wt-outer", "/repo"),
        worktree("wt-inner", "/repo/nested"),
      ],
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

    expect(reportFileLinkFailure).toHaveBeenCalledWith(
      "Failed to open file browser",
      "worktree removed",
      "/repo/src/index.ts"
    );
  });
});
