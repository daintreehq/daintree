import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
const panelState = vi.hoisted(() => ({
  panelsById: {} as Record<
    string,
    { id: string; kind?: string; location?: string; worktreeId?: string } & Record<string, unknown>
  >,
  getPanelGroup: vi.fn((_panelId: string): { id: string } | undefined => undefined),
  setActiveTab: vi.fn(),
  setFileViewMode: vi.fn(),
  setFileBrowserView: vi.fn(),
  pingTerminal: vi.fn(),
}));
const selection = vi.hoisted(() => ({
  activeWorktreeId: "wt-1" as string | null,
  selectWorktree: vi.fn(),
  trackTerminalFocus: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: () => panelState } }));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: () => selection },
}));

import { showFileDraft } from "../showFileDraft";
import { useFileBrowserDraftReviewStore } from "@/store/fileBrowserDraftReviewStore";

beforeEach(() => {
  dispatch.mockReset().mockResolvedValue({ ok: true });
  panelState.panelsById = {};
  panelState.getPanelGroup.mockReset().mockReturnValue(undefined);
  panelState.setActiveTab.mockReset();
  panelState.setFileViewMode.mockReset();
  panelState.setFileBrowserView.mockReset();
  panelState.pingTerminal.mockReset();
  useFileBrowserDraftReviewStore.setState({ byPanelId: {} });
  selection.activeWorktreeId = "wt-1";
  selection.selectWorktree.mockReset();
  selection.trackTerminalFocus.mockReset();
});

