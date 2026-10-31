// @vitest-environment jsdom
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

vi.mock("@/hooks/useScopedSelectAll", () => ({ useScopedSelectAll: () => {} }));

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
    const counts: number[] = [];
    renderDiff(EDITED_DIFF, EDITED_SOURCE, { onChangeCount: (n: number) => counts.push(n) });

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
      [0, "attempt-1"],
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
      [0, "attempt-3"],
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
