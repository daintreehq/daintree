// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { EditorView } from "@codemirror/view";

type PasteFile = { path: string; name: string; size: number };
type PasteCallback = (view: EditorView, files: PasteFile[]) => void | Promise<void>;

// The whole module is stubbed rather than partially mocked: pulling the real
// index in drags the CodeMirror extension graph (and, transitively, electron)
// into a suite that only needs to observe what the paste callback dispatches.
type ImagePasteCallback = (view: EditorView) => void | Promise<void>;
const captured: { filePaste: PasteCallback | null; imagePaste: ImagePasteCallback | null } = {
  filePaste: null,
  imagePaste: null,
};

vi.mock("../../inputEditorExtensions", () => ({
  createImagePasteHandler: vi.fn((cb: ImagePasteCallback) => {
    captured.imagePaste = cb;
    return { kind: "image-paste" };
  }),
  createPlainPasteKeymap: vi.fn(() => ({ kind: "plain-paste" })),
  createFilePasteHandler: vi.fn((cb: PasteCallback) => {
    captured.filePaste = cb;
    return { kind: "file-paste" };
  }),
  addImageChip: { of: vi.fn((value: unknown) => ({ value })) },
  addFileDropChip: { of: vi.fn((value: unknown) => ({ value })) },
}));

const { usePasteExtensions } = await import("../usePasteExtensions");
const { createFilePasteHandler } = await import("../../inputEditorExtensions");
const { setRemoteMaterializer } = await import("@/services/materialize");
const { getPendingUploads, _resetPendingUploadsForTests } =
  await import("../../uploads/pendingUploads");

const CWD = "/Users/greg/Projects/daintree";

/** `head` may be a getter, for a caret that moves while a paste resolves. */
function fakeView(head: number | (() => number) = 0) {
  const dispatch = vi.fn();
  const main = {
    get head() {
      return typeof head === "function" ? head() : head;
    },
  };
  const view = {
    state: { selection: { main } },
    dispatch,
  } as unknown as EditorView;
  return { view, dispatch, head: main.head };
}

function pasted(name: string, path: string): PasteFile {
  return { path, name, size: 42 };
}

function insertedToken(dispatch: ReturnType<typeof vi.fn>): string {
  const insert = dispatch.mock.calls[0]?.[0]?.changes?.insert as string;
  return insert.trimEnd();
}

function effectValues(dispatch: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  const effects = dispatch.mock.calls[0]?.[0]?.effects as { value: Record<string, unknown> }[];
  return effects.map((e) => e.value);
}

/** What each chip range actually covers in the document. */
function chipSpellings(dispatch: ReturnType<typeof vi.fn>, head: number): string[] {
  const insert = dispatch.mock.calls[0]?.[0]?.changes?.insert as string;
  return effectValues(dispatch).map((chip) =>
    insert.slice((chip.from as number) - head, (chip.to as number) - head)
  );
}

const saveImage = vi.fn(async () => ({
  filePath: "/tmp/daintree-clipboard/clipboard-1-abc.png",
  thumbnailDataUrl: "data:image/png;base64,abc",
}));

beforeEach(() => {
  captured.filePaste = null;
  captured.imagePaste = null;
  vi.clearAllMocks();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { clipboard: { saveImage } },
  });
});

afterEach(() => {
  setRemoteMaterializer(null);
  Reflect.deleteProperty(window, "electron");
});

