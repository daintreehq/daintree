// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

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
      {...overrides}
    />
  );
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
});

describe("RenderedMarkdownDiff", () => {
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

    expect(removed?.textContent).toBe("jumps");
    expect(added?.textContent).toBe("leaps");
  });

  it("names each changed block for a screen reader and shows a non-colour marker", () => {
    const { container } = renderDiff(EDITED_DIFF, EDITED_SOURCE);

    const removed = container.querySelector(".rendered-markdown-diff__block--removed");
    const added = container.querySelector(".rendered-markdown-diff__block--added");

    expect(removed?.querySelector(".sr-only")?.textContent).toBe("Removed block:");
    expect(added?.querySelector(".sr-only")?.textContent).toBe("Added block:");
    expect(removed?.querySelector(".rendered-markdown-diff__marker")?.textContent).toBe("−");
    expect(added?.querySelector(".rendered-markdown-diff__marker")?.textContent).toBe("+");
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

    expect(container.querySelector("li .rendered-markdown-diff__inline--added")?.textContent).toBe(
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
