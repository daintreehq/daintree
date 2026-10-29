// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFileDocumentProjection,
  useFileDocumentDraftText,
  useFileDocumentFlags,
  useFileDocumentStore,
  type FileDocumentProjection,
} from "../fileDocumentStore";

function projection(overrides: Partial<FileDocumentProjection> = {}): FileDocumentProjection {
  return {
    identityKey: "doc-1",
    draftText: null,
    dirty: false,
    conflict: false,
    save: vi.fn(async () => ({ status: "saved" as const })),
    discard: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("fileDocumentStore (#12323)", () => {
  beforeEach(() => {
    useFileDocumentStore.setState({ byPanelId: {} });
  });

  it("reads null draft text and clean flags for a panel nothing published", () => {
    const draft = renderHook(() => useFileDocumentDraftText("p1"));
    const flags = renderHook(() => useFileDocumentFlags("p1"));
    expect(draft.result.current).toBeNull();
    expect(flags.result.current).toEqual({ dirty: false, conflict: false });
    expect(getFileDocumentProjection("p1")).toBeUndefined();
  });

  it("publishes a projection per panel and keeps sibling panels apart", () => {
    const draft = renderHook(() => useFileDocumentDraftText("p1"));
    const other = renderHook(() => useFileDocumentDraftText("p2"));
    act(() => {
      useFileDocumentStore
        .getState()
        .setFileDocument("p1", projection({ draftText: "hello", dirty: true }));
    });
    expect(draft.result.current).toBe("hello");
    expect(other.result.current).toBeNull();
  });

  it("returns a referentially stable flags pair while nothing changes", () => {
    useFileDocumentStore.getState().setFileDocument("p1", projection({ dirty: true }));
    const { result, rerender } = renderHook(() => useFileDocumentFlags("p1"));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    act(() => {
      useFileDocumentStore
        .getState()
        .setFileDocument("p1", projection({ dirty: true, conflict: true }));
    });
    expect(result.current).toEqual({ dirty: true, conflict: true });
  });

  it("clears a projection and ignores a clear for an unknown panel", () => {
    useFileDocumentStore.getState().setFileDocument("p1", projection());
    const before = useFileDocumentStore.getState().byPanelId;
    useFileDocumentStore.getState().clearFileDocument("nope");
    expect(useFileDocumentStore.getState().byPanelId).toBe(before);
    useFileDocumentStore.getState().clearFileDocument("p1");
    expect(getFileDocumentProjection("p1")).toBeUndefined();
  });

  // #13809: the built-in editor and a plugin editor can both hold a document
  // for one panel; whichever has a draft keeps the projection.
  it("never lets another document replace or clear a standing draft", () => {
    const store = useFileDocumentStore.getState();
    store.setFileDocument("p1", projection({ identityKey: "plugin", draftText: "x", dirty: true }));
    store.setFileDocument("p1", projection({ identityKey: "builtin" }));
    expect(getFileDocumentProjection("p1")?.identityKey).toBe("plugin");
    store.clearFileDocument("p1", "builtin");
    expect(getFileDocumentProjection("p1")?.identityKey).toBe("plugin");
    // The owner itself still updates and clears it.
    store.setFileDocument("p1", projection({ identityKey: "plugin" }));
    expect(getFileDocumentProjection("p1")?.dirty).toBe(false);
    store.setFileDocument("p1", projection({ identityKey: "builtin" }));
    expect(getFileDocumentProjection("p1")?.identityKey).toBe("builtin");
    store.clearFileDocument("p1", "builtin");
    expect(getFileDocumentProjection("p1")).toBeUndefined();
  });
});
