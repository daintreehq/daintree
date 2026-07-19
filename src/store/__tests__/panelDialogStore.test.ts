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

const { usePanelDialogStore } = await import("../panelDialogStore");

describe("panelDialogStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePanelDialogStore.setState({ panelId: null, requestSeq: 0 });
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
        idDuringCreate = usePanelDialogStore.getState().panelId;
        return options.requestedId;
      });

      await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });

      expect(idDuringCreate).not.toBeNull();
      expect(idDuringCreate).toBe(usePanelDialogStore.getState().panelId);
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
      expect(usePanelDialogStore.getState().panelId).toBeNull();
    });

    it("clears the reservation when addPanel throws", async () => {
      addPanelMock.mockRejectedValue(new Error("boom"));

      const result = await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });

      expect(result).toBeNull();
      expect(usePanelDialogStore.getState().panelId).toBeNull();
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
      const inFlightId = usePanelDialogStore.getState().panelId;
      usePanelDialogStore.getState().closePanelDialog();
      release(inFlightId!);

      await expect(pending).resolves.toBeNull();
      expect(usePanelDialogStore.getState().panelId).toBeNull();
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
      const firstId = usePanelDialogStore.getState().panelId;
      const second = usePanelDialogStore.getState().openPanelDialog({ kind: "file" });
      const secondId = usePanelDialogStore.getState().panelId;
      resolvers.forEach((r) => r());

      await expect(first).resolves.toBeNull();
      await expect(second).resolves.toBe(secondId);
      expect(removePanelMock).toHaveBeenCalledWith(firstId);
      expect(usePanelDialogStore.getState().panelId).toBe(secondId);
    });
  });

  describe("reconcileRemovedPanel", () => {
    it("clears the pointer when the presented panel is removed elsewhere", async () => {
      // Worktree teardown or a bulk action can remove the record out from under
      // the dialog; the pointer must not survive as a dangling id.
      const id = await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });

      usePanelDialogStore.getState().reconcileRemovedPanel(id!);

      expect(usePanelDialogStore.getState().panelId).toBeNull();
    });

    it("ignores removals of unrelated panels", async () => {
      const id = await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });

      usePanelDialogStore.getState().reconcileRemovedPanel("some-other-panel");

      expect(usePanelDialogStore.getState().panelId).toBe(id);
    });
  });

  describe("closePanelDialog", () => {
    it("clears the pointer and removes the ephemeral panel", async () => {
      const id = await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });

      usePanelDialogStore.getState().closePanelDialog();

      expect(usePanelDialogStore.getState().panelId).toBeNull();
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
      expect(usePanelDialogStore.getState().panelId).toBeNull();
      // Removing here would destroy the panel the user just chose to keep.
      expect(removePanelMock).not.toHaveBeenCalled();
      expect(activateMock).toHaveBeenCalledWith(id);
    });

    it("keeps the dialog open when the promotion is refused", async () => {
      await usePanelDialogStore.getState().openPanelDialog({ kind: "file" });
      promoteMock.mockReturnValue(false);

      const promoted = usePanelDialogStore.getState().promoteToGrid();

      expect(promoted).toBe(false);
      expect(usePanelDialogStore.getState().panelId).not.toBeNull();
      expect(activateMock).not.toHaveBeenCalled();
    });

    it("is a no-op when nothing is open", () => {
      expect(usePanelDialogStore.getState().promoteToGrid()).toBe(false);
      expect(promoteMock).not.toHaveBeenCalled();
    });
  });
});
