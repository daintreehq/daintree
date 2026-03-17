// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNoteSearch } from "../useNoteSearch";
import { notesClient } from "@/clients/notesClient";
import type { NoteListItem } from "@/clients/notesClient";

vi.mock("@/clients/notesClient", () => ({
  notesClient: {
    search: vi.fn(),
    onUpdated: vi.fn(() => vi.fn()),
  },
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

describe("useNoteSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(notesClient.search).mockResolvedValue({ notes: [], query: "" });
    vi.mocked(notesClient.onUpdated).mockReturnValue(vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
  });

  const defaultProps = () => ({
    isOpen: true,
    notes: [makeNote()],
    isLoading: false,
    refresh: vi.fn(),
  });

  it("performs debounced search after 150ms", async () => {
    const notes = [makeNote()];
    vi.mocked(notesClient.search).mockResolvedValue({ notes, query: "test" });

    const { result } = renderHook(() => useNoteSearch(defaultProps()));

    await act(async () => {
      result.current.setQuery("test");
    });

    expect(notesClient.search).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(notesClient.search).toHaveBeenCalledWith("test");
  });

  it("cancels pending search on rapid query changes", async () => {
    const { result } = renderHook(() => useNoteSearch(defaultProps()));

    await act(async () => {
      result.current.setQuery("ab");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await act(async () => {
      result.current.setQuery("abc");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(notesClient.search).toHaveBeenCalledTimes(1);
    expect(notesClient.search).toHaveBeenCalledWith("abc");
  });

  it("falls back to notes prop on search failure", async () => {
    const notes = [makeNote({ id: "fallback" })];
    vi.mocked(notesClient.search).mockRejectedValue(new Error("fail"));

    const { result } = renderHook(() => useNoteSearch({ ...defaultProps(), notes }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(result.current.searchResults).toEqual(notes);
  });

  it("persists sort order to sessionStorage", async () => {
    const { result } = renderHook(() => useNoteSearch(defaultProps()));

    act(() => {
      result.current.setSortOrder("title-asc");
    });

    expect(sessionStorage.getItem("notes-sort-order")).toBe("title-asc");
  });

  it("restores sort order from sessionStorage", () => {
    sessionStorage.setItem("notes-sort-order", "created-asc");
    const { result } = renderHook(() => useNoteSearch(defaultProps()));
    expect(result.current.sortOrder).toBe("created-asc");
  });

  it("filters visibleNotes by selected tag", async () => {
    const notes = [
      makeNote({ id: "n1", tags: ["work"] }),
      makeNote({ id: "n2", tags: ["personal"] }),
    ];
    vi.mocked(notesClient.search).mockResolvedValue({ notes, query: "" });

    const { result } = renderHook(() => useNoteSearch(defaultProps()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    act(() => {
      result.current.setSelectedTag("work");
    });

    expect(result.current.visibleNotes).toHaveLength(1);
    expect(result.current.visibleNotes[0].id).toBe("n1");
  });

  it("clears selected tag when it disappears from available tags", async () => {
    const notes = [makeNote({ id: "n1", tags: ["work"] })];
    vi.mocked(notesClient.search).mockResolvedValue({ notes, query: "" });

    const { result } = renderHook(() => useNoteSearch(defaultProps()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    act(() => {
      result.current.setSelectedTag("work");
    });
    expect(result.current.selectedTag).toBe("work");

    vi.mocked(notesClient.search).mockResolvedValue({ notes: [], query: "" });

    await act(async () => {
      result.current.setQuery("xxx");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(result.current.selectedTag).toBeNull();
  });

  it("subscribes to onUpdated and unsubscribes on unmount", () => {
    const unsubscribe = vi.fn();
    vi.mocked(notesClient.onUpdated).mockReturnValue(unsubscribe);

    const { unmount } = renderHook(() => useNoteSearch(defaultProps()));

    expect(notesClient.onUpdated).toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("does not search when isOpen is false", async () => {
    renderHook(() => useNoteSearch({ ...defaultProps(), isOpen: false }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(notesClient.search).not.toHaveBeenCalled();
  });

  it("sorts visibleNotes by sortOrder", async () => {
    const notes = [
      makeNote({ id: "a", title: "Zebra", modifiedAt: 100 }),
      makeNote({ id: "b", title: "Apple", modifiedAt: 200 }),
    ];
    vi.mocked(notesClient.search).mockResolvedValue({ notes, query: "" });

    const { result } = renderHook(() => useNoteSearch(defaultProps()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    // Default is modified-desc
    expect(result.current.visibleNotes[0].id).toBe("b");

    act(() => {
      result.current.setSortOrder("title-asc");
    });

    expect(result.current.visibleNotes[0].id).toBe("b"); // Apple
    expect(result.current.visibleNotes[1].id).toBe("a"); // Zebra
  });
});
