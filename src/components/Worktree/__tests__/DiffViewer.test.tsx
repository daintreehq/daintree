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
    render(wrap(<DiffViewer diff={rustDiff} filePath="main.rs" />));
    await waitFor(() => {
      expect(screen.getByTestId("diff-plain-text-badge")).toBeTruthy();
    });
    expect(screen.getByTestId("diff-plain-text-badge").textContent).toBe("Plain text");
  });

  it("does not show Plain text badge for built-in languages", async () => {
    render(wrap(<DiffViewer diff={jsDiff} filePath="app.js" />));
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
    render(wrap(<DiffViewer diff={unknownDiff} filePath="foo.xyz" />));
    await waitFor(() => {
      expect(screen.getByText("foo.xyz")).toBeTruthy();
    });
    expect(screen.queryByTestId("diff-plain-text-badge")).toBeNull();
  });

  it("renders NO_CHANGES sentinel", () => {
    render(wrap(<DiffViewer diff="NO_CHANGES" filePath="src/index.ts" />));
    expect(screen.getByText("No changes detected")).toBeTruthy();
  });

  it("renders BINARY_FILE sentinel", () => {
    render(wrap(<DiffViewer diff="BINARY_FILE" filePath="src/index.ts" />));
    expect(screen.getByText("Binary file - cannot display diff")).toBeTruthy();
  });

  it("renders FILE_TOO_LARGE sentinel", () => {
    render(wrap(<DiffViewer diff="FILE_TOO_LARGE" filePath="src/index.ts" />));
    expect(screen.getByText(/File too large to display diff/)).toBeTruthy();
  });

  it("renders ERROR sentinel with error message", () => {
    render(wrap(<DiffViewer diff="ERROR" filePath="src/index.ts" />));
    expect(screen.getByText("Failed to load diff")).toBeTruthy();
  });

  it("does not render parse-failure fallback for ERROR sentinel", () => {
    render(wrap(<DiffViewer diff="ERROR" filePath="src/index.ts" />));
    // ERROR sentinel is checked before files.length, so we get the error UI
    expect(screen.getByText("Failed to load diff")).toBeTruthy();
    expect(screen.queryByText("Unable to parse diff")).toBeNull();
  });

  it("renders retry button when onRetry is provided", () => {
    const onRetry = vi.fn();
    render(wrap(<DiffViewer diff="ERROR" filePath="src/index.ts" onRetry={onRetry} />));
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("does not render retry button when onRetry is omitted", () => {
    render(wrap(<DiffViewer diff="ERROR" filePath="src/index.ts" />));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("calls onRetry when retry button is clicked", () => {
    const onRetry = vi.fn();
    render(wrap(<DiffViewer diff="ERROR" filePath="src/index.ts" onRetry={onRetry} />));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders empty diff sentinel", () => {
    render(wrap(<DiffViewer diff="" filePath="src/index.ts" />));
    expect(screen.getByText("No changes detected")).toBeTruthy();
  });

  it("renders parse failure when diff is unparseable", () => {
    render(wrap(<DiffViewer diff="not a real diff" filePath="src/index.ts" />));
    expect(screen.getByText("Unable to parse diff")).toBeTruthy();
  });
});

describe("DiffViewer sentinel messages", () => {
  beforeEach(() => {
    _resetLangStateForTests();
  });

  it("shows NO_CHANGES message", () => {
    render(wrap(<DiffViewer diff="NO_CHANGES" filePath="a.ts" />));
    expect(screen.getByText("No changes detected")).toBeTruthy();
  });

  it("shows BINARY_FILE message", () => {
    render(wrap(<DiffViewer diff="BINARY_FILE" filePath="icon.png" />));
    expect(screen.getByText("Binary file - cannot display diff")).toBeTruthy();
  });

  it("shows FILE_TOO_LARGE message with 1MB threshold", () => {
    render(wrap(<DiffViewer diff="FILE_TOO_LARGE" filePath="big.ts" />));
    expect(screen.getByText(/File too large/)).toBeTruthy();
    expect(screen.getByText(/1MB/)).toBeTruthy();
  });
});

describe("DiffViewer collapse behavior", () => {
  beforeEach(() => {
    _resetLangStateForTests();
  });

  it("collapses lockfile diff by default with toggle", () => {
    render(wrap(<DiffViewer diff={LOCKFILE_DIFF} filePath="package-lock.json" />));

    expect(screen.getByText("Generated file collapsed")).toBeTruthy();
    expect(screen.getByText("Show diff")).toBeTruthy();

    fireEvent.click(screen.getByText("Show diff"));

    expect(screen.getByText("Hide diff")).toBeTruthy();
  });

  it("renders small normal file without collapse", () => {
    render(wrap(<DiffViewer diff={SMALL_DIFF} filePath="src/a.ts" />));

    expect(screen.queryByText("Show diff")).toBeNull();
    expect(screen.queryByText("Generated file collapsed")).toBeNull();
  });

  it("toggles collapse state — expand then collapse again", () => {
    render(wrap(<DiffViewer diff={LOCKFILE_DIFF} filePath="package-lock.json" />));

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
    render(
      wrap(
        <DiffViewer
          diff={LOCKFILE_DIFF}
          filePath="package-lock.json"
          onToggleCollapse={onToggleCollapse}
        />
      )
    );

    expect(onToggleCollapse).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Show diff"));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Hide diff"));
    expect(onToggleCollapse).toHaveBeenCalledTimes(2);
  });
});
