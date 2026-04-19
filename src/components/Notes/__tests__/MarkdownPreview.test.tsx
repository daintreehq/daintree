// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MarkdownPreview } from "../MarkdownPreview";

const mockOpenExternal = vi.fn();
const mockOpenPath = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "electron", {
    value: {
      system: { openExternal: mockOpenExternal, openPath: mockOpenPath },
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

  describe("attachment URL rewriting", () => {
    it("rewrites attachments/ image URLs to daintree-file:// when notesDir is provided", () => {
      const { container } = render(
        <MarkdownPreview content="![shot](attachments/abc.png)" notesDir="/Users/me/notes/p1" />
      );
      const img = container.querySelector("img");
      expect(img).toBeTruthy();
      expect(img!.getAttribute("src")).toContain("daintree-file://");
      expect(img!.getAttribute("src")).toContain(
        encodeURIComponent("/Users/me/notes/p1/attachments/abc.png")
      );
      expect(img!.getAttribute("src")).toContain(
        `root=${encodeURIComponent("/Users/me/notes/p1")}`
      );
    });

    it("leaves attachment URLs unchanged when notesDir is absent", () => {
      const { container } = render(<MarkdownPreview content="![shot](attachments/abc.png)" />);
      const img = container.querySelector("img");
      expect(img).toBeTruthy();
      expect(img!.getAttribute("src")).not.toContain("daintree-file://");
    });

    it("rewrites attachment link URLs and opens via openPath on click", () => {
      render(
        <MarkdownPreview content="[spec](attachments/xyz.pdf)" notesDir="/Users/me/notes/p1" />
      );
      const link = screen.getByText("spec");
      fireEvent.click(link);
      expect(mockOpenPath).toHaveBeenCalledWith("/Users/me/notes/p1/attachments/xyz.pdf");
      expect(mockOpenExternal).not.toHaveBeenCalled();
    });

    it("does not rewrite http/https URLs in attachments prefix check", () => {
      const { container } = render(
        <MarkdownPreview
          content="![ok](https://example.com/img.png)"
          notesDir="/Users/me/notes/p1"
        />
      );
      const img = container.querySelector("img");
      expect(img!.getAttribute("src")).toBe("https://example.com/img.png");
    });

    it("ignores URLs containing .. as a defensive guard", () => {
      const { container } = render(
        <MarkdownPreview
          content="![evil](attachments/../escape.png)"
          notesDir="/Users/me/notes/p1"
        />
      );
      const img = container.querySelector("img");
      // Should NOT contain daintree-file:// since we reject .. paths
      expect(img!.getAttribute("src")).not.toContain("daintree-file://");
    });

    it("does not rewrite percent-encoded parent traversal to daintree-file://", () => {
      const { container } = render(
        <MarkdownPreview
          content="![evil](attachments/%2e%2e/secret.md)"
          notesDir="/Users/me/notes/p1"
        />
      );
      const img = container.querySelector("img");
      expect(img!.getAttribute("src")).not.toContain("daintree-file://");
    });

    it("does not throw on malformed percent-encoding in attachment URLs", () => {
      expect(() =>
        render(
          <MarkdownPreview
            content="![bad](attachments/%E0%A4%A.png)"
            notesDir="/Users/me/notes/p1"
          />
        )
      ).not.toThrow();
    });
  });
});
