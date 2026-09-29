// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render, act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeChangedDirs } from "@/store/createWorktreeStore";

// Only FilePane's read triggers are under test here, so the chrome renders
// its children bare and every store is a plain object the test mutates.
vi.mock("@/components/Panel/ContentPanel", () => ({
  ContentPanel: (props: { children?: ReactNode }) => <>{props.children}</>,
}));
const panelsById: Record<string, unknown> = {};
vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (state: unknown) => unknown) =>
    selector({
      panelsById,
      setFileViewMode: vi.fn(),
      setFilePanelPath: vi.fn(),
      activeDockTerminalId: null,
    }),
}));
vi.mock("@/lib/viewCacheState", () => ({
  subscribeProjectViewLifecycle: () => () => {},
  isProjectViewCached: () => false,
  isProjectViewObservable: () => true,
  subscribeProjectViewObservability: () => () => {},
  __resetProjectViewCacheStateForTests: () => {},
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) => selector({ currentProject: null }),
}));
vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector: (state: unknown) => unknown) =>
    selector({
      markdownWrapLines: false,
      setMarkdownWrapLines: vi.fn(),
      markdownFontSize: "lg",
      setMarkdownFontSize: vi.fn(),
      diffViewType: "unified",
      diffWrapLines: null,
      setDiffWrapLines: vi.fn(),
      diffIgnoreWhitespace: false,
    }),
}));
interface WorktreeLike {
  id: string;
  path: string;
  worktreeChanges?: { changes: never[]; lastUpdated?: number } | null;
}
const worktreeState = vi.hoisted(() => ({
  worktrees: new Map<string, WorktreeLike>(),
  workingTreeChangedAtById: new Map<string, number>(),
  workingTreeChangedDirsById: new Map<string, WorktreeChangedDirs>(),
}));
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: unknown) => unknown) => selector(worktreeState),
}));
vi.mock("@/store/accessibilityAnnouncerStore", () => ({
  useAnnouncerStore: { getState: () => ({ announce: vi.fn() }) },
}));
vi.mock("@/hooks/useExternalChangeTick", () => ({
  NO_WATCHED_PATHS: Object.freeze([]),
  useExternalChangeTick: () => undefined,
}));
const { readMock } = vi.hoisted(() => ({ readMock: vi.fn() }));
vi.mock("@/clients/filesClient", () => ({
  filesClient: { read: readMock, search: vi.fn().mockResolvedValue({ files: [] }) },
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true, result: undefined }) },
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/components/FileViewer/CodeViewer", () => ({
  CodeViewer: () => <div data-testid="code-viewer-mock" />,
}));
vi.mock("@/panels/diff/useDiffContent", () => ({
  useDiffContent: () => ({ content: undefined, stale: false, retry: vi.fn() }),
}));
vi.mock("@/registry/fileEditorRegistry", () => ({
  resolveFileEditor: () => null,
  useResolvedFileEditor: () => null,
  useFileEditor: () => null,
}));

import { FilePane } from "../FilePane";
import { TooltipProvider } from "@/components/ui/tooltip";

// How often a worktree tick or a window focus costs an open file pane a disk
// read. Every write anywhere in the worktree moves the tick, and every mounted
// pane hears every window focus, so a busy worktree with a handful of files
// open re-reads all of them constantly unless each read is earned.
const WORKTREE_ID = "wt-1";

function report(metric: string, value: number) {
  if (process.env.RELOAD_BENCH) process.stdout.write(`[reload-bench] ${metric}: ${value}\n`);
}

function seed(fsTick: number, dirs: readonly string[] | null) {
  worktreeState.worktrees.set(WORKTREE_ID, {
    id: WORKTREE_ID,
    path: "/repo",
    worktreeChanges: { changes: [], lastUpdated: 1 },
  });
  worktreeState.workingTreeChangedAtById.set(WORKTREE_ID, fsTick);
  worktreeState.workingTreeChangedDirsById.set(WORKTREE_ID, {
    at: fsTick,
    previousAt: fsTick - 1,
    dirs,
    run: "run-1",
  });
}

function panes(count: number, focusedIndex: number) {
  return (
    <TooltipProvider>
      {Array.from({ length: count }, (_, index) => (
        <FilePane
          key={index}
          id={`file-${index}`}
          title={`f${index}.ts`}
          isFocused={index === focusedIndex}
          location="grid"
          onFocus={() => {}}
          onClose={() => {}}
        />
      ))}
    </TooltipProvider>
  );
}

function seedPanes(count: number) {
  for (let index = 0; index < count; index++) {
    panelsById[`file-${index}`] = {
      id: `file-${index}`,
      kind: "file",
      filePath: `/repo/src/p${index}/f${index}.ts`,
      worktreeId: WORKTREE_ID,
    };
  }
}

beforeEach(() => {
  worktreeState.worktrees.clear();
  worktreeState.workingTreeChangedAtById.clear();
  worktreeState.workingTreeChangedDirsById.clear();
  readMock.mockReset();
  readMock.mockResolvedValue({ content: "const a = 1;", pathIsCanonical: true });
});

