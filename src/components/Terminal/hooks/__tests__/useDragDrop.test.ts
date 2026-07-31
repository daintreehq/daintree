// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { EditorView } from "@codemirror/view";

// The hook reaches `useTerminalFileTransfer` for one regex, but that module
// constructs the `terminalInstanceService` singleton at import time — real
// heartbeat intervals and window listeners this suite never disposes. Stub it
// so the suite owns nothing but the hook.
vi.mock("../../useTerminalFileTransfer", () => ({
  IMAGE_EXTENSIONS: /\.(png|jpe?g|bmp|tiff?|avif|heic)$/i,
}));

const { useDragDrop } = await import("../useDragDrop");
const { FILE_DRAG_MIME, encodeFileDragPaths } = await import("@/lib/fileDragPayload");

const CWD = "/Users/greg/Projects/daintree";

function fakeView(head = 0) {
  const dispatch = vi.fn();
  const view = {
    state: { selection: { main: { head } } },
    dispatch,
  } as unknown as EditorView;
  return { view, dispatch, head, ref: { current: view } as React.RefObject<EditorView | null> };
}

/**
 * The one place a synthetic transfer becomes a `DragEvent`. Every builder
 * below routes through it so the suite keeps a single assertion rather than
 * one per drag shape.
 */
function dragEventWith(dataTransfer: object): React.DragEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer,
  } as unknown as React.DragEvent;
}

function dropEvent(files: File[]): React.DragEvent {
  return dragEventWith({ files, types: ["Files"] });
}

/**
 * A drop from the file browser (#11576): paths, no `File` objects. `getData`
 * only answers for the type the source actually wrote, which is what proves
 * the handler asks for the right one.
 */
function internalDropEvent(
  serialized: string,
  getData: (type: string) => string = vi.fn((type: string) =>
    type === FILE_DRAG_MIME ? serialized : ""
  )
): React.DragEvent {
  return dragEventWith({ files: [], types: [FILE_DRAG_MIME], getData });
}

/** The same, carrying paths the source would really have encoded. */
function internalDrop(paths: string[]): React.DragEvent {
  return internalDropEvent(encodeFileDragPaths(paths));
}

/** A hover, with no payload readable yet — what protected mode really hands us. */
function dragEvent(types: string[]): React.DragEvent {
  return dragEventWith({ types, dropEffect: "none", getData: vi.fn(() => "") });
}

function fakeFile(name: string, size = 10): File {
  return { name, size } as unknown as File;
}

/** The document text the drop inserted, minus the trailing separator space. */
function insertedToken(dispatch: ReturnType<typeof vi.fn>): string {
  const insert = dispatch.mock.calls[0]?.[0]?.changes?.insert as string;
  return insert.trimEnd();
}

/** The `addFileDropChip` / `addImageChip` payloads carried by the dispatch. */
function effectValues(dispatch: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  const effects = dispatch.mock.calls[0]?.[0]?.effects as { value: Record<string, unknown> }[];
  return effects.map((e) => e.value);
}

/**
 * Every chip range is a document position, so it only lines up if the hook
 * accumulated offsets against the emitted spelling rather than the original
 * absolute path. Returns what each range actually covers in the document.
 */
function chipSpellings(dispatch: ReturnType<typeof vi.fn>, head: number): string[] {
  const insert = dispatch.mock.calls[0]?.[0]?.changes?.insert as string;
  return effectValues(dispatch).map((chip) =>
    insert.slice((chip.from as number) - head, (chip.to as number) - head)
  );
}

let pathForFile: ReturnType<typeof vi.fn>;
let thumbnailFromPath: ReturnType<typeof vi.fn>;

beforeEach(() => {
  pathForFile = vi.fn((file: File) => `${CWD}/${file.name}`);
  thumbnailFromPath = vi.fn(async () => ({ thumbnailDataUrl: "data:image/png;base64,x" }));
  (window as unknown as { electron: unknown }).electron = {
    webUtils: { getPathForFile: pathForFile },
    clipboard: { thumbnailFromPath },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { electron?: unknown }).electron;
});

