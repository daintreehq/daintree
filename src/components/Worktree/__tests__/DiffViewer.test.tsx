// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ChangeData, HunkData, RenderToken } from "react-diff-view";
import type { InsertChange, DeleteChange } from "gitdiff-parser";
import { DiffViewer, _resetLangStateForTests, _flushLangLoadsForTests } from "../DiffViewer";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("refractor/rust", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

const { capturedDiffProps } = vi.hoisted(() => ({
  capturedDiffProps: {} as Record<string, unknown>,
}));

vi.mock("react-diff-view", async () => {
  const actual = await vi.importActual<typeof import("react-diff-view")>("react-diff-view");
  return {
    ...actual,
    Diff: (props: { children: (hunks: unknown[]) => React.ReactNode; hunks: unknown[] }) => {
      Object.assign(capturedDiffProps, props);
      return <div data-testid="diff-element">{props.children(props.hunks)}</div>;
    },
    Hunk: ({ hunk }: { hunk: { oldStart: number; newStart: number } }) => (
      <div data-testid="hunk">
        {hunk.oldStart}-{hunk.newStart}
      </div>
    ),
    tokenize: vi.fn(),
    markEdits: vi.fn(() => vi.fn()),
  };
});

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

const rustDiff = `diff --git a/main.rs b/main.rs
index abc123..def456 100644
--- a/main.rs
+++ b/main.rs
@@ -1,3 +1,3 @@
-fn old() {
+fn new() {
   let x = 1;
-  return x;
+  return x + 1;
 }`;

const jsDiff = `diff --git a/app.js b/app.js
index 123abc..456def 100644
--- a/app.js
+++ b/app.js
@@ -1,1 +1,1 @@
-console.log("old");
+console.log("new");`;

const SMALL_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 0123456..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
+added
 line2
-line3`;

const LOCKFILE_DIFF = `diff --git a/package-lock.json b/package-lock.json
index 0123456..abcdefg 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,4 @@
 line1
+added
 line2
-line3`;

function wrap(ui: React.ReactElement) {
  return <TooltipProvider>{ui}</TooltipProvider>;
}

// DiffViewer tokenizes through DiffTokenizeService. jsdom has no Worker, so the
// service fails over to in-thread tokenization behind setTimeout(0) yields, fired
// by the component as a floating promise (`void tokenize().then(setPass)`). That
// leaves async work that can log after a test finishes:
//   - console.warn "Diff tokenize worker unavailable…" (failover)
//   - console.warn "Failed to load refractor grammar…" (the rust mock throws)
//   - console.error React act() warning when the late setPass lands out of act
// Any of these firing during worker teardown trips vitest's
// "Closing rpc while onUserConsoleLog was pending". Silence the expected console
// noise for this file (never restored, so nothing leaks at teardown) and, in
// afterEach, drain the macrotask/microtask queue inside act() so the pipeline
// and its state update settle deterministically before the next test.
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    await _flushLangLoadsForTests();
  });
});

describe("DiffViewer", () => {
  beforeEach(() => {
    _resetLangStateForTests();
  });

  it("shows Plain text badge when refractor chunk load fails", async () => {
    render(wrap(<DiffViewer diff={rustDiff} />));
    await waitFor(() => {
      expect(screen.getByTestId("diff-plain-text-badge")).toBeTruthy();
    });
    expect(screen.getByTestId("diff-plain-text-badge").textContent).toBe("Plain text");
  });

  it("does not show Plain text badge for built-in languages", async () => {
    render(wrap(<DiffViewer diff={jsDiff} />));
    await waitFor(() => {
      expect(screen.getByText("app.js")).toBeTruthy();
    });
    expect(screen.queryByTestId("diff-plain-text-badge")).toBeNull();
  });

  it("does not show Plain text badge for unknown file extensions", async () => {
    const unknownDiff = `diff --git a/foo.xyz b/foo.xyz
index 000..111 100644
--- a/foo.xyz
+++ b/foo.xyz
@@ -1,1 +1,1 @@
-old
+new`;
    render(wrap(<DiffViewer diff={unknownDiff} />));
    await waitFor(() => {
      expect(screen.getByText("foo.xyz")).toBeTruthy();
    });
    expect(screen.queryByTestId("diff-plain-text-badge")).toBeNull();
  });

  it("renders NO_CHANGES sentinel", () => {
    render(wrap(<DiffViewer diff="NO_CHANGES" />));
    expect(screen.getByText("No changes detected")).toBeTruthy();
  });

  it("renders BINARY_FILE sentinel", () => {
    render(wrap(<DiffViewer diff="BINARY_FILE" />));
    expect(screen.getByText("Binary file")).toBeTruthy();
  });

  it("renders FILE_TOO_LARGE sentinel", () => {
    render(wrap(<DiffViewer diff="FILE_TOO_LARGE" />));
    expect(screen.getByText("File too large")).toBeTruthy();
  });

  it("renders ERROR sentinel with error message", () => {
    render(wrap(<DiffViewer diff="ERROR" />));
    expect(screen.getByText("Couldn't load diff")).toBeTruthy();
  });

  it("does not render parse-failure fallback for ERROR sentinel", () => {
    render(wrap(<DiffViewer diff="ERROR" />));
    // ERROR sentinel is checked before files.length, so we get the error UI
    expect(screen.getByText("Couldn't load diff")).toBeTruthy();
    expect(screen.queryByText("Unable to parse diff")).toBeNull();
  });

  it("renders retry button when onRetry is provided", () => {
    const onRetry = vi.fn();
    render(wrap(<DiffViewer diff="ERROR" onRetry={onRetry} />));
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("does not render retry button when onRetry is omitted", () => {
    render(wrap(<DiffViewer diff="ERROR" />));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("calls onRetry when retry button is clicked", () => {
    const onRetry = vi.fn();
    render(wrap(<DiffViewer diff="ERROR" onRetry={onRetry} />));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders empty diff sentinel", () => {
    render(wrap(<DiffViewer diff="" />));
    expect(screen.getByText("No changes detected")).toBeTruthy();
  });

  it("renders parse failure when diff is unparseable", () => {
    render(wrap(<DiffViewer diff="not a real diff" />));
    expect(screen.getByText("Unable to parse diff")).toBeTruthy();
  });
});

describe("DiffViewer sentinel messages", () => {
  beforeEach(() => {
    _resetLangStateForTests();
  });

  it("shows NO_CHANGES message", () => {
    render(wrap(<DiffViewer diff="NO_CHANGES" />));
    expect(screen.getByText("No changes detected")).toBeTruthy();
  });

  it("shows BINARY_FILE message", () => {
    render(wrap(<DiffViewer diff="BINARY_FILE" />));
    expect(screen.getByText("Binary file")).toBeTruthy();
  });

  it("shows FILE_TOO_LARGE message with 1MB threshold", () => {
    render(wrap(<DiffViewer diff="FILE_TOO_LARGE" />));
    expect(screen.getByText(/File too large/)).toBeTruthy();
    expect(screen.getByText(/over 1 MB/)).toBeTruthy();
  });
});

describe("DiffViewer collapse behavior", () => {
  beforeEach(() => {
    _resetLangStateForTests();
  });

  it("collapses lockfile diff by default with toggle", () => {
    render(wrap(<DiffViewer diff={LOCKFILE_DIFF} />));

    expect(screen.getByText("Generated file collapsed")).toBeTruthy();
    expect(screen.getByText("Show diff")).toBeTruthy();

    fireEvent.click(screen.getByText("Show diff"));

    expect(screen.getByText("Hide diff")).toBeTruthy();
  });

  it("renders small normal file without collapse", () => {
    render(wrap(<DiffViewer diff={SMALL_DIFF} />));

    expect(screen.queryByText("Show diff")).toBeNull();
    expect(screen.queryByText("Generated file collapsed")).toBeNull();
  });

  it("toggles collapse state — expand then collapse again", () => {
    render(wrap(<DiffViewer diff={LOCKFILE_DIFF} />));

    expect(screen.queryByTestId("diff-element")).toBeNull();

    fireEvent.click(screen.getByText("Show diff"));
    expect(screen.getByTestId("diff-element")).toBeTruthy();
    expect(screen.getByText("Hide diff")).toBeTruthy();

    fireEvent.click(screen.getByText("Hide diff"));
    expect(screen.queryByTestId("diff-element")).toBeNull();
    expect(screen.getByText("Show diff")).toBeTruthy();
  });

  // #10013: consumers re-scan hunk rows on toggle, so the callback must fire on
  // both expand and collapse — once per transition.
  it("fires onToggleCollapse on each expand and collapse transition", () => {
    const onToggleCollapse = vi.fn();
    render(wrap(<DiffViewer diff={LOCKFILE_DIFF} onToggleCollapse={onToggleCollapse} />));

    expect(onToggleCollapse).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Show diff"));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Hide diff"));
    expect(onToggleCollapse).toHaveBeenCalledTimes(2);
  });
});

const ADDED_FILE_DIFF = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..abcdef1
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+line1
+line2`;

const DELETED_FILE_DIFF = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index abcdef1..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line1
-line2`;

describe("DiffViewer centered split", () => {
  it("uses the centered-split scroll system for two-column split diffs", () => {
    const { container } = render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="split" />));

    expect(container.querySelector(".diff-file-centered")).not.toBeNull();
    expect(container.querySelector(".diff-file-scroll")).toBeNull();
    expect(screen.getByTestId("diff-hscrollbar").getAttribute("data-scroll-mode")).toBe("centered");
  });

  it("keeps the native scroller in unified view, with a proxy strip beside it", () => {
    const { container } = render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="unified" />));

    expect(container.querySelector(".diff-file-centered")).toBeNull();
    expect(container.querySelector(".diff-file-scroll")).not.toBeNull();
    expect(screen.getByTestId("diff-hscrollbar").getAttribute("data-scroll-mode")).toBe("native");
  });

  it("keeps the native scroller when wrapping lines", () => {
    const { container } = render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="split" wrapLines />));

    expect(container.querySelector(".diff-file-centered")).toBeNull();
    expect(screen.queryByTestId("diff-hscrollbar")).toBeNull();
  });

  it("keeps the native scroller for single-side added-file diffs", () => {
    const { container } = render(wrap(<DiffViewer diff={ADDED_FILE_DIFF} viewType="split" />));

    // Add files are single-column ("monotonous") in react-diff-view, so they take
    // the horizontal-scroll fallback path rather than the two-column centered split.
    expect(container.querySelector(".diff-file-centered")).toBeNull();
    expect(container.querySelector(".diff-file-scroll")).not.toBeNull();
    expect(screen.getByTestId("diff-hscrollbar").getAttribute("data-scroll-mode")).toBe("native");
  });

  it("keeps the native scroller for single-side deleted-file diffs", () => {
    const { container } = render(wrap(<DiffViewer diff={DELETED_FILE_DIFF} viewType="split" />));

    expect(container.querySelector(".diff-file-centered")).toBeNull();
    expect(container.querySelector(".diff-file-scroll")).not.toBeNull();
    expect(screen.getByTestId("diff-hscrollbar").getAttribute("data-scroll-mode")).toBe("native");
  });

  it("mirrors the scrollbar strip's scrollLeft into --diff-hscroll", () => {
    const { container } = render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="split" />));
    const region = container.querySelector<HTMLElement>(".diff-file-centered");
    const bar = screen.getByTestId("diff-hscrollbar");

    expect(region?.style.getPropertyValue("--diff-hscroll")).toBe("0px");

    bar.scrollLeft = 120;
    fireEvent.scroll(bar);

    expect(region?.style.getPropertyValue("--diff-hscroll")).toBe("120px");
  });

  it("forwards horizontal wheel deltas to the scrollbar strip", () => {
    const { container } = render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="split" />));
    const region = container.querySelector<HTMLElement>(".diff-file-centered");
    const bar = screen.getByTestId("diff-hscrollbar");
    Object.defineProperty(bar, "scrollWidth", { value: 500, configurable: true });
    Object.defineProperty(bar, "clientWidth", { value: 200, configurable: true });

    fireEvent.wheel(region!, { deltaX: 50, deltaY: 0 });
    expect(bar.scrollLeft).toBe(50);

    // Predominantly vertical gestures stay with the vertical scroller.
    fireEvent.wheel(region!, { deltaX: 5, deltaY: 50 });
    expect(bar.scrollLeft).toBe(50);
  });
});

describe("DiffViewer wrap attribute", () => {
  // data-wrap drives the [data-wrap="true"] CSS rules (soft-wrap on) versus the
  // base white-space: pre rule (no-wrap + horizontal scroll). The attribute must
  // track wrapLines for every diff type, including the single-side add/delete
  // files that take the fallback scroll path.
  it("omits data-wrap when wrapLines is unset, for added-file diffs", () => {
    const { container } = render(wrap(<DiffViewer diff={ADDED_FILE_DIFF} viewType="split" />));

    const root = container.querySelector(".diff-viewer");
    expect(root).not.toBeNull();
    expect(root?.hasAttribute("data-wrap")).toBe(false);
  });

  it("sets data-wrap=true when wrapLines is on, for added-file diffs", () => {
    const { container } = render(
      wrap(<DiffViewer diff={ADDED_FILE_DIFF} viewType="split" wrapLines />)
    );

    expect(container.querySelector(".diff-viewer")?.getAttribute("data-wrap")).toBe("true");
  });

  it("sets data-wrap=true when wrapLines is on, for deleted-file diffs", () => {
    const { container } = render(
      wrap(<DiffViewer diff={DELETED_FILE_DIFF} viewType="split" wrapLines />)
    );

    expect(container.querySelector(".diff-viewer")?.getAttribute("data-wrap")).toBe("true");
  });
});

const MOVED_DIFF = `diff --git a/src/m.ts b/src/m.ts
index 0000001..0000002 100644
--- a/src/m.ts
+++ b/src/m.ts
@@ -1,5 +1,3 @@
 const top = 1;
-function relocated(): number {
-  return computeExpensiveValue(top);
-}
 const after = 2;
@@ -20,3 +18,6 @@
 const tail = 3;
+function relocated(): number {
+  return computeExpensiveValue(top);
+}
 const end = 4;`;

type LineClassParams = { changes: ChangeData[]; defaultGenerate: () => string };
type GenerateLineClassName = (params: LineClassParams) => string;

function clearCapturedDiffProps() {
  for (const key of Object.keys(capturedDiffProps)) {
    delete capturedDiffProps[key];
  }
}

describe("DiffViewer moved-line styling", () => {
  beforeEach(() => {
    _resetLangStateForTests();
    clearCapturedDiffProps();
  });

  it("tags relocated rows with side-specific moved classes", () => {
    render(wrap(<DiffViewer diff={MOVED_DIFF} viewType="split" />));

    const generate = capturedDiffProps.generateLineClassName as GenerateLineClassName;
    const hunks = capturedDiffProps.hunks as HunkData[];
    const del = hunks[0]!.changes.find((c) => c.type === "delete")!;
    const ins = hunks[1]!.changes.find((c) => c.type === "insert")!;
    const ctx = hunks[0]!.changes.find((c) => c.type === "normal")!;

    expect(generate({ changes: [del], defaultGenerate: () => "diff-line" })).toBe(
      "diff-line diff-line-moved-old"
    );
    expect(generate({ changes: [ins], defaultGenerate: () => "diff-line" })).toBe(
      "diff-line diff-line-moved-new"
    );
    expect(generate({ changes: [ctx], defaultGenerate: () => "diff-line" })).toBe("diff-line");
  });

  it("leaves rows untouched when nothing moved", () => {
    render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="split" />));

    const generate = capturedDiffProps.generateLineClassName as GenerateLineClassName;
    const hunks = capturedDiffProps.hunks as HunkData[];
    const ins = hunks[0]!.changes.find((c) => c.type === "insert")!;

    expect(generate({ changes: [ins], defaultGenerate: () => "diff-line" })).toBe("diff-line");
  });
});

describe("DiffViewer whitespace visualization", () => {
  beforeEach(() => {
    _resetLangStateForTests();
    clearCapturedDiffProps();
  });

  function getRenderToken(): RenderToken {
    render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="split" />));
    return capturedDiffProps.renderToken as RenderToken;
  }

  it("renders whitespace-only edit tokens as glyph spans with the text intact", () => {
    const renderToken = getRenderToken();
    const renderDefault = vi.fn(() => null);

    const result = renderToken(
      { type: "edit", children: [{ type: "text", value: "  \t " }] },
      renderDefault,
      0
    );

    expect(renderDefault).not.toHaveBeenCalled();
    const { container } = render(<>{result}</>);
    expect(container.querySelectorAll(".diff-ws-space")).toHaveLength(2);
    expect(container.querySelectorAll(".diff-ws-tab")).toHaveLength(1);
    // The DOM text stays the real whitespace so copying is unaffected.
    expect(container.textContent).toBe("  \t ");
  });

  it("falls back to the default renderer when the edit has visible characters", () => {
    const renderToken = getRenderToken();
    const renderDefault = vi.fn(() => null);

    renderToken({ type: "edit", value: "foo " }, renderDefault, 0);

    expect(renderDefault).toHaveBeenCalledTimes(1);
  });

  it("passes non-edit tokens straight through", () => {
    const renderToken = getRenderToken();
    const renderDefault = vi.fn(() => null);

    renderToken({ type: "text", value: "   " }, renderDefault, 0);

    expect(renderDefault).toHaveBeenCalledTimes(1);
  });
});

const FAR_HUNKS_DIFF = `diff --git a/src/far.ts b/src/far.ts
index 0000001..0000002 100644
--- a/src/far.ts
+++ b/src/far.ts
@@ -1,2 +1,2 @@
 line1
-line2
+line2-changed
@@ -100,2 +100,2 @@
 line100
-line101
+line101-changed`;

const FAR_HUNKS_SOURCE = Array.from({ length: 101 }, (_, i) => {
  const line = i + 1;
  if (line === 2) return "line2-changed";
  if (line === 101) return "line101-changed";
  return `line${line}`;
}).join("\n");

describe("DiffViewer directional context expansion", () => {
  beforeEach(() => {
    _resetLangStateForTests();
    clearCapturedDiffProps();
  });

  it("offers up/down/all expansion for gaps past the expand-all cap", () => {
    render(wrap(<DiffViewer diff={FAR_HUNKS_DIFF} source={FAR_HUNKS_SOURCE} viewType="split" />));

    expect(screen.getByRole("button", { name: /Expand up/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Expand down/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Expand all 97" })).toBeTruthy();
  });

  it("expand down reveals lines after the previous hunk and shrinks the gap", () => {
    render(wrap(<DiffViewer diff={FAR_HUNKS_DIFF} source={FAR_HUNKS_SOURCE} viewType="split" />));

    fireEvent.click(screen.getByRole("button", { name: /Expand down/ }));

    // 97 hidden - 50 revealed = 47 left, below the cap → single expander.
    expect(screen.getByRole("button", { name: "Expand 47 lines" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Expand down/ })).toBeNull();
  });

  it("expand up reveals lines directly above the next hunk", () => {
    render(wrap(<DiffViewer diff={FAR_HUNKS_DIFF} source={FAR_HUNKS_SOURCE} viewType="split" />));

    fireEvent.click(screen.getByRole("button", { name: /Expand up/ }));

    expect(screen.getByRole("button", { name: "Expand 47 lines" })).toBeTruthy();
  });
});

describe("DiffViewer hunk copy", () => {
  beforeEach(() => {
    _resetLangStateForTests();
    clearCapturedDiffProps();
  });

  it("copies the hunk's new-side text without +/- prefixes", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="split" />));

    fireEvent.click(screen.getAllByRole("button", { name: "Copy hunk" })[0]!);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("line1\nadded\nline2");
    });
  });
});

// #10422: the +/- marker in the gutter must stay on the same line as the
// line number regardless of line-number width, zoom, or font. The fix lives
// in CSS (white-space: nowrap on the gutter cell + a per-element nowrap on
// .diff-line-number), so the test asserts the static DOM/CSS contract:
// renderGutter always wraps the line number in a .diff-line-number span and
// always emits a sibling .diff-line-marker span carrying the +/- glyph.
describe("DiffViewer gutter marker never wraps (#10422)", () => {
  beforeEach(() => {
    _resetLangStateForTests();
    clearCapturedDiffProps();
  });

  type RenderGutterParams = {
    change: ChangeData;
    renderDefault: () => React.ReactNode;
    wrapInAnchor: (node: React.ReactNode) => React.ReactNode;
  };
  type RenderGutterFn = (params: RenderGutterParams) => React.ReactNode;
  function getRenderGutter(): RenderGutterFn {
    render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="split" />));
    return capturedDiffProps.renderGutter as RenderGutterFn;
  }

  it("wraps the line number in a .diff-line-number span for insert rows", () => {
    const renderGutter = getRenderGutter();
    const change: InsertChange = {
      type: "insert",
      content: "added",
      lineNumber: 2,
      isInsert: true,
    };
    const result = renderGutter({
      change,
      renderDefault: () => "2",
      wrapInAnchor: (n) => <a href="#L2">{n}</a>,
    });
    const { container } = render(<>{result}</>);

    const lineNumberSpans = container.querySelectorAll(".diff-line-number");
    const markerSpans = container.querySelectorAll(".diff-line-marker");

    expect(lineNumberSpans).toHaveLength(1);
    expect(lineNumberSpans[0]!.querySelector("a")).not.toBeNull();
    expect(markerSpans).toHaveLength(1);
    expect(markerSpans[0]!.textContent).toBe("+");
  });

  it("wraps the line number in a .diff-line-number span for delete rows", () => {
    const renderGutter = getRenderGutter();
    const change: DeleteChange = {
      type: "delete",
      content: "old",
      lineNumber: 1,
      isDelete: true,
    };
    const result = renderGutter({
      change,
      renderDefault: () => "1",
      wrapInAnchor: (n) => <a href="#L1">{n}</a>,
    });
    const { container } = render(<>{result}</>);

    const lineNumberSpans = container.querySelectorAll(".diff-line-number");
    const markerSpans = container.querySelectorAll(".diff-line-marker");

    expect(lineNumberSpans).toHaveLength(1);
    expect(lineNumberSpans[0]!.querySelector("a")).not.toBeNull();
    expect(markerSpans).toHaveLength(1);
    expect(markerSpans[0]!.textContent).toBe("-");
  });

  it("emits a sibling .diff-line-marker after the .diff-line-number, never inside it", () => {
    const renderGutter = getRenderGutter();
    const change: InsertChange = {
      type: "insert",
      content: "added",
      lineNumber: 2,
      isInsert: true,
    };
    const result = renderGutter({
      change,
      renderDefault: () => "2",
      wrapInAnchor: (n) => <a href="#L2">{n}</a>,
    });
    const { container } = render(<>{result}</>);

    const lineNumberSpans = container.querySelectorAll(".diff-line-number");
    const markerSpans = container.querySelectorAll(".diff-line-marker");

    expect(lineNumberSpans).toHaveLength(1);
    expect(markerSpans).toHaveLength(1);
    // The marker is a sibling of the line number, not nested inside it — the
    // gutter cell is what enforces nowrap; the marker span itself is the
    // element that would wrap if the cell allowed it.
    expect(lineNumberSpans[0]!.querySelector(".diff-line-marker")).toBeNull();
  });
});

// Load the actual stylesheet at test time so a deleted/regressed rule breaks
// the build, not just a hand-typed assumption. The load is async-free and
// the file is small — the assertion guards both the gutter-level fix and the
// per-element fallback against accidental removal.
describe("DiffViewer gutter CSS contract (#10422)", () => {
  it("declares white-space: nowrap on the gutter cell and on .diff-line-number", () => {
    const cssText = readFileSync(join(__dirname, "..", "DiffViewer.css"), "utf8");
    expect(cssText).toMatch(/\.diff-viewer\s+\.diff-gutter\s*\{[^}]*white-space:\s*nowrap/);
    expect(cssText).toMatch(/\.diff-viewer\s+\.diff-line-number\s*\{[^}]*white-space:\s*nowrap/);
  });
});

// The no-wrap behavior on the fallback (add/delete) scroll path and the
// word-boundary behavior in wrap-on mode are CSS-only and can't be exercised by
// jsdom (no layout engine), so guard the load-bearing declarations against an
// accidental revert to react-diff-view's vendor break-all/break-word defaults
// (the original #10623 bug). Same readFileSync pattern as the #10422 guard.
describe("DiffViewer wrap CSS contract (#10623)", () => {
  it("resets the vendor wrap defaults on the base .diff-code rule", () => {
    const cssText = readFileSync(join(__dirname, "..", "DiffViewer.css"), "utf8");
    expect(cssText).toMatch(/\.diff-viewer\s+\.diff-code\s*\{[^}]*white-space:\s*pre[;\s}]/);
    expect(cssText).toMatch(/\.diff-viewer\s+\.diff-code\s*\{[^}]*word-break:\s*normal/);
    expect(cssText).toMatch(/\.diff-viewer\s+\.diff-code\s*\{[^}]*overflow-wrap:\s*normal/);
  });

  it("breaks at word boundaries (not mid-token) in wrap-on mode", () => {
    const cssText = readFileSync(join(__dirname, "..", "DiffViewer.css"), "utf8");
    // Strip comments so the negative break-all assertion checks declarations
    // only — the rule's own comment explains why break-all was dropped.
    const declarations = cssText
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .match(/\.diff-viewer\[data-wrap="true"\]\s+\.diff-code\s*\{[^}]*\}/)?.[0];
    expect(declarations).toBeTruthy();
    expect(declarations).toMatch(/word-break:\s*normal/);
    expect(declarations).toMatch(/overflow-wrap:\s*anywhere/);
    expect(declarations).not.toMatch(/word-break:\s*break-all/);
    // The screenshot regression is specifically pre-wrap with overflow-wrap: normal:
    // soft-wrap on, but long unbreakable runs can't break, so a Markdown table that
    // overflows the fixed wrap column collapses to one token per line. Guard the
    // exact degenerate value, not just the absence of break-all.
    expect(declarations).not.toMatch(/overflow-wrap:\s*normal/);
  });

  it("never enables soft-wrap anywhere in the sheet without a way to break long runs", () => {
    // Broader than the single rule above: any rule that turns soft-wrapping on
    // (white-space: pre-wrap) under the fixed-width wrap table must also let an
    // unbreakable run break, or it reopens #10623. Guards future rules too, not
    // just today's [data-wrap] one.
    const withoutComments = readFileSync(join(__dirname, "..", "DiffViewer.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      ""
    );
    // Match innermost declaration blocks ({ ... } with no nested braces) so the
    // invariant still holds for a soft-wrap rule nested inside an @media block.
    const softWrapRules = (withoutComments.match(/\{[^{}]*\}/g) ?? []).filter((rule) =>
      /white-space:\s*pre-wrap/.test(rule)
    );
    expect(softWrapRules.length).toBeGreaterThan(0);
    for (const rule of softWrapRules) {
      const canBreakLongRuns =
        /overflow-wrap:\s*(anywhere|break-word)/.test(rule) ||
        /word-break:\s*(break-all|break-word)/.test(rule);
      expect(canBreakLongRuns).toBe(true);
    }
  });
});

// refractor's Markdown grammar tags table-row tokens with class="token table …".
// Tailwind ships `.table { display: table }`, so without an inline reset those
// inline syntax tokens become block-level table boxes and a one-line Markdown
// table row stacks to one token per line once the (post-paint) token pass lands
// — the whole diff appears to "collapse". jsdom can't lay out row heights, but it
// DOES resolve the `display` cascade, so render the colliding token and assert
// the real DiffViewer.css pins it back to inline against a present `.table`
// utility. The no-reset render proves the harness exercises the real collision,
// so the positive case can't silently false-pass.
describe("DiffViewer token CSS contract (Tailwind display-utility collision)", () => {
  function computeTokenDisplay(diffViewerCss: string): string {
    const style = document.createElement("style");
    // `.table { display: table }` is Tailwind's colliding utility; refractor puts
    // `class="token table …"` on Markdown table tokens.
    style.textContent = `.table { display: table; }\n${diffViewerCss}`;
    document.head.appendChild(style);
    document.body.innerHTML =
      '<div class="diff-viewer"><table class="diff"><tbody><tr>' +
      '<td class="diff-code diff-code-insert">' +
      '<span id="tok" class="token table table-data">x</span>' +
      "</td></tr></tbody></table></div>";
    const display = getComputedStyle(document.getElementById("tok")!).display;
    document.body.innerHTML = "";
    style.remove();
    return display;
  }

  it("keeps Markdown table tokens inline despite Tailwind's .table utility", () => {
    // Sanity: with no DiffViewer reset, Tailwind's `.table` wins and the token
    // computes block-level `table` — the bug, and proof the harness hits it.
    expect(computeTokenDisplay("")).toBe("table");
    // With the real stylesheet the reset pins the token back to inline.
    const css = readFileSync(join(__dirname, "..", "DiffViewer.css"), "utf8");
    expect(computeTokenDisplay(css)).toBe("inline");
  });
});

// The unified / single-side path keeps a REAL native scroller and adds the
// sticky strip as its sibling, so the strip resolves against .diff-scroll-root
// and stays reachable mid-file. jsdom has no layout, so these tests stub the
// widths the measurement reads and drive ResizeObserver by hand — the global
// stub installed in vitest.setup.ts is a no-op and would never call back.
type FakeObserver = { callback: () => void; targets: Set<Element> };

describe("DiffViewer native scroll proxy", () => {
  const observers: FakeObserver[] = [];
  let originalResizeObserver: typeof ResizeObserver;

  class FakeResizeObserver {
    private readonly entry: FakeObserver;
    constructor(callback: () => void) {
      this.entry = { callback, targets: new Set() };
      observers.push(this.entry);
    }
    observe(target: Element) {
      this.entry.targets.add(target);
    }
    unobserve(target: Element) {
      this.entry.targets.delete(target);
    }
    disconnect() {
      this.entry.targets.clear();
    }
  }

  beforeEach(() => {
    observers.length = 0;
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
  });

  /** Fire every observer currently watching `target`; the callback sets state. */
  function resize(target: Element) {
    act(() => {
      for (const observer of observers) {
        if (observer.targets.has(target)) observer.callback();
      }
    });
  }

  /** jsdom reports 0 for every layout box; hand the element real numbers. */
  function stubLayout(element: Element, clientWidth: number, scrollWidth: number) {
    const state = { scrollWidth };
    Object.defineProperty(element, "scrollWidth", {
      get: () => state.scrollWidth,
      configurable: true,
    });
    Object.defineProperty(element, "clientWidth", {
      get: () => clientWidth,
      configurable: true,
    });
    return state;
  }

  /**
   * Chromium clamps a write past the end and fires NO scroll event for it —
   * from that element's point of view nothing moved. jsdom does neither, so
   * model both to exercise the clamp reconciliation.
   */
  function stubScrollLeft(element: HTMLElement, max: number, initial = 0) {
    let current = initial;
    const writes: number[] = [];
    Object.defineProperty(element, "scrollLeft", {
      get: () => current,
      set: (next: number) => {
        writes.push(next);
        if (writes.length > 20) throw new Error("scrollLeft mirroring never settled");
        const clamped = Math.min(max, Math.max(0, next));
        if (clamped === current) return;
        current = clamped;
        element.dispatchEvent(new Event("scroll"));
      },
      configurable: true,
    });
    return { writes, value: () => current };
  }

  function parts(container: HTMLElement) {
    const shell = container.querySelector<HTMLElement>(".diff-file-shell");
    const scroller = container.querySelector<HTMLElement>(".diff-file-scroll");
    const proxy = screen.getByTestId("diff-hscrollbar");
    return { shell, scroller, proxy };
  }

  it("makes the strip a sibling of the scroller, never a descendant of it", () => {
    const { container } = render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="unified" />));
    const { shell, scroller, proxy } = parts(container);

    expect(shell).not.toBeNull();
    expect(scroller?.parentElement).toBe(shell);
    expect(proxy.parentElement).toBe(shell);
    // The whole point: a sticky strip inside the horizontally scrolling box
    // would slide sideways with the user's own scroll.
    expect(scroller?.contains(proxy)).toBe(false);
    expect(scroller?.contains(screen.getByTestId("diff-element"))).toBe(true);
  });

  it("leaves the region semantics on the element that actually scrolls", () => {
    const { container } = render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="unified" />));
    const { shell, scroller } = parts(container);

    expect(scroller?.getAttribute("role")).toBe("region");
    expect(scroller?.getAttribute("tabindex")).toBe("0");
    expect(scroller?.id.startsWith("diff-region-")).toBe(true);
    expect(shell?.hasAttribute("id")).toBe(false);
  });

  it("keeps the native bar and an inert strip until overflow is measured", () => {
    const { container } = render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="unified" />));
    const { scroller, proxy } = parts(container);

    expect(proxy.hasAttribute("data-active")).toBe(false);
    expect(scroller?.hasAttribute("data-proxy-active")).toBe(false);
  });

  it("activates both halves of the handoff and sizes the strip to the content", () => {
    const { container } = render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="unified" />));
    const { scroller, proxy } = parts(container);
    stubLayout(scroller!, 200, 500);

    resize(scroller!);

    expect(proxy.getAttribute("data-active")).toBe("true");
    expect(scroller?.getAttribute("data-proxy-active")).toBe("true");
    expect(proxy.style.getPropertyValue("--diff-native-scroll-width")).toBe("500px");
  });

  it("re-measures from the content box, which is where a scrollWidth-only change shows up", () => {
    const { container } = render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="unified" />));
    const { scroller, proxy } = parts(container);
    const layout = stubLayout(scroller!, 200, 500);
    resize(scroller!);
    expect(proxy.getAttribute("data-active")).toBe("true");

    // The scroller's own border box never changes here — only its content
    // narrows, so ResizeObserver fires for the table, not the container.
    layout.scrollWidth = 200;
    resize(scroller!.firstElementChild!);

    expect(proxy.hasAttribute("data-active")).toBe(false);
    expect(scroller?.hasAttribute("data-proxy-active")).toBe(false);
  });

  it("mirrors scrollLeft both ways and settles instead of ping-ponging", () => {
    const { container } = render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="unified" />));
    const { scroller, proxy } = parts(container);

    scroller!.scrollLeft = 80;
    fireEvent.scroll(scroller!);
    expect(proxy.scrollLeft).toBe(80);

    proxy.scrollLeft = 30;
    fireEvent.scroll(proxy);
    expect(scroller!.scrollLeft).toBe(30);

    // The echo event each write triggers finds the pair equal and stops.
    fireEvent.scroll(scroller!);
    fireEvent.scroll(proxy);
    expect(scroller!.scrollLeft).toBe(30);
    expect(proxy.scrollLeft).toBe(30);
  });

  it("drops the strip while wrapping and restores it on the way back", () => {
    const { container, rerender } = render(
      wrap(<DiffViewer diff={SMALL_DIFF} viewType="unified" />)
    );
    const scroller = container.querySelector<HTMLElement>(".diff-file-scroll");
    const layout = stubLayout(scroller!, 200, 500);
    resize(scroller!);
    expect(scroller?.getAttribute("data-proxy-active")).toBe("true");

    rerender(wrap(<DiffViewer diff={SMALL_DIFF} viewType="unified" wrapLines />));
    expect(screen.queryByTestId("diff-hscrollbar")).toBeNull();
    expect(container.querySelector(".diff-file-scroll")?.hasAttribute("data-proxy-active")).toBe(
      false
    );

    rerender(wrap(<DiffViewer diff={SMALL_DIFF} viewType="unified" />));
    const restored = container.querySelector<HTMLElement>(".diff-file-scroll");
    layout.scrollWidth = 500;
    resize(restored!);
    expect(screen.getByTestId("diff-hscrollbar").getAttribute("data-active")).toBe("true");
  });

  it("re-syncs the strip after hunk expansion changes the content width", () => {
    const { container } = render(
      wrap(<DiffViewer diff={FAR_HUNKS_DIFF} source={FAR_HUNKS_SOURCE} viewType="unified" />)
    );
    const { scroller, proxy } = parts(container);
    stubLayout(scroller!, 200, 500);

    // A scroll the strip never saw: the browser can move the real scroller
    // through find-in-page, scrollIntoView or drag-select without one either.
    scroller!.scrollLeft = 90;
    expect(proxy.scrollLeft).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: /Expand down/ }));

    expect(screen.getByTestId("diff-hscrollbar").scrollLeft).toBe(90);
  });

  it("gives each stacked file its own strip and its own offset", () => {
    const { container } = render(
      wrap(<DiffViewer diff={`${ADDED_FILE_DIFF}\n${DELETED_FILE_DIFF}`} viewType="unified" />)
    );

    const shells = container.querySelectorAll(".diff-file-shell");
    const scrollers = container.querySelectorAll<HTMLElement>(".diff-file-scroll");
    const proxies = screen.getAllByTestId("diff-hscrollbar");
    expect(shells.length).toBe(2);
    expect(proxies.length).toBe(2);
    for (const shell of shells) {
      expect(shell.querySelectorAll('[data-testid="diff-hscrollbar"]').length).toBe(1);
    }

    const [firstScroller, secondScroller] = Array.from(scrollers);
    const [firstProxy, secondProxy] = proxies;
    firstScroller!.scrollLeft = 70;
    fireEvent.scroll(firstScroller!);

    expect(firstProxy!.scrollLeft).toBe(70);
    expect(secondProxy!.scrollLeft).toBe(0);
    expect(secondScroller!.scrollLeft).toBe(0);
  });

  it("activates only the stacked file that actually overflows", () => {
    const { container } = render(
      wrap(<DiffViewer diff={`${ADDED_FILE_DIFF}\n${DELETED_FILE_DIFF}`} viewType="unified" />)
    );
    const [first, second] = Array.from(
      container.querySelectorAll<HTMLElement>(".diff-file-scroll")
    );
    stubLayout(first!, 200, 500);
    stubLayout(second!, 200, 200);

    resize(first!);
    resize(second!);

    const [firstProxy, secondProxy] = screen.getAllByTestId("diff-hscrollbar");
    expect(firstProxy!.getAttribute("data-active")).toBe("true");
    expect(first!.getAttribute("data-proxy-active")).toBe("true");
    expect(secondProxy!.hasAttribute("data-active")).toBe(false);
    expect(second!.hasAttribute("data-proxy-active")).toBe(false);
  });

  it("settles when the shorter side is already at its end and stays silent", () => {
    const { container } = render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="unified" />));
    const { scroller, proxy } = parts(container);
    // Both parked at their own maximum, the strip's range outrunning the
    // content's. This is the case an echo can never fix: writing 100 to the
    // content clamps to the 90 it already holds, so it does not move and fires
    // no scroll event at all. Only reading the landed value back settles it.
    const content = stubScrollLeft(scroller!, 90, 90);
    const strip = stubScrollLeft(proxy, 100, 100);

    fireEvent.scroll(proxy);

    expect(content.value()).toBe(90);
    expect(strip.value()).toBe(90);
    expect(strip.writes.length + content.writes.length).toBeLessThan(8);
  });

  it("settles the same way when the content is the longer of the two", () => {
    const { container } = render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="unified" />));
    const { scroller, proxy } = parts(container);
    const content = stubScrollLeft(scroller!, 100, 100);
    const strip = stubScrollLeft(proxy, 90, 90);

    fireEvent.scroll(scroller!);

    expect(content.value()).toBe(90);
    expect(strip.value()).toBe(90);
    expect(strip.writes.length + content.writes.length).toBeLessThan(8);
  });

  it("holds a one-pixel overflow below the activation threshold", () => {
    // scrollWidth/clientWidth are rounded integers, so a sub-pixel layout
    // difference can surface as a 1px delta. Popping a 12px strip for that is
    // disproportionate, and the scroller keeps its own bar either way — the
    // same tolerance centered split has always used.
    const { container } = render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="unified" />));
    const { scroller, proxy } = parts(container);
    const layout = stubLayout(scroller!, 200, 201);

    resize(scroller!);
    expect(proxy.hasAttribute("data-active")).toBe(false);

    layout.scrollWidth = 202;
    resize(scroller!);
    expect(proxy.getAttribute("data-active")).toBe("true");
  });

  it("re-attaches to the elements a collapse round-trip remounts", () => {
    // isCollapsed is in the measurement effect's deps for exactly this: the
    // effect first runs while both refs are null, and nothing else changes when
    // the user expands.
    const { container } = render(wrap(<DiffViewer diff={LOCKFILE_DIFF} viewType="unified" />));
    expect(container.querySelector(".diff-file-scroll")).toBeNull();

    fireEvent.click(screen.getByText("Show diff"));
    const scroller = container.querySelector<HTMLElement>(".diff-file-scroll");
    stubLayout(scroller!, 200, 500);
    resize(scroller!);
    expect(scroller?.getAttribute("data-proxy-active")).toBe("true");

    fireEvent.click(screen.getByText("Hide diff"));
    expect(screen.queryByTestId("diff-hscrollbar")).toBeNull();

    fireEvent.click(screen.getByText("Show diff"));
    const reopened = container.querySelector<HTMLElement>(".diff-file-scroll");
    stubLayout(reopened!, 200, 500);
    resize(reopened!);
    expect(screen.getByTestId("diff-hscrollbar").getAttribute("data-active")).toBe("true");
  });

  it("leaves both surfaces agreeing across a view-type round-trip", () => {
    const { container, rerender } = render(
      wrap(<DiffViewer diff={SMALL_DIFF} viewType="unified" />)
    );
    const scroller = container.querySelector<HTMLElement>(".diff-file-scroll");
    stubLayout(scroller!, 200, 500);
    resize(scroller!);
    scroller!.scrollLeft = 60;
    fireEvent.scroll(scroller!);
    expect(screen.getByTestId("diff-hscrollbar").scrollLeft).toBe(60);

    rerender(wrap(<DiffViewer diff={SMALL_DIFF} viewType="split" />));
    expect(container.querySelector(".diff-file-centered")).not.toBeNull();
    expect(screen.getByTestId("diff-hscrollbar").getAttribute("data-scroll-mode")).toBe("centered");

    rerender(wrap(<DiffViewer diff={SMALL_DIFF} viewType="unified" />));
    // React reuses the strip node across the two branches, so it arrives here
    // still holding the old offset while the inner scroller is freshly mounted
    // at 0. The reconciliation has to pull the reused strip back to the
    // scroller; what must never happen is the two disagreeing.
    const back = container.querySelector<HTMLElement>(".diff-file-scroll");
    expect(back!.scrollLeft).toBe(screen.getByTestId("diff-hscrollbar").scrollLeft);
  });

  it("still measures the centered-split strip through the shared effect", () => {
    render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="split" />));
    const proxy = screen.getByTestId("diff-hscrollbar");
    expect(proxy.getAttribute("data-scroll-mode")).toBe("centered");
    const layout = stubLayout(proxy, 200, 500);

    resize(proxy);

    expect(proxy.getAttribute("data-active")).toBe("true");
    // Centered split sizes its spacer from the estimated longest line, so the
    // native measurement must not leak into it.
    expect(proxy.style.getPropertyValue("--diff-native-scroll-width")).toBe("");

    layout.scrollWidth = 200;
    resize(proxy.firstElementChild!);
    expect(proxy.hasAttribute("data-active")).toBe(false);
  });

  it("disconnects its observer when the diff unmounts", () => {
    const { container, unmount } = render(
      wrap(<DiffViewer diff={SMALL_DIFF} viewType="unified" />)
    );
    const scroller = container.querySelector<HTMLElement>(".diff-file-scroll");
    expect(observers.some((observer) => observer.targets.has(scroller!))).toBe(true);

    unmount();

    expect(observers.some((observer) => observer.targets.size > 0)).toBe(false);
  });
});

// The behavioural tests above can only see attributes and inline custom
// properties. Everything that turns those into a usable scrollbar lives in the
// stylesheet, and deleting any of it would leave them all green.
describe("DiffViewer native scroll proxy CSS contract (#12103)", () => {
  const declarations = () =>
    readFileSync(join(__dirname, "..", "DiffViewer.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("sizes the native strip's spacer from the measured content width", () => {
    expect(declarations()).toMatch(
      /\.diff-hscrollbar\[data-scroll-mode="native"\]\s+\.diff-hscroll-spacer\s*\{[^}]*width:\s*var\(--diff-native-scroll-width/
    );
  });

  it("hands the bar over rather than showing two or none", () => {
    const css = declarations();
    // Height only when active — otherwise the strip would reserve space under
    // every file whether or not it can scroll.
    expect(css).toMatch(/\.diff-hscrollbar\s*\{[^}]*height:\s*0/);
    expect(css).toMatch(/\.diff-hscrollbar\[data-active\]\s*\{[^}]*height:\s*12px/);
    // ...and the scroller's own bar goes away only once the strip has taken over.
    expect(css).toMatch(/\.diff-file-scroll\[data-proxy-active\]\s*\{[^}]*scrollbar-width:\s*none/);
    expect(css).toMatch(
      /\.diff-file-scroll\[data-proxy-active\]::-webkit-scrollbar\s*\{[^}]*height:\s*0/
    );
  });

  it("pins the strip's vertical overflow so its range can match the scroller's", () => {
    // Left at its initial `visible` this computes to `auto`, the 1px spacer
    // overflows the strip's 12px box, and the vertical scrollbar it reserves
    // shrinks the strip's clientWidth below the scroller's — giving the proxy
    // travel the content cannot follow.
    expect(declarations()).toMatch(/\.diff-hscrollbar\s*\{[^}]*overflow-y:\s*hidden/);
  });

  it("never lets the shell become the sticky containing block", () => {
    // position: sticky resolves against the nearest scroll container. overflow,
    // contain, transform, filter or perspective on the shell would make it one
    // and silently re-pin the strip to the bottom of the file — the exact bug
    // #12103 is about.
    const shell = declarations().match(/\.diff-viewer\s+\.diff-file-shell\s*\{[^}]*\}/)?.[0];
    expect(shell).toBeTruthy();
    expect(shell).not.toMatch(/overflow|contain|transform|filter|perspective/);
  });
});