afterEach(() => {
  cleanup();
  for (const key of Object.keys(panelsById)) delete panelsById[key];
});

describe("FilePane re-reads on worktree ticks and window focus", () => {
  it("skips the read when a tick names only directories that cannot hold the file", async () => {
    seedPanes(1);
    seed(100, ["src/p0"]);
    const view = render(panes(1, 0));
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));

    for (let i = 1; i <= 20; i++) {
      seed(100 + i, [`docs/d${i}`, "src/other"]);
      await act(async () => {
        view.rerender(panes(1, 0));
      });
    }

    const reads = readMock.mock.calls.length - 1;
    report("pane: reads over 20 unrelated-dir ticks", reads);
    expect(reads).toBe(0);

    seed(121, ["src/p0"]);
    await act(async () => {
      view.rerender(panes(1, 0));
    });
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(2));
  });

  it("scopes nothing when the tick cannot prove it covers the file", async () => {
    seedPanes(1);
    seed(100, ["src/p0"]);
    const view = render(panes(1, 0));
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));

    async function tick(mutate: () => void, expectedReads: number) {
      mutate();
      await act(async () => {
        view.rerender(panes(1, 0));
      });
      await waitFor(() => expect(readMock).toHaveBeenCalledTimes(expectedReads));
    }

    // A rename two levels up is reported under the grandparent only.
    await tick(() => seed(101, ["src"]), 2);
    // A root write can be a top-level directory rename.
    await tick(() => seed(102, [""]), 3);
    // An unclassifiable burst.
    await tick(() => seed(103, null), 4);
    // A burst that went by unseen breaks the chain.
    await tick(() => {
      seed(104, ["docs"]);
      worktreeState.workingTreeChangedDirsById.set(WORKTREE_ID, {
        at: 105,
        previousAt: 104.5,
        dirs: ["docs"],
        run: "run-1",
      });
      worktreeState.workingTreeChangedAtById.set(WORKTREE_ID, 105);
    }, 5);
    // A git-status pass describes no directories.
    await tick(() => {
      seed(106, ["docs"]);
      worktreeState.worktrees.set(WORKTREE_ID, {
        id: WORKTREE_ID,
        path: "/repo",
        worktreeChanges: { changes: [], lastUpdated: 2 },
      });
    }, 6);
    // Case and separators are folded rather than trusted.
    await tick(() => seed(107, ["SRC\\P0"]), 7);
  });

  it("re-reads on every tick when the file is reached through a symlinked directory", async () => {
    readMock.mockResolvedValue({ content: "const a = 1;", pathIsCanonical: false });
    seedPanes(1);
    seed(100, ["src/p0"]);
    const view = render(panes(1, 0));
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));

    for (let i = 1; i <= 3; i++) {
      seed(100 + i, ["docs"]);
      await act(async () => {
        view.rerender(panes(1, 0));
      });
    }

    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(4));
  });

  it("keeps retrying after a background read fails behind content still on screen", async () => {
    seedPanes(1);
    seed(100, ["src/p0"]);
    const view = render(panes(1, 0));
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));

    readMock.mockRejectedValueOnce(new Error("EBUSY"));
    seed(101, ["src/p0"]);
    await act(async () => {
      view.rerender(panes(1, 0));
    });
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(2));
    await act(async () => {});

    seed(102, ["docs"]);
    await act(async () => {
      view.rerender(panes(1, 0));
    });
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(3));
  });

  it("does not scope a markdown file, whose embedded images live elsewhere", async () => {
    panelsById["file-0"] = {
      id: "file-0",
      kind: "file",
      filePath: "/repo/docs/spec.md",
      worktreeId: WORKTREE_ID,
    };
    seed(100, ["docs"]);
    const view = render(panes(1, 0));
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));
    await act(async () => {});

    seed(101, ["docs/img"]);
    await act(async () => {
      view.rerender(panes(1, 0));
    });
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(2));
  });

  it("keeps re-reading on unrelated ticks while the last read failed", async () => {
    readMock.mockRejectedValue(new Error("half-written"));
    seedPanes(1);
    seed(100, ["src/p0"]);
    const view = render(panes(1, 0));
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));

    readMock.mockResolvedValue({ content: "const a = 1;", pathIsCanonical: true });
    seed(101, ["docs"]);
    await act(async () => {
      view.rerender(panes(1, 0));
    });
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(2));
  });

  // Deliberately unscoped: a worktree that is neither focused nor running an
  // agent keeps only a `.git` watcher, so for a pane showing one of its files
  // the window focus is the only signal a write made from another app arrives.
  it("still re-reads every mounted pane on window focus", async () => {
    const count = 10;
    seedPanes(count);
    seed(100, ["src"]);
    render(panes(count, 0));
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(count));
    // Let every pane settle into "loaded", which is what arms its listener.
    await act(async () => {});

    for (let i = 0; i < 5; i++) {
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
    }

    const reads = readMock.mock.calls.length - count;
    report(`pane: reads over 5 window focuses with ${count} panes`, reads);
    expect(reads).toBe(count * 5);
  });
});
