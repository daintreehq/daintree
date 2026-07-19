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
