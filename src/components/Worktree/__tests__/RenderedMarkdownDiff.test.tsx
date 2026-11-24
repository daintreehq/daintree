// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Component, type ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import {
  buildMarkdownDiff,
  type MarkdownDiffResult,
  type ReconstructInput,
} from "../markdownBlockDiff";

interface PendingBuild {
  key: string;
  input: ReconstructInput;
  signal: AbortSignal;
  resolve: (result: MarkdownDiffResult | null) => void;
  reject: (error: unknown) => void;
}

// Long documents build on the worker. The client is replaced with one whose
// builds the test settles by hand, so each can land late, early or never.
const { buildMock, builds } = vi.hoisted(() => ({
  buildMock: vi.fn(),
  builds: [] as PendingBuild[],
}));
vi.mock("@/services/MarkdownDiffService", () => ({
  markdownDiffClient: { build: buildMock },
}));

const { dispatchMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn().mockResolvedValue({ ok: true, result: undefined }),
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

// The chord itself is the hook's business; what this view owes it is the
// callback that puts every block in the DOM before the selection is made.
const { selectAll } = vi.hoisted(() => ({
  selectAll: { beforeSelect: undefined as (() => void) | undefined },
}));
vi.mock("@/hooks/useScopedSelectAll", () => ({
  useScopedSelectAll: (_ref: unknown, _enabled: unknown, _scope: unknown, before?: () => void) => {
    selectAll.beforeSelect = before;
  },
}));

// Each ReactMarkdown render builds a processor, which runs the GFM attacher
// once: counting attacher calls counts parses.
const { gfmParses } = vi.hoisted(() => ({ gfmParses: { count: 0 } }));
vi.mock("remark-gfm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remark-gfm")>();
  return {
    default: function countedRemarkGfm(this: unknown, ...args: unknown[]) {
      gfmParses.count++;
      return Reflect.apply(actual.default, this, args) as unknown;
    },
  };
});

vi.mock("@/components/ui/EmptyState", () => ({
  EmptyState: (props: { title: string; description?: string }) => (
    <div data-testid="empty-state" data-title={props.title} data-description={props.description} />
  ),
}));

import { RenderedMarkdownDiff } from "../RenderedMarkdownDiff";
import { installAppPluginKitHost } from "@/services/plugin/appPluginKitHost";

// The app's own kit host, so the kit reaches the app services mocked here.
installAppPluginKitHost();

const ROOT = "/repo";
const FILE = "/repo/docs/guide.md";

function patch(hunks: string[]): string {
  return [
    "diff --git a/docs/guide.md b/docs/guide.md",
    "--- a/docs/guide.md",
    "+++ b/docs/guide.md",
    ...hunks,
  ].join("\n");
}

function renderDiff(
  diff: string,
  newSource: string | undefined,
  overrides: Partial<Parameters<typeof RenderedMarkdownDiff>[0]> = {}
) {
  return render(
    <RenderedMarkdownDiff
      diff={diff}
      newSource={newSource}
      status="modified"
      filePath={FILE}
      rootPath={ROOT}
      attemptKey="attempt-1"
      requestKey="pane-1"
      {...overrides}
    />
  );
}

/**
 * What a sighted reader sees, with the screen-reader-only labels removed.
 *
 * Every mark carries a hidden "Inserted: " / "Deleted: " prefix, because no
 * mainstream screen reader announces `<ins>`/`<del>` on its own. A bare
 * `textContent` therefore reports text nobody can see, and asserting against it
 * would pin the label's wording into every unrelated assertion in this file.
 */
function visibleText(element: Element | null | undefined): string {
  if (!element) return "";
  const clone = element.cloneNode(true);
  if (!(clone instanceof Element)) return "";
  clone.querySelectorAll(".sr-only").forEach((hidden) => hidden.remove());
  return clone.textContent ?? "";
}

function blockKinds(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-block-kind]")].map(
    (element) => element.getAttribute("data-block-kind") ?? ""
  );
}

const EDITED_DIFF = patch([
  "@@ -1,3 +1,3 @@",
  " # Guide",
  " ",
  "-The quick brown fox jumps over the lazy dog.",
  "+The quick brown fox leaps over the lazy dog.",
]);
const EDITED_SOURCE = "# Guide\n\nThe quick brown fox leaps over the lazy dog.\n";

beforeEach(() => {
  dispatchMock.mockClear();
  builds.length = 0;
  buildMock.mockReset();
  buildMock.mockImplementation(
    (key: string, input: ReconstructInput, signal: AbortSignal) =>
      new Promise<MarkdownDiffResult | null>((resolve, reject) => {
        builds.push({ key, input, signal, resolve, reject });
      })
  );
});

/**
 * A document with `count` untouched paragraphs between two edited ones, as a
 * patch plus its new side.
 */
function documentWithUnchangedRun(count: number) {
  const filler = Array.from({ length: count }, (_, i) => `Untouched paragraph ${i + 1}.`);
  const newSource = ["New opening line.", ...filler, "New closing line."].join("\n\n") + "\n";
  const hunk = [
    `@@ -1,${(count + 2) * 2 - 1} +1,${(count + 2) * 2 - 1} @@`,
    "-Old opening line.",
    "+New opening line.",
    ...filler.flatMap((line) => [" ", ` ${line}`]),
    " ",
    "-Old closing line.",
    "+New closing line.",
  ];
  return { diff: patch(hunk), newSource };
}

