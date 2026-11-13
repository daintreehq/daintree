// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { targetOwnsCopy } from "../terminalCopyKey";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

function field<T extends HTMLInputElement | HTMLTextAreaElement>(el: T, value: string): T {
  el.value = value;
  document.body.appendChild(el);
  el.focus();
  return el;
}

describe("targetOwnsCopy", () => {
  it("claims Cmd+C for an input holding a selected range", () => {
    const input = field(document.createElement("input"), "needle");
    input.setSelectionRange(0, 3);
    // The field's selection never reaches the document selection.
    expect(window.getSelection()?.toString() ?? "").toBe("");
    expect(targetOwnsCopy(input)).toBe(true);
  });

  it("claims Cmd+C for a textarea holding a selected range", () => {
    const textarea = field(document.createElement("textarea"), "first line");
    textarea.setSelectionRange(2, 7);
    expect(targetOwnsCopy(textarea)).toBe(true);
  });

  it("leaves Cmd+C to the terminal when the field's caret is collapsed", () => {
    const input = field(document.createElement("input"), "needle");
    input.setSelectionRange(3, 3);
    expect(targetOwnsCopy(input)).toBe(false);
  });

  it("leaves Cmd+C to the terminal for an input type with no text selection", () => {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    document.body.appendChild(checkbox);
    expect(targetOwnsCopy(checkbox)).toBe(false);
  });

  it("claims Cmd+C for a document selection, as an editor's selected text", () => {
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.textContent = "composer draft";
    document.body.appendChild(editor);
    const range = document.createRange();
    range.selectNodeContents(editor);
    window.getSelection()?.addRange(range);
    expect(targetOwnsCopy(editor)).toBe(true);
  });

  it("leaves Cmd+C to the terminal with nothing selected anywhere", () => {
    const pane = document.createElement("div");
    document.body.appendChild(pane);
    expect(targetOwnsCopy(pane)).toBe(false);
    expect(targetOwnsCopy(null)).toBe(false);
  });
});
