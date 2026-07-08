// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const dispatchMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

import { MarkdownDocument } from "../MarkdownDocument";

const FIXTURE_PROPS = {
  filePath: "/repo/docs/spec.md",
  rootPath: "/repo",
};

beforeEach(() => {
  dispatchMock.mockClear();
});

describe("MarkdownDocument", () => {
  it("renders headings, GFM tables, and task lists", () => {
    const { container } = render(
      <MarkdownDocument
        {...FIXTURE_PROPS}
        content={[
          "# Spec title",
          "",
          "| Col A | Col B |",
          "| ----- | ----- |",
          "| a     | b     |",
          "",
          "- [x] done item",
          "- [ ] open item",
          "",
          "~~gone~~",
        ].join("\n")}
      />
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Spec title");
    expect(container.querySelector("table")).not.toBeNull();
    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]?.checked).toBe(true);
    expect(container.querySelector("del")?.textContent).toBe("gone");
  });

  it("syntax-highlights fenced code with refractor tokens", () => {
    const { container } = render(
      <MarkdownDocument
        {...FIXTURE_PROPS}
        content={'```typescript\nconst x: string = "hi";\n```'}
      />
    );

    // typescript is a preregistered diffRefractor grammar, so highlighting is
    // synchronous: keyword tokens must be present on first render.
    const code = container.querySelector("code.language-typescript");
    expect(code).not.toBeNull();
    expect(code!.querySelector(".token.keyword")).not.toBeNull();
    expect(code!.textContent).toContain('const x: string = "hi";');
  });

  it("keeps unknown fence languages as plain text without crashing", () => {
    const { container } = render(
      <MarkdownDocument {...FIXTURE_PROPS} content={"```zzznotalang\nplain body\n```"} />
    );
    expect(container.textContent).toContain("plain body");
  });

  it("drops raw HTML instead of rendering it", () => {
    const { container } = render(
      <MarkdownDocument
        {...FIXTURE_PROPS}
        content={
          'before\n\n<script>window.pwned = true;</script>\n<img src="x" onerror="window.pwned=true">\n\nafter'
        }
      />
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    // skipHtml removes the raw nodes entirely — not even escaped text remains.
    expect(container.textContent).not.toContain("script");
    expect(container.textContent).not.toContain("onerror");
    expect(container.textContent).toContain("before");
    expect(container.textContent).toContain("after");
  });

  it("routes relative image sources through the daintree-file protocol", () => {
    const { container } = render(
      <MarkdownDocument {...FIXTURE_PROPS} content={"![diagram](./img/arch.png)"} />
    );

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    const src = img!.getAttribute("src") ?? "";
    expect(src.startsWith("daintree-file://load?")).toBe(true);
    expect(decodeURIComponent(src)).toContain("/repo/docs/img/arch.png");
    expect(decodeURIComponent(src)).toContain("root=/repo");
  });

  it("keeps remote image sources untouched", () => {
    const { container } = render(
      <MarkdownDocument {...FIXTURE_PROPS} content={"![logo](https://example.com/logo.png)"} />
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/logo.png"
    );
  });

  it("opens external links through browser.openExternal instead of navigating", () => {
    render(<MarkdownDocument {...FIXTURE_PROPS} content={"[site](https://example.com)"} />);

    const link = screen.getByRole("link", { name: "site" });
    link.click();

    expect(dispatchMock).toHaveBeenCalledWith(
      "browser.openExternal",
      { url: "https://example.com" },
      { source: "user" }
    );
  });

  it("opens relative file links in the in-app viewer resolved against the document", () => {
    render(<MarkdownDocument {...FIXTURE_PROPS} content={"[other](../README.md)"} />);

    screen.getByRole("link", { name: "other" }).click();

    expect(dispatchMock).toHaveBeenCalledWith(
      "file.view",
      { path: "/repo/README.md", rootPath: "/repo" },
      { source: "user" }
    );
  });

  it("strips query and fragment from local file links", () => {
    render(<MarkdownDocument {...FIXTURE_PROPS} content={"[section](./guide.md#usage?x=1)"} />);

    screen.getByRole("link", { name: "section" }).click();

    expect(dispatchMock).toHaveBeenCalledWith(
      "file.view",
      { path: "/repo/docs/guide.md", rootPath: "/repo" },
      { source: "user" }
    );
  });

  it("refuses to open file links that escape the document root", () => {
    render(
      <MarkdownDocument
        {...FIXTURE_PROPS}
        content={"[secret](/etc/passwd) and [climb](../../../../etc/passwd)"}
      />
    );

    screen.getByRole("link", { name: "secret" }).click();
    screen.getByRole("link", { name: "climb" }).click();

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("ignores same-document anchors, protocol-relative URLs, and javascript: links", () => {
    render(
      <MarkdownDocument
        {...FIXTURE_PROPS}
        content={"[anchor](#section) [proto](//evil.example/doc) [js](javascript:alert(1))"}
      />
    );

    screen.getByRole("link", { name: "anchor" }).click();
    screen.getByRole("link", { name: "proto" }).click();
    // defaultUrlTransform strips the javascript: scheme, leaving an empty
    // href — the anchor loses its accessible link role, so query by text.
    const jsLink = screen.getByText("js");
    expect(jsLink.getAttribute("href") ?? "").not.toContain("javascript");
    jsLink.click();

    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
