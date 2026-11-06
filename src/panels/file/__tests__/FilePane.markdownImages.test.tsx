// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render, act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeChangedDirs } from "@/store/createWorktreeStore";

// What a worktree tick costs an open, rendered Markdown pane: the document
// read, and a refetch of every local image whose `src` moves (#15678). The
// real MarkdownViewer renders here, so the image URLs counted are the ones
// Chromium would be handed.
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
const lifecycleListeners = vi.hoisted(() => new Set<(phase: string) => void>());
vi.mock("@/lib/viewCacheState", () => ({
  subscribeProjectViewLifecycle: (listener: (phase: string) => void) => {
    lifecycleListeners.add(listener);
    return () => {
      lifecycleListeners.delete(listener);
    };
  },
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
vi.mock("@/registry/fileEditorRegistry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/registry/fileEditorRegistry")>()),
  resolveFileEditor: () => null,
  useResolvedFileEditor: () => null,
  useFileEditor: () => null,
  usePluginFileEditorCandidates: () => [],
}));

import { FilePane } from "../FilePane";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PATH_CANONICAL_HEADER } from "@shared/types/ipc/files";

const WORKTREE_ID = "wt-1";
const DOC = `# Spec

![a](./img/a.png)

![b](../assets/b.png)

![c](../media/c.png)

![remote](https://example.com/r.png)
`;

function report(metric: string, value: number) {
  if (process.env.RELOAD_BENCH) process.stdout.write(`[markdown-images] ${metric}: ${value}\n`);
}

let at = 100;
function tick(dirs: readonly string[] | null) {
  at += 1;
  worktreeState.workingTreeChangedAtById.set(WORKTREE_ID, at);
  worktreeState.workingTreeChangedDirsById.set(WORKTREE_ID, {
    at,
    previousAt: at - 1,
    dirs,
    run: "run-1",
  });
}

// Every HEAD a probe sends, and whether the path it names is canonical. A
// path left out of `aliased` or `missing` is its own realpath.
const aliased = new Set<string>();
const missing = new Set<string>();
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const filePath = url.searchParams.get("path") ?? "";
  if (init?.method !== "HEAD") throw new Error("only HEAD probes are expected");
  if (missing.has(filePath)) return new Response(null, { status: 404 });
  return new Response(null, {
    status: 200,
    headers: { [PATH_CANONICAL_HEADER]: aliased.has(filePath) ? "false" : "true" },
  });
});
function probes(): string[] {
  return fetchMock.mock.calls.map(
    ([input]) => new URL(String(input)).searchParams.get("path") ?? ""
  );
}

function pane(isFocused = true) {
  return (
    <TooltipProvider>
      <FilePane
        id="file-0"
        title="spec.md"
        isFocused={isFocused}
        location="grid"
        onFocus={() => {}}
        onClose={() => {}}
      />
    </TooltipProvider>
  );
}

/** Each rendered image's path and current `src`, local ones keyed by path. */
function imageSrcs(container: HTMLElement): Map<string, string> {
  const srcs = new Map<string, string>();
  for (const img of container.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    const key = src.startsWith("daintree-file:")
      ? (new URL(src).searchParams.get("path") ?? src)
      : src;
    srcs.set(key, src);
  }
  return srcs;
}

function changedImages(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after].filter(([key, src]) => before.get(key) !== src).map(([key]) => key);
}

async function mountPane() {
  const view = render(pane());
  await waitFor(() => expect(view.container.querySelectorAll("img")).toHaveLength(4));
  // Let the first probes land: until one does, an image refreshes on every tick.
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  await act(async () => {});
  return view;
}

async function applyTick(view: ReturnType<typeof render>, dirs: readonly string[] | null) {
  tick(dirs);
  await act(async () => {
    view.rerender(pane());
  });
  await act(async () => {});
}

beforeEach(() => {
  at = 100;
  aliased.clear();
  missing.clear();
  worktreeState.worktrees.clear();
  worktreeState.workingTreeChangedAtById.clear();
  worktreeState.workingTreeChangedDirsById.clear();
  worktreeState.worktrees.set(WORKTREE_ID, {
    id: WORKTREE_ID,
    path: "/repo",
    worktreeChanges: { changes: [], lastUpdated: 1 },
  });
  tick(["docs"]);
  panelsById["file-0"] = {
    id: "file-0",
    kind: "file",
    filePath: "/repo/docs/spec.md",
    worktreeId: WORKTREE_ID,
    fileViewMode: "rendered",
  };
  readMock.mockReset();
  readMock.mockResolvedValue({ content: DOC, pathIsCanonical: true });
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  lifecycleListeners.clear();
  vi.unstubAllGlobals();
  for (const key of Object.keys(panelsById)) delete panelsById[key];
});

