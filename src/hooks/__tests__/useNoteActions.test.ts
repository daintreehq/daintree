// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNoteActions } from "../useNoteActions";
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
    isInitialized: true,
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
  describe("auto-delete heuristic", () => {
    it("auto-deletes note with empty title and empty content", async () => {
      const props = defaultProps({
        selectedNote: makeNote({ title: "" }),
        flushSave: vi.fn().mockResolvedValue(undefined),
        getLatestContent: vi.fn().mockReturnValue(""),
      });

      const { result } = renderHook(() => useNoteActions(props));

      await act(async () => {
        await result.current.handleClose();
      });

      expect(props.deleteNote).toHaveBeenCalledWith("/notes/n1.md");
    });

    it("does not auto-delete note with empty title but has content", async () => {
      const props = defaultProps({
        selectedNote: makeNote({ title: "" }),
        flushSave: vi.fn().mockResolvedValue(undefined),
        getLatestContent: vi.fn().mockReturnValue("some content"),
      });

      const { result } = renderHook(() => useNoteActions(props));

      await act(async () => {
        await result.current.handleClose();
      });

      expect(props.deleteNote).not.toHaveBeenCalled();
    });

    it("does not auto-delete note with custom title and empty content", async () => {
      const props = defaultProps({
        selectedNote: makeNote({ title: "Custom Title" }),
        flushSave: vi.fn().mockResolvedValue(undefined),
        getLatestContent: vi.fn().mockReturnValue(""),
      });

      const { result } = renderHook(() => useNoteActions(props));

      await act(async () => {
        await result.current.handleClose();
      });

      expect(props.deleteNote).not.toHaveBeenCalled();
    });
  });

  describe("handleClose", () => {
    it("flushes save before auto-delete check", async () => {
      const callOrder: string[] = [];
      const props = defaultProps({
        selectedNote: makeNote({ title: "" }),
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
      expect(props.deleteNote).not.toHaveBeenCalled();
      expect(props.onClose).toHaveBeenCalled();
    });

    it("auto-deletes empty untitled note after flush", async () => {
      const props = defaultProps({
        selectedNote: makeNote({ title: "" }),
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
    it("restores note with empty title and no preview", async () => {
      const noteWithEmptyTitle = makeNote({
        id: "n2",
        title: "",
        preview: "",
      });
      const props = defaultProps({
        lastSelectedNoteId: "n2",
        visibleNotes: [noteWithEmptyTitle],
        notes: [noteWithEmptyTitle],
      });

      renderHook(() => useNoteActions(props));

      expect(props.setSelectedNote).toHaveBeenCalledWith(noteWithEmptyTitle);
      expect(props.setLastSelectedNoteId).not.toHaveBeenCalledWith(null);
    });

    it("falls back to first visible note when lastSelectedNoteId not found", async () => {
      const firstNote = makeNote({ id: "first" });
      const emptyTitleNote = makeNote({
        id: "default",
        title: "",
        preview: "",
      });
      const props = defaultProps({
        lastSelectedNoteId: "nonexistent",
        visibleNotes: [emptyTitleNote, firstNote],
        notes: [emptyTitleNote, firstNote],
      });

      renderHook(() => useNoteActions(props));

      expect(props.setSelectedNote).toHaveBeenCalledWith(emptyTitleNote);
    });
  });

  describe("auto-create first note", () => {
    it("auto-creates when palette opens with no notes and store is initialized", () => {
      const createNote = vi.fn().mockResolvedValue({
        metadata: { id: "new1", title: "", scope: "project", createdAt: Date.now(), tags: [] },
        content: "",
        path: "/notes/new1.md",
        lastModified: Date.now(),
      });
      const props = defaultProps({
        notes: [],
        visibleNotes: [],
        isInitialized: true,
        isLoading: false,
        createNote,
      });

      renderHook(() => useNoteActions(props));

      expect(createNote).toHaveBeenCalledWith("", "project");
    });

    it("does not auto-create when isInitialized is false", () => {
      const createNote = vi.fn();
      const props = defaultProps({
        notes: [],
        visibleNotes: [],
        isInitialized: false,
        isLoading: true,
        createNote,
      });

      renderHook(() => useNoteActions(props));

      expect(createNote).not.toHaveBeenCalled();
    });

    it("does not auto-create when notes exist", () => {
      const createNote = vi.fn();
      const props = defaultProps({
        notes: [defaultNote],
        visibleNotes: [defaultNote],
        isInitialized: true,
        isLoading: false,
        createNote,
      });

      renderHook(() => useNoteActions(props));

      expect(createNote).not.toHaveBeenCalled();
    });

    it("does not auto-create when palette is closed", () => {
      const createNote = vi.fn();
      const props = defaultProps({
        isOpen: false,
        notes: [],
        visibleNotes: [],
        isInitialized: true,
        isLoading: false,
        createNote,
      });

      renderHook(() => useNoteActions(props));

      expect(createNote).not.toHaveBeenCalled();
    });

    it("does not auto-create when search hides all notes but notes exist", () => {
      const createNote = vi.fn();
      const props = defaultProps({
        notes: [defaultNote],
        visibleNotes: [],
        isInitialized: true,
        isLoading: false,
        isSearching: true,
        createNote,
      });

      renderHook(() => useNoteActions(props));

      expect(createNote).not.toHaveBeenCalled();
    });

    it("re-creates when palette is closed and reopened with zero notes", () => {
      const createNote = vi.fn().mockResolvedValue({
        metadata: { id: "new1", title: "", scope: "project", createdAt: Date.now(), tags: [] },
        content: "",
        path: "/notes/new1.md",
        lastModified: Date.now(),
      });
      const props = defaultProps({
        notes: [],
        visibleNotes: [],
        isInitialized: true,
        isLoading: false,
        createNote,
      });

      const { rerender } = renderHook(({ hookProps }) => useNoteActions(hookProps), {
        initialProps: { hookProps: props },
      });

      expect(createNote).toHaveBeenCalledTimes(1);

      // Close palette
      rerender({ hookProps: { ...props, isOpen: false } });
      // Reopen palette
      rerender({ hookProps: { ...props, isOpen: true } });

      expect(createNote).toHaveBeenCalledTimes(2);
    });
  });

  describe("handleSelectNote", () => {
    it("flushes and checks auto-delete when switching notes", async () => {
      const oldNote = makeNote({ id: "old", title: "" });
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
      expect(props.deleteNote).not.toHaveBeenCalled();
      expect(props.setLastSelectedNoteId).toHaveBeenCalledWith("new");
    });

    it("always persists lastSelectedNoteId for untitled notes", async () => {
      const props = defaultProps({
        visibleNotes: [defaultNote],
      });
      const untitledNote = makeNote({ title: "", preview: "" });

      const { result } = renderHook(() => useNoteActions(props));

      await act(async () => {
        await result.current.handleSelectNote(untitledNote, 0);
      });

      expect(props.setLastSelectedNoteId).toHaveBeenCalledWith("n1");
    });
  });
});