describe("useDragDrop", () => {
  it("inserts a cwd-relative @file token for a file dropped from inside the worktree", async () => {
    pathForFile.mockReturnValue(`${CWD}/src/App.tsx`);
    const { view, dispatch, ref } = fakeView();
    const { result } = renderHook(() => useDragDrop(ref, CWD));

    await act(async () => {
      await result.current.handleDrop(dropEvent([fakeFile("App.tsx")]));
    });

    expect(view.dispatch).toHaveBeenCalledTimes(1);
    expect(insertedToken(dispatch)).toBe("@src/App.tsx");
  });

  it("keeps the absolute @file token for a file dropped from outside the worktree", async () => {
    const outside = "/etc/hosts.ts";
    pathForFile.mockReturnValue(outside);
    const { dispatch, ref } = fakeView();
    const { result } = renderHook(() => useDragDrop(ref, CWD));

    await act(async () => {
      await result.current.handleDrop(dropEvent([fakeFile("hosts.ts")]));
    });

    expect(insertedToken(dispatch)).toBe(`@${outside}`);
  });

  // The live PTY cwd moves as the user cd's; `handleDrop` is a React prop, so
  // the rerendered callback is the one that must be consulted.
  it("relativizes against the cwd current at drop time, not at mount time", async () => {
    pathForFile.mockReturnValue(`${CWD}/src/App.tsx`);
    const { dispatch, ref } = fakeView();
    const { result, rerender } = renderHook(({ cwd }) => useDragDrop(ref, cwd), {
      initialProps: { cwd: "/somewhere/else" },
    });

    rerender({ cwd: CWD });

    await act(async () => {
      await result.current.handleDrop(dropEvent([fakeFile("App.tsx")]));
    });

    expect(insertedToken(dispatch)).toBe("@src/App.tsx");
  });

  it("stores the absolute path on the chip while the document text stays relative", async () => {
    const absolute = `${CWD}/src/App.tsx`;
    pathForFile.mockReturnValue(absolute);
    const { dispatch, ref } = fakeView();
    const { result } = renderHook(() => useDragDrop(ref, CWD));

    await act(async () => {
      await result.current.handleDrop(dropEvent([fakeFile("App.tsx")]));
    });

    const [chip] = effectValues(dispatch);
    expect(chip?.filePath).toBe(absolute);
    expect(insertedToken(dispatch)).not.toContain(CWD);
  });

  // The chip's range has to cover exactly the token that was inserted — a
  // shorter relative token with a range still sized for the absolute one would
  // leave the decoration overhanging into following text.
  it("sizes the chip range to the token actually inserted", async () => {
    pathForFile.mockReturnValue(`${CWD}/src/App.tsx`);
    const { dispatch, ref } = fakeView();
    const { result } = renderHook(() => useDragDrop(ref, CWD));

    await act(async () => {
      await result.current.handleDrop(dropEvent([fakeFile("App.tsx")]));
    });

    const [chip] = effectValues(dispatch);
    const token = insertedToken(dispatch);
    expect((chip?.to as number) - (chip?.from as number)).toBe(token.length);
  });

  it("keeps consecutive chip ranges aligned with their tokens when several files drop at once", async () => {
    pathForFile.mockImplementation((file: File) => `${CWD}/src/${file.name}`);
    const { dispatch, ref, head } = fakeView(17);
    const { result } = renderHook(() => useDragDrop(ref, CWD));

    await act(async () => {
      await result.current.handleDrop(dropEvent([fakeFile("a.ts"), fakeFile("b.ts")]));
    });

    expect(effectValues(dispatch)).toHaveLength(2);
    expect(chipSpellings(dispatch, head)).toEqual(["@src/a.ts", "@src/b.ts"]);
  });

  // The two branches share one `insertText`/`from` accumulator while emitting
  // different spellings — a bare absolute path for the image, a shortened
  // relative token for the file. Interleaving them is where an accumulator
  // still sized to the absolute path would drift.
  it("keeps ranges aligned when an image and a file drop together", async () => {
    pathForFile.mockImplementation((file: File) => `${CWD}/src/${file.name}`);
    const { dispatch, ref, head } = fakeView(9);
    const { result } = renderHook(() => useDragDrop(ref, CWD));

    await act(async () => {
      await result.current.handleDrop(dropEvent([fakeFile("shot.png"), fakeFile("a.ts")]));
    });

    expect(effectValues(dispatch)).toHaveLength(2);
    // Image effects are collected ahead of file effects, so compare as a set.
    expect(chipSpellings(dispatch, head).sort()).toEqual(
      [`${CWD}/src/shot.png`, "@src/a.ts"].sort()
    );
  });

  it("keeps ranges aligned when a file precedes an image", async () => {
    pathForFile.mockImplementation((file: File) => `${CWD}/src/${file.name}`);
    const { dispatch, ref, head } = fakeView(4);
    const { result } = renderHook(() => useDragDrop(ref, CWD));

    await act(async () => {
      await result.current.handleDrop(dropEvent([fakeFile("a.ts"), fakeFile("shot.png")]));
    });

    expect(chipSpellings(dispatch, head).sort()).toEqual(
      [`${CWD}/src/shot.png`, "@src/a.ts"].sort()
    );
  });

  it("inserts at the cursor and leaves the caret after everything it inserted", async () => {
    pathForFile.mockReturnValue(`${CWD}/src/App.tsx`);
    const { dispatch, ref, head } = fakeView(23);
    const { result } = renderHook(() => useDragDrop(ref, CWD));

    await act(async () => {
      await result.current.handleDrop(dropEvent([fakeFile("App.tsx")]));
    });

    const call = dispatch.mock.calls[0]?.[0];
    const insert = call?.changes?.insert as string;
    expect(call?.changes?.from).toBe(head);
    expect(call?.selection?.anchor).toBe(head + insert.length);
  });

  // A file named `terminal` at the cwd root relativizes to a bare `terminal`,
  // which the send path would otherwise resolve as "inject the terminal
  // buffer" instead of referencing the file.
  it("keeps a cwd-root file that collides with a reserved token a path", async () => {
    pathForFile.mockReturnValue(`${CWD}/terminal`);
    const { dispatch, ref } = fakeView();
    const { result } = renderHook(() => useDragDrop(ref, CWD));

    await act(async () => {
      await result.current.handleDrop(dropEvent([fakeFile("terminal")]));
    });

    expect(insertedToken(dispatch)).toBe("@./terminal");
  });

  // Images insert a bare path rather than an `@file` token and are out of this
  // issue's scope — the range math for them must stay untouched.
  it("leaves a dropped image inserting its absolute path", async () => {
    const absolute = `${CWD}/shot.png`;
    pathForFile.mockReturnValue(absolute);
    const { dispatch, ref } = fakeView();
    const { result } = renderHook(() => useDragDrop(ref, CWD));

    await act(async () => {
      await result.current.handleDrop(dropEvent([fakeFile("shot.png")]));
    });

    const insert = dispatch.mock.calls[0]?.[0]?.changes?.insert as string;
    expect(insert.trimEnd()).toBe(absolute);
    const [chip] = effectValues(dispatch);
    expect((chip?.to as number) - (chip?.from as number)).toBe(absolute.length);
  });

  // A thumbnail failure demotes the image to the regular file branch, which
  // does produce an `@file` token and so must relativize like any other file.
  it("relativizes an image that falls back to the file branch", async () => {
    pathForFile.mockReturnValue(`${CWD}/shot.png`);
    thumbnailFromPath.mockRejectedValue(new Error("no thumbnail"));
    const { dispatch, ref } = fakeView();
    const { result } = renderHook(() => useDragDrop(ref, CWD));

    await act(async () => {
      await result.current.handleDrop(dropEvent([fakeFile("shot.png")]));
    });

    expect(insertedToken(dispatch)).toBe("@shot.png");
  });

  it("does not dispatch when every dropped file resolves to no path", async () => {
    pathForFile.mockReturnValue("");
    const { view, ref } = fakeView();
    const { result } = renderHook(() => useDragDrop(ref, CWD));

    await act(async () => {
      await result.current.handleDrop(dropEvent([fakeFile("App.tsx")]));
    });

    expect(view.dispatch).not.toHaveBeenCalled();
  });

  // A drag out of the file browser (#11576). It carries paths instead of
  // `File` objects, so the gate and the payload both have a second source —
  // everything downstream has to stay the OS drop's.
  describe("in-app file drag", () => {
    it("lights the drop affordance up for the in-app type", () => {
      const { ref } = fakeView();
      const { result } = renderHook(() => useDragDrop(ref, CWD));
      const enter = dragEvent([FILE_DRAG_MIME]);

      act(() => {
        result.current.handleDragEnter(enter);
      });

      expect(enter.preventDefault).toHaveBeenCalled();
      expect(result.current.isDragOverFiles).toBe(true);
    });

    it("accepts the in-app type as a copy", () => {
      const { ref } = fakeView();
      const { result } = renderHook(() => useDragDrop(ref, CWD));
      const over = dragEvent([FILE_DRAG_MIME]);

      act(() => {
        result.current.handleDragOver(over);
      });

      expect(over.preventDefault).toHaveBeenCalled();
      expect(over.dataTransfer.dropEffect).toBe("copy");
    });

    // Chromium blanks `getData` until the drop, so a gate that reached for the
    // payload would refuse every in-app drag it is supposed to advertise.
    it("gates on the type alone, never on the payload", () => {
      const { ref } = fakeView();
      const { result } = renderHook(() => useDragDrop(ref, CWD));
      const enter = dragEvent([FILE_DRAG_MIME]);
      const over = dragEvent([FILE_DRAG_MIME]);

      act(() => {
        result.current.handleDragEnter(enter);
        result.current.handleDragOver(over);
      });

      expect(enter.dataTransfer.getData).not.toHaveBeenCalled();
      expect(over.dataTransfer.getData).not.toHaveBeenCalled();
    });

    it("ignores a drag carrying neither files nor the in-app type", () => {
      const { ref } = fakeView();
      const { result } = renderHook(() => useDragDrop(ref, CWD));
      const enter = dragEvent(["text/plain"]);

      act(() => {
        result.current.handleDragEnter(enter);
      });

      expect(enter.preventDefault).not.toHaveBeenCalled();
      expect(result.current.isDragOverFiles).toBe(false);
    });

    // The bar the whole feature is measured against: dragging a row must
    // produce what dropping the same file from Finder produces.
    it("inserts the same cwd-relative token an OS drop of the file produces", async () => {
      const { dispatch, ref } = fakeView();
      const { result } = renderHook(() => useDragDrop(ref, CWD));

      await act(async () => {
        await result.current.handleDrop(internalDrop([`${CWD}/src/App.tsx`]));
      });

      expect(insertedToken(dispatch)).toBe("@src/App.tsx");
    });

    it("stores the absolute path on the chip and names it from the path", async () => {
      const absolute = `${CWD}/src/App.tsx`;
      const { dispatch, ref } = fakeView();
      const { result } = renderHook(() => useDragDrop(ref, CWD));

      await act(async () => {
        await result.current.handleDrop(internalDrop([absolute]));
      });

      const [chip] = effectValues(dispatch);
      expect(chip?.filePath).toBe(absolute);
      expect(chip?.fileName).toBe("App.tsx");
      // No `File` behind an in-app drag, so no size — the chip already treats
      // it as optional rather than this reaching for a stat over IPC.
      expect(chip?.fileSize).toBeUndefined();
    });

    it("keeps a reserved-name collision a path", async () => {
      const { dispatch, ref } = fakeView();
      const { result } = renderHook(() => useDragDrop(ref, CWD));

      await act(async () => {
        await result.current.handleDrop(internalDrop([`${CWD}/terminal`]));
      });

      expect(insertedToken(dispatch)).toBe("@./terminal");
    });

    it("quotes a dragged path that needs it", async () => {
      const { dispatch, ref } = fakeView();
      const { result } = renderHook(() => useDragDrop(ref, CWD));

      await act(async () => {
        await result.current.handleDrop(internalDrop([`${CWD}/my notes.md`]));
      });

      expect(insertedToken(dispatch)).toBe('@"my notes.md"');
    });

    // A folder is a meaningful reference for an agent and drags like any file.
    it("references a dragged folder", async () => {
      const { dispatch, ref } = fakeView();
      const { result } = renderHook(() => useDragDrop(ref, CWD));

      await act(async () => {
        await result.current.handleDrop(internalDrop([`${CWD}/src/components`]));
      });

      expect(insertedToken(dispatch)).toBe("@src/components");
    });

    it("keeps chip ranges aligned across several dragged paths", async () => {
      const { dispatch, ref, head } = fakeView(11);
      const { result } = renderHook(() => useDragDrop(ref, CWD));

      await act(async () => {
        await result.current.handleDrop(internalDrop([`${CWD}/src/a.ts`, `${CWD}/src/b.ts`]));
      });

      expect(chipSpellings(dispatch, head)).toEqual(["@src/a.ts", "@src/b.ts"]);
    });

    // Matching the OS drop means matching it for images too: Finder's drop of
    // a PNG yields a thumbnail chip, so dragging that row must as well.
    it("thumbnails a dragged image exactly as an OS drop does", async () => {
      const absolute = `${CWD}/shot.png`;
      const { dispatch, ref } = fakeView();
      const { result } = renderHook(() => useDragDrop(ref, CWD));

      await act(async () => {
        await result.current.handleDrop(internalDrop([absolute]));
      });

      expect(thumbnailFromPath).toHaveBeenCalledWith(absolute);
      const insert = dispatch.mock.calls[0]?.[0]?.changes?.insert as string;
      expect(insert.trimEnd()).toBe(absolute);
    });

    // A folder whose name ends in an image extension takes the same recovery a
    // corrupt image already takes, rather than needing its own payload field.
    it("falls back to a file chip when the thumbnail fails", async () => {
      thumbnailFromPath.mockRejectedValue(new Error("not an image"));
      const { dispatch, ref } = fakeView();
      const { result } = renderHook(() => useDragDrop(ref, CWD));

      await act(async () => {
        await result.current.handleDrop(internalDrop([`${CWD}/assets.png`]));
      });

      expect(insertedToken(dispatch)).toBe("@assets.png");
    });

    // The OS path would resolve nothing for a drag that has no `File` at all.
    it("never asks the OS to resolve a path it was handed", async () => {
      const { ref } = fakeView();
      const { result } = renderHook(() => useDragDrop(ref, CWD));

      await act(async () => {
        await result.current.handleDrop(internalDrop([`${CWD}/src/App.tsx`]));
      });

      expect(pathForFile).not.toHaveBeenCalled();
    });

    it("reads the payload from the in-app type", async () => {
      const getData = vi.fn(() => encodeFileDragPaths([`${CWD}/src/App.tsx`]));
      const { ref } = fakeView();
      const { result } = renderHook(() => useDragDrop(ref, CWD));

      await act(async () => {
        await result.current.handleDrop(internalDropEvent("", getData));
      });

      expect(getData).toHaveBeenCalledWith(FILE_DRAG_MIME);
    });

    // The payload is only readable once the drop has already been advertised,
    // so a malformed one has to fail quietly rather than insert something.
    it("dispatches nothing for a malformed payload but still clears the overlay", async () => {
      const { view, ref } = fakeView();
      const { result } = renderHook(() => useDragDrop(ref, CWD));

      act(() => {
        result.current.handleDragEnter(dragEvent([FILE_DRAG_MIME]));
      });
      expect(result.current.isDragOverFiles).toBe(true);

      await act(async () => {
        await result.current.handleDrop(internalDropEvent("not json"));
      });

      expect(view.dispatch).not.toHaveBeenCalled();
      expect(result.current.isDragOverFiles).toBe(false);
    });

    it("dispatches nothing for a payload carrying a relative path", async () => {
      const { view, ref } = fakeView();
      const { result } = renderHook(() => useDragDrop(ref, CWD));

      await act(async () => {
        await result.current.handleDrop(internalDropEvent(encodeFileDragPaths(["src/App.tsx"])));
      });

      expect(view.dispatch).not.toHaveBeenCalled();
    });

    // Draining both would insert every reference twice.
    it("prefers the in-app payload when files ride along too", async () => {
      pathForFile.mockReturnValue(`${CWD}/from-os.ts`);
      const { dispatch, ref } = fakeView();
      const { result } = renderHook(() => useDragDrop(ref, CWD));
      const event = dragEventWith({
        files: [fakeFile("from-os.ts")],
        types: ["Files", FILE_DRAG_MIME],
        getData: () => encodeFileDragPaths([`${CWD}/src/App.tsx`]),
      });

      await act(async () => {
        await result.current.handleDrop(event);
      });

      expect(effectValues(dispatch)).toHaveLength(1);
      expect(insertedToken(dispatch)).toBe("@src/App.tsx");
    });
  });
});
