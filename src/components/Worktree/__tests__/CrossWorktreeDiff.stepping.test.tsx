// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { CrossWorktreeDiff } from "../CrossWorktreeDiff";
import { TooltipProvider } from "@/components/ui/tooltip";

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
  DiffViewer: ({ diff }: { diff: string }) => <div data-testid="diff-viewer">{diff}</div>,
}));

// Selector stub: clicking the labeled button picks the matching worktree.
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
  Object.defineProperty(window, "electron", {
    value: { git: { compareWorktrees: mockCompareWorktrees } },
    configurable: true,
  });
});

const FILES = [
  { path: "src/alpha.ts", status: "M", insertions: 3, deletions: 1 },
  { path: "src/beta.ts", status: "M", insertions: 1, deletions: 1 },
  { path: "src/gamma.ts", status: "A", insertions: 9, deletions: 0 },
];

async function setupComparison() {
  mockCompareWorktrees.mockImplementation((_path, _b1, _b2, filePath?: string) =>
    Promise.resolve(
      filePath === undefined
        ? { branch1: "main", branch2: "feature", files: FILES }
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

  await waitFor(() => {
    expect(screen.getByText("alpha.ts")).toBeTruthy();
  });
}

describe("CrossWorktreeDiff file stepping", () => {
  it("`]` with no selection opens the first file", async () => {
    await setupComparison();

    fireEvent.keyDown(window, { key: "]" });

    await waitFor(() => {
      expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe("1 of 3");
    });
    expect(mockCompareWorktrees).toHaveBeenLastCalledWith(
      "/wt/left",
      "main",
      "feature",
      "src/alpha.ts",
      undefined,
      false
    );
  });

  it("steps forward and back through the comparison set", async () => {
    await setupComparison();

    fireEvent.keyDown(window, { key: "]" });
    await waitFor(() => {
      expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe("1 of 3");
    });

    fireEvent.keyDown(window, { key: "]" });
    await waitFor(() => {
      expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe("2 of 3");
    });
    expect(mockCompareWorktrees).toHaveBeenLastCalledWith(
      "/wt/left",
      "main",
      "feature",
      "src/beta.ts",
      undefined,
      false
    );

    fireEvent.keyDown(window, { key: "[" });
    await waitFor(() => {
      expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe("1 of 3");
    });
  });

  it("does not step past either end", async () => {
    await setupComparison();

    // `[` with nothing selected is a no-op (no file fetch happens).
    const callsBefore = mockCompareWorktrees.mock.calls.length;
    fireEvent.keyDown(window, { key: "[" });
    expect(mockCompareWorktrees.mock.calls.length).toBe(callsBefore);

    fireEvent.keyDown(window, { key: "]" }); // 1 of 3
    fireEvent.keyDown(window, { key: "]" }); // 2 of 3
    fireEvent.keyDown(window, { key: "]" }); // 3 of 3
    await waitFor(() => {
      expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe("3 of 3");
    });

    const callsAtEnd = mockCompareWorktrees.mock.calls.length;
    fireEvent.keyDown(window, { key: "]" });
    expect(mockCompareWorktrees.mock.calls.length).toBe(callsAtEnd);
    expect(screen.getByLabelText("Next file").hasAttribute("disabled")).toBe(true);
  });

  it("stepper buttons navigate like the bracket keys", async () => {
    await setupComparison();

    fireEvent.click(screen.getByText("alpha.ts"));
    await waitFor(() => {
      expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe("1 of 3");
    });
    expect(screen.getByLabelText("Previous file").hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByLabelText("Next file"));
    await waitFor(() => {
      expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe("2 of 3");
    });
  });
});
