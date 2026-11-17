// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "@/config/terminalFont";
import { CodeViewer } from "../CodeViewer";

const SCOPE_SELECTOR = "[data-code-viewer-sticky-scope]";

function scrollWrapper(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>("[data-code-viewer-scroll]")!;
}

// jsdom has no layout: scroll offset is read as wrapper.top - documentTop, so
// pushing the wrapper's rect down stands in for a scrolled document.
async function scrollBy(wrapper: HTMLElement, top: number) {
  wrapper.scrollTop = top;
  wrapper.getBoundingClientRect = () => ({
    top,
    bottom: top,
    left: 0,
    right: 0,
    width: 0,
    height: 0,
    x: 0,
    y: top,
    toJSON() {},
  });
  await act(async () => {
    wrapper.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  });
}

afterEach(cleanup);

describe("CodeViewer sticky scope", () => {
  it("reserves no band above the document when there is no scope", () => {
    const { container } = render(<CodeViewer content={'{\n  "a": 1\n}'} filePath="data.json" />);
    const wrapper = scrollWrapper(container);
    const editor = wrapper.querySelector(".cm-editor")!;

    expect(wrapper.querySelector(SCOPE_SELECTOR)).toBeNull();
    for (const child of Array.from(wrapper.children)) {
      if (child.contains(editor) || child === editor) continue;
      expect(child.className).toContain("h-0");
      expect((child as HTMLElement).style.height).toBe("");
      expect(child.textContent).toBe("");
    }
  });

  it("overlays the scope line in the editor's monospace font with semantic tokens", async () => {
    const content = [
      "function outer() {",
      ...Array.from({ length: 30 }, (_, i) => `  a${i}();`),
      "}",
    ].join("\n");
    const { container } = render(<CodeViewer content={content} filePath="main.js" />);
    const wrapper = scrollWrapper(container);
    await waitFor(() => expect(container.querySelector(".cm-line")).not.toBeNull());
    await waitFor(async () => {
      await scrollBy(wrapper, 70);
      expect(wrapper.querySelector(SCOPE_SELECTOR)).not.toBeNull();
    });

    const scope = wrapper.querySelector<HTMLElement>(SCOPE_SELECTOR)!;
    expect(scope.textContent).toBe("function outer() {");
    expect(scope.style.fontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(scope.className).toContain("absolute");
    expect(scope.className).toContain("bg-surface-sidebar");
    expect(scope.className).toContain("text-text-secondary");
    expect(scope.className).toContain("border-border-default");
    expect(scope.className).not.toContain("--theme-");
    expect(scope.parentElement!.className).toContain("h-0");

    await scrollBy(wrapper, 0);
    expect(wrapper.querySelector(SCOPE_SELECTOR)).toBeNull();
  });
});