describe("usePasteExtensions", () => {
  it("inserts a cwd-relative @file token for a file pasted from inside the worktree", async () => {
    renderHook(() => usePasteExtensions(CWD));
    const { view, dispatch } = fakeView();

    await captured.filePaste?.(view, [pasted("App.tsx", `${CWD}/src/App.tsx`)]);

    expect(insertedToken(dispatch)).toBe("@src/App.tsx");
  });

  it("keeps the absolute @file token for a file pasted from outside the worktree", async () => {
    renderHook(() => usePasteExtensions(CWD));
    const { view, dispatch } = fakeView();
    const outside = "/etc/hosts.ts";

    await captured.filePaste?.(view, [pasted("hosts.ts", outside)]);

    expect(insertedToken(dispatch)).toBe(`@${outside}`);
  });

  // The regression this hook's ref exists for. `useEditorFactory` installs the
  // paste extension once, while building the initial EditorState under an
  // effect keyed on terminalId alone — so a memo rebuilt on `cwd` would hand
  // the editor an object it never installs. The extension the editor is
  // actually holding is the one that has to see the post-`cd` cwd.
  it("relativizes against the current cwd through the extension installed at mount", async () => {
    const { rerender } = renderHook(({ cwd }) => usePasteExtensions(cwd), {
      initialProps: { cwd: "/somewhere/else" },
    });
    const installed = captured.filePaste;

    rerender({ cwd: CWD });

    const { view, dispatch } = fakeView();
    await installed?.(view, [pasted("App.tsx", `${CWD}/src/App.tsx`)]);

    expect(insertedToken(dispatch)).toBe("@src/App.tsx");
  });

  it("does not rebuild the paste extension when cwd changes", async () => {
    const { result, rerender } = renderHook(({ cwd }) => usePasteExtensions(cwd), {
      initialProps: { cwd: "/somewhere/else" },
    });
    const first = result.current.filePasteExtension;

    rerender({ cwd: CWD });

    expect(result.current.filePasteExtension).toBe(first);
    expect(createFilePasteHandler).toHaveBeenCalledTimes(1);
  });

  it("stores the absolute path on the chip while the document text stays relative", async () => {
    renderHook(() => usePasteExtensions(CWD));
    const { view, dispatch } = fakeView();
    const absolute = `${CWD}/src/App.tsx`;

    await captured.filePaste?.(view, [pasted("App.tsx", absolute)]);

    const [chip] = effectValues(dispatch);
    expect(chip?.filePath).toBe(absolute);
    expect(insertedToken(dispatch)).not.toContain(CWD);
  });

  it("keeps consecutive chip ranges aligned with their tokens when several files paste at once", async () => {
    renderHook(() => usePasteExtensions(CWD));
    const { view, dispatch, head } = fakeView(31);

    await captured.filePaste?.(view, [
      pasted("a.ts", `${CWD}/src/a.ts`),
      pasted("b.ts", `${CWD}/src/b.ts`),
    ]);

    expect(effectValues(dispatch)).toHaveLength(2);
    expect(chipSpellings(dispatch, head)).toEqual(["@src/a.ts", "@src/b.ts"]);
  });

  it("inserts at the cursor and leaves the caret after everything it inserted", async () => {
    renderHook(() => usePasteExtensions(CWD));
    const { view, dispatch, head } = fakeView(12);

    await captured.filePaste?.(view, [pasted("App.tsx", `${CWD}/src/App.tsx`)]);

    const call = dispatch.mock.calls[0]?.[0];
    const insert = call?.changes?.insert as string;
    expect(call?.changes?.from).toBe(head);
    expect(call?.selection?.anchor).toBe(head + insert.length);
  });

  it("keeps a cwd-root file that collides with a reserved token a path", async () => {
    renderHook(() => usePasteExtensions(CWD));
    const { view, dispatch } = fakeView();

    await captured.filePaste?.(view, [pasted("selection", `${CWD}/selection`)]);

    expect(insertedToken(dispatch)).toBe("@./selection");
  });
});

