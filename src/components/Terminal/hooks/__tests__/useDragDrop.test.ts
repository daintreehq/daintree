// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { EditorView } from "@codemirror/view";
import { useDragDrop } from "../useDragDrop";

const CWD = "/Users/greg/Projects/daintree";

function fakeView() {
  const dispatch = vi.fn();
  const view = {
    state: { selection: { main: { head: 0 } } },
    dispatch,
  } as unknown as EditorView;
  return { view, dispatch, ref: { current: view } as React.RefObject<EditorView | null> };
}

function dropEvent(files: File[]): React.DragEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: { files, types: ["Files"] },
  } as unknown as React.DragEvent;
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
    const { dispatch, ref } = fakeView();
    const { result } = renderHook(() => useDragDrop(ref, CWD));

    await act(async () => {
      await result.current.handleDrop(dropEvent([fakeFile("a.ts"), fakeFile("b.ts")]));
    });

    const insert = dispatch.mock.calls[0]?.[0]?.changes?.insert as string;
    for (const chip of effectValues(dispatch)) {
      const from = chip.from as number;
      const to = chip.to as number;
      expect(insert.slice(from, to)).toBe(`@src/${chip.fileName as string}`);
    }
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
});
