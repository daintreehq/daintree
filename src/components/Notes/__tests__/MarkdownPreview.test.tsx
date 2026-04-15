// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MarkdownPreview } from "../MarkdownPreview";

const mockOpenExternal = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "electron", {
    value: {
      system: { openExternal: mockOpenExternal },
    },
    writable: true,
    configurable: true,
  });
});

describe("MarkdownPreview", () => {
  it("renders markdown headings", () => {
    render(<MarkdownPreview content="# Hello World" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Hello World");
  });

  it("renders GFM strikethrough", () => {
    render(<MarkdownPreview content="~~deleted~~" />);
    expect(screen.getByText("deleted").tagName).toBe("DEL");
  });

  it("renders fenced code blocks", () => {
    render(<MarkdownPreview content={'```js\nconsole.log("hi");\n```'} />);
    expect(screen.getByText(/console/)).toBeTruthy();
  });

  it("highlights fenced code blocks with hljs class tokens", () => {
    const { container } = render(<MarkdownPreview content={"```javascript\nconst x = 1;\n```"} />);
    const codeEl = container.querySelector("code.hljs");
    expect(codeEl).toBeTruthy();
    const hasTokenClass = codeEl?.querySelector("[class*='hljs-']") !== null;
    expect(hasTokenClass).toBe(true);
  });

  it("opens external http links via electron", () => {
    render(<MarkdownPreview content="[click](https://example.com)" />);
    const link = screen.getByText("click");
    fireEvent.click(link);
    expect(mockOpenExternal).toHaveBeenCalledWith("https://example.com");
  });

  it("does not call openExternal for hash links", () => {
    render(<MarkdownPreview content="[anchor](#section)" />);
    const link = screen.getByText("anchor");
    fireEvent.click(link);
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it("applies prose-daintree class", () => {
    const { container } = render(<MarkdownPreview content="text" />);
    expect(container.firstElementChild?.classList.contains("prose-daintree")).toBe(true);
  });

  it("forwards ref", () => {
    const ref = vi.fn();
    render(<MarkdownPreview ref={ref} content="text" />);
    expect(ref).toHaveBeenCalledWith(expect.any(HTMLDivElement));
  });
});