describe("usePasteExtensions — materialize seam", () => {
  it("pastes a clipboard image as its raw path behind an image chip, as before", async () => {
    renderHook(() => usePasteExtensions(CWD));
    const { view, dispatch } = fakeView(5);
    const path = "/tmp/daintree-clipboard/clipboard-1-abc.png";

    await captured.imagePaste?.(view);

    expect(saveImage).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toEqual({
      changes: { from: 5, insert: path + " " },
      effects: {
        value: {
          from: 5,
          to: 5 + path.length,
          filePath: path,
          thumbnailUrl: "data:image/png;base64,abc",
        },
      },
      selection: { anchor: 5 + path.length + 1 },
    });
  });

  it("references a pasted image as a file when no thumbnail came back", async () => {
    setRemoteMaterializer(async () => ({
      hostPath: `${CWD}/.inbox/clip.png`,
      displayName: "clip.png",
      bytes: 10,
    }));
    renderHook(() => usePasteExtensions(CWD));
    const { view, dispatch } = fakeView();

    await captured.imagePaste?.(view);

    expect(insertedToken(dispatch)).toBe("@.inbox/clip.png");
    expect(dispatch.mock.calls[0]?.[0]?.effects?.value).toMatchObject({
      filePath: `${CWD}/.inbox/clip.png`,
      fileName: "clip.png",
    });
  });

  it("materializes pasted files as local files and inserts the returned paths", async () => {
    const seen: unknown[] = [];
    setRemoteMaterializer(async (source) => {
      seen.push(source);
      return { hostPath: "/host/inbox/files/App.tsx", displayName: "App.tsx", bytes: 1 };
    });
    renderHook(() => usePasteExtensions(CWD));
    const { view, dispatch } = fakeView();

    await captured.filePaste?.(view, [pasted("App.tsx", "/Users/me/App.tsx")]);

    expect(seen).toEqual([{ kind: "local-file", path: "/Users/me/App.tsx" }]);
    expect(insertedToken(dispatch)).toBe("@/host/inbox/files/App.tsx");
    expect(effectValues(dispatch)[0]).toMatchObject({ fileName: "App.tsx", fileSize: 42 });
  });

  it("skips a pasted file that fails to materialize, and dispatches nothing if all fail", async () => {
    setRemoteMaterializer(async () => {
      throw new Error("refused");
    });
    renderHook(() => usePasteExtensions(CWD));
    const { view, dispatch } = fakeView();

    await captured.filePaste?.(view, [pasted("a.ts", `${CWD}/a.ts`)]);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reads the caret after the paths resolve, not before", async () => {
    let release!: () => void;
    setRemoteMaterializer(
      (source) =>
        new Promise((resolve) => {
          release = () =>
            resolve({ hostPath: "path" in source ? source.path : "", displayName: "x", bytes: 0 });
        })
    );
    renderHook(() => usePasteExtensions(CWD));
    let caret = 0;
    const { view, dispatch } = fakeView(() => caret);

    const pending = captured.filePaste?.(view, [pasted("a.ts", `${CWD}/a.ts`)]);
    caret = 9;
    release();
    await pending;

    expect(dispatch.mock.calls[0]?.[0]?.changes?.from).toBe(9);
  });
});

describe("usePasteExtensions: an image pasted in a remote window's composer", () => {
  beforeEach(() => {
    _resetPendingUploadsForTests();
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
  });

  afterEach(() => {
    delete window.__DAINTREE_HOST_ID__;
    _resetPendingUploadsForTests();
  });

  it("hands the upload the chip's progress and cancel, and inserts nothing once cancelled", async () => {
    let seen: { onProgress?: (fraction: number) => void; signal?: AbortSignal } | undefined;
    let finish!: () => void;
    setRemoteMaterializer((source, options) => {
      seen = options;
      return new Promise((resolve, reject) => {
        options?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" }))
        );
        finish = () =>
          resolve({
            hostPath: "/tmp/daintree-inbox/clipboard/clipboard-1.png",
            displayName: "clipboard-1.png",
            bytes: null,
            thumbnail: "data:image/png;base64,AA",
          });
        void source;
      });
    });
    renderHook(() => usePasteExtensions(CWD, "composer:t1"));
    const { view, dispatch } = fakeView();

    const pending = captured.imagePaste?.(view);
    await vi.waitFor(() => expect(seen?.signal).toBeInstanceOf(AbortSignal));
    seen!.onProgress?.(0.42);
    const [chip] = getPendingUploads("composer:t1");
    expect(chip?.fraction).toBe(0.42);

    chip!.cancel();
    finish();
    await pending;

    expect(seen!.signal!.aborted).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(getPendingUploads("composer:t1")).toHaveLength(0);
  });
});
