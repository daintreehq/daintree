// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { buildMarkdownEditorExtensions, linkTargetAt } from "../markdownEditorExtensions";

vi.mock("@/config/terminalFont", () => ({ DEFAULT_TERMINAL_FONT_FAMILY: "monospace" }));

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
  it("labels the content for assistive tech and reports typing as whole-buffer text", () => {
    mounted = mount("# Plan\n");
    const { view, callbacks } = mounted;
    expect(view.contentDOM.getAttribute("aria-label")).toBe("plan.md");
    view.dispatch({ changes: { from: view.state.doc.length, insert: "more" } });
    expect(callbacks.onChange).toHaveBeenCalledWith("# Plan\nmore");
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
    expect(callbacks.onChange).toHaveBeenCalledWith("か");
  });

  it("the editor is editable — a buffer that CodeMirror lets the user type into", () => {
    mounted = mount("x");
    expect(mounted.view.state.readOnly).toBe(false);
    expect(mounted.view.contentDOM.getAttribute("contenteditable")).toBe("true");
  });
});
