// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

// jsdom does not implement Trusted Types; chip widgets render through it.
vi.mock("@/lib/trustedTypesPolicy", () => ({
  createTrustedHTML: (s: string) => s,
  setTrustedInnerHTML: (el: Element, html: string) => {
    el.innerHTML = html;
  },
}));

type FilePasteCallback = (
  view: EditorView,
  files: { path: string; name: string; size: number }[]
) => void | Promise<void>;
type ImagePasteCallback = (view: EditorView) => void | Promise<void>;
const captured: { filePaste: FilePasteCallback | null; imagePaste: ImagePasteCallback | null } = {
  filePaste: null,
  imagePaste: null,
};

// The real extensions and chip fields run; only the callbacks the hook hands
// to the paste handlers are kept so a test can invoke them without a native
// clipboard event.
vi.mock("../../inputEditorExtensions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../inputEditorExtensions")>();
  return {
    ...actual,
    createImagePasteHandler: (cb: ImagePasteCallback) => {
      captured.imagePaste = cb;
      return actual.createImagePasteHandler(cb);
    },
    createFilePasteHandler: (cb: FilePasteCallback) => {
      captured.filePaste = cb;
      return actual.createFilePasteHandler(cb);
    },
  };
});

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { splitImageInputSegments } from "@shared/utils/imageAttachmentInput";
import { fileDropChipField, imageChipField, readImageChipPaths } from "../../inputEditorExtensions";
import { getAllAtFileTokens } from "../../hybridInputParsing";

const { usePasteExtensions } = await import("../usePasteExtensions");
const { setRemoteMaterializer } = await import("@/services/materialize");

const CWD = "/Users/greg/Projects/daintree";
const IMAGE_PATH = "/tmp/daintree-clipboard/shot.png";

function makeView(doc: string, caret = doc.length): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: caret },
      extensions: [imageChipField, fileDropChipField],
    }),
  });
}

function chipSpellings(view: EditorView): string[] {
  const doc = view.state.doc;
  return view.state.field(fileDropChipField).map((chip) => doc.sliceString(chip.from, chip.to));
}

function installImage(thumbnail: string | undefined) {
  setRemoteMaterializer(async () => ({
    hostPath: IMAGE_PATH,
    displayName: "shot.png",
    bytes: 1,
    ...(thumbnail ? { thumbnail } : {}),
  }));
}

function installFiles() {
  setRemoteMaterializer(async (source) => ({
    hostPath: "path" in source ? source.path : "",
    displayName: "x",
    bytes: 1,
  }));
}

beforeEach(() => {
  captured.filePaste = null;
  captured.imagePaste = null;
  renderHook(() => usePasteExtensions(CWD));
});

afterEach(() => {
  setRemoteMaterializer(null);
});

describe("paste after a non-boundary character", () => {
  it("separates a pasted image from the word before it, so it still splits into an image segment", async () => {
    installImage("data:image/png;base64,abc");
    const view = makeView("explain");

    await captured.imagePaste?.(view);

    const text = view.state.doc.toString();
    expect(text).toBe(`explain ${IMAGE_PATH} `);
    expect(readImageChipPaths(view)).toEqual([IMAGE_PATH]);
    expect(splitImageInputSegments(text, readImageChipPaths(view))).toContainEqual({
      kind: "image",
      path: IMAGE_PATH,
    });
    expect(view.state.selection.main.head).toBe(text.length);
  });

  it("separates the no-thumbnail @file fallback so the token parses", async () => {
    installImage(undefined);
    const view = makeView("explain");

    await captured.imagePaste?.(view);

    const text = view.state.doc.toString();
    expect(text).toBe(`explain @${IMAGE_PATH} `);
    expect(getAllAtFileTokens(text).map((t) => t.start)).toEqual([8]);
    expect(chipSpellings(view)).toEqual([`@${IMAGE_PATH}`]);
    expect(view.state.selection.main.head).toBe(text.length);
  });

  it("separates pasted files once and keeps their order and chip ranges", async () => {
    installFiles();
    const view = makeView("explain");

    await captured.filePaste?.(view, [
      { path: `${CWD}/src/a.ts`, name: "a.ts", size: 1 },
      { path: `${CWD}/src/b.ts`, name: "b.ts", size: 1 },
    ]);

    const text = view.state.doc.toString();
    expect(text).toBe("explain @src/a.ts @src/b.ts ");
    expect(getAllAtFileTokens(text).map((t) => text.slice(t.start, t.end))).toEqual([
      "@src/a.ts",
      "@src/b.ts",
    ]);
    expect(chipSpellings(view)).toEqual(["@src/a.ts", "@src/b.ts"]);
    expect(view.state.selection.main.head).toBe(text.length);
  });

  it("adds nothing when the paste fails to materialize", async () => {
    setRemoteMaterializer(async () => {
      throw new Error("refused");
    });
    const view = makeView("explain");

    await captured.filePaste?.(view, [{ path: `${CWD}/a.ts`, name: "a.ts", size: 1 }]);

    expect(view.state.doc.toString()).toBe("explain");
  });
});

describe("paste where no separator is needed", () => {
  it.each([
    ["the start of the document", ""],
    ["after a space", "explain "],
    ["after a newline", "explain\n"],
    ["after an opening paren", "("],
    ["after an opening bracket", "["],
    ["after an opening brace", "{"],
  ])("adds no leading space for an image at %s", async (_label, doc) => {
    installImage("data:image/png;base64,abc");
    const view = makeView(doc);

    await captured.imagePaste?.(view);

    expect(view.state.doc.toString()).toBe(`${doc}${IMAGE_PATH} `);
  });

  it.each([
    ["the start of the document", ""],
    ["after a space", "explain "],
    ["after an opening paren", "("],
  ])("adds no leading space for files at %s", async (_label, doc) => {
    installFiles();
    const view = makeView(doc);

    await captured.filePaste?.(view, [{ path: `${CWD}/src/a.ts`, name: "a.ts", size: 1 }]);

    expect(view.state.doc.toString()).toBe(`${doc}@src/a.ts `);
    expect(chipSpellings(view)).toEqual(["@src/a.ts"]);
  });

  it("adds no leading space for the no-thumbnail fallback after whitespace", async () => {
    installImage(undefined);
    const view = makeView("explain ");

    await captured.imagePaste?.(view);

    expect(view.state.doc.toString()).toBe(`explain @${IMAGE_PATH} `);
  });
});
