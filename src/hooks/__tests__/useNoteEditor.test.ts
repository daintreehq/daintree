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

  it("detects conflict on write", async () => {
    vi.mocked(notesClient.write).mockResolvedValue({ error: "conflict" });

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

    expect(result.current.hasConflict).toBe(true);
  });

  it("reloads note and clears conflict", async () => {
    vi.mocked(notesClient.write).mockResolvedValue({ error: "conflict" });

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
    expect(result.current.hasConflict).toBe(true);

    vi.mocked(notesClient.read).mockResolvedValue(
      makeContent({ content: "reloaded", lastModified: 7000 })
    );

    await act(async () => {
      await result.current.handleReloadNote();
    });

    expect(result.current.hasConflict).toBe(false);
    expect(result.current.noteContent).toBe("reloaded");
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

  it("flushSave detects conflict", async () => {
    vi.mocked(notesClient.write).mockResolvedValue({ error: "conflict" });

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

    expect(result.current.hasConflict).toBe(true);
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
