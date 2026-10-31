// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, placeholder } from "@codemirror/view";
import {
  interimWidgetField,
  setInterimText,
  setVoiceCaret,
  voiceCaret,
  type VoiceCaretAt,
  type VoiceCaretPhase,
} from "../inputEditorExtensions";

let views: EditorView[] = [];

function mount(doc: string, cursor = 0, extra: Extension[] = []) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [interimWidgetField, voiceCaret, extra],
    }),
  });
  views.push(view);
  return view;
}

function caret(view: EditorView) {
  return view.contentDOM.querySelector<HTMLElement>(".cm-voice-caret");
}

/** The text before the caret, as drawn. */
function textBefore(view: EditorView): string | null {
  const el = caret(view);
  if (!el) return null;
  const range = document.createRange();
  range.setStart(view.contentDOM, 0);
  range.setEndBefore(el);
  return range.toString();
}

function show(view: EditorView, phase: VoiceCaretPhase | null, at?: VoiceCaretAt) {
  view.dispatch({ effects: setVoiceCaret.of({ phase, ...(at !== undefined ? { at } : {}) }) });
}

function covers(view: EditorView): boolean {
  return view.dom.hasAttribute("data-voice-caret-covers");
}

afterEach(() => {
  for (const view of views) {
    view.dom.parentElement?.remove();
    view.destroy();
  }
  views = [];
});

describe("voiceCaret", () => {
  it("draws nothing without a session", () => {
    const view = mount("fix the bug");
    expect(caret(view)).toBeNull();
    show(view, "starting", "end");
    show(view, null);
    expect(caret(view)).toBeNull();
  });

  it("carries the mic's state through starting, live and held", () => {
    const view = mount("fix the bug");
    const seen: (string | undefined)[] = [];
    for (const phase of ["starting", "live", "held", "live"] as const) {
      show(view, phase, "end");
      seen.push(caret(view)?.dataset.phase);
    }
    expect(seen).toEqual(["starting", "live", "held", "live"]);
  });

  it("shows at the end of a draft never focused, without focus", () => {
    // The caret sits at 0, but nobody chose it: dictation appends.
    const view = mount("fix the bug", 0);
    expect(view.hasFocus).toBe(false);
    show(view, "starting", "caret");
    expect(textBefore(view)).toBe("fix the bug");
  });

  it("follows the composer's caret once it has had focus, and keeps it after focus leaves", () => {
    const view = mount("fix the bug", 0);
    view.focus();
    view.dispatch({ selection: EditorSelection.cursor(4) });
    show(view, "starting", "caret");
    expect(textBefore(view)).toBe("fix ");

    view.contentDOM.blur();
    view.dispatch({ effects: [] });
    expect(view.hasFocus).toBe(false);
    expect(textBefore(view)).toBe("fix ");
  });

  it.each([
    [8, 4],
    [4, 8],
  ])("starts a selection's replacement where it begins (anchor %i, head %i)", (anchor, head) => {
    const view = mount("fix the bug", 0);
    view.focus();
    view.dispatch({ selection: EditorSelection.range(anchor, head) });
    show(view, "live", "caret");
    expect(textBefore(view)).toBe("fix ");
    // A selection shows as a selection: the editor's caret isn't hidden for it.
    expect(covers(view)).toBe(false);
  });

  it("stays at the session's anchor, mapped through edits before it", () => {
    const view = mount("fix the bug");
    show(view, "live", 7);
    expect(textBefore(view)).toBe("fix the");
    view.dispatch({ changes: { from: 0, insert: "please " } });
    expect(textBefore(view)).toBe("please fix the");
    // A phase change without a position keeps the mapped one.
    show(view, "held");
    expect(textBefore(view)).toBe("please fix the");
  });

  it("ignores a position outside the draft, and takes the next edit (#15716)", () => {
    const view = mount("fix the bug");
    show(view, "live", 7);
    show(view, "held", 312);
    expect(textBefore(view)).toBe("fix the");
    view.dispatch({ changes: { from: 0, to: 11, insert: "" } });
    show(view, "held", 312);
    view.dispatch({ changes: { from: 0, insert: "next" } });
    expect(view.state.doc.toString()).toBe("next");
    expect(textBefore(view)).toBe("next");
  });

  it("sits past the dictation's preview while one shows, wherever the preview is", () => {
    const view = mount("fix the bug");
    show(view, "live", 3);
    view.dispatch({ effects: setInterimText.of({ text: " login", pos: 7 }) });
    expect(textBefore(view)).toBe("fix the login");
    view.dispatch({ effects: setInterimText.of({ text: "", pos: null }) });
    expect(textBefore(view)).toBe("fix");
  });

  it("follows a preview with no position of its own to the end of the draft", () => {
    const view = mount("fix the bug");
    show(view, "live", 3);
    view.dispatch({ effects: setInterimText.of({ text: " now", pos: null }) });
    expect(textBefore(view)).toBe("fix the bug now");
  });

  it("shows ahead of an empty draft's placeholder", () => {
    const view = mount("", 0, [placeholder("Listening…")]);
    show(view, "live", "end");
    expect(textBefore(view)).toBe("");
    expect(view.contentDOM.textContent).toBe("Listening…");
  });

  it("stands in for the editor's caret only where the two meet", () => {
    const view = mount("fix the bug", 0);
    view.focus();
    view.dispatch({ selection: EditorSelection.cursor(4) });
    show(view, "live", "caret");
    expect(covers(view)).toBe(true);

    // The user moves off to type elsewhere: their caret comes back.
    show(view, "live", 11);
    expect(covers(view)).toBe(false);

    // Back where the words go, it steps aside again; and a session gone
    // leaves the editor's caret alone.
    view.dispatch({ selection: EditorSelection.cursor(11) });
    expect(covers(view)).toBe(true);
    show(view, null);
    expect(covers(view)).toBe(false);
  });

  it("never covers the caret of an editor without focus", () => {
    const view = mount("fix the bug", 11);
    show(view, "live", "end");
    expect(caret(view)).not.toBeNull();
    expect(covers(view)).toBe(false);
  });
});
