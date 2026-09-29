// @vitest-environment jsdom
import { Profiler, type ReactNode } from "react";
import { render, act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileChangeDetail, GitStatus } from "@shared/types/git";

// What every worktree store write costs the open file panes. Each pane
// subscribes to the store through several selectors, and all of them run on
// every write — a busy worktree status tick lands on every open pane at once.
// The store here is a real zustand store so selector work is measured the way
// React runs it (useSyncExternalStore snapshots), with the pane's chrome and
// readers stubbed out.
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
const { benchStore } = await vi.hoisted(async () => {
  const { createStore } = await import("zustand/vanilla");
  return {
    benchStore: createStore<Record<string, unknown>>(() => ({
      worktrees: new Map(),
      workingTreeChangedAtById: new Map(),
      workingTreeChangedDirsById: new Map(),
    })),
  };
});
vi.mock("@/hooks/useWorktreeStore", async () => {
  const { useStore } = await import("zustand");
  return {
    useWorktreeStore: (selector: (state: unknown) => unknown) => useStore(benchStore, selector),
  };
});
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

const WORKTREE_ID = "wt-1";
const ROOT = "/repo";
const PANES = 4;
const CHANGES = 2000;
const WRITES = 100;

function report(metric: string, value: number | string) {
  if (process.env.FILEPANE_BENCH) process.stdout.write(`[filepane-bench] ${metric}: ${value}\n`);
}

function filePathFor(index: number) {
  return `${ROOT}/src/p${index}/f${index}.ts`;
}

// Stored change paths are absolute, keyed by the host's changesMap.
function buildChanges(tick: number, touched: { index: number; status: GitStatus } | null) {
  const changes: FileChangeDetail[] = [];
  for (let i = 0; i < CHANGES; i++) {
    changes.push({
      path: `${ROOT}/pkg/m${i % 40}/file-${i}-${tick % 3}.ts`,
      status: "modified",
      insertions: 1,
      deletions: 0,
    });
  }
  if (touched) {
    changes.push({
      path: filePathFor(touched.index),
      status: touched.status,
      insertions: 1,
      deletions: 0,
    });
  }
  return changes;
}

function writeChanges(tick: number, touched: { index: number; status: GitStatus } | null) {
  const worktrees = new Map(benchStore.getState().worktrees as Map<string, unknown>);
  worktrees.set(WORKTREE_ID, {
    id: WORKTREE_ID,
    path: ROOT,
    worktreeChanges: { changes: buildChanges(tick, touched), lastUpdated: 1 },
  });
  benchStore.setState({ worktrees });
}

let renders = 0;
function panes() {
  return (
    <Profiler id="panes" onRender={() => renders++}>
      <TooltipProvider>
        {Array.from({ length: PANES }, (_, index) => (
          <FilePane
            key={index}
            id={`file-${index}`}
            title={`f${index}.ts`}
            isFocused={index === 0}
            location="grid"
            onFocus={() => {}}
            onClose={() => {}}
          />
        ))}
      </TooltipProvider>
    </Profiler>
  );
}

beforeEach(() => {
  for (let index = 0; index < PANES; index++) {
    panelsById[`file-${index}`] = {
      id: `file-${index}`,
      kind: "file",
      filePath: filePathFor(index),
      worktreeId: WORKTREE_ID,
    };
  }
  benchStore.setState({
    worktrees: new Map(),
    workingTreeChangedAtById: new Map(),
    workingTreeChangedDirsById: new Map(),
  });
  readMock.mockReset();
  readMock.mockResolvedValue({ content: "const a = 1;", pathIsCanonical: true });
});

afterEach(() => {
  cleanup();
  for (const key of Object.keys(panelsById)) delete panelsById[key];
});

describe("FilePane change selectors under a large worktree status", () => {
  it("tracks this file's status across status ticks while unrelated churn stays cheap", async () => {
    writeChanges(0, null);
    render(panes());
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(PANES));

    // Warm up the JIT so the timed loop measures steady state.
    for (let i = 0; i < 10; i++) {
      await act(async () => writeChanges(i + 1, null));
    }

    renders = 0;
    let unrelatedMs = 0;
    let ownMs = 0;
    let nonChangeMs = 0;
    let nonChangeCommits = 0;
    for (let i = 0; i < WRITES; i++) {
      // Every third tick touches pane 0's file; the rest churn unrelated paths.
      const touched =
        i % 3 === 0 ? { index: 0, status: (i % 2 ? "added" : "modified") as GitStatus } : null;
      const start = performance.now();
      await act(async () => writeChanges(100 + i, touched));
      const elapsed = performance.now() - start;
      if (touched) ownMs += elapsed;
      else unrelatedMs += elapsed;

      // A write that leaves the change list alone (a filesystem tick elsewhere).
      const commitsBefore = renders;
      const fsStart = performance.now();
      await act(async () => {
        const at = new Map(benchStore.getState().workingTreeChangedAtById as Map<string, number>);
        at.set("wt-other", i);
        benchStore.setState({ workingTreeChangedAtById: at });
      });
      nonChangeMs += performance.now() - fsStart;
      nonChangeCommits += renders - commitsBefore;
    }
    report(`status writes (${WRITES}) total ms`, (unrelatedMs + ownMs).toFixed(1));
    report("  unrelated-file writes ms", unrelatedMs.toFixed(1));
    report("  this-file writes ms", ownMs.toFixed(1));
    report(`non-change writes (${WRITES}) ms`, nonChangeMs.toFixed(1));
    report("commits", renders);
    // Pane 0's status flips on its own ticks; nothing else may re-render.
    expect(nonChangeCommits).toBe(0);
    expect(renders).toBeGreaterThan(0);
  });
});
