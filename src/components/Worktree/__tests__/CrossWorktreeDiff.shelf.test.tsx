// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { CrossWorktreeDiff } from "../CrossWorktreeDiff";
import { TooltipProvider } from "@/components/ui/tooltip";

const worktrees = new Map([
  [
    "wt-left",
    { id: "wt-left", name: "helios", path: "/wt/left", branch: "main", isMainWorktree: true },
  ],
  [
    "wt-right",
    { id: "wt-right", name: "right", path: "/wt/right", branch: "feature", isMainWorktree: false },
  ],
  ["wt-detached", { id: "wt-detached", name: "bisect", path: "/wt/bisect", isMainWorktree: false }],
]);

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (sel: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    sel({ worktrees }),
}));

vi.mock("@/components/ui/AppDialog", () => {
  interface SectionProps {
    children?: ReactNode;
  }
  const AppDialog = ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) =>
    isOpen ? <div data-testid="app-dialog">{children}</div> : null;
  AppDialog.Header = ({ children }: SectionProps) => <div>{children}</div>;
  AppDialog.Title = ({ children }: SectionProps) => <h2>{children}</h2>;
  AppDialog.CloseButton = () => <button type="button">close</button>;
  return { AppDialog };
});

vi.mock("../DiffViewer", () => ({
  DiffViewer: ({ diff }: { diff: string }) => <div data-testid="diff-viewer">{diff}</div>,
}));

const mockCompareWorktrees = vi.fn();

beforeEach(() => {
  mockCompareWorktrees.mockReset();
  Object.defineProperty(window, "electron", {
    value: { git: { compareWorktrees: mockCompareWorktrees } },
    configurable: true,
  });
});

type FileFixture = { path: string; status: string; insertions: number; deletions: number };

function renderComparison(files: FileFixture[]) {
  mockCompareWorktrees.mockImplementation((_path, _b1, _b2, filePath?: string) =>
    Promise.resolve(
      filePath === undefined
        ? { branch1: "main", branch2: "feature", files }
        : `diff --git a/${filePath} b/${filePath}\n@@ -1 +1 @@\n-old\n+new`
    )
  );
  render(
    <TooltipProvider>
      <CrossWorktreeDiff isOpen onClose={vi.fn()} initialWorktreeId="wt-left" />
    </TooltipProvider>
  );
  fireEvent.change(screen.getByLabelText("Compare"), { target: { value: "wt-right" } });
}

function fileRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-file-path]"));
}

const COLLIDING: FileFixture[] = [
  { path: "src/cart/index.ts", status: "M", insertions: 2, deletions: 1 },
  { path: "README.md", status: "M", insertions: 5, deletions: 1 },
  { path: "src/checkout/index.ts", status: "M", insertions: 2, deletions: 1 },
];

describe("CrossWorktreeDiff pickers", () => {
  it("names each picker by the side it sets", () => {
    renderComparison([]);
    const base = screen.getByLabelText("Base");
    const compare = screen.getByLabelText("Compare");
    expect(base.tagName).toBe("SELECT");
    expect(compare.tagName).toBe("SELECT");
    expect(base).not.toBe(compare);
  });

  it("offers a worktree with no branch only as unavailable", () => {
    renderComparison([]);
    const compare = screen.getByLabelText("Compare") as HTMLSelectElement;
    const options = Array.from(compare.options).filter((o) => o.value !== "");
    for (const option of options) {
      const wt = worktrees.get(option.value)!;
      if (!("branch" in wt) || !wt.branch) expect(option.disabled).toBe(true);
    }
  });
});

describe("CrossWorktreeDiff file shelf", () => {
  it("gives files that share a basename distinct accessible names", async () => {
    renderComparison(COLLIDING);
    await waitFor(() => expect(fileRows()).toHaveLength(COLLIDING.length));
    const names = fileRows().map((row) => row.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
  });

  it("marks exactly the open file as current", async () => {
    renderComparison(COLLIDING);
    await waitFor(() => expect(fileRows()).toHaveLength(COLLIDING.length));
    const target = fileRows()[2]!;
    fireEvent.click(target);
    await waitFor(() => expect(screen.getByTestId("diff-viewer")).toBeTruthy());
    const current = fileRows().filter((row) => row.getAttribute("aria-current") === "true");
    expect(current).toEqual([target]);
  });

  it("steps through files in the order the list draws them", async () => {
    renderComparison(COLLIDING);
    await waitFor(() => expect(fileRows()).toHaveLength(COLLIDING.length));
    const drawn = fileRows().map((row) => row.dataset.filePath);
    const visited: (string | undefined)[] = [];
    for (let i = 0; i < drawn.length; i++) {
      fireEvent.keyDown(window, { key: "]" });
      await waitFor(() =>
        expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe(
          `${i + 1} of ${drawn.length}`
        )
      );
      visited.push(
        fileRows().find((row) => row.getAttribute("aria-current") === "true")?.dataset.filePath
      );
    }
    expect(visited).toEqual(drawn);
  });

  it("never asks for a file to be picked when the comparison has none", async () => {
    renderComparison([]);
    await waitFor(() => expect(mockCompareWorktrees).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("No differences")).toBeTruthy());
    expect(screen.queryByText(/pick a changed file/i)).toBeNull();
    expect(fileRows()).toHaveLength(0);
  });

  it("turns a diff response that isn't text into a retryable failure", async () => {
    renderComparison(COLLIDING);
    await waitFor(() => expect(fileRows()).toHaveLength(COLLIDING.length));
    mockCompareWorktrees.mockImplementation(() =>
      Promise.resolve({ branch1: "main", branch2: "feature", files: [] })
    );
    fireEvent.click(fileRows()[0]!);
    await waitFor(() => expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy());
    expect(screen.queryByTestId("diff-viewer")).toBeNull();
  });

  it("offers the full path on focus when the directory band is shortened", async () => {
    const deep = "packages/telemetry-exporter/src/internal/strategy.ts";
    renderComparison([{ path: deep, status: "A", insertions: 1, deletions: 0 }]);
    await waitFor(() => expect(fileRows()).toHaveLength(1));
    fireEvent.focus(fileRows()[0]!);
    await waitFor(() =>
      expect(screen.getAllByRole("tooltip").some((t) => t.textContent?.includes(deep))).toBe(true)
    );
  });
});
