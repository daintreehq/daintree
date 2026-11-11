// @vitest-environment jsdom
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { CrossWorktreeDiff } from "../CrossWorktreeDiff";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/components/ui/select", () => import("@/components/ui/__tests__/nativeSelectMock"));

type Snapshot = {
  id: string;
  name: string;
  path: string;
  branch: string | undefined;
  isMainWorktree: boolean;
  worktreeChanges: { headOid: string };
};

let current = new Map<string, Snapshot>();

function snapshot(id: string, branch: string | undefined, isMainWorktree = false): Snapshot {
  return {
    id,
    name: id,
    path: `/wt/${id}`,
    branch,
    isMainWorktree,
    worktreeChanges: { headOid: "aaa" },
  };
}

function setWorktrees(...snapshots: Snapshot[]) {
  current = new Map(snapshots.map((s) => [s.id, s]));
}

const LEFT = () => snapshot("wt-left", "main", true);
const RIGHT = () => snapshot("wt-right", "feature");

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
  DiffFilePath: ({ path }: { path: string }) => <span>{path}</span>,
  DiffViewer: ({ diff, source }: { diff: string; source?: string | null }) => (
    <div data-testid="diff-viewer" data-source={source ?? ""}>
      {diff}
    </div>
  ),
}));

const mockCompareWorktrees = vi.fn();
let diffText: string;

const A = { path: "a.ts", status: "M", insertions: 1, deletions: 0 };
const B = { path: "b.ts", status: "M", insertions: 2, deletions: 1 };

function listResponse() {
  return { branch1: "main", branch2: "feature", files: [A, B].map((f) => ({ ...f })) };
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockCompareWorktrees.mockReset();
  diffText = "diff v1";
  mockCompareWorktrees.mockImplementation((_path, _b1, _b2, filePath?: string) =>
    Promise.resolve(filePath === undefined ? listResponse() : diffText)
  );
  Object.defineProperty(window, "electron", {
    value: { git: { compareWorktrees: mockCompareWorktrees } },
    configurable: true,
  });
  setWorktrees(LEFT(), RIGHT());
});

