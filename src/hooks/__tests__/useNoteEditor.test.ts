// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNoteEditor } from "../useNoteEditor";
import { notesClient } from "@/clients/notesClient";
import type { NoteListItem, NoteContent } from "@/clients/notesClient";

vi.mock("@/clients/notesClient", () => ({
  notesClient: {
    read: vi.fn(),
    write: vi.fn(),
  },
}));

vi.mock("../../../shared/utils/noteTags", () => ({
  normalizeTag: (t: string) => t.trim().toLowerCase() || null,
}));

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

const makeContent = (overrides: Partial<NoteContent> = {}): NoteContent => ({
  metadata: { id: "n1", title: "Test Note", scope: "project", createdAt: 1000 },
  content: "Hello world",
  path: "/notes/n1.md",
  lastModified: 5000,
  ...overrides,
});

describe("useNoteEditor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(notesClient.read).mockResolvedValue(makeContent());
    vi.mocked(notesClient.write).mockResolvedValue({ lastModified: 6000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const defaultNote = makeNote();

  const defaultProps = () => ({
    selectedNote: defaultNote,
    refresh: vi.fn(),
    setLastSelectedNoteId: vi.fn(),
  });

  it("loads content when selectedNote changes", async () => {
    const { result } = renderHook(() => useNoteEditor(defaultProps()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(notesClient.read).toHaveBeenCalledWith("/notes/n1.md");
    expect(result.current.noteContent).toBe("Hello world");
    expect(result.current.noteMetadata?.title).toBe("Test Note");
    expect(result.current.noteLastModified).toBe(5000);
    expect(result.current.isLoadingContent).toBe(false);
  });

  it("resets state when selectedNote is null", () => {
    const { result } = renderHook(() => useNoteEditor({ ...defaultProps(), selectedNote: null }));

    expect(result.current.noteContent).toBe("");
    expect(result.current.noteMetadata).toBeNull();
    expect(result.current.noteLastModified).toBeNull();
  });

  it("auto-saves after 500ms debounce", async () => {
    const { result } = renderHook(() => useNoteEditor(defaultProps()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      result.current.handleContentChange("updated text");
    });

    expect(notesClient.write).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(notesClient.write).toHaveBeenCalledWith(
      "/notes/n1.md",
      "updated text",
      expect.any(Object),
      5000
    );
  });

  it("surfaces conflict copy path after a dual-preservation save", async () => {
    vi.mocked(notesClient.write).mockResolvedValue({
      lastModified: 9000,
      conflictPath: "test-note (conflict 2026-04-19).md",
    });

    const { result } = renderHook(() => useNoteEditor(defaultProps()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      result.current.handleContentChange("new text");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.conflictCopyPath).toBe("test-note (conflict 2026-04-19).md");
    expect(result.current.noteLastModified).toBe(9000);
  });

  it("keeps saving after a conflict was preserved", async () => {
    vi.mocked(notesClient.write).mockResolvedValue({
      lastModified: 9000,
      conflictPath: "test-note (conflict 2026-04-19).md",
    });

    const { result } = renderHook(() => useNoteEditor(defaultProps()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      result.current.handleContentChange("first");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.conflictCopyPath).toBe("test-note (conflict 2026-04-19).md");

    vi.mocked(notesClient.write).mockClear();
    vi.mocked(notesClient.write).mockResolvedValue({ lastModified: 10000 });

    // A second edit should still trigger a save (no read-only lockout).
    act(() => {
      result.current.handleContentChange("second");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(notesClient.write).toHaveBeenCalled();
    expect(notesClient.write).toHaveBeenCalledWith(
      "/notes/n1.md",
      "second",
      expect.any(Object),
      9000
    );
    expect(result.current.noteLastModified).toBe(10000);
  });

  it("dismissConflictNotice clears the preserved-path banner", async () => {
    vi.mocked(notesClient.write).mockResolvedValue({
      lastModified: 9000,
      conflictPath: "test-note (conflict 2026-04-19).md",
    });

    const { result } = renderHook(() => useNoteEditor(defaultProps()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      result.current.handleContentChange("new text");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.conflictCopyPath).not.toBeNull();

    act(() => {
      result.current.dismissConflictNotice();
    });

    expect(result.current.conflictCopyPath).toBeNull();
  });

  it("flushes pending save on unmount", async () => {
    const props = defaultProps();
    const { result, unmount } = renderHook(() => useNoteEditor(props));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      result.current.handleContentChange("pending text");
    });

    // Unmount should flush the pending save
    unmount();

    expect(notesClient.write).toHaveBeenCalledWith(
      "/notes/n1.md",
      "pending text",
      expect.any(Object),
      5000
    );
  });

  it("adds a tag and writes immediately", async () => {
    const mockRefresh = vi.fn();
    const { result } = renderHook(() => useNoteEditor({ ...defaultProps(), refresh: mockRefresh }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await result.current.handleAddTag("work");
    });

    expect(notesClient.write).toHaveBeenCalledWith(
      "/notes/n1.md",
      "Hello world",
      expect.objectContaining({ tags: ["work"] }),
      5000
    );
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("removes a tag and writes immediately", async () => {
    vi.mocked(notesClient.read).mockResolvedValue(
      makeContent({
        metadata: {
          id: "n1",
          title: "Test Note",
          scope: "project",
          createdAt: 1000,
          tags: ["work", "personal"],
        },
      })
    );

    const { result } = renderHook(() => useNoteEditor(defaultProps()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await result.current.handleRemoveTag("work");
    });

    expect(notesClient.write).toHaveBeenCalledWith(
      "/notes/n1.md",
      "Hello world",
      expect.objectContaining({ tags: ["personal"] }),
      5000
    );
  });

  it("flushSave immediately writes pending content and clears timer", async () => {
    const { result } = renderHook(() => useNoteEditor(defaultProps()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      result.current.handleContentChange("flush me");
    });

    vi.mocked(notesClient.write).mockClear();

    await act(async () => {
      await result.current.flushSave();
    });

    expect(notesClient.write).toHaveBeenCalledWith(
      "/notes/n1.md",
      "flush me",
      expect.any(Object),
      5000
    );

    // Advancing past debounce should not double-write
    vi.mocked(notesClient.write).mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(notesClient.write).not.toHaveBeenCalled();
  });

  it("flushSave is a no-op when no save is pending", async () => {
    const { result } = renderHook(() => useNoteEditor(defaultProps()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    vi.mocked(notesClient.write).mockClear();

    await act(async () => {
      await result.current.flushSave();
    });

    expect(notesClient.write).not.toHaveBeenCalled();
  });

  it("getLatestContent returns current content after handleContentChange", async () => {
    const { result } = renderHook(() => useNoteEditor(defaultProps()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      result.current.handleContentChange("latest value");
    });

    expect(result.current.getLatestContent()).toBe("latest value");
  });

  it("flushSave surfaces conflict copy path", async () => {
    vi.mocked(notesClient.write).mockResolvedValue({
      lastModified: 9000,
      conflictPath: "test-note (conflict 2026-04-19).md",
    });

    const { result } = renderHook(() => useNoteEditor(defaultProps()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      result.current.handleContentChange("conflict text");
    });

    await act(async () => {
      await result.current.flushSave();
    });

    expect(result.current.conflictCopyPath).toBe("test-note (conflict 2026-04-19).md");
  });

  it("flushSave sets lastSelectedNoteId for non-empty content", async () => {
    const props = defaultProps();
    const { result } = renderHook(() => useNoteEditor(props));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      result.current.handleContentChange("hello world");
    });

    await act(async () => {
      await result.current.flushSave();
    });

    expect(props.setLastSelectedNoteId).toHaveBeenCalledWith("n1");
  });

  it("flushSave does not set lastSelectedNoteId for whitespace content", async () => {
    const props = defaultProps();
    const { result } = renderHook(() => useNoteEditor(props));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      result.current.handleContentChange("   ");
    });

    await act(async () => {
      await result.current.flushSave();
    });

    expect(props.setLastSelectedNoteId).not.toHaveBeenCalled();
  });

  it("flushSave is a no-op after debounce has already fired", async () => {
    const props = defaultProps();
    const { result } = renderHook(() => useNoteEditor(props));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      result.current.handleContentChange("debounced text");
    });

    // Let the debounce fire
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    vi.mocked(notesClient.write).mockClear();

    // flushSave should be a no-op since debounce already fired and cleared the ref
    await act(async () => {
      await result.current.flushSave();
    });

    expect(notesClient.write).not.toHaveBeenCalled();
  });

  it("resets content during loading window when switching notes", async () => {
    const noteA = makeNote({ id: "a", path: "/notes/a.md" });
    const noteB = makeNote({ id: "b", path: "/notes/b.md" });

    vi.mocked(notesClient.read).mockResolvedValueOnce(
      makeContent({
        metadata: { id: "a", title: "A", scope: "project", createdAt: 1000 },
        content: "A body",
        path: "/notes/a.md",
        lastModified: 5000,
      })
    );

    let resolveB: (v: NoteContent) => void = () => {};
    vi.mocked(notesClient.read).mockImplementationOnce(
      () =>
        new Promise<NoteContent>((r) => {
          resolveB = r;
        })
    );

    const { result, rerender } = renderHook(
      ({ selectedNote }: { selectedNote: NoteListItem | null }) =>
        useNoteEditor({
          selectedNote,
          refresh: vi.fn(),
          setLastSelectedNoteId: vi.fn(),
        }),
      { initialProps: { selectedNote: noteA } }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.noteContent).toBe("A body");
    expect(result.current.noteLastModified).toBe(5000);

    // Switch to note B — the async read for B is pending
    rerender({ selectedNote: noteB });

    // During the loading window, state must not expose stale note A content
    expect(result.current.noteContent).toBe("");
    expect(result.current.noteMetadata).toBeNull();
    expect(result.current.noteLastModified).toBeNull();
    expect(result.current.isLoadingContent).toBe(true);

    await act(async () => {
      resolveB(
        makeContent({
          metadata: { id: "b", title: "B", scope: "project", createdAt: 1500 },
          content: "B body",
          path: "/notes/b.md",
          lastModified: 8000,
        })
      );
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.noteContent).toBe("B body");
    expect(result.current.noteLastModified).toBe(8000);
    expect(result.current.isLoadingContent).toBe(false);
  });

  it("drops late write results when the user has switched notes", async () => {
    const noteA = makeNote({ id: "a", path: "/notes/a.md" });
    const noteB = makeNote({ id: "b", path: "/notes/b.md" });

    vi.mocked(notesClient.read).mockImplementation(async (p: string) =>
      p === "/notes/a.md"
        ? makeContent({
            metadata: { id: "a", title: "A", scope: "project", createdAt: 1000 },
            content: "A body",
            path: "/notes/a.md",
            lastModified: 5000,
          })
        : makeContent({
            metadata: { id: "b", title: "B", scope: "project", createdAt: 2000 },
            content: "B body",
            path: "/notes/b.md",
            lastModified: 6000,
          })
    );

    let resolveWrite: (v: { lastModified?: number; conflictPath?: string }) => void = () => {};
    vi.mocked(notesClient.write).mockImplementation(() => new Promise((r) => (resolveWrite = r)));

    const { result, rerender } = renderHook(
      ({ selectedNote }: { selectedNote: NoteListItem | null }) =>
        useNoteEditor({
          selectedNote,
          refresh: vi.fn(),
          setLastSelectedNoteId: vi.fn(),
        }),
      { initialProps: { selectedNote: noteA } }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      result.current.handleContentChange("edit A");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    // Switch to note B before note A's write resolves.
    rerender({ selectedNote: noteB });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Now resolve note A's write with a conflict payload. Note B must not be
    // contaminated by these fields.
    await act(async () => {
      resolveWrite({
        lastModified: 9999,
        conflictPath: "a-conflict.md",
      });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.conflictCopyPath).toBeNull();
    expect(result.current.noteLastModified).toBe(6000);
  });

  it("cancels pending save when adding a tag", async () => {
    const { result } = renderHook(() => useNoteEditor(defaultProps()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    vi.mocked(notesClient.write).mockClear();

    act(() => {
      result.current.handleContentChange("some edit");
    });

    // Tag add should cancel the pending content save and write immediately
    await act(async () => {
      await result.current.handleAddTag("urgent");
    });

    const writeCalls = vi.mocked(notesClient.write).mock.calls;
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]![2]).toEqual(expect.objectContaining({ tags: ["urgent"] }));

    // Advance past the save debounce - should not fire again since it was cleared
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(vi.mocked(notesClient.write).mock.calls).toHaveLength(1);
  });
});
