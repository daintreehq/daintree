// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
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
type Request = NonNullable<Parameters<EditorView["requestMeasure"]>[0]>;
let queue: Request[] = [];

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
  // The side picks the character before or after the position.
  vi.spyOn(view, "coordsAtPos").mockImplementation((pos, side = 1) => {
    const bottom = lineBottom(side < 0 && pos > 0 ? pos - 1 : pos);
    return { left: 0, right: 0, ...rect(bottom) };
  });
  vi.spyOn(view, "requestMeasure").mockImplementation((request) => {
    if (!request) return;
    const at = queue.findIndex((queued) => request.key != null && queued.key === request.key);
    if (at >= 0) queue[at] = request;
    else queue.push(request);
  });
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
  view.scrollDOM.dispatchEvent(new Event("wheel"));
  layoutScroll(view, top);
}

/** The scroller moved without the person: clamped, kept in place, or reparented. */
function layoutScroll(view: EditorView, top: number) {
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
  Object.defineProperty(HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value(this: HTMLElement) {
      return this.classList.contains("cm-voice-interim") ? [rect(previewEndPx)] : [];
    },
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  delete (HTMLElement.prototype as Partial<HTMLElement>).getClientRects;
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
        setDictationFollow.of({ session: "s1", end: DRAFT.length + words.length }),
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

  it("keeps following when the scroller moves without the person", () => {
    const view = mount();
    hear(view, "so the first", 420);

    // Shorter content pulling it back, or the editor moving into the expanded view.
    layoutScroll(view, 0);
    hear(view, "so the first thing", 440);

    expect(previewInView()).toBe(true);
    view.destroy();
  });

  it("doesn't read its own scroll as the person's, however late it arrives", () => {
    const view = mount();
    hear(view, "so the first", 420);
    view.scrollDOM.dispatchEvent(new Event("wheel"));

    // More words arrive before the event for the follower's last scroll does.
    previewEndPx = 440;
    contentPx = 440 + PAD_PX;
    view.dispatch({ effects: setInterimText.of("so the first thing") });
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    flush(view);

    expect(previewInView()).toBe(true);
    view.destroy();
  });

  it("brings the words a stop writes into view", () => {
    const view = mount();
    view.dispatch({ effects: setDictationFollow.of({ session: "s1", end: DRAFT.length }) });
    flush(view);
    writes = [];

    // The stop writes the last words and ends the session in the same pass.
    const words = "x".repeat(40);
    contentPx = lineBottom(DRAFT.length + words.length - 1) + PAD_PX;
    view.dispatch({
      changes: { from: DRAFT.length, insert: words },
      effects: setDictationFollow.of({ session: null }),
    });
    flush(view);

    expect(scrollTop).toBe(lineBottom(DRAFT.length + words.length - 1) + 5 - VIEW_PX);
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

    // The cleanup streaming in, and landing shorter, scrolls nothing of its own.
    contentPx = 300;
    view.dispatch({ changes: { from: 150, to: 200, insert: "So the first." } });
    flush(view);
    expect(writes).toHaveLength(1);
    view.destroy();
  });

  it("doesn't follow the last words past a cleanup that has begun", () => {
    const view = mount();
    view.dispatch({ effects: setDictationFollow.of({ session: "s1", end: DRAFT.length }) });
    flush(view);
    writes = [];

    // The stop's last words, the session's end and the cleanup in one pass.
    const words = "x".repeat(40);
    contentPx = lineBottom(DRAFT.length + words.length - 1) + PAD_PX;
    view.dispatch({
      changes: { from: DRAFT.length, insert: words },
      effects: [setDictationFollow.of({ session: null }), revealDictationStart.of(150)],
    });
    flush(view);

    expect(writes).toEqual([lineBottom(150) - LINE_PX - 5]);
    view.destroy();
  });

  it("finds a passage start outside the rendered viewport by its line's height", () => {
    const doc = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const view = mount(doc);
    contentPx = 10000;
    scrollTop = 1500;
    vi.mocked(view.coordsAtPos).mockReturnValue(null);
    const start = view.state.doc.line(30).from;

    view.dispatch({ effects: revealDictationStart.of(start) });
    flush(view);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe(
      1500 +
        view.documentTop +
        view.lineBlockAt(start).top -
        view.scrollDOM.getBoundingClientRect().top -
        5
    );
    view.destroy();
  });

  it("drops a passage start a new dictation has overtaken", () => {
    const view = mount();
    userScroll(view, 300);

    view.dispatch({ effects: revealDictationStart.of(20) });
    view.dispatch({ effects: setDictationFollow.of({ session: "s2", end: DRAFT.length }) });
    flush(view);

    // Only the new dictation's own following moves it.
    expect(writes).toEqual([lineBottom(DRAFT.length - 1) + 5 - VIEW_PX]);
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
