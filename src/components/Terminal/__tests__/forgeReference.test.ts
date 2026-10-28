/**
 * @vitest-environment jsdom
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/trustedTypesPolicy", () => ({
  createTrustedHTML: (s: string) => s,
  setTrustedInnerHTML: (el: Element, html: string) => {
    el.innerHTML = html;
  },
}));

import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { cursorCharLeft, cursorCharRight } from "@codemirror/commands";
import type { ForgeNumberReference } from "@shared/types/forge";
import {
  applyForgeReferences,
  closesReferenceCard,
  describeForgeReference,
  eligibleIssueReferences,
  forgeReferenceField,
  forgeReferenceTooltipAt,
  onForgeReferenceRescan,
  rescanForgeReferences,
  setForgeReferences,
  type ForgeReferenceMap,
} from "../inputEditorExtensions/forgeReference";
import { createFileChipField } from "../inputEditorExtensions/fileChip";
import { chipPendingDeleteField } from "../inputEditorExtensions/chipBackspace";
import { fileDropChipField } from "../inputEditorExtensions/fileDropChip";
import { addImageChip, imageChipField } from "../inputEditorExtensions/imageChip";

const MERGED_PR: ForgeNumberReference = {
  kind: "pr",
  number: 14843,
  title: "Clean up long dictations",
  state: "merged",
  isDraft: false,
};
const OPEN_ISSUE: ForgeNumberReference = {
  kind: "issue",
  number: 7,
  title: "Crash on start",
  state: "open",
};
const REFERENCES: ForgeReferenceMap = new Map<number, ForgeNumberReference>([
  [14843, MERGED_PR],
  [7, OPEN_ISSUE],
]);

// jsdom has no layout: a card measures its text through Range rects it lacks.
const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
});
afterAll(() => {
  if (originalRangeRects)
    Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
  else delete (Range.prototype as Partial<Range>).getClientRects;
});

const views: EditorView[] = [];
let updates: ViewUpdate[] = [];

function mount(doc: string, caret = doc.length): EditorView {
  updates = [];
  const view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(caret),
      extensions: [
        chipPendingDeleteField,
        forgeReferenceField,
        createFileChipField(),
        fileDropChipField,
        imageChipField,
        EditorView.updateListener.of((update) => {
          updates.push(update);
        }),
      ],
    }),
  });
  views.push(view);
  return view;
}

function marked(view: EditorView): string[] {
  return [...view.dom.querySelectorAll(".cm-forge-ref")].map((el) => el.textContent ?? "");
}

function cardText(view: EditorView, pos: number, side: -1 | 1 = 1): string | null {
  const tooltip = forgeReferenceTooltipAt(view, pos, side);
  return tooltip ? (tooltip.create(view).dom.textContent ?? "") : null;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.useRealTimers();
});

describe("issue and pull request references (#14849)", () => {
  it("marks the numbers that name something and leaves the rest as typed", () => {
    const view = mount("Make sure to merge #14843 and #99 then #7, not #fff");
    applyForgeReferences(view, REFERENCES);
    expect(marked(view)).toEqual(["#14843", "#7"]);
    // Marked, not replaced: the draft is exactly what was typed.
    expect(view.state.doc.toString()).toBe("Make sure to merge #14843 and #99 then #7, not #fff");
  });

  it("says what a mark names to assistive tech", () => {
    const view = mount("see #14843");
    applyForgeReferences(view, REFERENCES);
    const mark = view.dom.querySelector(".cm-forge-ref");
    expect(mark?.getAttribute("aria-description")).toBe(
      "Merged pull request #14843: Clean up long dictations"
    );
  });

  it("follows the number as it is edited", () => {
    const view = mount("see #7");
    applyForgeReferences(view, REFERENCES);
    expect(marked(view)).toEqual(["#7"]);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "1" } });
    expect(marked(view)).toEqual([]);
    view.dispatch({ changes: { from: view.state.doc.length - 1, to: view.state.doc.length } });
    expect(marked(view)).toEqual(["#7"]);
  });

  it("lets the caret walk through a reference one character at a time", () => {
    const view = mount("a #7 b", 1);
    applyForgeReferences(view, REFERENCES);
    const heads: number[] = [];
    for (let i = 0; i < 4; i++) {
      cursorCharRight(view);
      heads.push(view.state.selection.main.head);
    }
    expect(heads).toEqual([2, 3, 4, 5]);
    cursorCharLeft(view);
    cursorCharLeft(view);
    expect(view.state.selection.main.head).toBe(3);
  });

  it("does not dispatch when told what it already holds", () => {
    const view = mount("see #7");
    applyForgeReferences(view, REFERENCES);
    const dispatch = vi.spyOn(view, "dispatch");
    applyForgeReferences(
      view,
      new Map<number, ForgeNumberReference>([
        [7, { ...OPEN_ISSUE }],
        [14843, { ...MERGED_PR }],
      ])
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["title", { title: "Renamed" }],
    ["state", { state: "closed" }],
    ["draft flag", { isDraft: true }],
  ] as const)("redraws when a reference's %s changes", (_, change) => {
    const view = mount("see #14843");
    const openPr: ForgeNumberReference = { ...MERGED_PR, state: "open" };
    applyForgeReferences(view, new Map([[14843, openPr]]));
    const changed = { ...openPr, ...change } as ForgeNumberReference;
    applyForgeReferences(view, new Map([[14843, changed]]));
    const description = view.dom.querySelector(".cm-forge-ref")?.getAttribute("aria-description");
    expect(description).toBe(`${describeForgeReference(changed)}: ${changed.title}`);
    expect(description).not.toBe(`${describeForgeReference(openPr)}: ${openPr.title}`);
  });

  it("redraws when a number turns out to name the other kind", () => {
    const view = mount("see #7");
    applyForgeReferences(view, REFERENCES);
    const asPr: ForgeNumberReference = { ...OPEN_ISSUE, kind: "pr", isDraft: false };
    applyForgeReferences(view, new Map([...REFERENCES, [7, asPr]]));
    expect(view.dom.querySelector(".cm-forge-ref")?.getAttribute("aria-description")).toBe(
      "Open pull request #7: Crash on start"
    );
  });

  it("leaves a number inside a file chip to the chip", () => {
    const view = mount('read @"notes #7.md" about #7');
    applyForgeReferences(view, REFERENCES);
    expect(eligibleIssueReferences(view.state).map((t) => t.start)).toEqual([26]);
    expect(marked(view)).toEqual(["#7"]);
  });

  it("leaves a number inside a pasted image's path to its chip", () => {
    const view = mount("");
    const path = "/tmp/shot #7.png";
    view.dispatch({
      changes: { from: 0, insert: `${path} see #7` },
      effects: addImageChip.of({ from: 0, to: path.length, filePath: path, thumbnailUrl: "" }),
    });
    expect(eligibleIssueReferences(view.state).map((t) => t.start)).toEqual([path.length + 5]);
  });

  it("leaves a number inside a context reference to its chip", () => {
    const view = mount("pull @rec:#7 and #7");
    expect(eligibleIssueReferences(view.state).map((t) => t.start)).toEqual([17]);
  });

  it("hands a rescan to the composer that registered for the view", () => {
    const view = mount("see #7");
    const rescan = vi.fn();
    const stop = onForgeReferenceRescan(view, rescan);
    rescanForgeReferences(view);
    expect(rescan).toHaveBeenCalledTimes(1);
    stop();
    rescanForgeReferences(view);
    expect(rescan).toHaveBeenCalledTimes(1);
  });

  it("describes each state the badges show", () => {
    expect(describeForgeReference(OPEN_ISSUE)).toBe("Open issue #7");
    expect(describeForgeReference({ ...OPEN_ISSUE, state: "closed" })).toBe("Closed issue #7");
    expect(describeForgeReference({ ...MERGED_PR, state: "open", isDraft: true })).toBe(
      "Draft pull request #14843"
    );
    expect(describeForgeReference({ ...MERGED_PR, state: "closed" })).toBe(
      "Closed pull request #14843"
    );
    expect(describeForgeReference(MERGED_PR)).toBe("Merged pull request #14843");
  });
});

describe("the reference card", () => {
  it("shows the state, the number and the title over a marked number", () => {
    const view = mount("see #14843 and #7");
    applyForgeReferences(view, REFERENCES);
    expect(cardText(view, 6)).toBe("Merged#14843Clean up long dictations");
    expect(cardText(view, 16)).toBe("Open#7Crash on start");
  });

  it("opens at a reference's edges only from inside it", () => {
    const view = mount("see #7 now");
    applyForgeReferences(view, REFERENCES);
    expect(cardText(view, 4, 1)).not.toBeNull();
    expect(cardText(view, 4, -1)).toBeNull();
    expect(cardText(view, 6, -1)).not.toBeNull();
    expect(cardText(view, 6, 1)).toBeNull();
  });

  it("offers nothing over a number that names nothing", () => {
    const view = mount("see #99");
    applyForgeReferences(view, REFERENCES);
    expect(cardText(view, 5)).toBeNull();
  });

  it("closes once the text changes or its number stops naming anything", () => {
    const view = mount("see #7");
    applyForgeReferences(view, REFERENCES);
    const card = forgeReferenceTooltipAt(view, 5, 1)!;
    const typed = view.state.update({ changes: { from: 6, insert: "1" } });
    const gone = view.state.update({ effects: setForgeReferences.of(new Map()) });
    const renamed = view.state.update({
      effects: setForgeReferences.of(new Map([[7, { ...OPEN_ISSUE, title: "Renamed" }]])),
    });
    const moved = view.state.update({ selection: EditorSelection.cursor(0) });
    expect(closesReferenceCard(typed, card)).toBe(true);
    expect(closesReferenceCard(gone, card)).toBe(true);
    expect(closesReferenceCard(renamed, card)).toBe(false);
    expect(closesReferenceCard(moved, card)).toBe(false);
  });

  it("takes a newer answer for its number while it is open", () => {
    const view = mount("see #7");
    applyForgeReferences(view, REFERENCES);
    const card = forgeReferenceTooltipAt(view, 5, 1)!.create(view);
    const lastUpdate = () => updates.at(-1)!;

    // Fitted to the old content; the new content gets fitted afresh.
    card.dom.style.width = "40px";
    applyForgeReferences(view, new Map([[7, { ...OPEN_ISSUE, state: "closed" }]]));
    card.update!(lastUpdate());
    expect(card.dom.textContent).toBe("Closed#7Crash on start");
    expect(card.dom.style.width).toBe("");

    // Another number's answer leaves this card as it is.
    applyForgeReferences(
      view,
      new Map<number, ForgeNumberReference>([
        [7, { ...OPEN_ISSUE, state: "closed" }],
        [14843, MERGED_PR],
      ])
    );
    const before = card.dom.firstChild;
    card.update!(lastUpdate());
    expect(card.dom.firstChild).toBe(before);
  });

  it("asks the composer to re-read references once a card is shown", () => {
    vi.useFakeTimers();
    const view = mount("see #7");
    applyForgeReferences(view, REFERENCES);
    const rescan = vi.fn();
    onForgeReferenceRescan(view, rescan);
    forgeReferenceTooltipAt(view, 5, 1);
    expect(rescan).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(rescan).toHaveBeenCalledTimes(1);
  });
});
