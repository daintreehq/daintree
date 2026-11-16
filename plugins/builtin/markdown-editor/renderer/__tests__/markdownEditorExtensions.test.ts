// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import {
  buildMarkdownEditorExtensions,
  docUtf8Bytes,
  externalChange,
  linkTargetAt,
} from "../markdownEditorExtensions";

const language = markdown({ base: markdownLanguage });

function mount(doc: string) {
  const callbacks = { onChange: vi.fn(), onSave: vi.fn(), onFollowLink: vi.fn() };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: buildMarkdownEditorExtensions({
        language,
        polarity: "dark",
        wrapLines: false,
        ariaLabel: "plan.md",
        callbacks,
      }),
    }),
    parent: host,
  });
  return { view, callbacks, host };
}

function keydown(view: EditorView, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  view.contentDOM.dispatchEvent(event);
  return event;
}

let mounted: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

afterEach(() => {
  mounted?.view.destroy();
  mounted?.host.remove();
  mounted = null;
});

describe("markdownEditorExtensions (#12323)", () => {
  it("labels the content for assistive tech and reports typing as the document itself", () => {
    mounted = mount("# Plan\n");
    const { view, callbacks } = mounted;
    expect(view.contentDOM.getAttribute("aria-label")).toBe("plan.md");
    view.dispatch({ changes: { from: view.state.doc.length, insert: "more" } });
    // The immutable document, never a string made per keystroke (#17071).
    expect(callbacks.onChange).toHaveBeenCalledTimes(1);
    expect(callbacks.onChange.mock.calls[0]![0]).toBe(view.state.doc);
    expect(view.state.doc.toString()).toBe("# Plan\nmore");
  });

  it("does not report a change that catches the buffer up to the shared document", () => {
    mounted = mount("# Plan\n");
    const { view, callbacks } = mounted;
    view.dispatch({ changes: { from: 0, insert: "x" }, annotations: externalChange.of(true) });
    expect(callbacks.onChange).not.toHaveBeenCalled();
    view.dispatch({ changes: { from: 0, insert: "y" } });
    expect(callbacks.onChange).toHaveBeenCalledTimes(1);
  });

  it("Mod-s saves and is consumed so nothing reaches the window", () => {
    mounted = mount("x");
    const { view, callbacks } = mounted;
    const windowSpy = vi.fn();
    window.addEventListener("keydown", windowSpy);
    const event = keydown(view, { key: "s", metaKey: true });
    const ctrl = keydown(view, { key: "s", ctrlKey: true });
    // Shift+Mod+S is swallowed without saving: no stray keystroke, no save-as.
    const shifted = keydown(view, { key: "S", metaKey: true, shiftKey: true });
    window.removeEventListener("keydown", windowSpy);
    expect(callbacks.onSave).toHaveBeenCalledTimes(2);
    expect(event.defaultPrevented).toBe(true);
    expect(ctrl.defaultPrevented).toBe(true);
    expect(shifted.defaultPrevented).toBe(true);
    // Consumed inside the editor: nothing bubbles to the window.
    expect(windowSpy).not.toHaveBeenCalled();
  });

  it("Enter continues a list item and Backspace on an empty item removes the marker", () => {
    mounted = mount("- item");
    const { view } = mounted;
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    keydown(view, { key: "Enter" });
    expect(view.state.doc.toString()).toBe("- item\n- ");
    keydown(view, { key: "Backspace" });
    // lang-markdown's deleteMarkupBackward swaps the marker for its width in
    // spaces so continuation text stays aligned; the marker itself is gone.
    expect(view.state.doc.toString()).toBe("- item\n  ");
  });

  it("Enter renumbers the next ordered item", () => {
    mounted = mount("1. one\n2. two");
    const { view } = mounted;
    view.dispatch({ selection: { anchor: 6 } });
    keydown(view, { key: "Enter" });
    expect(view.state.doc.toString()).toBe("1. one\n2. \n3. two");
  });

  it("resolves the link target under a position for inline links, autolinks and bare URLs", () => {
    mounted = mount("see [docs](./docs/spec.md) and <https://example.com> or https://bare.dev\n");
    const { view } = mounted;
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    expect(linkTargetAt(view, 6)).toBe("./docs/spec.md");
    expect(linkTargetAt(view, 34)).toBe("https://example.com");
    expect(linkTargetAt(view, 62)).toBe("https://bare.dev");
    expect(linkTargetAt(view, 1)).toBeNull();
  });

  it("only a Mod+click follows a link; a plain click just moves the caret", () => {
    mounted = mount("[docs](./docs/spec.md)");
    const { view, callbacks } = mounted;
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    const coords = { clientX: 5, clientY: 5 };
    vi.spyOn(view, "posAtCoords").mockReturnValue(2);
    view.contentDOM.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...coords })
    );
    expect(callbacks.onFollowLink).not.toHaveBeenCalled();
    view.contentDOM.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        metaKey: true,
        ...coords,
      })
    );
    expect(callbacks.onFollowLink).toHaveBeenCalledWith("./docs/spec.md");
  });

  it("does not report a buffer change while an IME composition is open", () => {
    mounted = mount("");
    const { view, callbacks } = mounted;
    // CodeMirror exposes composition through `view.composing`; emulate the
    // window during which the update listener must stay quiet.
    Object.defineProperty(view, "composing", { value: true, configurable: true });
    view.dispatch({ changes: { from: 0, insert: "か" } });
    expect(callbacks.onChange).not.toHaveBeenCalled();
    Object.defineProperty(view, "composing", { value: false, configurable: true });
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(callbacks.onChange).toHaveBeenCalledWith(view.state.doc);
    expect(view.state.doc.toString()).toBe("か");
  });

  it("the editor is editable — a buffer that CodeMirror lets the user type into", () => {
    mounted = mount("x");
    expect(mounted.view.state.readOnly).toBe(false);
    expect(mounted.view.contentDOM.getAttribute("contenteditable")).toBe("true");
  });

  it("keeps the buffer's UTF-8 size from its changes, surrogate pairs split and joined included (#17071)", () => {
    const encoded = (state: EditorState) => new TextEncoder().encode(state.doc.toString()).length;
    let state = EditorState.create({ doc: "# Plan\n😀 é\r\nend", extensions: [docUtf8Bytes] });
    expect(state.field(docUtf8Bytes)).toBe(encoded(state));
    const apply = (changes: Array<{ from: number; to?: number; insert?: string }>) => {
      state = state.update({ changes }).state;
      expect(state.field(docUtf8Bytes)).toBe(encoded(state));
    };
    const emoji = state.doc.toString().indexOf("😀");
    // Split a pair, rejoin it, then two changes either side of one kept unit.
    apply([{ from: emoji + 1, to: emoji + 2 }]);
    apply([{ from: emoji + 1, insert: "\ude00" }]);
    apply([
      { from: emoji, to: emoji + 1, insert: "\ud83d" },
      { from: emoji + 2, insert: "\ud83d" },
    ]);
    apply([
      { from: emoji + 1, to: emoji + 2 },
      { from: emoji + 3, insert: "\ude00" },
    ]);
    const pieces = ["a", "é", "€", "😀", "\n", "\ud83d", "\ude00", "", "xy\nz"];
    let seed = 17071;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let step = 0; step < 400; step++) {
      const length = state.doc.length;
      const from = random(length + 1);
      const to = Math.min(length, from + random(4));
      const second = Math.min(length, to + 1 + random(3));
      const changes = [{ from, to, insert: pieces[random(pieces.length)]! }];
      // Two changes in one transaction, a single unchanged unit apart at times.
      if (second < length && random(2) === 0) {
        changes.push({
          from: second,
          to: second + random(2),
          insert: pieces[random(pieces.length)]!,
        });
      }
      state = state.update({ changes }).state;
      expect(state.field(docUtf8Bytes)).toBe(encoded(state));
    }
  });
});