describe("a rendered Markdown pane on worktree ticks (#15678)", () => {
  it("(a) reads nothing and refetches no image on writes elsewhere in the worktree", async () => {
    const view = await mountPane();
    const reads = readMock.mock.calls.length;
    const heads = fetchMock.mock.calls.length;
    const before = imageSrcs(view.container);

    let refetches = 0;
    for (let i = 0; i < 20; i++) {
      const last = imageSrcs(view.container);
      await applyTick(view, ["src/other", `build/out${i}`]);
      refetches += changedImages(last, imageSrcs(view.container)).length;
    }

    report("(a) document reads over 20 unrelated ticks", readMock.mock.calls.length - reads);
    report("(a) image refetches over 20 unrelated ticks", refetches);
    report("(a) HEAD probes over 20 unrelated ticks", fetchMock.mock.calls.length - heads);
    expect(readMock.mock.calls.length - reads).toBe(0);
    expect(refetches).toBe(0);
    expect(fetchMock.mock.calls.length - heads).toBe(0);
    expect(imageSrcs(view.container)).toEqual(before);
  });

  it("(b) refetches only the rewritten image when the Markdown is unchanged", async () => {
    const view = await mountPane();
    const reads = readMock.mock.calls.length;
    const heads = fetchMock.mock.calls.length;
    const before = imageSrcs(view.container);

    await applyTick(view, ["assets"]);

    const changed = changedImages(before, imageSrcs(view.container));
    report("(b) document reads", readMock.mock.calls.length - reads);
    report("(b) image refetches", changed.length);
    expect(readMock.mock.calls.length - reads).toBe(0);
    expect(changed).toEqual(["/repo/assets/b.png"]);
    // The refreshed image proves its path again; the others stay proven.
    await waitFor(() => expect(probes().slice(heads)).toEqual(["/repo/assets/b.png"]));
  });

  it("(c) re-reads and re-renders a Markdown text edit as before", async () => {
    const view = await mountPane();
    const reads = readMock.mock.calls.length;
    const before = imageSrcs(view.container);

    readMock.mockResolvedValue({
      content: DOC.replace("# Spec", "# Spec v2"),
      pathIsCanonical: true,
    });
    await applyTick(view, ["docs"]);

    await waitFor(() => expect(view.container.querySelector("h1")?.textContent).toBe("Spec v2"));
    const changed = changedImages(before, imageSrcs(view.container));
    report("(c) document reads", readMock.mock.calls.length - reads);
    report("(c) image refetches", changed.length);
    expect(readMock.mock.calls.length - reads).toBe(1);
    // A write in `docs` could be a rename of the folder holding `docs/img`, so
    // that image refreshes too; the other directories were never named.
    expect(changed).toEqual(["/repo/docs/img/a.png"]);
  });

  it("refetches an image reached through an alias on every tick, and only that one", async () => {
    aliased.add("/repo/media/c.png");
    const view = await mountPane();

    let cRefetches = 0;
    let otherRefetches = 0;
    for (let i = 0; i < 3; i++) {
      const last = imageSrcs(view.container);
      await applyTick(view, ["src/other"]);
      for (const key of changedImages(last, imageSrcs(view.container))) {
        if (key === "/repo/media/c.png") cRefetches += 1;
        else otherRefetches += 1;
      }
    }

    expect(cRefetches).toBe(3);
    expect(otherRefetches).toBe(0);
  });

  it("keeps refetching a missing image until it appears, then scopes it", async () => {
    missing.add("/repo/assets/b.png");
    const view = await mountPane();

    let last = imageSrcs(view.container);
    await applyTick(view, ["src/other"]);
    expect(changedImages(last, imageSrcs(view.container))).toEqual(["/repo/assets/b.png"]);

    // Written by an agent: the probe after the next refresh proves it.
    missing.delete("/repo/assets/b.png");
    last = imageSrcs(view.container);
    await applyTick(view, ["assets"]);
    expect(changedImages(last, imageSrcs(view.container))).toEqual(["/repo/assets/b.png"]);
    await act(async () => {});

    last = imageSrcs(view.container);
    await applyTick(view, ["src/other"]);
    expect(changedImages(last, imageSrcs(view.container))).toEqual([]);
  });

  it("refetches every local image when the tick can't describe what moved", async () => {
    const view = await mountPane();
    const before = imageSrcs(view.container);

    await applyTick(view, null);

    expect(changedImages(before, imageSrcs(view.container)).sort()).toEqual([
      "/repo/assets/b.png",
      "/repo/docs/img/a.png",
      "/repo/media/c.png",
    ]);
  });

  it("refetches every local image on window focus, and never the remote one", async () => {
    const view = await mountPane();
    const before = imageSrcs(view.container);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    const after = imageSrcs(view.container);
    expect(changedImages(before, after).sort()).toEqual([
      "/repo/assets/b.png",
      "/repo/docs/img/a.png",
      "/repo/media/c.png",
    ]);
    expect(after.get("https://example.com/r.png")).toBe("https://example.com/r.png");
  });

  // #11588: an image rewritten while the project view sat cached reached no
  // tick, and the re-read the reveal triggers finds identical Markdown.
  it("refetches every local image when the project view is revealed", async () => {
    const view = await mountPane();
    const before = imageSrcs(view.container);
    const reads = readMock.mock.calls.length;

    await act(async () => {
      for (const listener of Array.from(lifecycleListeners)) listener("revealed");
    });

    await waitFor(() => expect(readMock.mock.calls.length).toBe(reads + 1));
    expect(changedImages(before, imageSrcs(view.container)).sort()).toEqual([
      "/repo/assets/b.png",
      "/repo/docs/img/a.png",
      "/repo/media/c.png",
    ]);
  });

  it("refetches every local image when the pane regains focus", async () => {
    const view = await mountPane();
    await act(async () => {
      view.rerender(pane(false));
    });
    const before = imageSrcs(view.container);

    await act(async () => {
      view.rerender(pane(true));
    });

    expect(changedImages(before, imageSrcs(view.container)).sort()).toEqual([
      "/repo/assets/b.png",
      "/repo/docs/img/a.png",
      "/repo/media/c.png",
    ]);
  });
});
