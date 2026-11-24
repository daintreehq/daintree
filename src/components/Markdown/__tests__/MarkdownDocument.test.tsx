// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const dispatchMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

// react-markdown builds a fresh processor per parse, attaching every remark
// plugin each time — so counting remark-gfm attaches counts parses.
const gfmAttaches = vi.hoisted(() => ({ count: 0 }));
vi.mock("remark-gfm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remark-gfm")>();
  return {
    default: function countedRemarkGfm(this: unknown, ...args: unknown[]) {
      gfmAttaches.count += 1;
      return (actual.default as (...a: unknown[]) => unknown).apply(this, args);
    },
  };
});

import { refractor } from "refractor/core";
import { MarkdownDocument, MARKDOWN_FONT_SIZE_TOKEN } from "../MarkdownDocument";
import { _clearHighlightCacheForTests } from "../markdownRenderPolicy";
import { markdownTargetLine } from "../markdownHeadingTargets";
import { MARKDOWN_FONT_SIZE_STEPS } from "@/store/preferencesStore";
import { installAppPluginKitHost } from "@/services/plugin/appPluginKitHost";

// The app's own kit host, so the kit reaches the app services mocked here.
installAppPluginKitHost();

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

  it("does not re-parse the document when only the cache token changes", () => {
    // Hosts move the token on every refresh tick while an agent writes. It only
    // matters to local images, so it must not cost a full re-parse.
    const content = "# Title\n\n![diagram](./img/arch.png)\n\nBody text.";
    const { container, rerender } = render(
      <MarkdownDocument {...FIXTURE_PROPS} cacheBust="rev-1" content={content} />
    );
    gfmAttaches.count = 0;

    rerender(<MarkdownDocument {...FIXTURE_PROPS} cacheBust="rev-2" content={content} />);
    rerender(<MarkdownDocument {...FIXTURE_PROPS} cacheBust="rev-3" content={content} />);

    expect(gfmAttaches.count).toBe(0);
    const src = container.querySelector("img")!.getAttribute("src") ?? "";
    expect(new URL(src).searchParams.get("v")).toBe("rev-3");

    rerender(
      <MarkdownDocument {...FIXTURE_PROPS} cacheBust="rev-3" content={`${content} More.`} />
    );
    expect(gfmAttaches.count).toBe(1);
  });

  it("reuses a highlighted fence across remounts instead of re-highlighting", () => {
    _clearHighlightCacheForTests();
    const highlight = vi.spyOn(refractor, "highlight");
    try {
      const content = "```typescript\nconst cached: number = 1;\n```";
      render(<MarkdownDocument {...FIXTURE_PROPS} content={content} />).unmount();
      const { container } = render(<MarkdownDocument {...FIXTURE_PROPS} content={content} />);

      expect(highlight).toHaveBeenCalledTimes(1);
      const code = container.querySelector("code.language-typescript");
      expect(code!.querySelector(".token.keyword")).not.toBeNull();
      expect(code!.textContent).toBe("const cached: number = 1;");
    } finally {
      highlight.mockRestore();
      _clearHighlightCacheForTests();
    }
  });

  it("re-highlights cached fences once another grammar is registered", () => {
    // Markdown and markup fences highlight embedded languages only when those
    // grammars are loaded, so a newly registered grammar can change the output
    // of a fence whose own language was already cached.
    _clearHighlightCacheForTests();
    const highlight = vi.spyOn(refractor, "highlight");
    try {
      const content = "```typescript\nconst again = 1;\n```";
      render(<MarkdownDocument {...FIXTURE_PROPS} content={content} />).unmount();
      render(<MarkdownDocument {...FIXTURE_PROPS} content={content} />).unmount();
      expect(highlight).toHaveBeenCalledTimes(1);

      const fakeGrammar = Object.assign(
        (prism: { languages: Record<string, unknown> }) => {
          prism.languages.zzzcachetestlang = { word: /\w+/ };
        },
        { displayName: "zzzcachetestlang", aliases: [] as string[] }
      );
      refractor.register(fakeGrammar);

      render(<MarkdownDocument {...FIXTURE_PROPS} content={content} />);
      expect(highlight).toHaveBeenCalledTimes(2);
    } finally {
      highlight.mockRestore();
    }
  });

  it("evicts the least recently used fence once the cache is full", () => {
    _clearHighlightCacheForTests();
    const highlight = vi.spyOn(refractor, "highlight");
    try {
      const fence = (n: number) => `\`\`\`typescript\nconst v${n} = ${n};\n\`\`\``;
      render(<MarkdownDocument {...FIXTURE_PROPS} content={fence(0)} />).unmount();
      render(<MarkdownDocument {...FIXTURE_PROPS} content={fence(1)} />).unmount();
      // Touch fence 0 so fence 1 is the oldest when the 65th entry arrives.
      render(<MarkdownDocument {...FIXTURE_PROPS} content={fence(0)} />).unmount();
      for (let n = 2; n <= 64; n++) {
        render(<MarkdownDocument {...FIXTURE_PROPS} content={fence(n)} />).unmount();
      }
      expect(highlight).toHaveBeenCalledTimes(65);

      render(<MarkdownDocument {...FIXTURE_PROPS} content={fence(0)} />).unmount();
      expect(highlight).toHaveBeenCalledTimes(65);
      render(<MarkdownDocument {...FIXTURE_PROPS} content={fence(1)} />).unmount();
      expect(highlight).toHaveBeenCalledTimes(66);
    } finally {
      highlight.mockRestore();
      _clearHighlightCacheForTests();
    }
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
      { path: "/repo/README.md", rootPath: "/repo", confineToRoot: true },
      { source: "user" }
    );
  });

  it("strips query and fragment from local file links", () => {
    render(<MarkdownDocument {...FIXTURE_PROPS} content={"[section](./guide.md#usage?x=1)"} />);

    screen.getByRole("link", { name: "section" }).click();

    expect(dispatchMock).toHaveBeenCalledWith(
      "file.view",
      { path: "/repo/docs/guide.md", rootPath: "/repo", confineToRoot: true },
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

  it("dispatches nothing for an anchor with no target, protocol-relative URLs, and javascript: links", () => {
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

/**
 * jsdom has no layout, so a pane here is a box whose geometry is stubbed: it
 * scrolls (overflow auto, taller content than view) and reports its top, and
 * each element the test names reports where it sits inside it.
 */
function stubPane(pane: HTMLElement, top: number): void {
  Object.defineProperty(pane, "clientHeight", { configurable: true, value: 400 });
  Object.defineProperty(pane, "scrollHeight", { configurable: true, value: 4000 });
  pane.getBoundingClientRect = () => ({ top }) as DOMRect;
}

function placeAt(element: Element, top: number): void {
  element.getBoundingClientRect = () => ({ top }) as DOMRect;
}

const TOC_PLAN = [
  "# Plan",
  "",
  "- [Risks](#risks)",
  "",
  "Intro.",
  "",
  "## Risks",
  "",
  "Late.",
].join("\n");

describe("MarkdownDocument same-document links (#17335)", () => {
  it("gives headings GitHub's prefixed ids, numbering repeats in document order", () => {
    const { container } = render(
      <MarkdownDocument
        {...FIXTURE_PROPS}
        content={"# Plan\n\n## Risks\n\n## What's new? (v2)\n\n### Risks"}
      />
    );

    const ids = [...container.querySelectorAll("h1, h2, h3")].map((heading) => heading.id);
    expect(ids).toEqual([
      "user-content-plan",
      "user-content-risks",
      "user-content-whats-new-v2",
      "user-content-risks-1",
    ]);
  });

  it("scrolls the clicked document's pane to its heading and focuses it, leaving a twin document alone", () => {
    const { getByTestId } = render(
      <div>
        <div data-testid="pane-a" style={{ overflowY: "auto" }}>
          <MarkdownDocument {...FIXTURE_PROPS} content={TOC_PLAN} />
        </div>
        <div data-testid="pane-b" style={{ overflowY: "auto" }}>
          <MarkdownDocument {...FIXTURE_PROPS} filePath="/repo/docs/other.md" content={TOC_PLAN} />
        </div>
      </div>
    );
    const paneA = getByTestId("pane-a");
    const paneB = getByTestId("pane-b");
    stubPane(paneA, 0);
    stubPane(paneB, 500);
    const headingA = paneA.querySelector("h2")!;
    const headingB = paneB.querySelector("h2")!;
    placeAt(headingA, 900);
    placeAt(headingB, 500 + 1200);
    paneB.scrollTop = 100;

    const linkB = paneB.querySelector("a")!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    linkB.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    // Lands 8px below the pane's top: 100 already scrolled + 1200 down - 8.
    expect(paneB.scrollTop).toBe(1292);
    expect(document.activeElement).toBe(headingB);
    expect(headingB.getAttribute("tabindex")).toBe("-1");
    expect(paneA.scrollTop).toBe(0);
    expect(headingA.hasAttribute("tabindex")).toBe(false);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("never falls back to another document for a heading this one lacks", () => {
    const { getByTestId } = render(
      <div>
        <div data-testid="pane-a" style={{ overflowY: "auto" }}>
          <MarkdownDocument {...FIXTURE_PROPS} content={"## Nowhere"} />
        </div>
        <div data-testid="pane-b" style={{ overflowY: "auto" }}>
          <MarkdownDocument {...FIXTURE_PROPS} content={"[gone](#nowhere)\n\n## Risks"} />
        </div>
      </div>
    );
    const paneA = getByTestId("pane-a");
    const paneB = getByTestId("pane-b");
    stubPane(paneA, 0);
    stubPane(paneB, 500);
    const elsewhere = paneA.querySelector("h2")!;
    placeAt(elsewhere, 900);
    const before = document.activeElement;

    screen.getByRole("link", { name: "gone" }).click();

    expect(paneA.scrollTop).toBe(0);
    expect(paneB.scrollTop).toBe(0);
    expect(document.activeElement).toBe(before);
    expect(elsewhere.hasAttribute("tabindex")).toBe(false);
  });

  it("scrolls only the document's own pane, never a scroller around it", () => {
    const { getByTestId } = render(
      <div data-testid="app" style={{ overflowY: "auto" }}>
        <div data-testid="pane" style={{ overflowY: "auto" }}>
          <MarkdownDocument {...FIXTURE_PROPS} content={TOC_PLAN} />
        </div>
      </div>
    );
    const app = getByTestId("app");
    const pane = getByTestId("pane");
    stubPane(app, 0);
    stubPane(pane, 40);
    placeAt(pane.querySelector("h2")!, 40 + 700);

    screen.getByRole("link", { name: "Risks" }).click();

    expect(pane.scrollTop).toBe(692);
    expect(app.scrollTop).toBe(0);
  });

  it("lands the heading below chrome the host pins over the pane", () => {
    const { getByTestId } = render(
      <div data-testid="pane" style={{ overflowY: "auto" }}>
        <MarkdownDocument {...FIXTURE_PROPS} content={TOC_PLAN} anchorTopGap={56} />
      </div>
    );
    const pane = getByTestId("pane");
    stubPane(pane, 0);
    placeAt(pane.querySelector("h2")!, 700);

    screen.getByRole("link", { name: "Risks" }).click();

    expect(pane.scrollTop).toBe(644);
  });

  it("follows a footnote to its note and back to the reference", () => {
    const { getByTestId } = render(
      <div data-testid="pane" style={{ overflowY: "auto" }}>
        <MarkdownDocument {...FIXTURE_PROPS} content={"Claim.[^1]\n\n[^1]: The source."} />
      </div>
    );
    const pane = getByTestId("pane");
    stubPane(pane, 0);
    const reference = pane.querySelector<HTMLAnchorElement>("a[data-footnote-ref]")!;
    const note = pane.querySelector("#user-content-fn-1")!;
    const back = pane.querySelector<HTMLAnchorElement>("a[data-footnote-backref]")!;
    placeAt(note, 1500);
    placeAt(reference, 300);

    reference.click();
    expect(pane.scrollTop).toBe(1492);
    expect(document.activeElement).toBe(note);

    pane.scrollTop = 0;
    back.click();
    expect(pane.scrollTop).toBe(292);
    expect(document.activeElement).toBe(reference);
    // A link is focusable already; nothing is added to it.
    expect(reference.hasAttribute("tabindex")).toBe(false);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("does nothing for a link that names no heading in the document", () => {
    const { getByTestId } = render(
      <div data-testid="pane" style={{ overflowY: "auto" }}>
        <MarkdownDocument
          {...FIXTURE_PROPS}
          content={"[gone](#nowhere) [bare](#) [Shouting](#RISKS)\n\n## Risks"}
        />
      </div>
    );
    const pane = getByTestId("pane");
    stubPane(pane, 0);
    placeAt(pane.querySelector("h2")!, 700);
    const before = document.activeElement;

    for (const name of ["gone", "Shouting"]) screen.getByRole("link", { name }).click();
    screen.getByText("bare").click();

    expect(pane.scrollTop).toBe(0);
    expect(document.activeElement).toBe(before);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  // Edit mode resolves `#risks` against the source with its own parse; both
  // must name the same place, or a link means two things across the toggle.
  it("mints exactly the ids Edit mode resolves to each heading's line", () => {
    const source = [
      "# Plan",
      "",
      "## Risks",
      "",
      "Risks",
      "-----",
      "",
      "### `slug()` & [more](./more.md)",
      "",
      "Claim.[^note]",
      "",
      "[^note]: Source.",
    ].join("\n");
    const { container } = render(<MarkdownDocument {...FIXTURE_PROPS} content={source} />);

    const ids = [...container.querySelectorAll("[id^='user-content-']")].map((el) => el.id);
    expect(ids).toEqual([
      "user-content-plan",
      "user-content-risks",
      "user-content-risks-1",
      "user-content-slug--more",
      "user-content-fnref-note",
      "user-content-fn-note",
    ]);
    expect(ids.map((id) => markdownTargetLine(source, `#${id}`))).toEqual([1, 3, 5, 8, 10, 12]);
  });

  it("does not re-parse the document when only the landing gap changes", () => {
    const { rerender } = render(
      <MarkdownDocument {...FIXTURE_PROPS} content={TOC_PLAN} anchorTopGap={8} />
    );
    const attachesAfterFirstRender = gfmAttaches.count;

    rerender(<MarkdownDocument {...FIXTURE_PROPS} content={TOC_PLAN} anchorTopGap={56} />);

    expect(gfmAttaches.count).toBe(attachesAfterFirstRender);
  });
});

describe("MarkdownDocument front matter (#17334)", () => {
  const frontmatterBlocks = (container: HTMLElement) => [
    ...container.querySelectorAll<HTMLElement>("[data-frontmatter]"),
  ];

  it("shows YAML front matter as its raw lines above the body, not as a rule and a heading", () => {
    const yaml = [
      "name: release-check",
      "description: Checks the release branch",
      "",
      "allowed-tools:",
      "  - Bash(git log:*)",
    ].join("\n");
    const { container } = render(
      <MarkdownDocument
        {...FIXTURE_PROPS}
        content={`---\n${yaml}\n---\n\n# Release check\n\nBody.`}
      />
    );

    const [block, ...rest] = frontmatterBlocks(container);
    expect(rest).toEqual([]);
    expect(block?.dataset.frontmatter).toBe("yaml");
    expect(block?.tagName).toBe("DIV");
    // Raw and whole: the blank line stays, and the nested list keeps the
    // indentation that makes it YAML.
    expect(block?.textContent).toBe(yaml);
    expect(container.querySelector(".markdown-document")?.firstElementChild).toBe(block);
    expect(container.querySelector("hr")).toBeNull();
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "Release check",
    ]);
  });

  it("shows TOML front matter the same way", () => {
    const { container } = render(
      <MarkdownDocument {...FIXTURE_PROPS} content={'+++\ntitle = "Plan"\n+++\n\n# Plan'} />
    );

    const [block] = frontmatterBlocks(container);
    expect(block?.dataset.frontmatter).toBe("toml");
    expect(block?.textContent).toBe('title = "Plan"');
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Plan"]);
  });

  it("never interprets a value: markup in it stays text", () => {
    const { container } = render(
      <MarkdownDocument
        {...FIXTURE_PROPS}
        content={"---\ndescription: <b>bold</b> **strong** [link](https://x.dev)\n---\n"}
      />
    );

    const [block] = frontmatterBlocks(container);
    expect(block?.textContent).toBe("description: <b>bold</b> **strong** [link](https://x.dev)");
    expect(block?.querySelector("b, strong, a")).toBeNull();
  });

  it("leaves a fence that isn't front matter to Markdown", () => {
    // Unclosed, and not on the first line: a rule each, as before.
    for (const content of ["---\nname: x\n\n# Title", "\n---\nname: x\n---\n\n# Title"]) {
      const { container, unmount } = render(
        <MarkdownDocument {...FIXTURE_PROPS} content={content} />
      );
      expect(frontmatterBlocks(container)).toEqual([]);
      expect(container.querySelector("hr")).not.toBeNull();
      unmount();
    }
  });

  it("draws nothing for blank front matter", () => {
    for (const content of ["---\n\n---\n\n# Title", "---\n \t\n  \n---\n\n# Title"]) {
      const { container, unmount } = render(
        <MarkdownDocument {...FIXTURE_PROPS} content={content} />
      );
      expect(frontmatterBlocks(container)).toEqual([]);
      expect(container.querySelector("hr")).toBeNull();
      expect(container.querySelector(".markdown-document")?.firstElementChild?.tagName).toBe("H1");
      unmount();
    }
  });

  it("keeps heading ids and their lines past the front matter, whose `#` lines are comments", () => {
    const source = "---\n# Risks\ntitle: Plan\n---\n\n# Risks\n\n## Risks";
    const { container } = render(<MarkdownDocument {...FIXTURE_PROPS} content={source} />);

    const ids = [...container.querySelectorAll("[id^='user-content-']")].map((el) => el.id);
    expect(ids).toEqual(["user-content-risks", "user-content-risks-1"]);
    expect(ids.map((id) => markdownTargetLine(source, `#${id}`))).toEqual([6, 8]);
  });
});

/**
 * The stylesheet is the half of the size control that no render test can see:
 * jsdom applies no author styles, so the whole feature — store, stepper,
 * forwarding, the inline custom property — stays green while the declaration
 * that consumes it is reverted and the type never moves (#12134). Read the
 * source instead, which is what actually ships in the lazy markdown chunk.
 */
describe("MarkdownDocument.css document scale (#12134)", () => {
  // Comments go first throughout: the file's header explains both rules below
  // by quoting the very things they forbid, so a raw scan reads its own prose.
  const rules = fs
    .readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../MarkdownDocument.css"),
      "utf8"
    )
    .replace(/\/\*[\s\S]*?\*\//g, "");

  /** The `.markdown-document` rule's own body, not a descendant's. */
  const rootBlock = /(?:^|\n)\.markdown-document\s*\{([^}]*)\}/.exec(rules)?.[1] ?? "";

  it("sizes the document from --markdown-font-size, falling back to the type scale", () => {
    expect(rootBlock).not.toBe("");
    const declarations = [...rootBlock.matchAll(/(?:^|[^-\w])font-size\s*:\s*([^;}\n]+)/g)].map(
      (match) => match[1]?.trim()
    );

    // The fallback is load-bearing: a document mounted without the prop, and
    // every surface that predates the control, still renders at 14px.
    expect(declarations).toEqual(["var(--markdown-font-size, var(--text-sm))"]);
  });

  it("keeps the scale unlayered, where it still outranks the typography plugin", () => {
    // Wrapping this file in @layer hands the prose rules back to the plugin's
    // light-theme defaults — the regression the file header records.
    expect(rules).not.toMatch(/@layer/);
  });
});

/**
 * The type can only hold the map exhaustive, not correct: `satisfies
 * Record<MarkdownFontSize, string>` accepts a rung mapped to the wrong step, or
 * to a variable that does not exist. Expressing the correlation as a template
 * literal type instead would put `var(--text-` in a type position, where
 * `builtInThemes.test.ts`'s renderer scan reads it as a consumer named `text-`
 * — so the correlation is pinned here, in a file that scan skips.
 */
describe("MARKDOWN_FONT_SIZE_TOKEN (#12134)", () => {
  it("resolves every rung to its own step of the shared type scale", () => {
    expect(Object.keys(MARKDOWN_FONT_SIZE_TOKEN).sort()).toEqual(
      [...MARKDOWN_FONT_SIZE_STEPS].sort()
    );
    for (const step of MARKDOWN_FONT_SIZE_STEPS) {
      expect(MARKDOWN_FONT_SIZE_TOKEN[step]).toBe(`var(--text-${step})`);
    }
  });
});
