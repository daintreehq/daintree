// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { EditorView } from "@codemirror/view";

type PasteFile = { path: string; name: string; size: number };
type PasteCallback = (view: EditorView, files: PasteFile[]) => void;

// The whole module is stubbed rather than partially mocked: pulling the real
// index in drags the CodeMirror extension graph (and, transitively, electron)
// into a suite that only needs to observe what the paste callback dispatches.
const captured: { filePaste: PasteCallback | null } = { filePaste: null };

vi.mock("../../inputEditorExtensions", () => ({
  createImagePasteHandler: vi.fn(() => ({ kind: "image-paste" })),
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

const CWD = "/Users/greg/Projects/daintree";

function fakeView(head = 0) {
  const dispatch = vi.fn();
  const view = {
    state: { selection: { main: { head } } },
    dispatch,
  } as unknown as EditorView;
  return { view, dispatch, head };
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

beforeEach(() => {
  captured.filePaste = null;
  vi.clearAllMocks();
});

describe("usePasteExtensions", () => {
  it("inserts a cwd-relative @file token for a file pasted from inside the worktree", () => {
    renderHook(() => usePasteExtensions(CWD));
    const { view, dispatch } = fakeView();

    captured.filePaste?.(view, [pasted("App.tsx", `${CWD}/src/App.tsx`)]);

    expect(insertedToken(dispatch)).toBe("@src/App.tsx");
  });

  it("keeps the absolute @file token for a file pasted from outside the worktree", () => {
    renderHook(() => usePasteExtensions(CWD));
    const { view, dispatch } = fakeView();
    const outside = "/etc/hosts.ts";

    captured.filePaste?.(view, [pasted("hosts.ts", outside)]);

    expect(insertedToken(dispatch)).toBe(`@${outside}`);
  });

  // The regression this hook's ref exists for. `useEditorFactory` installs the
  // paste extension once, while building the initial EditorState under an
  // effect keyed on terminalId alone — so a memo rebuilt on `cwd` would hand
  // the editor an object it never installs. The extension the editor is
  // actually holding is the one that has to see the post-`cd` cwd.
  it("relativizes against the current cwd through the extension installed at mount", () => {
    const { rerender } = renderHook(({ cwd }) => usePasteExtensions(cwd), {
      initialProps: { cwd: "/somewhere/else" },
    });
    const installed = captured.filePaste;

    rerender({ cwd: CWD });

    const { view, dispatch } = fakeView();
    installed?.(view, [pasted("App.tsx", `${CWD}/src/App.tsx`)]);

    expect(insertedToken(dispatch)).toBe("@src/App.tsx");
  });

  it("does not rebuild the paste extension when cwd changes", () => {
    const { result, rerender } = renderHook(({ cwd }) => usePasteExtensions(cwd), {
      initialProps: { cwd: "/somewhere/else" },
    });
    const first = result.current.filePasteExtension;

    rerender({ cwd: CWD });

    expect(result.current.filePasteExtension).toBe(first);
    expect(createFilePasteHandler).toHaveBeenCalledTimes(1);
  });

  it("stores the absolute path on the chip while the document text stays relative", () => {
    renderHook(() => usePasteExtensions(CWD));
    const { view, dispatch } = fakeView();
    const absolute = `${CWD}/src/App.tsx`;

    captured.filePaste?.(view, [pasted("App.tsx", absolute)]);

    const [chip] = effectValues(dispatch);
    expect(chip?.filePath).toBe(absolute);
    expect(insertedToken(dispatch)).not.toContain(CWD);
  });

  it("keeps consecutive chip ranges aligned with their tokens when several files paste at once", () => {
    renderHook(() => usePasteExtensions(CWD));
    const { view, dispatch, head } = fakeView(31);

    captured.filePaste?.(view, [
      pasted("a.ts", `${CWD}/src/a.ts`),
      pasted("b.ts", `${CWD}/src/b.ts`),
    ]);

    expect(effectValues(dispatch)).toHaveLength(2);
    expect(chipSpellings(dispatch, head)).toEqual(["@src/a.ts", "@src/b.ts"]);
  });

  it("inserts at the cursor and leaves the caret after everything it inserted", () => {
    renderHook(() => usePasteExtensions(CWD));
    const { view, dispatch, head } = fakeView(12);

    captured.filePaste?.(view, [pasted("App.tsx", `${CWD}/src/App.tsx`)]);

    const call = dispatch.mock.calls[0]?.[0];
    const insert = call?.changes?.insert as string;
    expect(call?.changes?.from).toBe(head);
    expect(call?.selection?.anchor).toBe(head + insert.length);
  });

  it("keeps a cwd-root file that collides with a reserved token a path", () => {
    renderHook(() => usePasteExtensions(CWD));
    const { view, dispatch } = fakeView();

    captured.filePaste?.(view, [pasted("selection", `${CWD}/selection`)]);

    expect(insertedToken(dispatch)).toBe("@./selection");
  });
});
