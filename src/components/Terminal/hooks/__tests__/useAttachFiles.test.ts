// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { EditorView } from "@codemirror/view";

// `fileAttachments` reaches `useTerminalFileTransfer` for one regex, but that
// module constructs the `terminalInstanceService` singleton at import time.
vi.mock("../../useTerminalFileTransfer", () => ({
  IMAGE_EXTENSIONS: /\.(png|jpe?g|bmp|tiff?|avif|heic)$/i,
}));

const logError = vi.hoisted(() => vi.fn());
vi.mock("@/utils/logger", () => ({ logError }));

const { useAttachFiles } = await import("../useAttachFiles");
const { getAllAtFileTokens } = await import("../../hybridInputParsing");

const CWD = "/Users/greg/Projects/daintree";

/** `before` is the document text ahead of the caret; whitespace unless a test says otherwise. */
function fakeView(head = 0, before = " ".repeat(head)) {
  const dispatch = vi.fn();
  const focus = vi.fn();
  const view = {
    state: {
      selection: { main: { head } },
      doc: { sliceString: (from: number, to: number) => before.slice(from, to) },
    },
    dispatch,
    focus,
  } as unknown as EditorView;
  return { view, dispatch, focus, ref: { current: view } as React.RefObject<EditorView | null> };
}

function insertedText(dispatch: ReturnType<typeof vi.fn>): string {
  return dispatch.mock.calls[0]?.[0]?.changes?.insert as string;
}

