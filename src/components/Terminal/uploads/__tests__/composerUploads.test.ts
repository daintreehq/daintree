/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useRef } from "react";
import type { EditorView } from "@codemirror/view";

const insertFileAttachments = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<void>>(async () => {})
);
vi.mock("../../fileAttachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../fileAttachments")>()),
  insertFileAttachments,
}));

const pickHostPaths = vi.hoisted(() => vi.fn<() => Promise<string[] | null>>());
vi.mock("@/components/HostFilePicker/hostFilePickerQueue", () => ({ pickHostPaths }));

vi.mock("../../paneFocusRequest", () => ({ requestPaneFocus: vi.fn(() => true) }));

import { useDragDrop } from "../../hooks/useDragDrop";
import { useAttachFiles, useAttachFromHost } from "../../hooks/useAttachFiles";
import { _resetPaneDropRoutingForTests, registerPaneDropTarget } from "../paneDropRouting";

const view = { focus: vi.fn() } as unknown as EditorView;

function dropEvent(altKey: boolean) {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    altKey,
    dataTransfer: {
      types: ["Files"],
      files: [Object.assign(new File(["x"], "spec.md"), { _testPath: "/Users/me/spec.md" })],
      getData: () => "",
    },
  } as unknown as React.DragEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
  (window as unknown as { electron: unknown }).electron = {
    files: {
      getDroppedFilePaths: (files: File[]) =>
        files.map((file) => (file as unknown as { _testPath: string })._testPath),
    },
    clipboard: { pickAttachments: vi.fn(async () => ["/Users/me/a.pdf"]) },
  };
});

afterEach(() => {
  cleanup();
  delete window.__DAINTREE_HOST_ID__;
});

function renderDragDrop() {
  return renderHook(() => {
    const ref = useRef<EditorView | null>(view);
    return useDragDrop(ref, "/srv/proj/src", undefined, undefined, {
      uploadSurface: "composer:t1",
      addToProjectDirectory: () => "/srv/proj",
    });
  });
}

describe("composer drops in a remote window", () => {
  it("attaches into the inbox on a plain drop, tracked on the composer", async () => {
    const { result } = renderDragDrop();
    await act(async () => {
      await result.current.handleDrop(dropEvent(false));
    });
    expect(insertFileAttachments).toHaveBeenCalledWith(
      expect.anything(),
      view,
      [expect.objectContaining({ source: "local", filePath: "/Users/me/spec.md" })],
      "/srv/proj/src",
      { uploadSurface: "composer:t1" }
    );
  });

  it("adds to the project's worktree on an Option-drop", async () => {
    const { result } = renderDragDrop();
    await act(async () => {
      await result.current.handleDrop(dropEvent(true));
    });
    expect(insertFileAttachments).toHaveBeenCalledWith(
      expect.anything(),
      view,
      expect.any(Array),
      "/srv/proj/src",
      { uploadSurface: "composer:t1", destination: { kind: "worktree", directory: "/srv/proj" } }
    );
  });

  it("never adds to the project from a window on this machine", async () => {
    delete window.__DAINTREE_HOST_ID__;
    const { result } = renderDragDrop();
    await act(async () => {
      await result.current.handleDrop(dropEvent(true));
    });
    expect(insertFileAttachments.mock.calls[0]).toHaveLength(5);
    expect(insertFileAttachments.mock.calls[0]![4]).toEqual({ uploadSurface: "composer:t1" });
  });
});

describe("a drop on a bar whose terminal could take it", () => {
  afterEach(() => {
    act(() => _resetPaneDropRoutingForTests());
  });

  function renderPaneDragDrop() {
    const take = vi.fn(() => true);
    registerPaneDropTarget("t1", "xterm", { canTake: () => true, take });
    // The bar's own registration, as HybridInputBar makes it beside the hook.
    registerPaneDropTarget("t1", "hybridInput", { canTake: () => true, take: () => true });
    const hook = renderHook(() => {
      const ref = useRef<EditorView | null>(view);
      return useDragDrop(ref, "/srv/proj/src", undefined, "t1", {
        uploadSurface: "composer:t1",
        addToProjectDirectory: () => "/srv/proj",
        sharesPaneDrops: true,
      });
    });
    return { take, result: hook.result };
  }

  it("stays on the bar, lit, and adds to the project with Option", async () => {
    const { take, result } = renderPaneDragDrop();
    act(() => result.current.handleDragEnter(dropEvent(true)));
    expect(result.current.isDragOverFiles).toBe(true);

    await act(async () => {
      await result.current.handleDrop(dropEvent(true));
    });
    expect(take).not.toHaveBeenCalled();
    expect(insertFileAttachments).toHaveBeenCalledWith(
      expect.anything(),
      view,
      expect.any(Array),
      "/srv/proj/src",
      { uploadSurface: "composer:t1", destination: { kind: "worktree", directory: "/srv/proj" } }
    );
  });

  it("stays on the bar, lit, and attaches as usual without Option", async () => {
    const { take, result } = renderPaneDragDrop();
    act(() => result.current.handleDragEnter(dropEvent(false)));
    expect(result.current.isDragOverFiles).toBe(true);

    await act(async () => {
      await result.current.handleDrop(dropEvent(false));
    });
    expect(take).not.toHaveBeenCalled();
    expect(insertFileAttachments).toHaveBeenCalledWith(
      expect.anything(),
      view,
      expect.any(Array),
      "/srv/proj/src",
      { uploadSurface: "composer:t1" }
    );
  });
});

describe("the attach menu's two sources", () => {
  it("uploads what the native dialog picked on this machine", async () => {
    const { result } = renderHook(() => {
      const ref = useRef<EditorView | null>(view);
      return useAttachFiles(ref, "/srv/proj", "composer:t1");
    });
    await act(async () => {
      await result.current();
    });
    expect(insertFileAttachments).toHaveBeenCalledWith(
      expect.anything(),
      view,
      [expect.objectContaining({ source: "local", filePath: "/Users/me/a.pdf" })],
      "/srv/proj",
      { uploadSurface: "composer:t1" }
    );
  });

  // Nothing is uploaded, but an image's thumbnail still comes from the host,
  // and the composer's send waits for it (#15599).
  it("inserts host paths from the host picker, on the composer's surface", async () => {
    pickHostPaths.mockResolvedValueOnce(["/srv/proj/README.md"]);
    const { result } = renderHook(() => {
      const ref = useRef<EditorView | null>(view);
      return useAttachFromHost(ref, "/srv/proj", "composer:t1");
    });
    await act(async () => {
      await result.current();
    });
    expect(pickHostPaths).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "file", multiple: true, defaultPath: "/srv/proj" })
    );
    expect(insertFileAttachments).toHaveBeenCalledWith(
      expect.anything(),
      view,
      [
        expect.objectContaining({
          source: "host",
          hostId: "studio-01",
          filePath: "/srv/proj/README.md",
        }),
      ],
      "/srv/proj",
      { uploadSurface: "composer:t1" }
    );
  });

  it("does nothing when the host picker is dismissed", async () => {
    pickHostPaths.mockResolvedValueOnce(null);
    const { result } = renderHook(() => {
      const ref = useRef<EditorView | null>(view);
      return useAttachFromHost(ref, "/srv/proj");
    });
    await act(async () => {
      await result.current();
    });
    expect(insertFileAttachments).not.toHaveBeenCalled();
  });
});
