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

  it("reports only once the document is in the DOM, so a host can hand back a pinned height", () => {
    // A host releases a height pin on this signal, so it has to fire after the
    // commit — reporting during render would release against a box that hasn't
    // laid out yet. Capture what the DOM looked like at call time rather than
    // just the call count, which a render-phase call would also satisfy.
    let headingAtReport: string | null = null;
    const onRendered = vi.fn(() => {
      headingAtReport = document.querySelector("h1")?.textContent ?? null;
    });

    render(<MarkdownDocument {...FIXTURE_PROPS} content="# Spec title" onRendered={onRendered} />);

    expect(onRendered).toHaveBeenCalledTimes(1);
    expect(headingAtReport).toBe("Spec title");
  });

  it("keeps fence text byte-identical when highlighting, trailing newline included", () => {
    // The cold-grammar path renders a fence as plain text and re-renders with
    // token spans once ensureLanguage resolves. That swap is only height-safe if
    // it wraps the same characters — this pins the text invariant on the warm
    // path. It does not prove equal box height: jsdom performs no layout, so
    // only Chromium can establish that.
    const code = 'const x: string = "hi";';
    const { container } = render(
      <MarkdownDocument {...FIXTURE_PROPS} content={`\`\`\`typescript\n${code}\n\`\`\``} />
    );

    const rendered = container.querySelector("code.language-typescript");
    expect(rendered!.querySelector(".token")).not.toBeNull();
    // The `code` mapping strips the fence's trailing newline before either path
    // renders, so neither can gain or lose a line relative to the other.
    expect(rendered!.textContent).toBe(code);
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
    // No host token supplied: the URL must stay clean rather than pick up an
    // empty or "undefined" parameter.
    expect(new URL(src).searchParams.has("v")).toBe(false);
  });

  it("keeps remote image sources untouched", () => {
    const { container } = render(
      <MarkdownDocument {...FIXTURE_PROPS} content={"![logo](https://example.com/logo.png)"} />
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/logo.png"
    );
  });

  it("carries the cache token on local images only, never on remote images or links", () => {
    // A token with a space and an ampersand would corrupt the query string if it
    // were interpolated raw; round-tripping it through searchParams proves it is
    // encoded without restating how.
    const token = "rev 1&2";
    const { container } = render(
      <MarkdownDocument
        {...FIXTURE_PROPS}
        cacheBust={token}
        content={[
          "![diagram](./img/arch.png)",
          "",
          "![logo](https://example.com/logo.png)",
          "",
          "[spec](./other.md)",
        ].join("\n")}
      />
    );

    const [local, remote] = Array.from(container.querySelectorAll("img"));
    const localUrl = new URL(local!.getAttribute("src") ?? "");
    expect(localUrl.searchParams.get("v")).toBe(token);
    // The token rides alongside the routing params rather than displacing them.
    expect(localUrl.searchParams.get("path")).toBe("/repo/docs/img/arch.png");
    expect(localUrl.searchParams.get("root")).toBe("/repo");

    // Remote images short-circuit before the daintree-file branch, and link
    // hrefs never enter it at all — neither may leak the token.
    expect(remote!.getAttribute("src")).toBe("https://example.com/logo.png");
    expect(screen.getByRole("link", { name: "spec" }).getAttribute("href")).not.toContain("v=");
  });

  it("treats an empty token as a value to carry, not as an absent one", () => {
    // The distinction the `=== undefined` check exists to make. A truthiness
    // check would swallow "" and silently stop busting for a host that reached
    // it — with only the undefined and non-empty cases covered, that swap would
    // leave every other test in this file green.
    const { container } = render(
      <MarkdownDocument {...FIXTURE_PROPS} cacheBust="" content={"![diagram](./img/arch.png)"} />
    );

    const url = new URL(container.querySelector("img")!.getAttribute("src") ?? "");
    expect(url.searchParams.has("v")).toBe(true);
    expect(url.searchParams.get("v")).toBe("");
  });

  it("rebuilds local image sources in place when only the cache token changes", () => {
    // The regression guard for #11587: a rewritten image keeps the same path and
    // root, so the src is byte-identical and Chromium never refetches it. This
    // fails if the token is dropped from the urlTransform memo's dependencies —
    // the stale closure would keep emitting the first token.
    const content = "![diagram](./img/arch.png)";
    const { container, rerender } = render(
      <MarkdownDocument {...FIXTURE_PROPS} cacheBust="rev-1" content={content} />
    );
    const imgBefore = container.querySelector("img")!;
    const before = imgBefore.getAttribute("src") ?? "";

    rerender(<MarkdownDocument {...FIXTURE_PROPS} cacheBust="rev-2" content={content} />);
    const imgAfter = container.querySelector("img")!;
    const after = imgAfter.getAttribute("src") ?? "";

    expect(after).not.toBe(before);
    const afterUrl = new URL(after);
    expect(afterUrl.searchParams.get("v")).toBe("rev-2");
    // Only the token moved: still the same file under the same containment root.
    expect(afterUrl.searchParams.get("path")).toBe(new URL(before).searchParams.get("path"));
    expect(afterUrl.searchParams.get("root")).toBe(new URL(before).searchParams.get("root"));
    // The whole reason for busting the src rather than keying the document: the
    // element is reused, so the reader's scroll position survives the swap.
    expect(imgAfter).toBe(imgBefore);
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

  // #12135: Select All is a native Edit-menu accelerator ending in
  // webContents.selectAll(). Chromium only scopes that to editable focus, so
  // over the rendered document it used to select the entire app window.
  it("claims Cmd+A for the document instead of the whole app", () => {
    // A React-owned pane wrapper, not a re-parented container: RTL only cleans
    // up a container whose parent is document.body, so moving one leaks it into
    // the tests that follow. This is the shape ContentPanel renders — focus on
    // the `data-panel-id` root, an ancestor of the document.
    const { getByTestId } = render(
      <div data-testid="pane" data-panel-id="file-1" tabIndex={-1}>
        <nav>sidebar chrome</nav>
        <MarkdownDocument {...FIXTURE_PROPS} content={"# Spec title\n\nBody line."} />
      </div>
    );

    const event = new KeyboardEvent("keydown", {
      key: "a",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    getByTestId("pane").dispatchEvent(event);

    // A prevented event never reaches the native accelerator.
    expect(event.defaultPrevented).toBe(true);
    const document_ = getByTestId("pane").querySelector(".markdown-document")!;
    const range = window.getSelection()?.getRangeAt(0);
    // The whole document, not a collapsed range that merely shares its ancestor.
    expect(range?.commonAncestorContainer).toBe(document_);
    expect(range?.startOffset).toBe(0);
    expect(range?.endOffset).toBe(document_.childNodes.length);
    expect(window.getSelection()?.toString()).toBe(document_.textContent);
    expect(window.getSelection()?.toString()).not.toContain("sidebar chrome");
    window.getSelection()?.removeAllRanges();
  });
});
