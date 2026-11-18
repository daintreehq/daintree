// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import type { FileSearchPayload, FileSearchResult } from "@shared/types";
import type { FileChangeDetail } from "@shared/types/git";
import type { PluginSearchProviderInfo } from "@shared/types/plugin";

const { useWorktreeStoreMock, openFileMock, searchMock, selection } = vi.hoisted(() => ({
  useWorktreeStoreMock: vi.fn(),
  openFileMock: vi.fn(),
  searchMock: vi.fn(),
  selection: { activeWorktreeId: "wt-1" as string | null },
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: useWorktreeStoreMock,
}));

vi.mock("@/clients/filesClient", () => ({
  filesClient: { search: searchMock },
}));

vi.mock("@/components/QuickSwitcher/openQuickSwitcherFile", () => ({
  openQuickSwitcherFile: openFileMock,
}));

vi.mock("@/store", async () => {
  const actual = await vi.importActual<typeof import("@/store")>("@/store");
  return {
    ...actual,
    useWorktreeSelectionStore: Object.assign(
      (selector: (s: unknown) => unknown) =>
        selector({ selectWorktree: vi.fn(), activeWorktreeId: selection.activeWorktreeId }),
      { getState: () => ({ activeWorktreeId: selection.activeWorktreeId }) }
    ),
  };
});

import { useQuickSwitcher, type QuickSwitcherItem } from "../useQuickSwitcher";
import { usePaletteStore } from "@/store/paletteStore";

interface PendingSearch {
  payload: FileSearchPayload;
  resolve: (result: FileSearchResult) => void;
  reject: (error: Error) => void;
}

let searches: PendingSearch[];
let catalog: PluginSearchProviderInfo[];
const bridge = {
  getSearchProviders: vi.fn(async () => catalog),
  querySearchProvider: vi.fn(async () => ({ status: "ok" as const, results: [] })),
  cancelSearchProviders: vi.fn(async () => {}),
};

function change(path: string, mtimeMs: number, status: FileChangeDetail["status"] = "modified") {
  return { path, status, insertions: 1, deletions: 0, mtimeMs };
}

function worktree(
  id: string,
  path: string,
  changes: FileChangeDetail[],
  changesRoot: string | undefined = path
) {
  return {
    id,
    path,
    name: id === "wt-1" ? "main" : "feature",
    branch: id === "wt-1" ? "main" : "feature",
    isMainWorktree: id === "wt-1",
    worktreeChanges: {
      worktreeId: id,
      rootPath: changesRoot,
      changes,
      changedFileCount: changes.length,
    },
  };
}

