// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const draft = vi.hoisted(() => ({ length: 0 }));

interface Request {
  read: () => unknown;
  write?: (measured: unknown) => void;
}

/**
 * The view's measure cycle: what is asked for while it writes waits for its
 * next pass, which reads everything asked for before writing any of it.
 */
const view = vi.hoisted(() => {
  const queued: Request[] = [];
  return {
    queued,
    flush() {
      const pass = queued.splice(0);
      const measured = pass.map((request) => request.read());
      pass.forEach((request, i) => request.write?.(measured[i]));
    },
  };
});

vi.mock("@codemirror/view", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codemirror/view")>();
  return {
    ...actual,
    EditorView: Object.assign(actual.EditorView, {
      findFromDOM: () => ({
        state: { doc: { length: draft.length } },
        requestMeasure: (request?: Request) => {
          if (request && !view.queued.includes(request)) view.queued.push(request);
        },
      }),
    }),
  };
});

import { COMPOSER_GEOMETRY_EVENT } from "../../inputEditorExtensions";
import { useComposerMeasure } from "../useComposerMeasure";

const CONTROLS_LEFT = 340;
const ROW_PX = 20;
const CHAR_PX = 8;
const COLUMNS = 40;

function rect(left: number, width: number): DOMRect {
  return new DOMRect(left, 0, width, ROW_PX);
}

function setup() {
  const shell = document.createElement("div");
  const scroller = document.createElement("div");
  scroller.className = "cm-scroller";
  const content = document.createElement("div");
  content.className = "cm-content";
  content.style.lineHeight = `${ROW_PX}px`;
  const line = document.createElement("div");
  line.className = "cm-line";
  const ink = document.createElement("img");
  line.appendChild(ink);
  content.appendChild(line);
  scroller.appendChild(content);
  shell.appendChild(scroller);
  const trailing = document.createElement("div");
  Object.defineProperty(trailing, "offsetWidth", { value: 60 });
  trailing.getBoundingClientRect = () => rect(CONTROLS_LEFT, 60);
  document.body.append(shell, trailing);

  const type = (chars: number) => {
    draft.length = chars;
    const lastRowChars = chars % COLUMNS;
    const rects = chars === 0 ? [] : [rect(4, lastRowChars * CHAR_PX)];
    ink.getClientRects = () => Object.assign(rects, { item: (i: number) => rects[i] ?? null });
    shell.dispatchEvent(new Event(COMPOSER_GEOMETRY_EVENT));
    view.flush();
  };
  const scroll = (on: boolean) => {
    scroller.style.overflowY = on ? "auto" : "";
  };

  const { result } = renderHook(() =>
    useComposerMeasure({
      inputShellRef: { current: shell },
      trailingGroupRef: { current: trailing },
    })
  );
  void result;
  return { shell, ink, type, scroll };
}

describe("useComposerMeasure", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    draft.length = 0;
    view.queued.length = 0;
  });

  it("reads the draft's last row in the view's next pass, not while the autosize writes", () => {
    const { shell, ink } = setup();
    let rowReads = 0;
    act(() => {
      draft.length = 400;
      const rects = [rect(4, 400 * CHAR_PX)];
      ink.getClientRects = () => {
        rowReads++;
        return Object.assign(rects, { item: (i: number) => rects[i] ?? null });
      };
      shell.dispatchEvent(new Event(COMPOSER_GEOMETRY_EVENT));
      shell.dispatchEvent(new Event(COMPOSER_GEOMETRY_EVENT));
    });
    expect(rowReads).toBe(0);
    expect(view.queued).toHaveLength(1);
    expect(shell.hasAttribute("data-composer-rail")).toBe(false);

    act(() => view.flush());
    expect(rowReads).toBe(1);
    expect(shell.hasAttribute("data-composer-rail")).toBe(true);
  });

  it("shares the bottom row with the controls while the last row ends short of them", () => {
    const { shell, type } = setup();
    act(() => type(5));
    expect(shell.hasAttribute("data-composer-rail")).toBe(false);
  });

  it("moves into the rail once and keeps it while a draft grows one character at a time past the cap", () => {
    const { shell, type, scroll } = setup();
    const states: boolean[] = [];
    for (let chars = 1; chars <= 600; chars++) {
      act(() => {
        scroll(chars > 320);
        type(chars);
      });
      states.push(shell.hasAttribute("data-composer-rail"));
    }
    const flips = states.filter((on, i) => i > 0 && on !== states[i - 1]).length;
    expect(flips).toBe(1);
    expect(states[states.length - 1]).toBe(true);
  });

  it("keeps the rail while deleting back down, and releases it when the draft is cleared", () => {
    const { shell, type, scroll } = setup();
    act(() => {
      scroll(true);
      type(400);
    });
    expect(shell.hasAttribute("data-composer-rail")).toBe(true);
    act(() => scroll(false));
    for (let chars = 399; chars >= 1; chars--) {
      act(() => type(chars));
      expect(shell.hasAttribute("data-composer-rail")).toBe(true);
    }
    act(() => type(0));
    expect(shell.hasAttribute("data-composer-rail")).toBe(false);
  });

  it("holds the rail across dictated words that land a word at a time", () => {
    const { shell, type, scroll } = setup();
    const states: boolean[] = [];
    let chars = 0;
    for (let word = 0; word < 90; word++) {
      chars += 6;
      act(() => {
        scroll(chars > 320);
        type(chars);
      });
      states.push(shell.hasAttribute("data-composer-rail"));
    }
    expect(states.filter((on, i) => i > 0 && on !== states[i - 1]).length).toBe(1);
    act(() => {
      scroll(false);
      type(0);
    });
    expect(shell.hasAttribute("data-composer-rail")).toBe(false);
  });
});