describe("RenderedMarkdownDiff", () => {
  it("keeps an unchanged block's link reference resolvable", () => {
    // Every block renders on its own, so a block citing `[docs][d]` loses its
    // target unless the definition is appended to it. Unchanged blocks are easy
    // to forget here because they are the ones nothing is being said about.
    const source = "See [the docs][d].\n\nA new closing line.\n\n[d]: https://example.com/docs\n";
    const diff = patch([
      "@@ -1,5 +1,5 @@",
      " See [the docs][d].",
      " ",
      "-An old closing line.",
      "+A new closing line.",
      " ",
      " [d]: https://example.com/docs",
    ]);

    const { container } = renderDiff(diff, source);
    const link = container.querySelector('[data-block-kind="unchanged"] a');
    expect(link?.getAttribute("href")).toBe("https://example.com/docs");
  });

  it("counts a modified pair as one change, not two", () => {
    // The number the stepper shows is a count of things the reader accepts or
    // rejects. A substitution is one of those; reporting its two halves
    // separately claims twice as many changes as the document has.
    const counts: (number | null)[] = [];
    renderDiff(EDITED_DIFF, EDITED_SOURCE, {
      onChangeCount: (n: number | null) => {
        counts.push(n);
      },
    });

    expect(counts.at(-1)).toBe(1);
  });

  it("folds a long run of unchanged blocks and opens it on request", () => {
    const { diff, newSource } = documentWithUnchangedRun(9);
    const { container } = renderDiff(diff, newSource);

    const fold = container.querySelector(".rendered-markdown-diff__fold");
    expect(fold?.textContent).toBe("Expand 5 unchanged blocks");
    // Two blocks of context survive at each edge — a change reads differently
    // when you cannot see what it follows.
    expect(container.querySelectorAll('[data-block-kind="unchanged"]').length).toBe(4);

    act(() => {
      fold?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector(".rendered-markdown-diff__fold")).toBe(null);
    expect(container.querySelectorAll('[data-block-kind="unchanged"]').length).toBe(9);
  });

  it("leaves a short run of unchanged blocks alone", () => {
    // A disclosure that hides almost nothing is pure cost: another control to
    // read, another decision to make, and no space back.
    const { diff, newSource } = documentWithUnchangedRun(4);
    const { container } = renderDiff(diff, newSource);

    expect(container.querySelector(".rendered-markdown-diff__fold")).toBe(null);
    expect(container.querySelectorAll('[data-block-kind="unchanged"]').length).toBe(4);
  });

  it("groups a substitution into one change and leaves unrelated edits as two", () => {
    // This is the structure the spacing rule keys off: a pair's halves touch
    // because they share a change wrapper, and two unrelated edits separate
    // because they do not. When the wrapper was introduced it silently
    // invalidated the old selector and a deletion-then-insertion started
    // looking exactly like a rewrite.
    const substitution = renderDiff(EDITED_DIFF, EDITED_SOURCE);
    expect(substitution.container.querySelectorAll("[data-change-index]").length).toBe(1);
    expect(
      substitution.container.querySelectorAll("[data-change-index] > .rendered-markdown-diff__pair")
        .length
    ).toBe(1);

    // Two paragraphs with nothing in common: one goes, a different one arrives.
    const source = "Kitchen inventory: seven mugs, three plates, one kettle.\n";
    const diff = patch([
      "@@ -1,1 +1,1 @@",
      "-The quick brown fox jumps over the lazy dog.",
      "+Kitchen inventory: seven mugs, three plates, one kettle.",
    ]);
    const unrelated = renderDiff(diff, source);
    expect(unrelated.container.querySelectorAll("[data-change-index]").length).toBe(2);
    expect(unrelated.container.querySelector(".rendered-markdown-diff__pair")).toBe(null);
  });

  it("gives every change a stable index for the stepper to land on", () => {
    const { diff, newSource } = documentWithUnchangedRun(9);
    const { container } = renderDiff(diff, newSource);

    const indices = [...container.querySelectorAll("[data-change-index]")].map((element) =>
      element.getAttribute("data-change-index")
    );
    expect(indices).toEqual(["0", "1"]);
  });

  it("renders the document, marking the changed block on both sides", () => {
    const { container } = renderDiff(EDITED_DIFF, EDITED_SOURCE);

    expect(container.querySelector("h1")?.textContent).toBe("Guide");
    expect(blockKinds(container)).toEqual(["unchanged", "removed", "added"]);
  });

  it("marks only the changed words inside a modified pair", () => {
    const { container } = renderDiff(EDITED_DIFF, EDITED_SOURCE);

    const removed = container.querySelector(
      ".rendered-markdown-diff__block--removed .rendered-markdown-diff__inline--removed"
    );
    const added = container.querySelector(
      ".rendered-markdown-diff__block--added .rendered-markdown-diff__inline--added"
    );

    expect(visibleText(removed)).toBe("jumps");
    expect(visibleText(added)).toBe("leaps");
  });

  it("carries native revision semantics on each mark", () => {
    // `<ins>` and `<del>` are what an assistive technology reads as a revision.
    // A styled `<span>` is a revision to nobody but a sighted reader, and this
    // view exists to be read.
    const { container } = renderDiff(EDITED_DIFF, EDITED_SOURCE);

    expect(container.querySelector(".rendered-markdown-diff__inline--removed")?.tagName).toBe(
      "DEL"
    );
    expect(container.querySelector(".rendered-markdown-diff__inline--added")?.tagName).toBe("INS");
  });

  it("names each mark for a screen reader", () => {
    // Neither NVDA, JAWS nor VoiceOver announces `<ins>`/`<del>` in browse mode
    // at default verbosity, so the elements alone leave a screen-reader user
    // hearing the same prose as everywhere else with no idea what moved.
    const { container } = renderDiff(EDITED_DIFF, EDITED_SOURCE);

    expect(
      container.querySelector(".rendered-markdown-diff__inline--removed .sr-only")?.textContent
    ).toBe("Deleted: ");
    expect(
      container.querySelector(".rendered-markdown-diff__inline--added .sr-only")?.textContent
    ).toBe("Inserted: ");
  });

  it("names each changed block for a screen reader", () => {
    const { container } = renderDiff(EDITED_DIFF, EDITED_SOURCE);

    const removed = container.querySelector(".rendered-markdown-diff__block--removed");
    const added = container.querySelector(".rendered-markdown-diff__block--added");

    expect(removed?.querySelector(".sr-only")?.textContent).toBe("Removed block:");
    expect(added?.querySelector(".sr-only")?.textContent).toBe("Added block:");
  });

  it("renders no source-diff glyph in the prose", () => {
    // A `+` or a `-` in a rendered document is a source-diff affordance leaking
    // into a reading view: it reads as content, it lands in a copy, and it
    // duplicates what the change bar already says. The non-colour cues here are
    // the bar, the strikethrough on deletions and the underline on insertions.
    const { container } = renderDiff(EDITED_DIFF, EDITED_SOURCE);

    expect(container.querySelector(".rendered-markdown-diff__marker")).toBe(null);
    for (const block of container.querySelectorAll(".rendered-markdown-diff__block")) {
      expect(visibleText(block).trimStart().startsWith("+")).toBe(false);
      expect(visibleText(block).trimStart().startsWith("\u2212")).toBe(false);
    }
  });

  it("strikes a whole deleted block, but only the deleted words of a replaced one", () => {
    // `data-whole` is what the strikethrough rule keys off. On the removed half
    // of a substitution the block-wide line crosses out the clauses that
    // SURVIVED, which is the opposite of what the engine found — there the
    // `<del>` ranges carry it instead.
    const replaced = renderDiff(EDITED_DIFF, EDITED_SOURCE);
    expect(
      replaced.container
        .querySelector(".rendered-markdown-diff__block--removed")
        ?.getAttribute("data-whole")
    ).toBe("false");

    const source = "Second paragraph.\n";
    const diff = patch(["@@ -1,3 +1,1 @@", "-First paragraph.", "-", " Second paragraph."]);
    const dropped = renderDiff(diff, source);
    expect(
      dropped.container
        .querySelector(".rendered-markdown-diff__block--removed")
        ?.getAttribute("data-whole")
    ).toBe("true");
  });

  it("mounts no line gutter, hunk header or line anchor", () => {
    const { container } = renderDiff(EDITED_DIFF, EDITED_SOURCE);

    expect(container.querySelector(".diff-gutter")).toBe(null);
    expect(container.querySelector(".diff-hunk-header")).toBe(null);
    expect(container.querySelector("table.diff")).toBe(null);
  });

  it("renders GFM tables and task lists", () => {
    const source = "| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n";
    const diff = patch([
      "@@ -0,0 +1,5 @@",
      "+| a | b |",
      "+| - | - |",
      "+| 1 | 2 |",
      "+",
      "+- [x] done",
    ]);

    const { container } = renderDiff(diff, source, { status: "added" });

    expect(container.querySelectorAll("table th")).toHaveLength(2);
    expect(container.querySelector('input[type="checkbox"]')).not.toBe(null);
  });

  it("never lets embedded HTML reach the DOM", () => {
    const source = 'Text.\n\n<img src="x" onerror="alert(1)">\n';
    const diff = patch([
      "@@ -1,3 +1,3 @@",
      " Text.",
      " ",
      '-<img src="y" onerror="alert(1)">',
      '+<img src="x" onerror="alert(1)">',
    ]);

    const { container } = renderDiff(diff, source);

    expect(container.querySelector("img")).toBe(null);
    expect(container.innerHTML).not.toContain("onerror");
  });

  it("says so when the source changed but the rendered document did not", () => {
    const source = 'Text.\n\n<div id="b">x</div>\n';
    const diff = patch([
      "@@ -1,3 +1,3 @@",
      " Text.",
      " ",
      '-<div id="a">x</div>',
      '+<div id="b">x</div>',
    ]);

    const { getByTestId } = renderDiff(diff, source);

    expect(getByTestId("empty-state").getAttribute("data-title")).toBe(
      "No rendered content changes"
    );
  });

  it("routes an external link through openExternal instead of navigating", () => {
    const source = "Read [the docs](https://example.com).\n";
    const diff = patch(["@@ -0,0 +1,1 @@", "+Read [the docs](https://example.com)."]);

    const { container } = renderDiff(diff, source, { status: "added" });
    const link = container.querySelector("a");
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(dispatchMock).toHaveBeenCalledWith(
      "browser.openExternal",
      { url: "https://example.com" },
      { source: "user" }
    );
  });

  it("refuses to open a repo link that escapes the containment root", () => {
    const source = "See [escape](../../../etc/passwd).\n";
    const diff = patch(["@@ -0,0 +1,1 @@", "+See [escape](../../../etc/passwd)."]);

    const { container } = renderDiff(diff, source, { status: "added" });
    container
      .querySelector("a")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  // Each block renders through its own pipeline, so a slugger would restart
  // at every block and repeated headings would collide: no anchors here.
  it("gives headings no ids and leaves same-document links inert (#17335)", () => {
    const source = "- [Risks](#risks)\n\n## Risks\n\nText[^1].\n\n[^1]: Note.\n";
    const diff = patch([
      "@@ -0,0 +1,7 @@",
      ...source
        .trimEnd()
        .split("\n")
        .map((line) => `+${line}`),
    ]);

    const { container } = renderDiff(diff, source, { status: "added" });
    // The view's own scroller, as a pane would be: jsdom has no layout, so it
    // is a box that scrolls with every target well below its top.
    container.style.overflowY = "auto";
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 4000 });
    container.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    for (const target of container.querySelectorAll("h2, [id]")) {
      target.getBoundingClientRect = () => ({ top: 900 }) as DOMRect;
    }
    const before = document.activeElement;
    const links = [
      container.querySelector('a[href="#risks"]'),
      container.querySelector("a[data-footnote-ref]"),
      container.querySelector("a[data-footnote-backref]"),
    ];
    for (const link of links) {
      if (!link) throw new Error("a same-document link the fixture promises is missing");
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      expect(container.scrollTop).toBe(0);
      expect(document.activeElement).toBe(before);
    }

    expect(container.querySelector("h2")?.id).toBe("");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("resolves a local image through the contained protocol URL", () => {
    const source = "![shot](./img/a.png)\n";
    const diff = patch(["@@ -0,0 +1,1 @@", "+![shot](./img/a.png)"]);

    const { container } = renderDiff(diff, source, { status: "added" });

    expect(container.querySelector("img")?.getAttribute("src")).toContain("daintree-file://");
  });

  it("carries the host's cache token on local images and follows it when it moves", () => {
    const source = "![shot](./img/a.png)\n\n![logo](https://example.com/logo.png)\n";
    const diff = patch([
      "@@ -0,0 +1,3 @@",
      "+![shot](./img/a.png)",
      "+",
      "+![logo](https://example.com/logo.png)",
    ]);

    const { container, rerender } = renderDiff(diff, source, {
      status: "added",
      cacheBust: "rev-1",
    });
    const [local, remote] = Array.from(container.querySelectorAll("img"));
    expect(new URL(local!.getAttribute("src") ?? "").searchParams.get("v")).toBe("rev-1");
    expect(remote!.getAttribute("src")).toBe("https://example.com/logo.png");

    rerender(
      <RenderedMarkdownDiff
        diff={diff}
        newSource={source}
        status="added"
        filePath={FILE}
        rootPath={ROOT}
        attemptKey="attempt-1"
        requestKey="pane-1"
        cacheBust="rev-2"
      />
    );
    const after = container.querySelector("img")!.getAttribute("src") ?? "";
    expect(new URL(after).searchParams.get("v")).toBe("rev-2");
  });

  it("reports its refusal to the host, stamped with the attempt it judged", () => {
    const onVerdict = vi.fn();
    const diff = patch(["@@ -1,2 +1,2 @@", " intro", "-old", "+new"]);

    renderDiff(diff, "intro\ndrifted\n", { onVerdict, attemptKey: "attempt-7" });

    expect(onVerdict).toHaveBeenCalledWith("source-mismatch", "attempt-7");
  });

  it("reports a clean verdict when the document rebuilt", () => {
    const onVerdict = vi.fn();

    renderDiff(EDITED_DIFF, EDITED_SOURCE, { onVerdict, attemptKey: "attempt-7" });

    expect(onVerdict).toHaveBeenCalledWith(null, "attempt-7");
  });

  it("marks changed words inside a list item, not just a bare paragraph", () => {
    // mdast-util-to-hast pads list markup with its own whitespace text nodes;
    // counting them made the two flattenings disagree and every list, table and
    // blockquote silently lose its inline marks.
    const source = "- The quick brown fox leaps over the lazy dog.\n";
    const diff = patch([
      "@@ -1,1 +1,1 @@",
      "-- The quick brown fox jumps over the lazy dog.",
      "+- The quick brown fox leaps over the lazy dog.",
    ]);

    const { container } = renderDiff(diff, source);

    expect(visibleText(container.querySelector("li .rendered-markdown-diff__inline--added"))).toBe(
      "leaps"
    );
  });

  it("marks a changed front matter value inside the metadata block, not a heading (#17334)", () => {
    const source = [
      "---",
      "name: release-check",
      "description: Checks the release branch before tagging",
      "---",
      "",
      "# Release check",
      "",
    ].join("\n");
    const diff = patch([
      "@@ -1,6 +1,6 @@",
      " ---",
      " name: release-check",
      "-description: Checks the release branch",
      "+description: Checks the release branch before tagging",
      " ---",
      " ",
      " # Release check",
    ]);

    const { container } = renderDiff(diff, source);

    expect(blockKinds(container)).toEqual(["removed", "added", "unchanged"]);
    const added = container.querySelector(
      ".rendered-markdown-diff__block--added [data-frontmatter]"
    );
    expect(visibleText(added)).toBe(
      "name: release-check\ndescription: Checks the release branch before tagging"
    );
    expect(
      [...(added?.querySelectorAll(".rendered-markdown-diff__inline--added") ?? [])].map(
        visibleText
      )
    ).toEqual(["before tagging"]);
    expect(container.querySelector("hr")).toBeNull();
    expect([...container.querySelectorAll("h1, h2")].map((h) => h.textContent)).toEqual([
      "Release check",
    ]);
  });

  it("renders a later block that opens with a fence as the document does, not as front matter", () => {
    const source = 'Body.\n\n+++\nname = "new"\n+++\n';
    const diff = patch([
      "@@ -1,5 +1,5 @@",
      " Body.",
      " ",
      " +++",
      '-name = "old"',
      '+name = "new"',
      " +++",
    ]);

    const { container } = renderDiff(diff, source);

    expect(container.querySelector("[data-frontmatter]")).toBeNull();
    expect(
      visibleText(container.querySelector(".rendered-markdown-diff__block--added p"))
    ).toContain('name = "new"');
  });

  it("strikes a deleted front matter block whole, keeping its lines visible", () => {
    const source = "# Release check\n";
    const diff = patch([
      "@@ -1,5 +1,1 @@",
      "----",
      "-name: release-check",
      "----",
      "-",
      " # Release check",
    ]);

    const { container } = renderDiff(diff, source);

    const removed = container.querySelector(".rendered-markdown-diff__block--removed");
    expect(removed?.getAttribute("data-whole")).toBe("true");
    const metadata = removed?.querySelector("[data-frontmatter]");
    expect(metadata?.textContent).toBe("name: release-check");

    // jsdom applies no imported stylesheet, so the rule that strikes a deleted
    // block's text goes in by hand to see that it reaches the metadata too.
    const style = document.createElement("style");
    style.textContent = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../RenderedMarkdownDiff.css"),
      "utf8"
    );
    document.head.append(style);
    try {
      expect(metadata && getComputedStyle(metadata).textDecoration).toContain("line-through");
    } finally {
      style.remove();
    }
  });

  it("keeps a footnote's text in the rendered output", () => {
    const source = "Text[^1].\n\n[^1]: The new note.\n";
    const diff = patch([
      "@@ -1,3 +1,3 @@",
      " Text[^1].",
      " ",
      "-[^1]: The old note.",
      "+[^1]: The new note.",
    ]);

    const { container } = renderDiff(diff, source);

    // The note rides with the block that cites it; rendered alone it would emit
    // nothing and the paragraph would show a literal "[^1]".
    expect(container.textContent).toContain("The new note.");
    expect(container.textContent).not.toContain("[^1].");
  });

  it("rebuilds a deleted document from the patch with no source on disk", () => {
    const diff = [
      "diff --git a/docs/guide.md b/docs/guide.md",
      "deleted file mode 100644",
      "--- a/docs/guide.md",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-# Gone",
      "-",
      "-Body text here.",
    ].join("\n");

    const { container } = renderDiff(diff, undefined, { status: "deleted" });

    expect(blockKinds(container)).toEqual(["removed", "removed"]);
    expect(container.textContent).toContain("Body text here.");
  });
});

/**
 * A document past the in-render ceiling with its last paragraph edited, as a
 * real patch plus its new side, so a test can settle the build with what the
 * engine actually makes of it.
 */
function longDocument(marker: string) {
  const filler = Array.from(
    { length: 400 },
    (_, i) => `Paragraph ${i + 1} of the ${marker} document, long enough to count.`
  );
  const newSource = [`# ${marker}`, ...filler, `The ${marker} ending was rewritten.`].join("\n\n");
  const line = newSource.split("\n").length;
  const diff = patch([
    `@@ -${line},1 +${line},1 @@`,
    `-The ${marker} ending.`,
    `+The ${marker} ending was rewritten.`,
  ]);
  expect(newSource.length).toBeGreaterThan(16 * 1024);
  return { diff, newSource };
}

function engineResult(build: PendingBuild | undefined): MarkdownDiffResult {
  if (!build) throw new Error("no build was requested");
  return buildMarkdownDiff(build.input);
}

const SKELETON = '[aria-label="Loading rendered Markdown"]';

class Boundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override render() {
    return this.state.error ? <div data-testid="boundary" /> : this.props.children;
  }
}

describe("RenderedMarkdownDiff off the main thread", () => {
  it("keeps a short document in render without touching the worker", () => {
    const { container } = renderDiff(EDITED_DIFF, EDITED_SOURCE);

    expect(buildMock).not.toHaveBeenCalled();
    expect(blockKinds(container)).toContain("added");
  });

  it("shows the skeleton and reports nothing until a long document's build lands", async () => {
    const onVerdict = vi.fn();
    const onChangeCount = vi.fn();
    const { diff, newSource } = longDocument("first");

    const { container } = renderDiff(diff, newSource, { onVerdict, onChangeCount });

    expect(container.querySelector(SKELETON)).not.toBeNull();
    expect(container.querySelector("[data-block-kind]")).toBeNull();
    expect(onVerdict).not.toHaveBeenCalled();
    expect(onChangeCount).not.toHaveBeenCalled();
    expect(builds).toHaveLength(1);
    expect(builds[0]!.key).toBe("pane-1");
    expect(builds[0]!.input).toEqual({ diff, newSource, status: "modified" });

    await act(async () => builds[0]!.resolve(engineResult(builds[0])));

    expect(container.querySelector(SKELETON)).toBeNull();
    expect(blockKinds(container)).toEqual(expect.arrayContaining(["removed", "added"]));
    expect(visibleText(container)).toContain("The first ending was rewritten.");
    expect(onVerdict.mock.calls).toEqual([[null, "attempt-1"]]);
    expect(onChangeCount.mock.calls).toEqual([[1, "attempt-1"]]);
  });

  it("never shows or reports a late result for inputs it has moved past", async () => {
    const onVerdict = vi.fn();
    const onChangeCount = vi.fn();
    const first = longDocument("first");
    const second = longDocument("second");
    const props = { onVerdict, onChangeCount };

    const { container, rerender } = renderDiff(first.diff, first.newSource, props);
    rerender(
      <RenderedMarkdownDiff
        diff={second.diff}
        newSource={second.newSource}
        status="modified"
        filePath={FILE}
        rootPath={ROOT}
        attemptKey="attempt-2"
        requestKey="pane-1"
        {...props}
      />
    );

    expect(builds).toHaveLength(2);
    expect(builds[0]!.signal.aborted).toBe(true);
    expect(builds[1]!.key).toBe("pane-1");

    // The first file's comparison lands after the reader has already moved on.
    await act(async () => builds[0]!.resolve(engineResult(builds[0])));

    expect(container.querySelector(SKELETON)).not.toBeNull();
    expect(container.querySelector("[data-block-kind]")).toBeNull();
    expect(onVerdict).not.toHaveBeenCalled();
    expect(onChangeCount).not.toHaveBeenCalled();

    await act(async () => builds[1]!.resolve(engineResult(builds[1])));

    expect(visibleText(container)).toContain("The second ending was rewritten.");
    expect(visibleText(container)).not.toContain("first ending");
    expect(onVerdict.mock.calls).toEqual([[null, "attempt-2"]]);
    expect(onChangeCount.mock.calls).toEqual([[1, "attempt-2"]]);
  });

  it("reports the worker's refusal exactly and renders nothing", async () => {
    const onVerdict = vi.fn();
    const onChangeCount = vi.fn();
    const { diff, newSource } = longDocument("refused");

    const { container } = renderDiff(diff, newSource, {
      onVerdict,
      onChangeCount,
      attemptKey: "attempt-9",
    });
    await act(async () => builds[0]!.resolve({ ok: false, reason: "too-large" }));

    expect(onVerdict.mock.calls).toEqual([["too-large", "attempt-9"]]);
    expect(onChangeCount.mock.calls).toEqual([[0, "attempt-9"]]);
    expect(container.innerHTML).toBe("");
  });

  it("stays loading, and silent, when its build is superseded", async () => {
    const onVerdict = vi.fn();
    const { diff, newSource } = longDocument("superseded");

    const { container } = renderDiff(diff, newSource, { onVerdict });
    await act(async () => builds[0]!.resolve(null));

    expect(container.querySelector(SKELETON)).not.toBeNull();
    expect(onVerdict).not.toHaveBeenCalled();
  });

  it("abandons its build when it unmounts", () => {
    const { diff, newSource } = longDocument("closed");

    const { unmount } = renderDiff(diff, newSource);
    unmount();

    expect(builds[0]!.signal.aborted).toBe(true);
  });

  it("hands an engine error to the error boundary rather than reporting a verdict", async () => {
    const onVerdict = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { diff, newSource } = longDocument("broken");

    const { getByTestId } = render(
      <Boundary>
        <RenderedMarkdownDiff
          diff={diff}
          newSource={newSource}
          status="modified"
          filePath={FILE}
          rootPath={ROOT}
          attemptKey="attempt-1"
          requestKey="pane-1"
          onVerdict={onVerdict}
        />
      </Boundary>
    );
    await act(async () => builds[0]!.reject(new Error("engine exploded")));

    expect(getByTestId("boundary")).toBeTruthy();
    expect(onVerdict).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
  it("drops a settled document for the skeleton the moment its inputs move on", async () => {
    const onVerdict = vi.fn();
    const onChangeCount = vi.fn();
    const first = longDocument("first");
    const second = longDocument("second");
    const props = { onVerdict, onChangeCount };

    const { container, rerender } = renderDiff(first.diff, first.newSource, props);
    await act(async () => builds[0]!.resolve(engineResult(builds[0])));
    expect(visibleText(container)).toContain("The first ending was rewritten.");

    rerender(
      <RenderedMarkdownDiff
        diff={second.diff}
        newSource={second.newSource}
        status="modified"
        filePath={FILE}
        rootPath={ROOT}
        attemptKey="attempt-2"
        requestKey="pane-1"
        {...props}
      />
    );

    // The first document is settled and still in state, but it is not what the
    // reader asked for any more.
    expect(container.querySelector(SKELETON)).not.toBeNull();
    expect(visibleText(container)).not.toContain("first ending");
    expect(onVerdict.mock.calls).toEqual([[null, "attempt-1"]]);
    // Its count is withdrawn, and nothing is reported for the attempt in flight.
    expect(onChangeCount.mock.calls).toEqual([
      [1, "attempt-1"],
      [null, "attempt-1"],
    ]);

    await act(async () => builds[1]!.resolve(engineResult(builds[1])));

    expect(visibleText(container)).toContain("The second ending was rewritten.");
    expect(onVerdict.mock.calls.at(-1)).toEqual([null, "attempt-2"]);
    expect(onChangeCount.mock.calls.at(-1)).toEqual([1, "attempt-2"]);
  });

  it("withdraws its change count when it unmounts", async () => {
    const onChangeCount = vi.fn();
    const { diff, newSource } = longDocument("closing");

    const { unmount } = renderDiff(diff, newSource, { onChangeCount, attemptKey: "attempt-3" });
    await act(async () => builds[0]!.resolve(engineResult(builds[0])));
    unmount();

    expect(onChangeCount.mock.calls).toEqual([
      [1, "attempt-3"],
      [null, "attempt-3"],
    ]);
  });

  it("sends a long deleted document to the worker, measured by its patch", async () => {
    const lines = Array.from(
      { length: 400 },
      (_, i) => `Removed paragraph ${i + 1}, long enough that the patch alone is large.`
    );
    const diff = [
      "diff --git a/docs/guide.md b/docs/guide.md",
      "deleted file mode 100644",
      "--- a/docs/guide.md",
      "+++ /dev/null",
      `@@ -1,${lines.length} +0,0 @@`,
      ...lines.map((line) => `-${line}`),
    ].join("\n");
    expect(diff.length).toBeGreaterThan(16 * 1024);

    const { container } = renderDiff(diff, undefined, { status: "deleted" });

    expect(builds).toHaveLength(1);
    expect(builds[0]!.input).toEqual({ diff, newSource: undefined, status: "deleted" });
    expect(container.querySelector(SKELETON)).not.toBeNull();

    await act(async () => builds[0]!.resolve(engineResult(builds[0])));

    expect(blockKinds(container)).toContain("removed");
    expect(visibleText(container)).toContain("Removed paragraph 400");
  });
});

describe("RenderedMarkdownDiff staged mounting", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  beforeEach(() => {
    frames = new Map();
    nextFrame = 1;
    gfmParses.count = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    return () => vi.restoreAllMocks();
  });

  /** Run every queued frame, and the frames those schedule, until none is left. */
  function drainFrames(limit = 1000) {
    let ran = 0;
    while (frames.size > 0) {
      if (++ran > limit) throw new Error("frames never settled");
      runOneFrame();
    }
    return ran;
  }

  function runOneFrame() {
    const [id, callback] = frames.entries().next().value!;
    frames.delete(id);
    act(() => callback(performance.now()));
  }

  function pendingCount(container: HTMLElement): number {
    return container.querySelectorAll(".rendered-markdown-diff__pending").length;
  }

  function addedDocument(count: number, label = "Added") {
    const paragraphs = Array.from({ length: count }, (_, i) => `${label} paragraph ${i + 1}.`);
    const lines = paragraphs.flatMap((line, i) => (i === 0 ? [line] : ["", line]));
    const diff = patch([`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)]);
    return { diff, newSource: lines.join("\n") + "\n" };
  }

  it("mounts a long document a slice at a time, with every change's frame in place", () => {
    const { diff, newSource } = addedDocument(80);
    const { container } = renderDiff(diff, newSource, { status: "added" });

    const changes = container.querySelectorAll("[data-change-index]").length;
    expect(changes).toBe(80);
    const firstPending = pendingCount(container);
    expect(firstPending).toBeGreaterThan(0);
    expect(firstPending).toBeLessThan(changes);
    // Frames stand in for every change from the first commit, so the stepper
    // can land on any of them.
    expect(container.querySelectorAll("[data-block-kind]").length).toBe(changes);
    expect(gfmParses.count).toBe(changes - firstPending);

    runOneFrame();
    expect(pendingCount(container)).toBeLessThan(firstPending);

    expect(drainFrames()).toBeGreaterThan(1);
    expect(pendingCount(container)).toBe(0);
    expect(visibleText(container)).toContain("Added paragraph 80.");
  });

  it("parses each block exactly once however many slices land around it", () => {
    const { diff, newSource } = addedDocument(80);
    renderDiff(diff, newSource, { status: "added" });
    drainFrames();
    expect(gfmParses.count).toBe(80);
  });

  it("renders a short document whole in its first commit", () => {
    const { container } = renderDiff(EDITED_DIFF, EDITED_SOURCE);
    expect(pendingCount(container)).toBe(0);
    expect(frames.size).toBe(0);
  });

  it("stages the blocks a fold reveals, keeping both edges mounted and focus on the reveal", () => {
    const { diff, newSource } = documentWithUnchangedRun(120);
    const { container } = renderDiff(diff, newSource);
    drainFrames();
    expect(pendingCount(container)).toBe(0);
    const edges = [...container.querySelectorAll('[data-block-kind="unchanged"] p')];
    expect(edges).toHaveLength(4);
    const parsedBefore = gfmParses.count;

    act(() => {
      container
        .querySelector(".rendered-markdown-diff__fold")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const unchanged = [...container.querySelectorAll('[data-block-kind="unchanged"]')];
    expect(unchanged).toHaveLength(120);
    expect(pendingCount(container)).toBeGreaterThan(0);
    // The edge blocks are the same nodes, not placeholders and not re-parses.
    expect(unchanged[0]!.querySelector("p")).toBe(edges[0]);
    expect(unchanged[1]!.querySelector("p")).toBe(edges[1]);
    expect(unchanged[118]!.querySelector("p")).toBe(edges[2]);
    expect(unchanged[119]!.querySelector("p")).toBe(edges[3]);
    expect(document.activeElement).toBe(unchanged[2]);

    drainFrames();
    expect(pendingCount(container)).toBe(0);
    expect(document.activeElement).toBe(unchanged[2]);
    expect(gfmParses.count - parsedBefore).toBe(116);
    expect(visibleText(container)).toContain("Untouched paragraph 60.");
  });

  it("puts every block in the DOM before a Select All is made", () => {
    const { diff, newSource } = addedDocument(80);
    const { container } = renderDiff(diff, newSource, { status: "added" });
    expect(pendingCount(container)).toBeGreaterThan(0);

    let pendingAtSelection = -1;
    act(() => {
      selectAll.beforeSelect?.();
      // The selection is made the moment the callback returns.
      pendingAtSelection = pendingCount(container);
    });

    expect(pendingAtSelection).toBe(0);
    expect(visibleText(container)).toContain("Added paragraph 80.");
  });

  it("starts a new document over rather than inheriting the last one's progress", () => {
    const first = addedDocument(80);
    const view = renderDiff(first.diff, first.newSource, { status: "added" });
    drainFrames();
    expect(pendingCount(view.container)).toBe(0);

    // Same shape, so the old document's keys would all count as mounted.
    const second = addedDocument(80, "Rewritten");
    view.rerender(
      <RenderedMarkdownDiff
        diff={second.diff}
        newSource={second.newSource}
        status="added"
        filePath={FILE}
        rootPath={ROOT}
        attemptKey="attempt-2"
        requestKey="pane-1"
      />
    );
    expect(pendingCount(view.container)).toBeGreaterThan(0);
    drainFrames();
    expect(pendingCount(view.container)).toBe(0);
    expect(visibleText(view.container)).toContain("Rewritten paragraph 80.");
  });

  it("mounts what the reader scrolls or steps to ahead of the sweep", () => {
    const observed: Element[] = [];
    let notify: ((entries: Partial<IntersectionObserverEntry>[]) => void) | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {
          notify = callback;
        }
        observe(element: Element) {
          observed.push(element);
        }
        disconnect() {
          observed.length = 0;
        }
        unobserve() {}
        takeRecords() {
          return [];
        }
      }
    );
    try {
      const { diff, newSource } = addedDocument(80);
      const { container } = renderDiff(diff, newSource, { status: "added" });
      const target = container.querySelector<HTMLElement>('[data-change-index="70"]')!;
      expect(observed).toContain(target);
      expect(target.querySelector(".rendered-markdown-diff__pending")).not.toBe(null);

      act(() => notify?.([{ target, isIntersecting: true }]));

      expect(target.querySelector(".rendered-markdown-diff__pending")).toBe(null);
      expect(visibleText(target)).toContain("Added paragraph 71.");
      // Only what came into view jumped the queue.
      const neighbour = container.querySelector('[data-change-index="69"]')!;
      expect(neighbour.querySelector(".rendered-markdown-diff__pending")).not.toBe(null);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops staging when it unmounts", () => {
    const { diff, newSource } = addedDocument(80);
    const view = renderDiff(diff, newSource, { status: "added" });
    expect(frames.size).toBe(1);
    view.unmount();
    expect(frames.size).toBe(0);
  });
});

describe("RenderedMarkdownDiff GitHub alerts (#17333)", () => {
  function alertsIn(container: HTMLElement, kind: "added" | "removed"): Element[] {
    return [
      ...container.querySelectorAll(`.rendered-markdown-diff__block--${kind} .markdown-alert`),
    ];
  }

  it("draws an edited alert as an alert on both sides, keeping its word marks", () => {
    const source = "> [!WARNING]\n> This migration drops the new table.\n";
    const diff = patch([
      "@@ -1,2 +1,2 @@",
      " > [!WARNING]",
      "-> This migration drops the old table.",
      "+> This migration drops the new table.",
    ]);

    const { container } = renderDiff(diff, source);
    const [removed] = alertsIn(container, "removed");
    const [added] = alertsIn(container, "added");

    expect(removed?.getAttribute("data-markdown-alert")).toBe("warning");
    expect(added?.getAttribute("data-markdown-alert")).toBe("warning");
    expect(visibleText(removed?.querySelector(".rendered-markdown-diff__inline--removed"))).toBe(
      "old"
    );
    expect(visibleText(added?.querySelector(".rendered-markdown-diff__inline--added"))).toBe("new");
    expect(container.textContent).not.toContain("[!WARNING]");
  });

  it("takes a changed marker out whole, leaving no empty mark behind", () => {
    const source = "> [!WARNING]\n> Back up the database first.\n";
    const diff = patch([
      "@@ -1,2 +1,2 @@",
      "-> [!NOTE]",
      "+> [!WARNING]",
      " > Back up the database first.",
    ]);
    // The engine marks inside the marker itself, so the marks reach the alert step.
    const built = buildMarkdownDiff({ diff, newSource: source, status: "modified" });
    const modified = built.ok
      ? built.model.changes.find((change) => change.kind === "modified")
      : undefined;
    expect(modified?.kind).toBe("modified");
    if (modified?.kind !== "modified") return;
    expect(modified.inline.old.some((range) => range.start < "[!NOTE]".length)).toBe(true);
    expect(modified.inline.new.some((range) => range.start < "[!WARNING]".length)).toBe(true);

    const { container } = renderDiff(diff, source);

    expect(
      alertsIn(container, "removed").map((box) => box.getAttribute("data-markdown-alert"))
    ).toEqual(["note"]);
    expect(
      alertsIn(container, "added").map((box) => box.getAttribute("data-markdown-alert"))
    ).toEqual(["warning"]);
    expect(container.textContent).not.toContain("[!");
    for (const mark of container.querySelectorAll(".rendered-markdown-diff__inline")) {
      expect(visibleText(mark)).not.toBe("");
    }
  });

  it("reads no further through authored strikethrough than the document does", () => {
    const source = "> ~~[!NOTE]~~\n> Body changed.\n";
    const diff = patch(["@@ -1,2 +1,2 @@", " > ~~[!NOTE]~~", "-> Body.", "+> Body changed."]);

    const { container } = renderDiff(diff, source);

    expect(container.querySelector(".markdown-alert")).toBeNull();
    expect(visibleText(container.querySelector(".rendered-markdown-diff__block--added"))).toContain(
      "[!NOTE]"
    );
  });

  it("draws a whole added alert as an alert", () => {
    const source = "# Guide\n\n> [!CAUTION]\n> Irreversible.\n";
    const diff = patch(["@@ -1,1 +1,4 @@", " # Guide", "+", "+> [!CAUTION]", "+> Irreversible."]);

    const { container } = renderDiff(diff, source);

    expect(
      alertsIn(container, "added").map((box) => box.getAttribute("data-markdown-alert"))
    ).toEqual(["caution"]);
  });
});