describe("showFileDraft (#15017)", () => {
  it("brings an inactive tab forward in Edit and focuses it", async () => {
    panelState.panelsById = {
      p1: { id: "p1", kind: "file", location: "grid", worktreeId: "wt-1" },
    };
    panelState.getPanelGroup.mockReturnValue({ id: "g1" });

    await showFileDraft("p1");

    expect(selection.selectWorktree).not.toHaveBeenCalled();
    expect(panelState.setFileViewMode).toHaveBeenCalledWith("p1", "edit");
    expect(panelState.setActiveTab).toHaveBeenCalledWith("g1", "p1");
    expect(panelState.setActiveTab.mock.invocationCallOrder[0]!).toBeLessThan(
      dispatch.mock.invocationCallOrder[0]!
    );
    expect(dispatch).toHaveBeenCalledWith("panel.focus", { panelId: "p1" }, { source: "user" });
    expect(panelState.pingTerminal).toHaveBeenCalledWith("p1");
  });

  it("switches to the panel's worktree first, restoring this panel there", async () => {
    panelState.panelsById = { p1: { id: "p1", location: "dock", worktreeId: "wt-2" } };

    await showFileDraft("p1");

    expect(selection.trackTerminalFocus).toHaveBeenCalledWith("wt-2", "p1");
    expect(selection.selectWorktree).toHaveBeenCalledWith("wt-2");
    // Tracked before the switch, which restores whatever the worktree last tracked.
    const tracked = selection.trackTerminalFocus.mock.invocationCallOrder[0]!;
    const selected = selection.selectWorktree.mock.invocationCallOrder[0]!;
    const focused = dispatch.mock.invocationCallOrder[0]!;
    expect(tracked).toBeLessThan(selected);
    expect(selected).toBeLessThan(focused);
    expect(panelState.setFileViewMode.mock.invocationCallOrder[0]!).toBeLessThan(focused);
  });

  it("does nothing for a panel that is gone or out of reach", async () => {
    panelState.panelsById = { p2: { id: "p2", location: "trash", worktreeId: "wt-1" } };

    await showFileDraft("p1");
    await showFileDraft("p2");

    expect(panelState.setFileViewMode).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("leaves the panel unpinged when focus was refused", async () => {
    panelState.panelsById = { p1: { id: "p1", location: "grid", worktreeId: "wt-1" } };
    dispatch.mockResolvedValue({ ok: false });

    await showFileDraft("p1");

    expect(panelState.pingTerminal).not.toHaveBeenCalled();
  });

  describe("in a file browser (#17197)", () => {
    function browser(fields: Record<string, unknown> = {}) {
      return {
        id: "fb",
        kind: "file-browser",
        location: "grid",
        worktreeId: "wt-1",
        browserSelectedPath: "docs/notes.md",
        ...fields,
      };
    }

    it("asks the viewer for Edit on the draft's file before its tab comes forward", async () => {
      panelState.panelsById = { fb: browser({ browserViewerCollapsed: true }) };
      panelState.getPanelGroup.mockReturnValue({ id: "g1" });
      let requestedWhenTabMoved: unknown;
      let requestedWhenViewerOpened: unknown;
      panelState.setActiveTab.mockImplementation(() => {
        requestedWhenTabMoved = useFileBrowserDraftReviewStore.getState().byPanelId.fb;
      });
      panelState.setFileBrowserView.mockImplementation(() => {
        requestedWhenViewerOpened = useFileBrowserDraftReviewStore.getState().byPanelId.fb;
      });

      await showFileDraft("fb");

      // Already waiting when the tab switch or the reopened column mounts the
      // viewer, so the first render it gets is the Edit one.
      expect(requestedWhenTabMoved).toMatchObject({ path: "docs/notes.md" });
      expect(requestedWhenViewerOpened).toMatchObject({ path: "docs/notes.md" });
      expect(useFileBrowserDraftReviewStore.getState().byPanelId.fb).toMatchObject({
        path: "docs/notes.md",
      });
      expect(panelState.setFileViewMode).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledWith("panel.focus", { panelId: "fb" }, { source: "user" });
    });

    it("opens a collapsed viewer, leaving visible settings alone", async () => {
      panelState.panelsById = {
        fb: browser({ browserViewerCollapsed: true, browserHideDotfiles: true }),
      };

      await showFileDraft("fb");

      expect(panelState.setFileBrowserView).toHaveBeenCalledTimes(1);
      expect(panelState.setFileBrowserView).toHaveBeenCalledWith("fb", {
        browserViewerCollapsed: false,
      });
    });

    it.each([".github/notes.md", "docs/.notes.md", "docs/.drafts/deep/notes.md"])(
      "shows dotfiles when the toggle is hiding the draft or one of its folders: %s",
      async (selected) => {
        panelState.panelsById = {
          fb: browser({ browserSelectedPath: selected, browserHideDotfiles: true }),
        };

        await showFileDraft("fb");

        expect(panelState.setFileBrowserView).toHaveBeenCalledWith("fb", {
          browserViewerCollapsed: false,
          browserHideDotfiles: false,
        });
      }
    );

    it("judges dotfiles below the tree's root, not in the root itself", async () => {
      // A tree rooted at `.github` lists its children with dotfiles hidden.
      panelState.panelsById = {
        fb: browser({
          browserSelectedPath: ".github/notes.md",
          browserRootPath: ".github",
          browserHideDotfiles: true,
        }),
      };

      await showFileDraft("fb");

      expect(panelState.setFileBrowserView).toHaveBeenCalledWith("fb", {
        browserViewerCollapsed: false,
      });
    });

    it("returns a tree scoped away from the draft to its base folder", async () => {
      // A sibling that shares the root's prefix is still outside it.
      panelState.panelsById = {
        fb: browser({ browserSelectedPath: "docs-old/notes.md", browserRootPath: "docs" }),
      };

      await showFileDraft("fb");

      expect(panelState.setFileBrowserView).toHaveBeenCalledWith("fb", {
        browserViewerCollapsed: false,
        browserRootPath: "",
      });
    });

    it("brings a browser with nothing selected forward as it stands", async () => {
      panelState.panelsById = { fb: browser({ browserSelectedPath: undefined }) };

      await showFileDraft("fb");

      expect(useFileBrowserDraftReviewStore.getState().byPanelId.fb).toBeUndefined();
      expect(panelState.setFileBrowserView).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledWith("panel.focus", { panelId: "fb" }, { source: "user" });
    });
  });
});
