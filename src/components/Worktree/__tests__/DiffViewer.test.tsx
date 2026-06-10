// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { DiffViewer, _resetLangStateForTests } from "../DiffViewer";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("refractor/rust", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

vi.mock("react-diff-view", async () => {
  const actual = await vi.importActual<typeof import("react-diff-view")>("react-diff-view");
  return {
    ...actual,
    Diff: ({
      children,
      hunks,
    }: {
      children: (hunks: unknown[]) => React.ReactNode;
      hunks: unknown[];
    }) => <div data-testid="diff-element">{children(hunks)}</div>,
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

describe("DiffViewer centered split", () => {
  it("uses the centered-split scroll system for two-column split diffs", () => {
    const { container } = render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="split" />));

    expect(container.querySelector(".diff-file-centered")).not.toBeNull();
    expect(container.querySelector(".diff-file-scroll")).toBeNull();
    expect(screen.getByTestId("diff-hscrollbar")).toBeTruthy();
  });

  it("keeps the native scroller in unified view", () => {
    const { container } = render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="unified" />));

    expect(container.querySelector(".diff-file-centered")).toBeNull();
    expect(container.querySelector(".diff-file-scroll")).not.toBeNull();
    expect(screen.queryByTestId("diff-hscrollbar")).toBeNull();
  });

  it("keeps the native scroller when wrapping lines", () => {
    const { container } = render(wrap(<DiffViewer diff={SMALL_DIFF} viewType="split" wrapLines />));

    expect(container.querySelector(".diff-file-centered")).toBeNull();
    expect(screen.queryByTestId("diff-hscrollbar")).toBeNull();
  });

  it("keeps the native scroller for single-side added-file diffs", () => {
    const { container } = render(wrap(<DiffViewer diff={ADDED_FILE_DIFF} viewType="split" />));

    expect(container.querySelector(".diff-file-centered")).toBeNull();
    expect(screen.queryByTestId("diff-hscrollbar")).toBeNull();
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
