// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  _resetComposerSnapshotsForTesting,
  keepComposerSnapshot,
  takeComposerSnapshot,
} from "@/lib/composerRemount";
import {
  keepComposerRemount,
  restoreComposerRemount,
} from "../inputEditorExtensions/composerRemount";
import {
  addFileDropChip,
  addImageChip,
  fileDropChipField,
  imageChipField,
} from "../inputEditorExtensions";

const IMAGE = "/tmp/a.png";
const DRAFT = `look at ${IMAGE} @b.md`;
const extensions = [imageChipField, fileDropChipField];

const views: EditorView[] = [];
function editor(doc: string): EditorView {
  const view = new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({ doc, extensions }),
  });
  views.push(view);
  return view;
}

/** An editor showing `DRAFT` with an image and a file chip, its caret after the image. */
function attached(): EditorView {
  const view = editor(DRAFT);
  view.dispatch({
    selection: { anchor: 18, head: 8 },
    effects: [
      addImageChip.of({ from: 8, to: 18, filePath: IMAGE, thumbnailUrl: "data:x" }),
      addFileDropChip.of({ from: 19, to: 24, filePath: "/repo/b.md", fileName: "b.md" }),
    ],
  });
  return view;
}

beforeEach(() => _resetComposerSnapshotsForTesting());
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

describe("keepComposerRemount (#16883)", () => {
  it("keeps the chips and selection of an editor showing the stored draft", () => {
    const view = attached();
    keepComposerRemount(view, "k", DRAFT);

    const snapshot = takeComposerSnapshot("k", DRAFT);
    expect(snapshot).not.toBeNull();
    const state = restoreComposerRemount(EditorState.create({ doc: DRAFT, extensions }), snapshot!);
    expect(state.field(imageChipField)).toEqual(view.state.field(imageChipField));
    expect(state.field(fileDropChipField)).toEqual(view.state.field(fileDropChipField));
    expect(state.selection.main.anchor).toBe(18);
    expect(state.selection.main.head).toBe(8);
  });

  it.each([
    ["ahead of", "look at"],
    ["behind", `${DRAFT} and more`],
  ])("keeps nothing for an editor %s the stored draft", (_case, stored) => {
    keepComposerRemount(attached(), "k", stored);
    expect(takeComposerSnapshot("k", DRAFT)).toBeNull();
    expect(takeComposerSnapshot("k", stored)).toBeNull();
  });

  it("keeps nothing for an empty editor", () => {
    keepComposerRemount(editor(""), "k", "");
    expect(takeComposerSnapshot("k", "")).toBeNull();
  });
});

describe("takeComposerSnapshot", () => {
  const snapshot = {
    draft: DRAFT,
    images: [],
    files: [],
    selection: { anchor: 0, head: 0 },
    caretPublished: false,
  };

  it("uses the snapshot up on a draft that no longer matches", () => {
    keepComposerSnapshot("k", snapshot);
    expect(takeComposerSnapshot("k", "other")).toBeNull();
    expect(takeComposerSnapshot("k", DRAFT)).toBeNull();
  });

  it("uses the snapshot up when it is put back", () => {
    keepComposerSnapshot("k", snapshot);
    expect(takeComposerSnapshot("k", DRAFT)).toEqual(snapshot);
    expect(takeComposerSnapshot("k", DRAFT)).toBeNull();
  });
});