function tree(initialWorktreeId: string | null = "wt-left") {
  return (
    <TooltipProvider>
      <CrossWorktreeDiff isOpen onClose={vi.fn()} initialWorktreeId={initialWorktreeId} />
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

async function openComparison() {
  const view = render(tree());
  fireEvent.change(screen.getByLabelText("Compare"), { target: { value: "wt-right" } });
  await waitFor(() => expect(screen.getByTestId("diff-viewer").textContent).toBe("diff v1"));
  return view;
}

function expectNothingStale() {
  expect(fileRow("a.ts")).toBeUndefined();
  expect(fileRow("b.ts")).toBeUndefined();
  expect(screen.queryByTestId("diff-viewer")).toBeNull();
  expect(screen.queryByTestId("cross-worktree-file-shelf")).toBeNull();
  expect(screen.queryByText("Couldn't compare these worktrees")).toBeNull();
}

describe("CrossWorktreeDiff when the chosen pair can no longer be compared", () => {
  it("clears the comparison and says why when the compare worktree leaves the list", async () => {
    const view = await openComparison();

    setWorktrees(LEFT());
    view.rerender(tree());

    expect(await screen.findByText("Choose another compare worktree")).toBeTruthy();
    expectNothingStale();
  });

  it("clears the comparison and says why when the base worktree leaves the list", async () => {
    const view = await openComparison();

    setWorktrees(RIGHT());
    view.rerender(tree());

    expect(await screen.findByText("Choose another base worktree")).toBeTruthy();
    expectNothingStale();
  });

  it("clears the comparison and says why when a worktree detaches its HEAD", async () => {
    const view = await openComparison();

    setWorktrees(LEFT(), snapshot("wt-right", undefined));
    view.rerender(tree());

    expect(await screen.findByText("Choose a compare worktree on a branch")).toBeTruthy();
    expect(screen.getByText(/wt-right has a detached HEAD/)).toBeTruthy();
    expectNothingStale();
  });

  it("says why when the base leaves the list before a compare side is chosen", () => {
    const view = render(tree());
    expect(screen.getByText("Choose a worktree to compare")).toBeTruthy();

    setWorktrees(RIGHT());
    view.rerender(tree());

    expect(screen.getByText("Choose another base worktree")).toBeTruthy();
    expect(mockCompareWorktrees).not.toHaveBeenCalled();
  });

  it("names the base side when the base worktree detaches its HEAD", async () => {
    const view = await openComparison();

    setWorktrees(snapshot("wt-left", undefined, true), RIGHT());
    view.rerender(tree());

    expect(await screen.findByText("Choose a base worktree on a branch")).toBeTruthy();
    expect(screen.getByText(/wt-left has a detached HEAD/)).toBeTruthy();
    expectNothingStale();
  });

  it("clears the comparison and says why when both sides are on the same branch", async () => {
    const view = await openComparison();

    setWorktrees(LEFT(), snapshot("wt-right", "main"));
    view.rerender(tree());

    expect(await screen.findByText("Choose a different branch to compare")).toBeTruthy();
    expect(screen.getByText(/Both worktrees have main checked out/)).toBeTruthy();
    expectNothingStale();
  });

  it("drops a comparison that lands after the pair stopped being comparable", async () => {
    const view = render(tree());
    const list = deferred();
    mockCompareWorktrees.mockImplementation((_path, _b1, _b2, filePath?: string) =>
      filePath === undefined ? list.promise : Promise.resolve("diff v1")
    );
    fireEvent.change(screen.getByLabelText("Compare"), { target: { value: "wt-right" } });
    await waitFor(() => expect(listCalls().length).toBe(1));

    setWorktrees(LEFT(), snapshot("wt-right", "main"));
    view.rerender(tree());
    await act(async () => list.resolve(listResponse()));

    expect(screen.getByText("Choose a different branch to compare")).toBeTruthy();
    expectNothingStale();
    expect(mockCompareWorktrees.mock.calls.some((c) => c[3] !== undefined)).toBe(false);
  });

  it("drops a file diff that lands after the pair stopped being comparable", async () => {
    const view = render(tree());
    const diff = deferred<string>();
    mockCompareWorktrees.mockImplementation((_path, _b1, _b2, filePath?: string) =>
      filePath === undefined ? Promise.resolve(listResponse()) : diff.promise
    );
    fireEvent.change(screen.getByLabelText("Compare"), { target: { value: "wt-right" } });
    await waitFor(() => expect(fileRow("a.ts")).toBeTruthy());

    setWorktrees(LEFT(), snapshot("wt-right", undefined));
    view.rerender(tree());
    await act(async () => diff.resolve("late diff"));

    expect(screen.getByText("Choose a compare worktree on a branch")).toBeTruthy();
    expectNothingStale();
  });

  it("hides a list skeleton still holding its floor when the pair breaks", async () => {
    vi.useFakeTimers();
    try {
      const view = render(tree());
      mockCompareWorktrees.mockImplementation(() => new Promise(() => {}));
      fireEvent.change(screen.getByLabelText("Compare"), { target: { value: "wt-right" } });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.getByTestId("cross-worktree-file-shelf")).toBeTruthy();

      setWorktrees(LEFT(), snapshot("wt-right", "main"));
      view.rerender(tree());

      expect(screen.getByText("Choose a different branch to compare")).toBeTruthy();
      expect(screen.queryByTestId("cross-worktree-file-shelf")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a fresh comparison once the pair is comparable again", async () => {
    const view = await openComparison();
    fireEvent.click(fileRow("b.ts")!);
    await waitFor(() => expect(fileRow("b.ts")?.getAttribute("aria-current")).toBe("true"));

    setWorktrees(LEFT(), snapshot("wt-right", undefined));
    view.rerender(tree());
    await screen.findByText("Choose a compare worktree on a branch");
    expectNothingStale();
    const callsWhileBlocked = mockCompareWorktrees.mock.calls.length;
    fireEvent.keyDown(window, { key: "]" });
    fireEvent.keyDown(window, { key: "[" });
    expect(mockCompareWorktrees.mock.calls.length).toBe(callsWhileBlocked);

    diffText = "diff v2";
    setWorktrees(LEFT(), RIGHT());
    view.rerender(tree());

    // The same pair as before, but a new comparison rather than a refresh of
    // the old one: it lands on its first file, not the one that was open.
    await waitFor(() => expect(screen.getByTestId("diff-viewer").textContent).toBe("diff v2"));
    expect(fileRow("a.ts")?.getAttribute("aria-current")).toBe("true");
    expect(fileRow("b.ts")?.getAttribute("aria-current")).toBeNull();
  });

  it("drops the previous pair's file diff and source once another pair is chosen", async () => {
    setWorktrees(LEFT(), RIGHT(), snapshot("wt-other", "other"));
    render(tree());
    const stalePatch = deferred<string>();
    const staleSource = deferred<string>();
    mockCompareWorktrees.mockImplementation(
      (
        _path,
        _b1,
        b2: string,
        filePath?: string,
        _mergeBase?: boolean,
        _ws?: boolean,
        context?: number
      ) => {
        if (filePath === undefined) return Promise.resolve(listResponse());
        if (b2 === "feature")
          return context === undefined ? stalePatch.promise : staleSource.promise;
        return Promise.resolve(
          context === undefined ? "diff other" : "@@ -1 +1 @@\n-old\n+source other"
        );
      }
    );
    fireEvent.change(screen.getByLabelText("Compare"), { target: { value: "wt-right" } });
    await waitFor(() =>
      expect(
        mockCompareWorktrees.mock.calls.filter((c) => c[2] === "feature" && c[3] !== undefined)
          .length
      ).toBe(2)
    );

    fireEvent.change(screen.getByLabelText("Compare"), { target: { value: "wt-other" } });
    await waitFor(() => expect(screen.getByTestId("diff-viewer").textContent).toBe("diff other"));
    expect(screen.getByTestId("diff-viewer").dataset.source).toBe("source other");

    await act(async () => staleSource.resolve("@@ -1 +1 @@\n-old\n+stale source"));
    await act(async () => stalePatch.resolve("stale diff"));

    expect(screen.getByTestId("diff-viewer").textContent).toBe("diff other");
    expect(screen.getByTestId("diff-viewer").dataset.source).toBe("source other");
  });
});

describe("CrossWorktreeDiff opened from a detached worktree", () => {
  it("defaults the base to a worktree on a branch", async () => {
    setWorktrees(LEFT(), RIGHT(), snapshot("wt-detached", undefined));
    render(tree("wt-detached"));

    expect((screen.getByLabelText("Base") as HTMLSelectElement).value).toBe("wt-left");
    expect(screen.getByText("Choose a worktree to compare")).toBeTruthy();
  });

  it("keeps a branch-backed initial worktree as the base even when it isn't listed first", () => {
    render(tree("wt-right"));

    expect((screen.getByLabelText("Base") as HTMLSelectElement).value).toBe("wt-right");
  });

  it("defaults the base past a detached main worktree", async () => {
    setWorktrees(snapshot("wt-left", undefined, true), RIGHT());
    render(tree("wt-left"));

    expect((screen.getByLabelText("Base") as HTMLSelectElement).value).toBe("wt-right");
  });

  it("leaves the base unchosen and says why when no worktree is on a branch", async () => {
    setWorktrees(snapshot("wt-detached", undefined), snapshot("wt-other", undefined));
    render(tree("wt-detached"));

    expect((screen.getByLabelText("Base") as HTMLSelectElement).value).toBe("");
    expect(screen.getByText("Check out a branch to compare")).toBeTruthy();
    expect(mockCompareWorktrees).not.toHaveBeenCalled();
  });
});
