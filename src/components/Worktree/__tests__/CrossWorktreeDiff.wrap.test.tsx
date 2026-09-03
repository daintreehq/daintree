// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { CrossWorktreeDiff } from "../CrossWorktreeDiff";
import { TooltipProvider } from "@/components/ui/tooltip";

// Cross-worktree compare passed no `wrapLines` at all before #12170, so it
// always scrolled horizontally with no reachable way out. These cover the
// toggle and the prose default; stepping stays in its own suite.

const worktrees = new Map([
  [
    "wt-left",
    { id: "wt-left", name: "left", path: "/wt/left", branch: "main", isMainWorktree: true },
  ],
  [
    "wt-right",
    { id: "wt-right", name: "right", path: "/wt/right", branch: "feature", isMainWorktree: false },
  ],
]);

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (sel: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    sel({ worktrees }),
}));

// Mocked rather than real so a test can seed an explicit override without
// leaking a persisted value into the next one.
const preferences = {
  diffIgnoreWhitespace: false,
  diffWrapLines: null as boolean | null,
  setDiffWrapLines: vi.fn(),
};
vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector: (state: unknown) => unknown) => selector(preferences),
}));

vi.mock("@/components/ui/AppDialog", () => {
  interface MockProps {
    isOpen: boolean;
    children: ReactNode;
  }
  interface SectionProps {
    children?: ReactNode;
    className?: string;
  }
  const AppDialog = ({ isOpen, children }: MockProps) =>
    isOpen ? <div data-testid="app-dialog">{children}</div> : null;
  AppDialog.Header = ({ children }: SectionProps) => <div>{children}</div>;
  AppDialog.Title = ({ children }: SectionProps) => <h2>{children}</h2>;
  AppDialog.CloseButton = () => <button type="button">close</button>;
  return { AppDialog };
});

vi.mock("../DiffViewer", () => ({
  DiffViewer: ({ wrapLines }: { wrapLines?: boolean }) => (
    <div data-testid="diff-viewer" data-wrap-lines={String(wrapLines)} />
  ),
}));

vi.mock("../WorktreeSelector", () => ({
  WorktreeSelector: ({ label, onChange }: { label: string; onChange: (id: string) => void }) => (
    <button
      type="button"
      onClick={() => onChange(label.startsWith("Left") ? "wt-left" : "wt-right")}
    >
      {label}
    </button>
  ),
}));

const mockCompareWorktrees = vi.fn();

beforeEach(() => {
  mockCompareWorktrees.mockReset();
  preferences.diffWrapLines = null;
  preferences.setDiffWrapLines.mockReset();
  Object.defineProperty(window, "electron", {
    value: { git: { compareWorktrees: mockCompareWorktrees } },
    configurable: true,
  });
});

async function setupComparison(files: { path: string; status: string }[]) {
  mockCompareWorktrees.mockImplementation((_path, _b1, _b2, filePath?: string) =>
    Promise.resolve(
      filePath === undefined
        ? {
            branch1: "main",
            branch2: "feature",
            files: files.map((f) => ({ ...f, insertions: 1, deletions: 1 })),
          }
        : `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1 +1 @@\n-old\n+new`
    )
  );

  render(
    <TooltipProvider>
      <CrossWorktreeDiff isOpen onClose={vi.fn()} initialWorktreeId={null} />
    </TooltipProvider>
  );
  fireEvent.click(screen.getByText("Left (base)"));
  fireEvent.click(screen.getByText("Right (compare)"));

  const name = files[0]!.path.split("/").pop()!;
  await waitFor(() => {
    expect(screen.getByText(name)).toBeTruthy();
  });
  fireEvent.click(screen.getByText(name));
  await waitFor(() => {
    expect(screen.getByTestId("diff-viewer")).toBeTruthy();
  });
}

function wrapButton(): HTMLElement {
  return screen.getByRole("button", { name: "Wrap long lines" });
}

function viewerWrap(): string | null {
  return screen.getByTestId("diff-viewer").getAttribute("data-wrap-lines");
}

describe("CrossWorktreeDiff wrap toggle (#12170)", () => {
  it("offers the toggle for a single-file comparison, where stepping is absent", async () => {
    // The whole row used to be gated on `files.length > 1`, which is exactly how
    // this surface ended up with no reachable toggle.
    await setupComparison([{ path: "docs/spec.md", status: "M" }]);

    expect(wrapButton()).toBeTruthy();
    expect(screen.queryByTestId("cross-worktree-file-position")).toBeNull();
    expect(screen.queryByLabelText("Next file")).toBeNull();
  });

  it("keeps the stepper alongside the toggle for a multi-file comparison", async () => {
    await setupComparison([
      { path: "docs/spec.md", status: "M" },
      { path: "src/a.ts", status: "M" },
    ]);

    expect(wrapButton()).toBeTruthy();
    expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe("1 of 2");
  });

  it("wraps a prose diff and not a code diff under the auto default", async () => {
    await setupComparison([{ path: "docs/spec.md", status: "M" }]);
    expect(viewerWrap()).toBe("true");
    expect(wrapButton().getAttribute("aria-pressed")).toBe("true");
  });

  it("leaves a code diff unwrapped", async () => {
    await setupComparison([{ path: "src/a.ts", status: "M" }]);
    expect(viewerWrap()).toBe("false");
    expect(wrapButton().getAttribute("aria-pressed")).toBe("false");
  });

  it("writes the opposite of the effective value, not of the stored one", async () => {
    await setupComparison([{ path: "docs/spec.md", status: "M" }]);

    fireEvent.click(wrapButton());

    expect(preferences.setDiffWrapLines).toHaveBeenCalledWith(false);
  });

  it("honours an explicit override over the file type", async () => {
    preferences.diffWrapLines = false;
    await setupComparison([{ path: "docs/spec.md", status: "M" }]);

    expect(viewerWrap()).toBe("false");
  });
});