function effectValues(dispatch: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  const effects = dispatch.mock.calls[0]?.[0]?.effects as { value: Record<string, unknown> }[];
  return effects.map((e) => e.value);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let pickAttachments: Mock<() => Promise<string[]>>;
let thumbnailFromPath: ReturnType<typeof vi.fn>;

beforeEach(() => {
  logError.mockClear();
  pickAttachments = vi.fn<() => Promise<string[]>>(async () => []);
  thumbnailFromPath = vi.fn(async () => ({ thumbnailDataUrl: "data:image/png;base64,x" }));
  (window as unknown as { electron: unknown }).electron = {
    clipboard: { pickAttachments, thumbnailFromPath },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { electron?: unknown }).electron;
});

describe("useAttachFiles", () => {
  it("inserts a picked file as an @file token that round-trips to its cwd-relative path", async () => {
    pickAttachments.mockResolvedValue([`${CWD}/logs/build output.log`]);
    const { dispatch, focus, ref } = fakeView();
    const { result } = renderHook(() => useAttachFiles(ref, CWD));

    await act(async () => {
      await result.current();
    });

    const text = insertedText(dispatch).trimEnd();
    const tokens = getAllAtFileTokens(text);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ start: 0, end: text.length, path: "logs/build output.log" });
    expect(focus).toHaveBeenCalled();
  });

  it("keeps the chip's metadata absolute and sizeless, naming it after the file", async () => {
    const absolute = `${CWD}/notes.txt`;
    pickAttachments.mockResolvedValue([absolute]);
    const { dispatch, ref } = fakeView();
    const { result } = renderHook(() => useAttachFiles(ref, CWD));

    await act(async () => {
      await result.current();
    });

    expect(effectValues(dispatch)).toEqual([
      expect.objectContaining({ filePath: absolute, fileName: "notes.txt", fileSize: undefined }),
    ]);
  });

  it("keeps the path absolute when the composer has no cwd", async () => {
    pickAttachments.mockResolvedValue(["/var/log/app.log"]);
    const { dispatch, ref } = fakeView();
    const { result } = renderHook(() => useAttachFiles(ref, ""));

    await act(async () => {
      await result.current();
    });

    const tokens = getAllAtFileTokens(insertedText(dispatch));
    expect(tokens.map((t) => t.path)).toEqual(["/var/log/app.log"]);
  });

  it("inserts an image as its absolute path behind a thumbnail chip", async () => {
    const shot = "/Users/greg/Desktop/shot.png";
    pickAttachments.mockResolvedValue([shot]);
    const { dispatch, ref } = fakeView();
    const { result } = renderHook(() => useAttachFiles(ref, CWD));

    await act(async () => {
      await result.current();
    });

    expect(thumbnailFromPath).toHaveBeenCalledWith(shot);
    expect(insertedText(dispatch).trimEnd()).toBe(shot);
    expect(effectValues(dispatch)).toEqual([
      expect.objectContaining({ filePath: shot, thumbnailUrl: "data:image/png;base64,x" }),
    ]);
  });

  // A screenshot off the Desktop sits outside every thumbnail root, so main
  // refuses the preview. The reference still has to go in.
  it("falls back to a file chip when the image can't be previewed", async () => {
    const shot = "/Users/greg/Desktop/shot.png";
    pickAttachments.mockResolvedValue([shot]);
    thumbnailFromPath.mockRejectedValue(new Error("outside allowed roots"));
    const { dispatch, ref } = fakeView();
    const { result } = renderHook(() => useAttachFiles(ref, CWD));

    await act(async () => {
      await result.current();
    });

    expect(getAllAtFileTokens(insertedText(dispatch)).map((t) => t.path)).toEqual([shot]);
    expect(effectValues(dispatch)).toEqual([
      expect.objectContaining({ filePath: shot, fileName: "shot.png" }),
    ]);
  });

  it("inserts several files in the picked order, each chip covering exactly its own text", async () => {
    const head = 5;
    pickAttachments.mockResolvedValue([`${CWD}/a.ts`, "/tmp/b.png", `${CWD}/c d.md`]);
    const { dispatch, ref } = fakeView(head);
    const { result } = renderHook(() => useAttachFiles(ref, CWD));

    await act(async () => {
      await result.current();
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const insert = insertedText(dispatch);
    // Image effects are emitted ahead of file effects, so read them back in
    // document order.
    const spans = effectValues(dispatch)
      .sort((a, b) => (a.from as number) - (b.from as number))
      .map((chip) => insert.slice((chip.from as number) - head, (chip.to as number) - head));
    expect(spans[1]).toBe("/tmp/b.png");
    expect(getAllAtFileTokens(spans[0]!).map((t) => t.path)).toEqual(["a.ts"]);
    expect(getAllAtFileTokens(spans[2]!).map((t) => t.path)).toEqual(["c d.md"]);
    expect(dispatch.mock.calls[0]![0].selection).toEqual({ anchor: head + insert.length });
  });

  // Type a sentence, then reach for the button: the caret sits right after the
  // last word, where neither an `@file` token nor a bare path would parse.
  it("separates what it inserts from the word the caret sits right after", async () => {
    const before = "compare this";
    pickAttachments.mockResolvedValue([`${CWD}/a.ts`, "/tmp/b.png"]);
    const { dispatch, ref } = fakeView(before.length, before);
    const { result } = renderHook(() => useAttachFiles(ref, CWD));

    await act(async () => {
      await result.current();
    });

    const doc = before + insertedText(dispatch);
    expect(getAllAtFileTokens(doc).map((t) => t.path)).toEqual(["a.ts"]);
    expect(doc.split(/\s+/)).toContain("/tmp/b.png");
    const spans = effectValues(dispatch).map((chip) =>
      doc.slice(chip.from as number, chip.to as number)
    );
    expect(spans.sort()).toEqual(["/tmp/b.png", "@a.ts"].sort());
  });

  it("adds no separator after an opening bracket, where a token already parses", async () => {
    const before = "see (";
    pickAttachments.mockResolvedValue([`${CWD}/a.ts`]);
    const { dispatch, ref } = fakeView(before.length, before);
    const { result } = renderHook(() => useAttachFiles(ref, CWD));

    await act(async () => {
      await result.current();
    });

    const doc = before + insertedText(dispatch);
    expect(doc.startsWith("see (@")).toBe(true);
    expect(getAllAtFileTokens(doc).map((t) => t.path)).toEqual(["a.ts"]);
  });

  it("does nothing when the picker is cancelled", async () => {
    pickAttachments.mockResolvedValue([]);
    const { dispatch, focus, ref } = fakeView();
    const { result } = renderHook(() => useAttachFiles(ref, CWD));

    await act(async () => {
      await result.current();
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it("logs a picker failure without touching the draft", async () => {
    pickAttachments.mockRejectedValue(new Error("dialog unavailable"));
    const { dispatch, ref } = fakeView();
    const { result } = renderHook(() => useAttachFiles(ref, CWD));

    await act(async () => {
      await result.current();
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("doesn't open the picker when there is no editor to insert into", async () => {
    const ref = { current: null } as React.RefObject<EditorView | null>;
    const { result } = renderHook(() => useAttachFiles(ref, CWD));

    await act(async () => {
      await result.current();
    });

    expect(pickAttachments).not.toHaveBeenCalled();
  });

  it("drops the selection when the editor was replaced while the picker was open", async () => {
    const pending = deferred<string[]>();
    pickAttachments.mockReturnValue(pending.promise);
    const original = fakeView();
    const replacement = fakeView();
    const ref = original.ref as { current: EditorView | null };
    const { result } = renderHook(() => useAttachFiles(ref, CWD));

    let run!: Promise<void>;
    act(() => {
      run = result.current();
    });
    ref.current = replacement.view;

    await act(async () => {
      pending.resolve([`${CWD}/a.ts`]);
      await run;
    });

    expect(original.dispatch).not.toHaveBeenCalled();
    expect(replacement.dispatch).not.toHaveBeenCalled();
    expect(original.focus).not.toHaveBeenCalled();
  });

  it("drops the selection when the editor was torn down while the picker was open", async () => {
    const pending = deferred<string[]>();
    pickAttachments.mockReturnValue(pending.promise);
    const { dispatch, ref } = fakeView();
    const { result } = renderHook(() => useAttachFiles(ref, CWD));

    let run!: Promise<void>;
    act(() => {
      run = result.current();
    });
    (ref as { current: EditorView | null }).current = null;

    await act(async () => {
      pending.resolve([`${CWD}/a.ts`]);
      await run;
    });

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("opens one picker at a time", async () => {
    const pending = deferred<string[]>();
    pickAttachments.mockReturnValue(pending.promise);
    const { ref } = fakeView();
    const { result } = renderHook(() => useAttachFiles(ref, CWD));

    let first!: Promise<void>;
    await act(async () => {
      first = result.current();
      await result.current();
    });
    expect(pickAttachments).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve([]);
      await first;
    });

    pickAttachments.mockResolvedValue([]);
    await act(async () => {
      await result.current();
    });
    expect(pickAttachments).toHaveBeenCalledTimes(2);
  });
});
