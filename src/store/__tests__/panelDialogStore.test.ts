/**
 * `panelDialogStore` open → close → promote lifecycle (#11239).
 *
 * The store owns the ephemeral panel record's creation and destruction so the
 * presented component's own effects never do: React 19 StrictMode double-invokes
 * effects in dev, which would destroy and recreate the record on every mount.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const addPanelMock = vi.fn();
const removePanelMock = vi.fn();
const promoteMock = vi.fn();
const activateMock = vi.fn();

vi.mock("../panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      addPanel: addPanelMock,
      removePanel: removePanelMock,
      promoteDialogPanelToGrid: promoteMock,
      activateTerminal: activateMock,
    }),
  },
}));

const { usePanelDialogStore, selectTopDialogPanelId } = await import("../panelDialogStore");

/** Topmost presented panel id — the single-dialog cases below all assert on it. */
const topId = () => selectTopDialogPanelId(usePanelDialogStore.getState());
/** Full stack, bottom-first. */
const stack = () => usePanelDialogStore.getState().dialogStack;

describe("panelDialogStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePanelDialogStore.setState({ dialogStack: [], requestSeq: 0 });
    addPanelMock.mockImplementation(async (options: { requestedId?: string }) => {
      return options.requestedId ?? "generated";
    });
    promoteMock.mockReturnValue(true);
  });

  describe("openPanelDialog", () => {
    it("creates the panel as an ephemeral dialog that bypasses the limit gate", async () => {
      await usePanelDialogStore.getState().openPanelDialog({
        kind: "file",
        filePath: "/repo/spec.md",
      });

      expect(addPanelMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "file",
          location: "dialog",
          excludeFromPersistence: true,
          bypassLimits: true,
        })
      );
    });

    it("publishes the panel id before addPanel resolves", async () => {
      let idDuringCreate: string | null = null;
      addPanelMock.mockImplementation(async (options: { requestedId?: string }) => {
        // The host renders against this pointer, and a close arriving mid-flight
        // must have an id to act on rather than a null.
        idDuringCreate = topId();
        return options.requestedId;
      });

      await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });

      expect(idDuringCreate).not.toBeNull();
      expect(idDuringCreate).toBe(topId());
    });

    it("bumps requestSeq on every open so a crashed boundary resets", async () => {
      await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });
      const first = usePanelDialogStore.getState().requestSeq;

      await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });

      expect(usePanelDialogStore.getState().requestSeq).toBeGreaterThan(first);
    });

    it("removes the previous panel when a second open supersedes it", async () => {
      const firstId = await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });

      await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });

      expect(removePanelMock).toHaveBeenCalledWith(firstId);
    });

    it("clears the reservation when the panel could not be created", async () => {
      addPanelMock.mockResolvedValue(null);

      const result = await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });

      expect(result).toBeNull();
      expect(topId()).toBeNull();
    });

    it("clears the reservation when addPanel throws", async () => {
      addPanelMock.mockRejectedValue(new Error("boom"));

      const result = await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });

      expect(result).toBeNull();
      expect(topId()).toBeNull();
    });

    it("removes a panel that lands after the dialog was already closed", async () => {
      // `addPanel` yields before committing for PTY-backed kinds, so a close can
      // land mid-flight. Without an ownership re-check the record commits after
      // the close and no host ever points at it — an invisible, unclosable leak.
      let release: (id: string) => void = () => {};
      addPanelMock.mockImplementation(
        (options: { requestedId?: string }) =>
          new Promise<string | null>((resolve) => {
            release = () => resolve(options.requestedId ?? null);
          })
      );

      const pending = usePanelDialogStore.getState().openPanelDialog({ kind: "file" });
      const inFlightId = topId();
      usePanelDialogStore.getState().closePanelDialog();
      release(inFlightId!);

      await expect(pending).resolves.toBeNull();
      expect(topId()).toBeNull();
      expect(removePanelMock).toHaveBeenCalledWith(inFlightId);
    });

    it("removes a panel that lands after a second open superseded it", async () => {
      const resolvers: Array<() => void> = [];
      addPanelMock.mockImplementation(
        (options: { requestedId?: string }) =>
          new Promise<string | null>((resolve) => {
            resolvers.push(() => resolve(options.requestedId ?? null));
          })
      );

      const first = usePanelDialogStore.getState().openPanelDialog({ kind: "file" });
      const firstId = topId();
      const second = usePanelDialogStore.getState().openPanelDialog({ kind: "file" });
      const secondId = topId();
      resolvers.forEach((r) => r());

      await expect(first).resolves.toBeNull();
      await expect(second).resolves.toBe(secondId);
      expect(removePanelMock).toHaveBeenCalledWith(firstId);
      expect(topId()).toBe(secondId);
    });
  });

  describe("reconcileRemovedPanel", () => {
    it("clears the pointer when the presented panel is removed elsewhere", async () => {
      // Worktree teardown or a bulk action can remove the record out from under
      // the dialog; the pointer must not survive as a dangling id.
      const id = await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });

      usePanelDialogStore.getState().reconcileRemovedPanel(id!);

      expect(topId()).toBeNull();
    });

    it("ignores removals of unrelated panels", async () => {
      const id = await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });

      usePanelDialogStore.getState().reconcileRemovedPanel("some-other-panel");

      expect(topId()).toBe(id);
    });
  });

  describe("closePanelDialog", () => {
    it("clears the pointer and removes the ephemeral panel", async () => {
      const id = await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });

      usePanelDialogStore.getState().closePanelDialog();

      expect(topId()).toBeNull();
      expect(removePanelMock).toHaveBeenCalledWith(id);
    });

    it("is a no-op when nothing is open", () => {
      usePanelDialogStore.getState().closePanelDialog();

      expect(removePanelMock).not.toHaveBeenCalled();
    });
  });

  describe("promoteToGrid", () => {
    it("closes the dialog without removing the now-grid panel", async () => {
      const id = await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });
      removePanelMock.mockClear();

      const promoted = usePanelDialogStore.getState().promoteToGrid();

      expect(promoted).toBe(true);
      expect(topId()).toBeNull();
      // Removing here would destroy the panel the user just chose to keep.
      expect(removePanelMock).not.toHaveBeenCalled();
      expect(activateMock).toHaveBeenCalledWith(id);
    });

    it("keeps the dialog open when the promotion is refused", async () => {
      await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });
      promoteMock.mockReturnValue(false);

      const promoted = usePanelDialogStore.getState().promoteToGrid();

      expect(promoted).toBe(false);
      expect(topId()).not.toBeNull();
      expect(activateMock).not.toHaveBeenCalled();
    });

    it("is a no-op when nothing is open", () => {
      expect(usePanelDialogStore.getState().promoteToGrid()).toBe(false);
      expect(promoteMock).not.toHaveBeenCalled();
    });
  });
  describe("pushPanelDialog (#11243)", () => {
    it("layers a child above its parent, keeping the parent's record alive", async () => {
      const parent = await usePanelDialogStore
        .getState()
        .openPanelDialog({ kind: "review", worktreeId: "wt-1" });

      const child = await usePanelDialogStore
        .getState()
        .pushPanelDialog({ kind: "diff", filePath: "a.ts" }, parent!);

      expect(stack()).toEqual([parent, child]);
      // The whole point: the review record survives the drill-down, so its
      // staging state (draft, selection, filters) is not torn down.
      expect(removePanelMock).not.toHaveBeenCalledWith(parent);
    });

    it("refuses to layer onto a parent that is no longer the top", async () => {
      await usePanelDialogStore.getState().openPanelDialog({ kind: "review" });

      const pushed = await usePanelDialogStore
        .getState()
        .pushPanelDialog({ kind: "diff" }, "some-other-panel");

      expect(pushed).toBeNull();
      expect(stack()).toHaveLength(1);
      expect(addPanelMock).toHaveBeenCalledTimes(1);
    });

    it("refuses to layer when nothing is open", async () => {
      const pushed = await usePanelDialogStore
        .getState()
        .pushPanelDialog({ kind: "diff" }, "ghost");

      expect(pushed).toBeNull();
      expect(addPanelMock).not.toHaveBeenCalled();
    });

    it("drops only its own reservation when creation fails", async () => {
      const parent = await usePanelDialogStore.getState().openPanelDialog({ kind: "review" });
      addPanelMock.mockResolvedValueOnce(null);

      const pushed = await usePanelDialogStore
        .getState()
        .pushPanelDialog({ kind: "diff" }, parent!);

      expect(pushed).toBeNull();
      // The parent is revealed again rather than collaterally closed.
      expect(stack()).toEqual([parent]);
    });

    it("removes a record that lands after its reservation was superseded", async () => {
      const parent = await usePanelDialogStore.getState().openPanelDialog({ kind: "review" });
      addPanelMock.mockImplementationOnce(async (options: { requestedId?: string }) => {
        // A plain open supersedes the whole stack while this push is in flight.
        await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });
        return options.requestedId;
      });

      const pushed = await usePanelDialogStore
        .getState()
        .pushPanelDialog({ kind: "diff" }, parent!);

      expect(pushed).toBeNull();
      expect(stack()).toHaveLength(1);
    });
  });

  describe("stack-aware close, reconcile and promote", () => {
    async function openReviewWithDiff() {
      const parent = await usePanelDialogStore.getState().openPanelDialog({ kind: "review" });
      const child = await usePanelDialogStore
        .getState()
        .pushPanelDialog({ kind: "diff" }, parent!);
      return { parent: parent!, child: child! };
    }

    it("closePanelDialog pops only the top, revealing the parent", async () => {
      const { parent, child } = await openReviewWithDiff();

      usePanelDialogStore.getState().closePanelDialog();

      expect(stack()).toEqual([parent]);
      expect(removePanelMock).toHaveBeenCalledWith(child);
      expect(removePanelMock).not.toHaveBeenCalledWith(parent);
    });

    it("closePanelDialogById closes a specific dialog wherever it sits", async () => {
      const { parent, child } = await openReviewWithDiff();

      usePanelDialogStore.getState().closePanelDialogById(parent);

      expect(stack()).toEqual([child]);
      expect(removePanelMock).toHaveBeenCalledWith(parent);
    });

    it("closePanelDialogById is a no-op for an id that is not presented", async () => {
      const { parent, child } = await openReviewWithDiff();

      usePanelDialogStore.getState().closePanelDialogById("not-open");

      expect(stack()).toEqual([parent, child]);
      expect(removePanelMock).not.toHaveBeenCalled();
    });

    it("reconcileRemovedPanel drops a suspended parent without touching the child", async () => {
      const { parent, child } = await openReviewWithDiff();

      usePanelDialogStore.getState().reconcileRemovedPanel(parent);

      expect(stack()).toEqual([child]);
    });

    it("a plain open supersedes the entire stack", async () => {
      const { parent, child } = await openReviewWithDiff();

      const replacement = await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });

      expect(stack()).toEqual([replacement]);
      expect(removePanelMock).toHaveBeenCalledWith(parent);
      expect(removePanelMock).toHaveBeenCalledWith(child);
    });

    it("promoting the top diff reveals the review beneath it", async () => {
      const { parent, child } = await openReviewWithDiff();

      const promoted = usePanelDialogStore.getState().promoteToGrid();

      expect(promoted).toBe(true);
      expect(promoteMock).toHaveBeenCalledWith(child);
      expect(stack()).toEqual([parent]);
      // Promotion moves the record into the grid — it must not delete it.
      expect(removePanelMock).not.toHaveBeenCalledWith(child);
    });

    it("leaves the stack untouched when promotion is refused at the limit", async () => {
      const { parent, child } = await openReviewWithDiff();
      promoteMock.mockReturnValue(false);

      expect(usePanelDialogStore.getState().promoteToGrid()).toBe(false);
      expect(stack()).toEqual([parent, child]);
    });
  });
});
