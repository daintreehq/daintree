// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNoteActions, isDefaultTitle } from "../useNoteActions";
import type { NoteListItem } from "@/clients/notesClient";

const makeNote = (overrides: Partial<NoteListItem> = {}): NoteListItem => ({
  id: "n1",
  title: "Test Note",
  path: "/notes/n1.md",
  scope: "project",
  createdAt: 1000,
  modifiedAt: 2000,
  preview: "some text",
  tags: [],
  ...overrides,
});

const defaultNote = makeNote();

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    isOpen: true,
    notes: [defaultNote],
    visibleNotes: [defaultNote],
    isLoading: false,
    isSearching: false,
    lastSelectedNoteId: null as string | null,
    setLastSelectedNoteId: vi.fn(),
    initialize: vi.fn(),
    createNote: vi.fn(),
    deleteNote: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn(),
    setQuery: vi.fn(),
    setNoteContent: vi.fn(),
    setNoteMetadata: vi.fn(),
    setNoteLastModified: vi.fn(),
    setHasConflict: vi.fn(),
    setEditingNoteId: vi.fn(),
    setIsEditingHeaderTitle: vi.fn(),
    setHeaderTitleEdit: vi.fn(),
    headerTitleInputRef: { current: null },
    flushSave: vi.fn().mockResolvedValue(undefined),
    getLatestContent: vi.fn().mockReturnValue(""),
    editingNoteId: null,
    isEditingHeaderTitle: false,
    showCreateItem: false,
    trimmedQuery: "",
    selectedNote: null as NoteListItem | null,
    setSelectedNote: vi.fn(),
    onClose: vi.fn(),
    handleOpenAsPanel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("useNoteActions", () => {
  describe("isDefaultTitle", () => {
    it("matches default date titles", () => {
      expect(isDefaultTitle("Note 3/28/2026")).toBe(true);
      expect(isDefaultTitle("Note 3/28/2026 (2)")).toBe(true);
    });

    it("rejects custom titles", () => {
      expect(isDefaultTitle("My Note")).toBe(false);
      expect(isDefaultTitle("Note about stuff")).toBe(false);
    });
  });

  describe("handleClose", () => {
    it("flushes save before auto-delete check", async () => {
      const callOrder: string[] = [];
      const props = defaultProps({
        selectedNote: makeNote({ title: "Note 3/28/2026" }),
        flushSave: vi.fn().mockImplementation(async () => {
          callOrder.push("flush");
        }),
        getLatestContent: vi.fn().mockReturnValue("has content"),
        deleteNote: vi.fn().mockImplementation(async () => {
          callOrder.push("delete");
        }),
        onClose: vi.fn().mockImplementation(() => {
          callOrder.push("close");
        }),
      });

      const { result } = renderHook(() => useNoteActions(props));

      await act(async () => {
        await result.current.handleClose();
      });

      expect(callOrder[0]).toBe("flush");
      expect(props.flushSave).toHaveBeenCalled();
      // Note has content so should NOT be deleted
      expect(props.deleteNote).not.toHaveBeenCalled();
      expect(props.onClose).toHaveBeenCalled();
    });

    it("auto-deletes empty default-titled note after flush", async () => {
      const props = defaultProps({
        selectedNote: makeNote({ title: "Note 3/28/2026" }),
        flushSave: vi.fn().mockResolvedValue(undefined),
        getLatestContent: vi.fn().mockReturnValue(""),
      });

      const { result } = renderHook(() => useNoteActions(props));

      await act(async () => {
        await result.current.handleClose();
      });

      expect(props.flushSave).toHaveBeenCalled();
      expect(props.deleteNote).toHaveBeenCalledWith("/notes/n1.md");
      expect(props.onClose).toHaveBeenCalled();
    });
  });

  describe("selection-restore", () => {
    it("restores note with default title and no preview", async () => {
      const noteWithDefaultTitle = makeNote({
        id: "n2",
        title: "Note 3/28/2026",
        preview: "",
      });
      const props = defaultProps({
        lastSelectedNoteId: "n2",
        visibleNotes: [noteWithDefaultTitle],
        notes: [noteWithDefaultTitle],
      });

      renderHook(() => useNoteActions(props));

      expect(props.setSelectedNote).toHaveBeenCalledWith(noteWithDefaultTitle);
      // Should NOT clear lastSelectedNoteId
      expect(props.setLastSelectedNoteId).not.toHaveBeenCalledWith(null);
    });

    it("falls back to first visible note when lastSelectedNoteId not found", async () => {
      const firstNote = makeNote({ id: "first" });
      const defaultTitleNote = makeNote({
        id: "default",
        title: "Note 3/28/2026",
        preview: "",
      });
      const props = defaultProps({
        lastSelectedNoteId: "nonexistent",
        visibleNotes: [defaultTitleNote, firstNote],
        notes: [defaultTitleNote, firstNote],
      });

      renderHook(() => useNoteActions(props));

      // Should fall back to first visible note (even with default title and no preview)
      expect(props.setSelectedNote).toHaveBeenCalledWith(defaultTitleNote);
    });
  });

  describe("handleSelectNote", () => {
    it("flushes and checks auto-delete when switching notes", async () => {
      const oldNote = makeNote({ id: "old", title: "Note 3/28/2026" });
      const newNote = makeNote({ id: "new", title: "New Note" });
      const props = defaultProps({
        selectedNote: oldNote,
        visibleNotes: [oldNote, newNote],
        flushSave: vi.fn().mockResolvedValue(undefined),
        getLatestContent: vi.fn().mockReturnValue("has content"),
      });

      const { result } = renderHook(() => useNoteActions(props));

      await act(async () => {
        await result.current.handleSelectNote(newNote, 1);
      });

      expect(props.flushSave).toHaveBeenCalled();
      // Old note has content, so not deleted
      expect(props.deleteNote).not.toHaveBeenCalled();
      // Always persist lastSelectedNoteId regardless of title
      expect(props.setLastSelectedNoteId).toHaveBeenCalledWith("new");
    });

    it("always persists lastSelectedNoteId for default-titled notes", async () => {
      const props = defaultProps({
        visibleNotes: [defaultNote],
      });
      const defaultTitleNote = makeNote({ title: "Note 3/28/2026", preview: "" });

      const { result } = renderHook(() => useNoteActions(props));

      await act(async () => {
        await result.current.handleSelectNote(defaultTitleNote, 0);
      });

      expect(props.setLastSelectedNoteId).toHaveBeenCalledWith("n1");
    });
  });
});
