// @vitest-environment jsdom
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { CrossWorktreeDiff } from "../CrossWorktreeDiff";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
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

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function listResponse() {
  return { branch1: "main", branch2: "feature", files: [A, B].map((f) => ({ ...f })) };
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

async function openComparison() {
  const view = render(tree());
  fireEvent.change(screen.getByLabelText("Compare"), { target: { value: "wt-right" } });
  await waitFor(() => expect(screen.getByTestId("diff-viewer").textContent).toBe("diff v1"));
  return view;
}

const SWAP = "Swap Base and Compare";

function select(label: "Base" | "Compare") {
  return screen.getByLabelText(label) as HTMLSelectElement;
}

describe("CrossWorktreeDiff swapping Base and Compare", () => {
  it("reverses a two-worktree comparison, which the selectors alone can't", async () => {
    await openComparison();
    expect(select("Base").value).toBe("wt-left");
    expect(select("Compare").value).toBe("wt-right");
    expect(mockCompareWorktrees).toHaveBeenCalledWith("/wt/wt-left", "main", "feature");

    mockCompareWorktrees.mockClear();
    diffText = "diff reversed";
    fireEvent.click(screen.getByRole("button", { name: SWAP }));

    expect(select("Base").value).toBe("wt-right");
    expect(select("Compare").value).toBe("wt-left");
    await waitFor(() =>
      expect(screen.getByTestId("diff-viewer").textContent).toBe("diff reversed")
    );
    expect(mockCompareWorktrees).toHaveBeenCalledWith("/wt/wt-right", "feature", "main");
    expect(mockCompareWorktrees).not.toHaveBeenCalledWith("/wt/wt-left", "main", "feature");
  });

  it("swaps back to the original comparison on a second press", async () => {
    await openComparison();
    const swap = screen.getByRole("button", { name: SWAP });
    fireEvent.click(swap);
    await waitFor(() => expect(select("Base").value).toBe("wt-right"));
    fireEvent.click(swap);

    expect(select("Base").value).toBe("wt-left");
    expect(select("Compare").value).toBe("wt-right");
    await waitFor(() => expect(screen.getByTestId("diff-viewer").textContent).toBe("diff v1"));
  });

  it("moves a lone base to the compare side without starting a comparison", () => {
    render(tree());
    expect(select("Base").value).toBe("wt-left");
    expect(select("Compare").value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: SWAP }));

    expect(select("Base").value).toBe("");
    expect(select("Compare").value).toBe("wt-left");
    expect(mockCompareWorktrees).not.toHaveBeenCalled();
  });

  it("is unavailable until a side is chosen", () => {
    render(tree(null));
    const swap = screen.getByRole("button", { name: SWAP });
    expect(swap.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(swap);

    expect(select("Base").value).toBe("");
    expect(select("Compare").value).toBe("");
  });

  it("says which worktree is on which side, since focus stays on the button", async () => {
    await openComparison();

    fireEvent.click(screen.getByRole("button", { name: SWAP }));

    expect(useAnnouncerStore.getState().polite?.msg).toBe(
      "Base is now feature, Compare is now main"
    );
  });

  it("keeps focus on the button so it can be pressed again", async () => {
    await openComparison();
    const swap = screen.getByRole("button", { name: SWAP });
    swap.focus();

    fireEvent.click(swap);

    expect(document.activeElement).toBe(swap);
  });

  it("opens the reversed comparison on its first file, not the one that was open", async () => {
    mockCompareWorktrees.mockImplementation((_path, b1, b2, filePath?: string) =>
      Promise.resolve(filePath === undefined ? listResponse() : `${b1}>${b2}:${filePath}`)
    );
    render(tree());
    fireEvent.change(screen.getByLabelText("Compare"), { target: { value: "wt-right" } });
    await waitFor(() =>
      expect(screen.getByTestId("diff-viewer").textContent).toBe("main>feature:a.ts")
    );
    fireEvent.click(fileRow("b.ts")!);
    await waitFor(() =>
      expect(screen.getByTestId("diff-viewer").textContent).toBe("main>feature:b.ts")
    );

    fireEvent.click(screen.getByRole("button", { name: SWAP }));

    await waitFor(() =>
      expect(screen.getByTestId("diff-viewer").textContent).toBe("feature>main:a.ts")
    );
  });

  it("drops the old direction's list when it lands after the swap", async () => {
    const stale = deferred();
    mockCompareWorktrees.mockImplementation((_path, b1, b2, filePath?: string) => {
      if (filePath !== undefined) return Promise.resolve(`${b1}>${b2}:${filePath}`);
      return b1 === "main"
        ? stale.promise
        : Promise.resolve({ branch1: "feature", branch2: "main", files: [{ ...B }] });
    });
    render(tree());
    fireEvent.change(screen.getByLabelText("Compare"), { target: { value: "wt-right" } });

    fireEvent.click(screen.getByRole("button", { name: SWAP }));
    await waitFor(() =>
      expect(screen.getByTestId("diff-viewer").textContent).toBe("feature>main:b.ts")
    );
    await act(async () => {
      stale.resolve(listResponse());
    });

    expect(fileRow("a.ts")).toBeUndefined();
    expect(fileRow("b.ts")).toBeDefined();
    expect(screen.getByTestId("diff-viewer").textContent).toBe("feature>main:b.ts");
  });
});
