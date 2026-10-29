// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { CrossWorktreeDiff } from "../CrossWorktreeDiff";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/components/ui/select", () => import("@/components/ui/__tests__/nativeSelectMock"));

type Snapshot = {
  id: string;
  name: string;
  path: string;
  branch: string;
  isMainWorktree: boolean;
  modifiedCount: number;
  worktreeChanges: { headOid: string };
};

let current = new Map<string, Snapshot>();

// A fresh object per call, as the real store produces for any status update.
function snapshot(id: string, overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id,
    name: id,
    path: `/wt/${id}`,
    branch: id === "wt-left" ? "main" : "feature",
    isMainWorktree: id === "wt-left",
    modifiedCount: 0,
    worktreeChanges: { headOid: "aaa" },
    ...overrides,
  };
}

function setWorktrees(left: Partial<Snapshot> = {}, right: Partial<Snapshot> = {}) {
  current = new Map([
    ["wt-left", snapshot("wt-left", left)],
    ["wt-right", snapshot("wt-right", right)],
  ]);
}

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (sel: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    sel({ worktrees: current }),
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

let files: { path: string; status: string; insertions: number; deletions: number }[];
let diffText: string;

const A = { path: "a.ts", status: "M", insertions: 1, deletions: 0 };
const B = { path: "b.ts", status: "M", insertions: 2, deletions: 1 };

beforeEach(() => {
  mockCompareWorktrees.mockReset();
  files = [A, B];
  diffText = "diff v1";
  mockCompareWorktrees.mockImplementation((_path, _b1, _b2, filePath?: string) =>
    Promise.resolve(
      filePath === undefined ? { branch1: "main", branch2: "feature", files } : diffText
    )
  );
  Object.defineProperty(window, "electron", {
    value: { git: { compareWorktrees: mockCompareWorktrees } },
    configurable: true,
  });
  setWorktrees();
});

function tree() {
  return (
    <TooltipProvider>
      <CrossWorktreeDiff isOpen onClose={vi.fn()} initialWorktreeId="wt-left" />
    </TooltipProvider>
  );
}

function fileRow(path: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-file-path]")).find(
    (el) => el.dataset.filePath === path
  );
}

function listCalls() {
  return mockCompareWorktrees.mock.calls.filter((c) => c[3] === undefined);
}

async function openFile(view: ReturnType<typeof render>, path: string) {
  fireEvent.change(screen.getByLabelText("Compare"), { target: { value: "wt-right" } });
  await waitFor(() => expect(fileRow(path)).toBeTruthy());
  fireEvent.click(fileRow(path)!);
  await waitFor(() => expect(screen.getByTestId("diff-viewer").textContent).toBe(diffText));
  return view;
}

describe("CrossWorktreeDiff when a worktree snapshot updates", () => {
  it("does not rerun the comparison for changes that are not in the comparison", async () => {
    const view = render(tree());
    await openFile(view, "b.ts");
    const callsBefore = mockCompareWorktrees.mock.calls.length;

    setWorktrees({ modifiedCount: 3 }, { modifiedCount: 7 });
    view.rerender(tree());

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockCompareWorktrees.mock.calls.length).toBe(callsBefore);
    expect(fileRow("b.ts")?.getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("diff-viewer").textContent).toBe("diff v1");
  });

  it("keeps the open file and refreshes its diff when a branch moves to a new commit", async () => {
    const view = render(tree());
    await openFile(view, "b.ts");
    const listCallsBefore = listCalls().length;

    diffText = "diff v2";
    setWorktrees({}, { worktreeChanges: { headOid: "bbb" } });
    view.rerender(tree());

    await waitFor(() => expect(screen.getByTestId("diff-viewer").textContent).toBe("diff v2"));
    expect(listCalls().length).toBe(listCallsBefore + 1);
    expect(fileRow("b.ts")?.getAttribute("aria-current")).toBe("true");
  });

  it("keeps the old diff on screen while the refresh is in flight", async () => {
    const view = render(tree());
    await openFile(view, "b.ts");

    let release!: (value: unknown) => void;
    mockCompareWorktrees.mockImplementation((_path, _b1, _b2, filePath?: string) =>
      filePath === undefined
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(diffText)
    );
    setWorktrees({ worktreeChanges: { headOid: "ccc" } });
    view.rerender(tree());

    await waitFor(() => expect(listCalls().length).toBe(2));
    expect(screen.getByTestId("diff-viewer").textContent).toBe("diff v1");
    expect(fileRow("b.ts")?.getAttribute("aria-current")).toBe("true");
    release({ branch1: "main", branch2: "feature", files });
  });

  it("closes the diff when the refreshed comparison no longer has the open file", async () => {
    const view = render(tree());
    await openFile(view, "b.ts");

    files = [A];
    setWorktrees({}, { worktreeChanges: { headOid: "ddd" } });
    view.rerender(tree());

    await waitFor(() => expect(fileRow("b.ts")).toBeUndefined());
    expect(fileRow("a.ts")?.getAttribute("aria-current")).toBeNull();
    expect(screen.queryByTestId("diff-viewer")).toBeNull();
  });

  it("starts over when a worktree switches branch", async () => {
    const view = render(tree());
    await openFile(view, "b.ts");

    files = [A];
    setWorktrees({}, { branch: "other" });
    view.rerender(tree());

    await waitFor(() => expect(fileRow("b.ts")).toBeUndefined());
    expect(screen.queryByTestId("diff-viewer")).toBeNull();
    expect(mockCompareWorktrees).toHaveBeenLastCalledWith("/wt/wt-left", "main", "other");
  });
});