function seedWorktrees(
  changes: FileChangeDetail[],
  extra: ReturnType<typeof worktree>[] = [],
  main = worktree("wt-1", "/repo", changes)
) {
  const worktrees = new Map<string, unknown>([["wt-1", main]]);
  for (const w of extra) worktrees.set(w.id, w);
  const state = {
    worktrees,
    isLoading: false,
    isInitialized: true,
    isReconnecting: false,
    error: null,
  };
  useWorktreeStoreMock.mockImplementation((selector: (s: unknown) => unknown) => selector(state));
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function openFiles() {
  const hook = renderHook(() => useQuickSwitcher());
  act(() => usePaletteStore.getState().openQuickSwitcher({ kind: "files" }));
  await settle();
  return hook;
}

function paths(items: readonly QuickSwitcherItem[]): string[] {
  return items.map((item) => item.file?.relativePath ?? `<${item.type}>`);
}

beforeEach(() => {
  vi.useFakeTimers();
  searches = [];
  catalog = [];
  selection.activeWorktreeId = "wt-1";
  searchMock.mockReset();
  searchMock.mockImplementation(
    (payload: FileSearchPayload) =>
      new Promise<FileSearchResult>((resolve, reject) =>
        searches.push({ payload, resolve, reject })
      )
  );
  openFileMock.mockClear();
  bridge.querySearchProvider.mockClear();
  vi.stubGlobal("electron", { plugin: bridge });
  usePanelStore.setState({ panelsById: {}, panelIds: [], mruList: [] });
  seedWorktrees([]);
});

afterEach(() => {
  usePaletteStore.setState({ activePaletteId: null, quickSwitcherScope: null });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useQuickSwitcher file scope", () => {
  it("lists the worktree's changed files newest first with nothing typed, without searching", async () => {
    seedWorktrees([
      change("/repo/src/old.ts", 100),
      change("/repo/src/gone.ts", 900, "deleted"),
      change("/repo/build/out.js", 800, "ignored"),
      change("/repo/new-folder/", 700, "untracked"),
      change("/elsewhere/x.ts", 600),
      change("README.md", 300),
      change("/repo/src/deep/new.ts", 500, "untracked"),
    ]);
    const { result } = await openFiles();

    expect(result.current.fileScope).toEqual({ worktreeName: "main", failed: false });
    expect(paths(result.current.results)).toEqual(["src/deep/new.ts", "README.md", "src/old.ts"]);
    expect(result.current.results[0]).toMatchObject({
      title: "new.ts",
      subtitle: "src/deep",
      file: { absolutePath: "/repo/src/deep/new.ts", changed: true },
    });
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("lists the worktree's shortest paths when nothing has changed", async () => {
    const { result } = await openFiles();
    // Files only: the host leaves folders out before it ranks and caps.
    expect(searches.map((s) => s.payload)).toEqual([
      expect.objectContaining({ cwd: "/repo", query: "", filesOnly: true }),
    ]);
    expect(result.current.isLoading).toBe(true);

    await act(async () => searches[0]!.resolve({ files: ["a.ts", "src/", "src/b.ts"] }));
    expect(paths(result.current.results)).toEqual(["a.ts", "src/b.ts"]);
    expect(result.current.isLoading).toBe(false);
  });

  it("searches what is typed, keeping the previous answer on screen but closed to picks", async () => {
    seedWorktrees([change("/repo/src/changed.ts", 100)]);
    const { result } = await openFiles();

    act(() => result.current.setQuery("bar"));
    await settle(149);
    expect(searchMock).not.toHaveBeenCalled();
    await settle(1);
    expect(searches.map((s) => s.payload.query)).toEqual(["bar"]);
    await act(async () => searches[0]!.resolve({ files: ["src/bar.ts", "lib/bar.md"] }));
    expect(paths(result.current.results)).toEqual(["src/bar.ts", "lib/bar.md"]);
    const barRow = result.current.results[0]!;

    act(() => result.current.setQuery("bars"));
    // The earlier answer stays drawn while the new one is on its way.
    expect(paths(result.current.results)).toEqual(["src/bar.ts", "lib/bar.md"]);
    expect(result.current.isFiltering).toBe(true);
    act(() => result.current.selectItem(barRow));
    expect(openFileMock).not.toHaveBeenCalled();
    expect(usePaletteStore.getState().activePaletteId).toBe("quick-switcher");

    await settle(150);
    await act(async () => searches[1]!.resolve({ files: ["src/bars.ts"] }));
    expect(result.current.isFiltering).toBe(false);
    act(() => result.current.selectItem(result.current.results[0]!, true));
    expect(openFileMock).toHaveBeenCalledWith("/repo/src/bars.ts", true);
    expect(usePaletteStore.getState().activePaletteId).toBeNull();
  });

  it("drops an answer that lands after a newer query was asked", async () => {
    const { result } = await openFiles();
    await act(async () => searches[0]!.resolve({ files: ["a.ts"] }));

    act(() => result.current.setQuery("x"));
    await settle(150);
    act(() => result.current.setQuery("xy"));
    await settle(150);
    await act(async () => searches[1]!.resolve({ files: ["x-only.ts"] }));
    expect(paths(result.current.results)).toEqual(["a.ts"]);

    await act(async () => searches[2]!.resolve({ files: ["xy.ts"] }));
    expect(paths(result.current.results)).toEqual(["xy.ts"]);
  });

  it("says the search failed when the host rejects it, rather than that nothing matched", async () => {
    const { result } = await openFiles();
    await act(async () => searches[0]!.resolve({ files: ["a.ts"] }));
    act(() => result.current.setQuery("a"));
    await settle(150);
    await act(async () => searches[1]!.reject(new Error("host gone")));

    expect(result.current.results).toEqual([]);
    expect(result.current.fileScope?.failed).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it("opens the top hit when Enter beat the answer to the query in the field", async () => {
    seedWorktrees([change("/repo/src/changed.ts", 100)]);
    const { result } = await openFiles();

    act(() => result.current.setQuery("src/foo/bar.ts"));
    act(() => result.current.confirmSelection(false));
    expect(openFileMock).not.toHaveBeenCalled();

    await settle(150);
    await act(async () => searches[0]!.resolve({ files: ["src/foo/bar.ts"] }));
    expect(openFileMock).toHaveBeenCalledWith("/repo/src/foo/bar.ts", false);
  });

  it("forgets a waiting Enter once the field asks something else", async () => {
    const { result } = await openFiles();
    await act(async () => searches[0]!.resolve({ files: ["a.ts"] }));

    act(() => result.current.setQuery("b"));
    act(() => result.current.confirmSelection(true));
    act(() => result.current.setQuery("bc"));
    await settle(150);
    await act(async () => searches[1]!.resolve({ files: ["bc.ts"] }));
    expect(openFileMock).not.toHaveBeenCalled();
  });

  it("never opens a row found in a worktree that is no longer the one shown", async () => {
    seedWorktrees(
      [change("/repo/src/changed.ts", 100)],
      [worktree("wt-2", "/repo-feature", [change("/repo-feature/src/changed.ts", 100)])]
    );
    const { result, rerender } = await openFiles();
    const oldRow = result.current.results[0]!;

    selection.activeWorktreeId = "wt-2";
    rerender();
    expect(result.current.fileScope?.worktreeName).toBe("feature");
    act(() => result.current.selectItem(oldRow));
    expect(openFileMock).not.toHaveBeenCalled();

    act(() => result.current.selectItem(result.current.results[0]!));
    expect(openFileMock).toHaveBeenCalledWith("/repo-feature/src/changed.ts", false);
  });

  it("never sends a typed file query to plugin search providers", async () => {
    catalog = [
      {
        key: "acme.notes.notes",
        pluginId: "acme.notes",
        pluginName: "Acme Notes",
        title: "Notes",
        keyword: "notes",
        iconId: "notebook",
        blend: true,
        kind: "declarative",
        shown: true,
      },
    ];
    const { result } = await openFiles();
    act(() => result.current.setQuery("secret-plan"));
    await settle(300);
    expect(bridge.querySearchProvider).not.toHaveBeenCalled();
  });

  it("scopes to files from the keyword, and a plain reopen starts unscoped", async () => {
    const { result } = renderHook(() => useQuickSwitcher());
    act(() => usePaletteStore.getState().openPalette("quick-switcher"));
    await settle();
    act(() => result.current.setQuery("Files "));
    expect(result.current.isFileKeyword).toBe(true);

    act(() => result.current.enterFileScope());
    expect(result.current.query).toBe("");
    expect(result.current.fileScope).not.toBeNull();
    expect(result.current.isFileKeyword).toBe(false);

    act(() => usePaletteStore.getState().openPalette("quick-switcher"));
    expect(result.current.fileScope).toBeNull();
  });

  it("relates changes to the root git resolved them against, and opens them on the worktree's", async () => {
    // macOS: the worktree is shown as /tmp/repo, git reports /private/tmp/repo.
    seedWorktrees(
      [],
      [],
      worktree(
        "wt-1",
        "/tmp/repo",
        [change("/private/tmp/repo/src/a.ts", 100)],
        "/private/tmp/repo"
      )
    );
    const { result } = await openFiles();
    expect(result.current.results.map((item) => item.file?.absolutePath)).toEqual([
      "/tmp/repo/src/a.ts",
    ]);
    expect(searchMock).not.toHaveBeenCalled();
    act(() => result.current.selectItem(result.current.results[0]!));
    expect(openFileMock).toHaveBeenCalledWith("/tmp/repo/src/a.ts", false);
  });

  it("relates changes to the worktree itself when the snapshot names no root", async () => {
    const bare = worktree("wt-1", "/repo", [
      change("src/b.ts", 200),
      change("/repo/src/c.ts", 100),
    ]);
    delete (bare.worktreeChanges as { rootPath?: string }).rootPath;
    seedWorktrees([], [], bare);
    const { result } = await openFiles();
    expect(paths(result.current.results)).toEqual(["src/b.ts", "src/c.ts"]);
  });

  it("finds a live hit ranked behind a full page of working-tree deletions", async () => {
    const gone = Array.from({ length: 50 }, (_, i) => `src/gone-${i}.ts`);
    seedWorktrees([
      ...gone.map((path) => change(`/repo/${path}`, 900, "deleted")),
      change("/repo/src/other.ts", 100),
    ]);
    const { result } = await openFiles();
    act(() => result.current.setQuery("src"));
    await settle(150);
    await act(async () => searches[0]!.resolve({ files: [...gone, "src/live.ts"] }));
    expect(paths(result.current.results)).toEqual(["src/live.ts"]);
  });

  it("leaves a file deleted in the working tree out of what the index still lists", async () => {
    seedWorktrees([change("/repo/src/gone.ts", 900, "deleted"), change("/repo/src/kept.ts", 100)]);
    const { result } = await openFiles();
    act(() => result.current.setQuery("src"));
    await settle(150);
    await act(async () => searches[0]!.resolve({ files: ["src/gone.ts", "src/kept.ts"] }));
    expect(paths(result.current.results)).toEqual(["src/kept.ts"]);
  });

  it("keeps the changed files on screen, closed to picks, until the first search answers", async () => {
    seedWorktrees([change("/repo/src/changed.ts", 100)]);
    const { result } = await openFiles();
    const changedRow = result.current.results[0]!;

    act(() => result.current.setQuery("x"));
    expect(paths(result.current.results)).toEqual(["src/changed.ts"]);
    expect(result.current.isFiltering).toBe(true);
    act(() => result.current.selectItem(changedRow));
    expect(openFileMock).not.toHaveBeenCalled();

    await settle(150);
    await act(async () => searches[0]!.resolve({ files: ["src/x.ts"] }));
    expect(paths(result.current.results)).toEqual(["src/x.ts"]);
  });

  it("opens only rows the current answer lists, and changed files only while git still reports them", async () => {
    seedWorktrees([change("/repo/src/changed.ts", 100)]);
    const { result, rerender } = await openFiles();
    const changedRow = result.current.results[0]!;

    act(() => result.current.setQuery("a"));
    await settle(150);
    await act(async () => searches[0]!.resolve({ files: ["src/a.ts"] }));
    const oldRow = result.current.results[0]!;
    act(() => result.current.setQuery("ab"));
    await settle(150);
    await act(async () => searches[1]!.resolve({ files: ["src/ab.ts"] }));
    act(() => result.current.selectItem(oldRow));
    expect(openFileMock).not.toHaveBeenCalled();

    act(() => result.current.setQuery(""));
    seedWorktrees([change("/repo/src/other.ts", 200)]);
    rerender();
    expect(paths(result.current.results)).toEqual(["src/other.ts"]);
    act(() => result.current.selectItem(changedRow));
    expect(openFileMock).not.toHaveBeenCalled();
    expect(usePaletteStore.getState().activePaletteId).toBe("quick-switcher");
  });

  it("opens the top hit with the modifier a waiting Enter was pressed with", async () => {
    const { result } = await openFiles();
    await act(async () => searches[0]!.resolve({ files: ["a.ts"] }));

    act(() => result.current.setQuery("bar"));
    act(() => result.current.confirmSelection(true));
    await settle(150);
    await act(async () => searches[1]!.resolve({ files: ["src/bar.ts", "lib/bar.ts"] }));
    expect(openFileMock.mock.calls).toEqual([["/repo/src/bar.ts", true]]);
  });

  it("drops a waiting Enter once the field asks something else, even back to the same query", async () => {
    const { result } = await openFiles();
    await act(async () => searches[0]!.resolve({ files: ["a.ts"] }));

    act(() => result.current.setQuery("b"));
    act(() => result.current.confirmSelection(false));
    act(() => result.current.setQuery("bc"));
    act(() => result.current.setQuery("b"));
    await settle(150);
    await act(async () => searches.at(-1)!.resolve({ files: ["b.ts"] }));
    expect(openFileMock).not.toHaveBeenCalled();
  });

  it("drops a waiting Enter when the switcher is opened again or the worktree changes", async () => {
    seedWorktrees([], [worktree("wt-2", "/repo-feature", [])], worktree("wt-1", "/repo", []));
    const { result, rerender } = await openFiles();
    act(() => result.current.confirmSelection(false));
    act(() => usePaletteStore.getState().openQuickSwitcher({ kind: "files" }));
    await settle();
    // The new opening asks again rather than taking the old opening's answer.
    expect(searches).toHaveLength(2);
    await act(async () => searches[0]!.resolve({ files: ["a.ts"] }));
    await act(async () => searches[1]!.resolve({ files: ["a.ts"] }));
    expect(openFileMock).not.toHaveBeenCalled();

    act(() => result.current.setQuery("q"));
    act(() => result.current.confirmSelection(false));
    selection.activeWorktreeId = "wt-2";
    rerender();
    await settle(150);
    for (const pending of searches.slice(2)) {
      await act(async () => pending.resolve({ files: ["q.ts"] }));
    }
    expect(openFileMock).not.toHaveBeenCalled();
  });

  it("keeps a waiting Enter dropped when the worktree changes and changes back", async () => {
    seedWorktrees([], [worktree("wt-2", "/repo-feature", [])], worktree("wt-1", "/repo", []));
    const { result, rerender } = await openFiles();
    await act(async () => searches[0]!.resolve({ files: ["a.ts"] }));

    act(() => result.current.setQuery("q"));
    act(() => result.current.confirmSelection(false));
    selection.activeWorktreeId = "wt-2";
    rerender();
    selection.activeWorktreeId = "wt-1";
    rerender();
    await settle(150);
    for (const pending of searches.slice(1)) {
      await act(async () => pending.resolve({ files: ["q.ts"] }));
    }
    expect(openFileMock).not.toHaveBeenCalled();
  });

  it("opens nothing from a handler drawn in an earlier opening, and leaves its waiting Enter", async () => {
    const { result } = await openFiles();
    await act(async () => searches[0]!.resolve({ files: ["a.ts"] }));
    const oldSelect = result.current.selectItem;
    const oldRow = result.current.results[0]!;

    act(() => usePaletteStore.getState().openQuickSwitcher({ kind: "files" }));
    await settle();
    act(() => result.current.confirmSelection(false));
    act(() => oldSelect(oldRow));
    await act(async () => searches[1]!.resolve({ files: ["b.ts"] }));
    expect(openFileMock.mock.calls).toEqual([["/repo/b.ts", false]]);
  });

  it("lists at most 50 files and opens none ranked past them", async () => {
    const { result } = await openFiles();
    await act(async () => searches[0]!.resolve({ files: ["x.ts"] }));
    act(() => result.current.setQuery("f"));
    await settle(150);
    const many = Array.from({ length: 60 }, (_, i) => `f${i}.ts`);
    await act(async () => searches[1]!.resolve({ files: many }));
    expect(result.current.totalResults).toBe(50);
    const top = result.current.results[0]!;
    const past = {
      ...top,
      file: { ...top.file!, relativePath: "f55.ts", absolutePath: "/repo/f55.ts" },
    };
    act(() => result.current.selectItem(past));
    expect(openFileMock).not.toHaveBeenCalled();
  });

  it("opens nothing for a row git has since reported deleted", async () => {
    const { result, rerender } = await openFiles();
    await act(async () => searches[0]!.resolve({ files: ["x.ts"] }));
    act(() => result.current.setQuery("src"));
    await settle(150);
    await act(async () => searches[1]!.resolve({ files: ["src/a.ts", "src/b.ts"] }));
    const rowA = result.current.results[0]!;

    seedWorktrees([change("/repo/src/a.ts", 900, "deleted")]);
    rerender();
    expect(paths(result.current.results)).toEqual(["src/b.ts"]);
    act(() => result.current.selectItem(rowA));
    expect(openFileMock).not.toHaveBeenCalled();
  });

  it("opens nothing from a handler that outlived the switcher's close", async () => {
    seedWorktrees([change("/repo/src/changed.ts", 100)]);
    const { result } = await openFiles();
    const select = result.current.selectItem;
    const row = result.current.results[0]!;
    act(() => usePaletteStore.getState().closePalette("quick-switcher"));
    act(() => select(row));
    expect(openFileMock).not.toHaveBeenCalled();
  });

  it("sends nothing to plugin providers when another palette takes over mid-query", async () => {
    catalog = [
      {
        key: "acme.notes.notes",
        pluginId: "acme.notes",
        pluginName: "Acme Notes",
        title: "Notes",
        keyword: "notes",
        iconId: "notebook",
        blend: true,
        kind: "declarative",
        shown: true,
      },
    ];
    const { result } = await openFiles();
    act(() => result.current.setQuery("secret-plan"));
    act(() => usePaletteStore.getState().openPalette("action"));
    await settle(300);
    expect(bridge.querySearchProvider).not.toHaveBeenCalled();
  });
});
