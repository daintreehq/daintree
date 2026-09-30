// @vitest-environment jsdom
import { render, act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeChangedDirs } from "@/store/createWorktreeStore";

// How often a worktree tick costs the open file a re-read, and the HTML preview
// its frame. Every write anywhere in the worktree moves the tick, so both have
// to be earned by the file itself: a read only when a changed directory could
// contain it, a frame navigation only when the bytes actually moved.
const { readMock } = vi.hoisted(() => ({ readMock: vi.fn() }));
vi.mock("@/clients/filesClient", () => ({ filesClient: { read: readMock } }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true, result: undefined }) },
}));
vi.mock("@/components/Markdown/MarkdownViewer", () => ({
  MarkdownViewer: () => <div data-testid="markdown-viewer-mock" />,
}));
vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector: (state: unknown) => unknown) =>
    selector({ markdownFontSize: "xl", setMarkdownFontSize: vi.fn() }),
}));
vi.mock("@/components/FileViewer/CodeViewer", () => ({
  CodeViewer: (props: { content: string }) => (
    <div data-testid="code-viewer-mock" data-content={props.content} />
  ),
}));
const htmlNonces = vi.hoisted(() => [] as number[]);
vi.mock("@/components/Html/HtmlViewer", () => ({
  HtmlViewer: (props: { reloadNonce: number }) => {
    htmlNonces.push(props.reloadNonce);
    return <div data-testid="html-viewer-mock" data-reload-nonce={props.reloadNonce} />;
  },
}));

import { FileBrowserViewer } from "../FileBrowserViewer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NO_HIDDEN_ROWS } from "../fileBrowserTree";

const ROOT = "/repo";

function viewer(
  relativePath: string,
  tick: number,
  changedDirs?: WorktreeChangedDirs,
  surfaceRefreshNonce = 0
) {
  const filePath = `${ROOT}/${relativePath}`;
  return (
    <TooltipProvider>
      <FileBrowserViewer
        panelId="panel-1"
        filePath={filePath}
        rootPath={ROOT}
        fileName={relativePath.split("/").pop() ?? relativePath}
        relativePath={relativePath}
        revision={`${tick}:${surfaceRefreshNonce}`}
        changeSignal={{ tick, gitTick: 1, changedDirs }}
        surfaceRefreshNonce={surfaceRefreshNonce}
        mediaReloadNonce={0}
        onMediaPlayingChange={vi.fn()}
        onRefresh={vi.fn()}
        isRefreshing={false}
        sidebarCollapsed={false}
        onToggleSidebar={vi.fn()}
        treeSidebarId="file-tree-column"
        changedFiles={null}
        onSelectChangedFile={vi.fn()}
        folderPath={null}
        folderRows={null}
        folderStatus="ready"
        folderHasHiddenDotfiles={false}
        folderHiddenCounts={NO_HIDDEN_ROWS}
        onShowDotfiles={vi.fn()}
        onSelectEntry={vi.fn()}
        basePath={ROOT}
        sort={{ key: "name", direction: "asc" }}
        onSortChange={vi.fn()}
        hideDotfiles={false}
        onHideDotfilesChange={vi.fn()}
        hiddenCounts={NO_HIDDEN_ROWS}
        onCollapseAll={vi.fn()}
        canCollapseAll={false}
        missingFilePath={null}
        onShowFolder={vi.fn()}
      />
    </TooltipProvider>
  );
}

/** One filesystem burst per tick, chained so each proves no burst went unseen. */
function burst(at: number, dirs: readonly string[] | null): WorktreeChangedDirs {
  return { at, previousAt: at - 1, dirs, run: "run-1" };
}

async function showRendered() {
  const button = await screen.findByRole("radio", { name: "Rendered" });
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function report(metric: string, value: number) {
  if (process.env.RELOAD_BENCH) process.stdout.write(`[reload-bench] ${metric}: ${value}\n`);
}

beforeEach(() => {
  readMock.mockReset();
  htmlNonces.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FileBrowserViewer re-reads on worktree ticks", () => {
  it("keeps the HTML preview frame when a tick leaves the file's bytes unchanged", async () => {
    readMock.mockResolvedValue({
      content: "<h1>same</h1>",
      htmlPreviewUrl: "daintree-html://t/page.html",
      pathIsCanonical: true,
    });
    const view = render(viewer("site/page.html", 100, burst(100, ["site"])));
    await showRendered();
    await waitFor(() => expect(htmlNonces.length).toBeGreaterThan(0));
    await flush();
    const baseline = htmlNonces.at(-1);

    for (let i = 1; i <= 10; i++) {
      view.rerender(viewer("site/page.html", 100 + i, burst(100 + i, ["site"])));
      await flush();
    }

    const navigations = new Set(htmlNonces.filter((nonce) => nonce !== baseline)).size;
    report("viewer: iframe navigations over 10 same-content ticks", navigations);
    expect(readMock).toHaveBeenCalledTimes(11);
    expect(navigations).toBe(0);
  });

  it("still re-navigates the frame for every tick that rewrites the file", async () => {
    let version = 0;
    readMock.mockImplementation(() =>
      Promise.resolve({
        content: `<h1>v${version++}</h1>`,
        htmlPreviewUrl: "daintree-html://t/page.html",
        pathIsCanonical: true,
      })
    );
    const view = render(viewer("site/page.html", 100, burst(100, ["site"])));
    await showRendered();
    await waitFor(() => expect(htmlNonces.length).toBeGreaterThan(0));
    await flush();
    const baseline = htmlNonces.at(-1);

    for (let i = 1; i <= 10; i++) {
      view.rerender(viewer("site/page.html", 100 + i, burst(100 + i, ["site"])));
      await flush();
    }

    expect(new Set(htmlNonces.filter((nonce) => nonce !== baseline)).size).toBe(10);
  });

  it("re-navigates the frame on Refresh even when the bytes are unchanged", async () => {
    readMock.mockResolvedValue({
      content: "<h1>same</h1>",
      htmlPreviewUrl: "daintree-html://t/page.html",
      pathIsCanonical: true,
    });
    const view = render(viewer("site/page.html", 100, burst(100, ["site"])));
    await showRendered();
    await waitFor(() => expect(htmlNonces.length).toBeGreaterThan(0));
    await flush();
    const baseline = htmlNonces.at(-1);

    view.rerender(viewer("site/page.html", 100, burst(100, ["site"]), 1));
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(2));
    await flush();

    expect(htmlNonces.at(-1)).not.toBe(baseline);
  });

  it("skips the read when a tick names only directories that cannot hold the file", async () => {
    readMock.mockResolvedValue({ content: "const a = 1;", pathIsCanonical: true });
    const view = render(viewer("src/a/file.ts", 100, burst(100, ["src/a"])));
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(1));
    await flush();

    for (let i = 1; i <= 20; i++) {
      view.rerender(viewer("src/a/file.ts", 100 + i, burst(100 + i, [`docs/d${i}`, "src/b"])));
      await flush();
    }

    const reads = readMock.mock.calls.length - 1;
    report("viewer: reads over 20 unrelated-dir ticks", reads);
    expect(reads).toBe(0);

    view.rerender(viewer("src/a/file.ts", 121, burst(121, ["src/a"])));
    await waitFor(() => expect(readMock).toHaveBeenCalledTimes(2));
  });
});
