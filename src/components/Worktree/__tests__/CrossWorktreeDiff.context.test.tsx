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
  branch: string;
  isMainWorktree: boolean;
  worktreeChanges: { headOid: string };
};

let current = new Map<string, Snapshot>();

function snapshot(id: string, headOid = "aaa"): Snapshot {
  return {
    id,
    name: id,
    path: `/wt/${id}`,
    branch: id === "wt-left" ? "main" : "feature",
    isMainWorktree: id === "wt-left",
    worktreeChanges: { headOid },
  };
}

function setWorktrees(rightHead = "aaa") {
  current = new Map([
    ["wt-left", snapshot("wt-left")],
    ["wt-right", snapshot("wt-right", rightHead)],
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
  DiffFilePath: ({ path }: { path: string }) => <span>{path}</span>,
  DiffViewer: ({ diff, source }: { diff: string; source?: string | null }) => (
    <div data-testid="diff-viewer" data-source={source ?? ""}>
      {diff}
    </div>
  ),
}));

const mockCompareWorktrees = vi.fn();

const A = { path: "a.ts", status: "M", insertions: 1, deletions: 0 };
const B = { path: "b.ts", status: "M", insertions: 2, deletions: 1 };

let files: { path: string; status: string; insertions: number; deletions: number }[];

