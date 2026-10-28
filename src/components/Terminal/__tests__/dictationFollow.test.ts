// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, type MeasureRequest } from "@codemirror/view";
import {
  dictationFollow,
  interimWidgetField,
  revealDictationStart,
  setDictationFollow,
  setInterimText,
} from "../inputEditorExtensions";

// jsdom lays nothing out, so the composer is a 100px window onto content whose
// lines are 20px tall, ten characters each, with padding below the last; the
// grey preview ends wherever a test puts it.
const VIEW_PX = 100;
const LINE_PX = 20;
const PAD_PX = 8;
const DRAFT = "x".repeat(200); // 20 lines, 400px

let contentPx = 0;
let previewEndPx = 0;
let scrollTop = 0;
let writes: number[] = [];
let queue: MeasureRequest<unknown>[] = [];

const lineBottom = (pos: number) => (Math.floor(pos / 10) + 1) * LINE_PX;
const rect = (bottom: number) => ({
  top: bottom - LINE_PX - scrollTop,
  bottom: bottom - scrollTop,
});

function mount(doc = DRAFT) {
  const view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({ doc, extensions: [interimWidgetField, dictationFollow] }),
  });
  contentPx = lineBottom(Math.max(0, doc.length - 1)) + PAD_PX;
  const scroller = view.scrollDOM;
  Object.defineProperty(scroller, "clientHeight", { get: () => VIEW_PX });
  Object.defineProperty(scroller, "scrollHeight", { get: () => Math.max(contentPx, VIEW_PX) });
  Object.defineProperty(scroller, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.min(Math.max(0, value), Math.max(0, contentPx - VIEW_PX));
      writes.push(scrollTop);
    },
  });
  vi.spyOn(view, "coordsAtPos").mockImplementation((pos) => {
    const bottom = lineBottom(pos);
    return { left: 0, right: 0, ...rect(bottom) };
  });
  view.requestMeasure = <T>(request?: MeasureRequest<T>) => {
    if (!request) return;
    const at = queue.findIndex((queued) => request.key != null && queued.key === request.key);
    if (at >= 0) queue[at] = request as MeasureRequest<unknown>;
    else queue.push(request as MeasureRequest<unknown>);
  };
  return view;
}

/** CodeMirror's measure loop: every queued read, then every write, until nothing is queued. */
function flush(view: EditorView) {
  while (queue.length > 0) {
    const batch = queue;
    queue = [];
    const read = batch.map((request) => request.read(view));
    batch.forEach((request, i) => request.write?.(read[i], view));
  }
}

function userScroll(view: EditorView, top: number) {
  scrollTop = Math.min(Math.max(0, top), Math.max(0, contentPx - VIEW_PX));
  view.scrollDOM.dispatchEvent(new Event("scroll"));
}

/** The preview grows to end at `endPx`, the content with it. */
function hear(view: EditorView, text: string, endPx: number, end = view.state.doc.length) {
  previewEndPx = endPx;
  contentPx = Math.max(contentPx, endPx + PAD_PX);
  view.dispatch({
    effects: [setDictationFollow.of({ session: "s1", end }), setInterimText.of(text)],
  });
  flush(view);
}

function previewInView() {
  const { top, bottom } = rect(previewEndPx);
  return top >= 0 && bottom <= VIEW_PX;
}

beforeEach(() => {
  scrollTop = 0;
  writes = [];
  queue = [];
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (
    this: HTMLElement
  ) {
    if (!this.classList.contains("cm-voice-interim")) return [] as unknown as DOMRectList;
    return [rect(previewEndPx)] as unknown as DOMRectList;
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("dictationFollow", () => {
  it("keeps the grey preview in view as it grows past a capped composer", () => {
    const view = mount();

    hear(view, "so the first", 420);
    expect(previewInView()).toBe(true);
    expect(scrollTop).toBe(420 + 5 - VIEW_PX);

    hear(view, "so the first thing we", 440);
    expect(previewInView()).toBe(true);
    expect(scrollTop).toBe(440 + 5 - VIEW_PX);
    view.destroy();
  });

  it("never scrolls a dictation that fits", () => {
    const view = mount("short");

    hear(view, "and a few words", 60);
    hear(view, "and a few words more", 80);

    expect(writes).toEqual([]);
    view.destroy();
  });

  it("doesn't move when an utterance is written where its preview was", () => {
    const view = mount();
    hear(view, "so the first", 420);
    const followed = scrollTop;
    writes = [];

    // The words land as text ending on the line the preview ended on.
    const words = "so the fir";
    contentPx = 420 + PAD_PX;
    view.dispatch({
      changes: { from: DRAFT.length, insert: words },
      effects: [
        setDictationFollow.of({ session: "s1", end: DRAFT.length + words.length - 1 }),
        setInterimText.of(""),
      ],
    });
    flush(view);

    expect(writes).toEqual([]);
    expect(scrollTop).toBe(followed);
    view.destroy();
  });

  it("follows the dictated words, not the end of a draft they went into the middle of", () => {
    const view = mount();

    // Words written into the middle, their end still in view.
    view.dispatch({ effects: setDictationFollow.of({ session: "s1", end: 32 }) });
    flush(view);
    expect(scrollTop).toBe(0);

    view.dispatch({ effects: setDictationFollow.of({ session: "s1", end: 142 }) });
    flush(view);
    expect(scrollTop).toBe(lineBottom(142) + 5 - VIEW_PX);
    view.destroy();
  });

  it("stops following when scrolled up, until the end is back in view", () => {
    const view = mount();
    hear(view, "so the first", 420);
    // The event the follower's own scroll fires doesn't count as the person's.
    view.scrollDOM.dispatchEvent(new Event("scroll"));

    userScroll(view, 100);
    hear(view, "so the first thing", 440);
    hear(view, "so the first thing we", 460);
    expect(scrollTop).toBe(100);

    userScroll(view, 460 - VIEW_PX);
    hear(view, "so the first thing we need", 480);
    expect(previewInView()).toBe(true);
    view.destroy();
  });

  it("follows again from the start of the next dictation", () => {
    const view = mount();
    hear(view, "so the first", 420);
    userScroll(view, 100);

    view.dispatch({ effects: setDictationFollow.of({ session: null }) });
    previewEndPx = 440;
    contentPx = 440 + PAD_PX;
    view.dispatch({
      effects: [
        setDictationFollow.of({ session: "s2", end: view.state.doc.length }),
        setInterimText.of("next"),
      ],
    });
    flush(view);

    expect(previewInView()).toBe(true);
    view.destroy();
  });

  it("shows a passage from its start, once, when its cleanup begins", () => {
    const view = mount();
    hear(view, "so the first", 420);
    view.dispatch({
      effects: [setDictationFollow.of({ session: null }), setInterimText.of("")],
    });
    writes = [];

    view.dispatch({ effects: revealDictationStart.of(150) });
    flush(view);
    expect(writes).toEqual([lineBottom(150) - LINE_PX - 5]);

    // The cleanup streaming in, and landing shorter, moves nothing.
    contentPx = 300;
    view.dispatch({ changes: { from: 150, to: 200, insert: "So the first." } });
    flush(view);
    expect(writes).toHaveLength(1);
    view.destroy();
  });

  it("doesn't move to a passage start already in view", () => {
    const view = mount();
    userScroll(view, 100);

    view.dispatch({ effects: revealDictationStart.of(60) });
    flush(view);

    expect(writes).toEqual([]);
    view.destroy();
  });
});