function listResponse() {
  return { branch1: "main", branch2: "feature", files: files.map((f) => ({ ...f })) };
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A whole-file diff whose compare side is `text`, as the context read returns it. */
function wholeFile(text: string): string {
  return `@@ -1 +1 @@\n-old\n+${text}`;
}

type Respond = (file: string, context: boolean) => Promise<unknown>;

function respondWith(respond: Respond) {
  mockCompareWorktrees.mockImplementation(
    (
      _path: string,
      _b1: string,
      _b2: string,
      filePath?: string,
      _mergeBase?: boolean,
      _ws?: boolean,
      context?: number
    ) =>
      filePath === undefined
        ? Promise.resolve(listResponse())
        : respond(filePath, context !== undefined)
  );
}

beforeEach(() => {
  mockCompareWorktrees.mockReset();
  files = [A, B];
  respondWith((file, context) =>
    Promise.resolve(context ? wholeFile(`source ${file}`) : `diff ${file}`)
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

function viewer() {
  return screen.getByTestId("diff-viewer");
}

function contextCalls(path: string) {
  return mockCompareWorktrees.mock.calls.filter((c) => c[3] === path && c[6] !== undefined);
}

async function openComparison() {
  const view = render(tree());
  fireEvent.change(screen.getByLabelText("Compare"), { target: { value: "wt-right" } });
  await waitFor(() => expect(viewer().textContent).toBe("diff a.ts"));
  await waitFor(() => expect(viewer().dataset.source).toBe("source a.ts"));
  return view;
}

describe("CrossWorktreeDiff loading a file's hidden context", () => {
  it("shows the patch without waiting for the whole-file read", async () => {
    await openComparison();
    const source = deferred<string>();
    respondWith((file, context) => (context ? source.promise : Promise.resolve(`diff ${file}`)));

    fireEvent.click(fileRow("b.ts")!);

    await waitFor(() => expect(viewer().textContent).toBe("diff b.ts"));
    expect(contextCalls("b.ts").length).toBe(1);
    expect(viewer().dataset.source).toBe("");

    await act(async () => source.resolve(wholeFile("source b.ts")));
    expect(viewer().textContent).toBe("diff b.ts");
    expect(viewer().dataset.source).toBe("source b.ts");
  });

  it("keeps the patch without expansion when the whole-file read fails", async () => {
    await openComparison();
    const source = deferred<string>();
    respondWith((file, context) => (context ? source.promise : Promise.resolve(`diff ${file}`)));

    fireEvent.click(fileRow("b.ts")!);
    await waitFor(() => expect(viewer().textContent).toBe("diff b.ts"));
    expect(contextCalls("b.ts").length).toBe(1);

    await act(async () => source.reject(new Error("too big")));
    expect(viewer().textContent).toBe("diff b.ts");
    expect(viewer().dataset.source).toBe("");
    expect(screen.queryByText(/couldn't/i)).toBeNull();
  });

  it("drops a previous file's context that lands after another file is picked", async () => {
    await openComparison();
    const staleSource = deferred<string>();
    respondWith((file, context) => {
      if (!context) return Promise.resolve(`diff ${file}`);
      return file === "b.ts" ? staleSource.promise : Promise.resolve(wholeFile(`source ${file}`));
    });

    fireEvent.click(fileRow("b.ts")!);
    await waitFor(() => expect(viewer().textContent).toBe("diff b.ts"));

    fireEvent.click(fileRow("a.ts")!);
    await waitFor(() => expect(viewer().textContent).toBe("diff a.ts"));
    await waitFor(() => expect(viewer().dataset.source).toBe("source a.ts"));

    await act(async () => staleSource.resolve(wholeFile("source b.ts")));
    expect(viewer().textContent).toBe("diff a.ts");
    expect(viewer().dataset.source).toBe("source a.ts");
  });

  it("drops a previous file's context while the new file's own read is still out", async () => {
    await openComparison();
    const staleSource = deferred<string>();
    const freshSource = deferred<string>();
    respondWith((file, context) => {
      if (!context) return Promise.resolve(`diff ${file}`);
      return file === "b.ts" ? staleSource.promise : freshSource.promise;
    });

    fireEvent.click(fileRow("b.ts")!);
    await waitFor(() => expect(viewer().textContent).toBe("diff b.ts"));
    fireEvent.click(fileRow("a.ts")!);
    await waitFor(() => expect(viewer().textContent).toBe("diff a.ts"));

    await act(async () => staleSource.resolve(wholeFile("source b.ts")));
    expect(viewer().dataset.source).toBe("");

    await act(async () => freshSource.resolve(wholeFile("source a.ts")));
    expect(viewer().dataset.source).toBe("source a.ts");
  });

  it("asks for no whole-file read when the patch is a message rather than a diff", async () => {
    await openComparison();
    respondWith((file, context) =>
      Promise.resolve(context ? wholeFile(`source ${file}`) : "BINARY_FILE")
    );

    fireEvent.click(fileRow("b.ts")!);
    await waitFor(() => expect(viewer().textContent).toBe("BINARY_FILE"));
    await act(async () => {});
    expect(contextCalls("b.ts").length).toBe(0);
  });

  it.each([
    ["added", "A", 0],
    ["deleted", "D", 0],
    ["renamed", "R", 1],
    ["copied", "C", 1],
  ])(
    "reads whole-file context for a %s file only when it's on both sides",
    async (_, status, reads) => {
      files = [A, { ...B, status }];
      await openComparison();

      fireEvent.click(fileRow("b.ts")!);
      await waitFor(() => expect(viewer().textContent).toBe("diff b.ts"));
      await waitFor(() => expect(viewer().dataset.source).toBe(reads ? "source b.ts" : ""));
      expect(contextCalls("b.ts").length).toBe(reads);
    }
  );

  it("drops a whole-file read that describes different blobs than the patch", async () => {
    await openComparison();
    const header = (index: string) => `diff --git a/b.ts b/b.ts\nindex ${index} 100644\n`;
    respondWith((_file, context) =>
      Promise.resolve(
        context
          ? header("abc1234..9990000") + wholeFile("source b.ts from a newer commit")
          : header("abc1234..def5678") + "@@ -1 +1 @@\n-old\n+source b.ts"
      )
    );

    fireEvent.click(fileRow("b.ts")!);
    await waitFor(() => expect(contextCalls("b.ts").length).toBe(1));
    await act(async () => {});
    expect(viewer().textContent).toContain("+source b.ts");
    expect(viewer().dataset.source).toBe("");
  });
});

describe("CrossWorktreeDiff refreshing an open file's hidden context", () => {
  async function refresh(view: ReturnType<typeof render>) {
    setWorktrees("bbb");
    view.rerender(tree());
    await waitFor(() => expect(contextCalls("a.ts").length).toBe(2));
  }

  it("swaps a refreshed patch and its source together", async () => {
    const view = await openComparison();
    const patch = deferred<string>();
    const source = deferred<string>();
    respondWith((_file, context) => (context ? source.promise : patch.promise));

    await refresh(view);
    await act(async () => patch.resolve("diff a.ts v2"));
    expect(viewer().textContent).toBe("diff a.ts");
    expect(viewer().dataset.source).toBe("source a.ts");

    await act(async () => source.resolve(wholeFile("source a.ts v2")));
    expect(viewer().textContent).toBe("diff a.ts v2");
    expect(viewer().dataset.source).toBe("source a.ts v2");
  });

  it("refreshes without expansion when the two reads describe different blobs", async () => {
    const view = await openComparison();
    const header = (index: string) => `diff --git a/a.ts b/a.ts\nindex ${index} 100644\n`;
    respondWith((_file, context) =>
      Promise.resolve(
        context
          ? header("abc1234..9990000") + wholeFile("source a.ts from a newer commit")
          : header("abc1234..def5678") + "@@ -1 +1 @@\n-old\n+source a.ts v2"
      )
    );

    await refresh(view);
    await waitFor(() => expect(viewer().textContent).toContain("+source a.ts v2"));
    expect(viewer().dataset.source).toBe("");
  });

  it("holds a refreshed source back until its patch lands", async () => {
    const view = await openComparison();
    const patch = deferred<string>();
    const source = deferred<string>();
    respondWith((_file, context) => (context ? source.promise : patch.promise));

    await refresh(view);
    await act(async () => source.resolve(wholeFile("source a.ts v2")));
    expect(viewer().textContent).toBe("diff a.ts");
    expect(viewer().dataset.source).toBe("source a.ts");

    await act(async () => patch.resolve("diff a.ts v2"));
    expect(viewer().textContent).toBe("diff a.ts v2");
    expect(viewer().dataset.source).toBe("source a.ts v2");
  });

  it.each([
    [
      "is rejected",
      (patch: ReturnType<typeof deferred<unknown>>) => patch.reject(new Error("boom")),
    ],
    ["isn't diff text", (patch: ReturnType<typeof deferred<unknown>>) => patch.resolve(undefined)],
  ])(
    "keeps the old pair when a refresh's patch %s, even once its source lands",
    async (_, fail) => {
      const view = await openComparison();
      const patch = deferred<unknown>();
      const source = deferred<string>();
      respondWith((_file, context) => (context ? source.promise : patch.promise));

      await refresh(view);
      await act(async () => source.resolve(wholeFile("source a.ts v2")));
      await act(async () => fail(patch));

      expect(viewer().textContent).toBe("diff a.ts");
      expect(viewer().dataset.source).toBe("source a.ts");
    }
  );
});
