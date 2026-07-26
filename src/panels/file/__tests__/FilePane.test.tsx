// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render, act, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitStatus } from "@shared/types/git";

// FilePane forwards a fixed prop list to ContentPanel; #10991 was a dropped
// `showRestoreControl`, which hid the inline "Move to grid" button on a docked
// single file panel. Stub ContentPanel to capture what FilePane forwards, and
// mock the heavy store/client/viewer surface so we render only FilePane's own
// wiring — the seam that shipped the bug. The stub also renders `toolbar`, so
// the toolbar-owned open-in-editor error banner (#11114) is observable.
const contentPanelProps: Array<Record<string, unknown>> = [];

vi.mock("@/components/Panel/ContentPanel", () => ({
  ContentPanel: (
    props: Record<string, unknown> & { toolbar?: ReactNode; children?: ReactNode }
  ) => {
    contentPanelProps.push(props);
    // Render children too so the Source/Rendered branch is observable, not just
    // the toolbar (#11191 HTML preview branch).
    return (
      <>
        {props.toolbar}
        {props.children}
      </>
    );
  },
}));

// Mutable so a test can seed a real file panel (giving FilePane a filePath, and
// therefore a toolbar) without disturbing the prop-forwarding tests.
const panelsById: Record<string, unknown> = {};

// Stable across selector calls so a test can assert which mode a toggle asked
// for — a fresh vi.fn() per call records nothing observable.
const { setFileViewModeMock, setFilePanelPathMock } = vi.hoisted(() => ({
  setFileViewModeMock: vi.fn(),
  setFilePanelPathMock: vi.fn(),
}));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (state: unknown) => unknown) =>
    selector({
      panelsById,
      setFileViewMode: setFileViewModeMock,
      setFilePanelPath: setFilePanelPathMock,
    }),
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) => selector({ currentProject: null }),
}));
vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector: (state: unknown) => unknown) =>
    selector({
      markdownWrapLines: false,
      setMarkdownWrapLines: vi.fn(),
      diffViewType: "unified",
      diffWrapLines: false,
      diffIgnoreWhitespace: false,
    }),
}));
// Mutable so a test can seed a worktree whose change list makes the file
// locally changed — the Diff option's only trigger (#11274).
// Field names mirror WorktreeSnapshot / WorktreeViewState exactly: the live
// change tick (#11451) reads `id` off the snapshot to index the side map, so a
// seeded worktree missing one silently resolves no tick at all.
interface WorktreeLike {
  id: string;
  path: string;
  worktreeChanges?: {
    changes: Array<{ path: string; status: GitStatus }>;
    lastUpdated?: number;
  } | null;
}
const worktreeState = vi.hoisted(() => ({
  // Typed rather than `unknown`: the mocked hook hands the state to the pane's
  // selectors as `unknown`, so nothing else would catch a seed whose shape has
  // drifted from the real snapshot — and vitest never typechecks.
  worktrees: new Map<string, WorktreeLike>(),
  // The raw filesystem-write tick, keyed by worktree id and stored beside the
  // snapshots rather than on them (#11330). Absent here, the pane's change-tick
  // selector would throw on `.get`.
  workingTreeChangedAtById: new Map<string, number>(),
}));
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: unknown) => unknown) => selector(worktreeState),
}));
vi.mock("@/store/accessibilityAnnouncerStore", () => ({
  useAnnouncerStore: { getState: () => ({ announce: vi.fn() }) },
}));
const { readMock, searchMock } = vi.hoisted(() => ({
  readMock: vi.fn(),
  searchMock: vi.fn(),
}));
vi.mock("@/clients/filesClient", () => ({
  filesClient: { read: readMock, search: searchMock },
}));
// dispatch() resolves an ActionDispatchResult union and never rejects; callers
// branch on `.ok`, so the mock must honour that shape rather than resolve void.
const { dispatchMock, notifyMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  notifyMock: vi.fn(),
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
// Captures the props FilePane hands the rendered viewer so the #11255 release
// chain (FilePane → MarkdownViewer.onRendered → the height pin) is observable;
// without this the wiring could be deleted with every test still green.
const markdownViewerProps = vi.hoisted(() => ({
  current: null as { onRendered?: () => void } | null,
}));
vi.mock("@/components/Markdown/MarkdownViewer", () => ({
  MarkdownViewer: (props: { onRendered?: () => void }) => {
    markdownViewerProps.current = props;
    return <div data-testid="markdown-viewer-mock" />;
  },
}));
vi.mock("@/components/FileViewer/CodeViewer", () => ({
  // Surfaces `content` so a re-read's result is observable — the only way to
  // tell a stale settle apart from a fresh one (#11451).
  CodeViewer: (props: { content?: string }) => (
    <div data-testid="code-viewer-mock" data-content={props.content ?? ""} />
  ),
}));
// Typed rather than bare vi.fn() so reading .mock.calls needs no `as` cast
// (which would regress the no-unsafe-type-assertion ratchet).
interface DiffSubjectLike {
  source: string;
  worktreePath: string;
  filePath: string;
  status: string;
}
const { useDiffContentMock } = vi.hoisted(() => ({
  useDiffContentMock: vi.fn<
    (subject: DiffSubjectLike | null) => {
      content: string | undefined;
      stale: boolean;
      retry: () => void;
    }
  >(),
}));
vi.mock("@/panels/diff/useDiffContent", () => ({ useDiffContent: useDiffContentMock }));
// FilePane lazy-loads the viewer, so assertions on it must await the chunk.
vi.mock("@/components/Worktree/DiffViewer", () => ({
  DiffViewer: (props: { diff: string; rootPath?: string }) => (
    <div data-testid="diff-viewer-mock" data-diff={props.diff} data-root={props.rootPath ?? ""} />
  ),
}));
vi.mock("@/components/Html/HtmlViewer", () => ({
  HtmlViewer: (props: { previewUrl: string | null; reloadNonce: number }) => (
    <div
      data-testid="html-viewer-mock"
      data-preview-url={props.previewUrl ?? ""}
      data-reload-nonce={props.reloadNonce}
    />
  ),
}));

import { FilePane } from "../FilePane";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FILE_READ_ERROR_MESSAGES } from "@/components/FileViewer/fileReadErrors";
import { revealCopy } from "@/components/FileViewer/revealCopy";

function lastContentPanelProps(): Record<string, unknown> {
  const props = contentPanelProps.at(-1);
  if (!props) throw new Error("ContentPanel was not rendered");
  return props;
}

beforeEach(() => {
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ ok: true, result: undefined });
  useDiffContentMock.mockReset();
  useDiffContentMock.mockReturnValue({ content: undefined, stale: false, retry: vi.fn() });
  worktreeState.worktrees.clear();
  worktreeState.workingTreeChangedAtById.clear();
  // Reset per test so a prior test's read call can't satisfy a later
  // toHaveBeenCalledWith assertion (cross-test contamination).
  readMock.mockReset();
  readMock.mockResolvedValue({ content: "" });
  searchMock.mockReset();
  searchMock.mockResolvedValue({ files: [] });
  // InlineStatusBanner reads window.matchMedia at render time; jsdom does not
  // implement it, so provide a no-op stub.
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }
});

afterEach(() => {
  contentPanelProps.length = 0;
  for (const key of Object.keys(panelsById)) delete panelsById[key];
  setFileViewModeMock.mockReset();
  setFilePanelPathMock.mockReset();
  markdownViewerProps.current = null;
});

describe("FilePane restore-control wiring", () => {
  it("forwards showRestoreControl so a single docked file panel shows the inline restore button", () => {
    render(
      <FilePane
        id="file-1"
        title="spec.md"
        isFocused={false}
        location="dock"
        onFocus={() => {}}
        onClose={() => {}}
        onRestore={() => {}}
        showRestoreControl={true}
      />
    );

    const props = lastContentPanelProps();
    expect(props.showRestoreControl).toBe(true);
    expect(props.onRestore).toBeTypeOf("function");
  });

  it("forwards showRestoreControl=false so grouped docked panels keep the inline button hidden", () => {
    render(
      <FilePane
        id="file-2"
        title="spec.md"
        isFocused={false}
        location="dock"
        onFocus={() => {}}
        onClose={() => {}}
        onRestore={() => {}}
        showRestoreControl={false}
      />
    );

    expect(lastContentPanelProps().showRestoreControl).toBe(false);
  });
});

// #11114: dispatch() resolves {ok:false} rather than rejecting, so the old
// `.catch(logError)` was dead code and a failed open produced no feedback at all.
describe("FilePane open-in-editor failure feedback (#11114)", () => {
  function renderFilePane() {
    panelsById["file-1"] = { id: "file-1", kind: "file", filePath: "/repo/src/index.ts" };
    // The toolbar's path pill is a Radix Tooltip, which needs a provider once
    // the ContentPanel stub actually renders the toolbar.
    return render(
      <TooltipProvider>
        <FilePane
          id="file-1"
          title="index.ts"
          isFocused={false}
          location="grid"
          onFocus={() => {}}
          onClose={() => {}}
        />
      </TooltipProvider>
    );
  }

  function clickOpenInEditor(container: HTMLElement) {
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Open in editor"
    );
    if (!button) throw new Error("Open in editor button not rendered");
    return act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("stays silent when the open succeeds", async () => {
    const { container } = renderFilePane();
    await clickOpenInEditor(container);

    expect(dispatchMock).toHaveBeenCalledWith(
      "file.openInEditor",
      { path: "/repo/src/index.ts" },
      { source: "user" }
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("surfaces the dispatch error inline when the open fails", async () => {
    const message = "No editor configured for .ts files";
    dispatchMock.mockResolvedValue({ ok: false, error: { code: "EXECUTION_ERROR", message } });

    const { container } = renderFilePane();
    await clickOpenInEditor(container);

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain(message);
    // Tier 3 is pane-local — the failure must not also fire a global toast.
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("collapses a double-click into a single editor launch", async () => {
    let resolveDispatch: (value: unknown) => void = () => {};
    dispatchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveDispatch = resolve;
      })
    );

    const { container } = renderFilePane();
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Open in editor"
    )!;

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Without a synchronous guard the second click starts a second OS launch,
    // whose late failure could then paper over the first launch's success.
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDispatch({ ok: true, result: undefined });
    });

    // The guard released — the button is usable again, not latched.
    await clickOpenInEditor(container);
    expect(dispatchMock).toHaveBeenCalledTimes(2);
  });

  it("drops a stale failure when the pane switched files mid-flight", async () => {
    let resolveDispatch: (value: unknown) => void = () => {};
    dispatchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveDispatch = resolve;
      })
    );

    const { container, rerender } = renderFilePane();
    await clickOpenInEditor(container);

    // The pane is repointed at another file while the open is still in flight.
    panelsById["file-1"] = { id: "file-1", kind: "file", filePath: "/repo/src/other.ts" };
    rerender(
      <TooltipProvider>
        <FilePane
          id="file-1"
          title="other.ts"
          isFocused={false}
          location="grid"
          onFocus={() => {}}
          onClose={() => {}}
        />
      </TooltipProvider>
    );

    await act(async () => {
      resolveDispatch({
        ok: false,
        error: { code: "EXECUTION_ERROR", message: "Stale failure for index.ts" },
      });
    });

    // The old file's failure must not be reported against the new one.
    expect(container.querySelector('[role="alert"]')).toBeNull();

    // ...and the switch must have released the in-flight guard, or the button
    // would be permanently dead on the new file.
    dispatchMock.mockResolvedValue({ ok: true, result: undefined });
    await clickOpenInEditor(container);
    expect(dispatchMock).toHaveBeenLastCalledWith(
      "file.openInEditor",
      { path: "/repo/src/other.ts" },
      { source: "user" }
    );
  });

  it("clears the error once a retry succeeds", async () => {
    dispatchMock.mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "Editor launch failed" },
    });
    const { container } = renderFilePane();
    await clickOpenInEditor(container);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    dispatchMock.mockResolvedValue({ ok: true, result: undefined });
    const retry = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Retry")
    );
    await act(async () => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Retry must re-run the action against the same file, not merely dismiss.
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(dispatchMock).toHaveBeenLastCalledWith(
      "file.openInEditor",
      { path: "/repo/src/index.ts" },
      { source: "user" }
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

// #11386: the read-only viewer gains a "Reveal in file manager" button so the
// file can be opened in Finder/Explorer even when the viewer can't render it
// (oversized, unsupported video). Reveal and the browser/editor open button are
// concurrently clickable, so external-open state is tracked per target.
describe("FilePane reveal in file manager (#11386)", () => {
  const PATH = "/repo/src/index.ts";

  // Platform-derived, so resolve it the same way the component does rather than
  // hardcoding a per-OS string that would fail on the other platform's CI.
  const revealLabel = revealCopy().label;

  function paneElement(filePath: string) {
    return (
      <TooltipProvider>
        <FilePane
          id="file-1"
          title={filePath.split("/").pop() ?? filePath}
          isFocused={false}
          location="grid"
          onFocus={() => {}}
          onClose={() => {}}
        />
      </TooltipProvider>
    );
  }

  function renderFilePane(filePath = PATH) {
    panelsById["file-1"] = { id: "file-1", kind: "file", filePath };
    return render(paneElement(filePath));
  }

  function findButton(container: HTMLElement, label: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === label
    );
    if (!button) throw new Error(`${label} button not rendered`);
    return button;
  }

  function click(button: HTMLElement) {
    return act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function deferred() {
    let resolve: (value: unknown) => void = () => {};
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("dispatches file.showItemInFolder with the file's absolute path", async () => {
    const { container } = renderFilePane();
    await click(findButton(container, revealLabel));

    expect(dispatchMock).toHaveBeenCalledWith(
      "file.showItemInFolder",
      { path: PATH },
      { source: "user" }
    );
  });

  it("still offers reveal for a file the viewer can't render", async () => {
    // An unsupported video never reaches a playable/text surface — revealing it
    // in the OS file manager is the whole point of the button.
    const { container } = renderFilePane("/repo/media/demo.mov");
    await act(async () => {});
    expect(container.querySelector("video")).toBeNull();

    await click(findButton(container, revealLabel));
    expect(dispatchMock).toHaveBeenCalledWith(
      "file.showItemInFolder",
      { path: "/repo/media/demo.mov" },
      { source: "user" }
    );
  });

  it("surfaces a reveal failure inline and retries reveal, without a global toast", async () => {
    dispatchMock.mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "File no longer exists" },
    });
    const { container } = renderFilePane();
    await click(findButton(container, revealLabel));

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("File no longer exists");
    // Tier 3 is pane-local — the failure must not also fire a global toast.
    expect(notifyMock).not.toHaveBeenCalled();

    dispatchMock.mockResolvedValue({ ok: true, result: undefined });
    // Cleared so the assertion can't be satisfied by the original failed
    // dispatch — a Retry that merely cleared the banner would then fail here.
    dispatchMock.mockClear();
    await click(findButton(container, revealCopy().retryAriaLabel));

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(
      "file.showItemInFolder",
      { path: PATH },
      { source: "user" }
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("runs reveal and editor concurrently without one invalidating the other", async () => {
    const revealGate = deferred();
    // Reveal is held open; the editor click that follows resolves immediately.
    dispatchMock.mockReturnValueOnce(revealGate.promise).mockResolvedValue({
      ok: true,
      result: undefined,
    });
    const { container } = renderFilePane();

    act(() => {
      findButton(container, revealLabel).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // A slow reveal must not swallow the click on the editor button.
    await click(findButton(container, "Open in editor"));
    expect(dispatchMock.mock.calls.map(([actionId]) => actionId)).toEqual([
      "file.showItemInFolder",
      "file.openInEditor",
    ]);

    // The editor completing must not mark the still-pending reveal stale: its
    // late failure has to surface, not be silently dropped by a shared counter.
    await act(async () => {
      revealGate.resolve({
        ok: false,
        error: { code: "EXECUTION_ERROR", message: "reveal came back after the editor" },
      });
      await revealGate.promise;
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "reveal came back after the editor"
    );
  });

  it("keeps a failed target's banner when a sibling action succeeds", async () => {
    dispatchMock.mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "No editor configured" },
    });
    const { container } = renderFilePane();
    await click(findButton(container, "Open in editor"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "No editor configured"
    );

    // Revealing the file did nothing to configure an editor, so the editor's
    // failure is still true and its banner must stand.
    dispatchMock.mockResolvedValue({ ok: true, result: undefined });
    dispatchMock.mockClear();
    await click(findButton(container, revealLabel));

    // The reveal really ran (not swallowed by the editor's error state) yet the
    // editor's own banner is untouched.
    expect(dispatchMock).toHaveBeenCalledWith(
      "file.showItemInFolder",
      { path: PATH },
      { source: "user" }
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "No editor configured"
    );
  });

  it("leaves a target's Retry usable while only a sibling target is pending", async () => {
    dispatchMock.mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "No editor configured" },
    });
    const { container } = renderFilePane();
    await click(findButton(container, "Open in editor"));

    // A reveal held in flight must not disable the editor's Retry — pending is
    // per target, so a slow sibling says nothing about the editor's own state.
    const revealGate = deferred();
    dispatchMock.mockReturnValue(revealGate.promise);
    act(() => {
      findButton(container, revealLabel).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(findButton(container, "Retry opening in editor").hasAttribute("disabled")).toBe(false);

    await act(async () => {
      revealGate.resolve({ ok: true, result: undefined });
      await revealGate.promise;
    });
  });

  it("won't let a superseded reveal unlock the attempt that replaced it", async () => {
    const staleReveal = deferred();
    const liveReveal = deferred();
    dispatchMock.mockReturnValueOnce(staleReveal.promise).mockReturnValueOnce(liveReveal.promise);
    const { container, rerender } = renderFilePane();

    act(() => {
      findButton(container, revealLabel).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Switch files: the reset bumps the generation so the first reveal's later
    // completion belongs to a file the pane no longer shows.
    panelsById["file-1"] = { id: "file-1", kind: "file", filePath: "/repo/src/other.ts" };
    rerender(paneElement("/repo/src/other.ts"));
    act(() => {
      findButton(container, revealLabel).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dispatchMock).toHaveBeenCalledTimes(2);

    // The stale reveal lands last. Releasing the in-flight guard on its way out
    // would hand the live reveal's slot away and permit a duplicate OS launch.
    await act(async () => {
      staleReveal.resolve({ ok: true, result: undefined });
      await staleReveal.promise;
    });
    act(() => {
      findButton(container, revealLabel).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dispatchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      liveReveal.resolve({ ok: true, result: undefined });
      await liveReveal.promise;
    });
  });
});

// #11191: HTML files get the same Source/Rendered toggle as Markdown; rendered
// HTML routes to the sandboxed-iframe HtmlViewer.
describe("FilePane HTML Source/Rendered (#11191)", () => {
  function renderPane(filePath: string, fileViewMode?: "source" | "rendered") {
    panelsById["file-1"] = { id: "file-1", kind: "file", filePath, fileViewMode };
    return render(
      <TooltipProvider>
        <FilePane
          id="file-1"
          title={filePath.split("/").pop() ?? filePath}
          isFocused={false}
          location="grid"
          onFocus={() => {}}
          onClose={() => {}}
        />
      </TooltipProvider>
    );
  }

  it("shows the Source/Rendered toggle for an .html file", async () => {
    renderPane("/repo/dist/report.html");
    // SegmentedToggle labels are literal text; both appear only for renderable files.
    expect(await screen.findByText("Rendered")).toBeTruthy();
    expect(screen.getByText("Source")).toBeTruthy();
  });

  it("shows the toggle for a .htm file", async () => {
    renderPane("/repo/dist/page.htm");
    expect(await screen.findByText("Rendered")).toBeTruthy();
  });

  it("does not show the toggle for a non-renderable file (.css)", async () => {
    renderPane("/repo/src/index.css");
    // Wait for load to settle so we're not asserting on a pre-render frame.
    await screen.findByTestId("code-viewer-mock");
    expect(screen.queryByText("Rendered")).toBeNull();
  });

  it("routes rendered HTML to the sandboxed HtmlViewer with the minted preview URL", async () => {
    readMock.mockResolvedValue({
      content: "<h1>x</h1>",
      htmlPreviewUrl: "daintree-html://tok/report.html",
    });
    renderPane("/repo/dist/report.html", "rendered");
    const viewer = await screen.findByTestId("html-viewer-mock");
    // The URL from files:read must reach HtmlViewer's previewUrl prop.
    expect(viewer.getAttribute("data-preview-url")).toBe("daintree-html://tok/report.html");
    expect(screen.queryByTestId("code-viewer-mock")).toBeNull();
  });

  it("routes source HTML to the CodeViewer, not the HtmlViewer", async () => {
    renderPane("/repo/dist/report.html", "source");
    expect(await screen.findByTestId("code-viewer-mock")).toBeTruthy();
    expect(screen.queryByTestId("html-viewer-mock")).toBeNull();
  });

  it("passes htmlPreview:true to files:read for HTML files", async () => {
    renderPane("/repo/dist/report.html", "rendered");
    await waitFor(() =>
      expect(readMock).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/repo/dist/report.html", htmlPreview: true })
      )
    );
  });

  it("passes htmlPreview:false to files:read for non-HTML files", async () => {
    renderPane("/repo/src/index.css");
    await waitFor(() =>
      expect(readMock).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/repo/src/index.css", htmlPreview: false })
      )
    );
  });

  it("still routes rendered Markdown to the MarkdownViewer (regression)", async () => {
    renderPane("/repo/docs/spec.md", "rendered");
    expect(await screen.findByTestId("markdown-viewer-mock")).toBeTruthy();
    expect(screen.queryByTestId("html-viewer-mock")).toBeNull();
  });

  // The toolbar's open button follows the view: rendered HTML opens in the
  // browser, everything else in the editor.
  async function clickOpen(label: string) {
    const button = await screen.findByLabelText(label);
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("opens rendered HTML in the browser, not the editor", async () => {
    renderPane("/repo/dist/report.html", "rendered");
    await clickOpen("Open in browser");
    expect(dispatchMock).toHaveBeenCalledWith(
      "file.openInBrowser",
      { path: "/repo/dist/report.html" },
      { source: "user" }
    );
  });

  it("opens source HTML in the editor", async () => {
    renderPane("/repo/dist/report.html", "source");
    await clickOpen("Open in editor");
    expect(dispatchMock).toHaveBeenCalledWith(
      "file.openInEditor",
      { path: "/repo/dist/report.html" },
      { source: "user" }
    );
  });

  it("retries a failed browser open as a browser open even after the view switches to source", async () => {
    dispatchMock.mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "Launch failed" },
    });
    const { container, rerender } = renderPane("/repo/dist/report.html", "rendered");
    await clickOpen("Open in browser");

    // Flip the live view to source so the toolbar's own open button now targets
    // the editor — the banner's Retry must still fire the browser open it owns,
    // not follow the live target. Same file, so the failure banner survives.
    panelsById["file-1"] = {
      id: "file-1",
      kind: "file",
      filePath: "/repo/dist/report.html",
      fileViewMode: "source",
    };
    await act(async () => {
      rerender(
        <TooltipProvider>
          <FilePane
            id="file-1"
            title="report.html"
            isFocused={false}
            location="grid"
            onFocus={() => {}}
            onClose={() => {}}
          />
        </TooltipProvider>
      );
    });
    // The live open button really did change target away from browser.
    expect(await screen.findByLabelText("Open in editor")).toBeTruthy();

    // Cleared so the assertion can't be satisfied by the original failed open.
    dispatchMock.mockClear();
    const retry = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Retry")
    );
    await act(async () => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(
      "file.openInBrowser",
      { path: "/repo/dist/report.html" },
      { source: "user" }
    );
  });
});

// #11255: a dialog host sizes to its content every frame, so swapping markdown
// source for the rendered chunk's skeleton collapsed the dialog and expanded it
// again once the document landed. FilePane pins the body's height across the
// swap and the rendered document releases it. The pin's own lifecycle is
// covered in useHeightHold.test.tsx; these cover FilePane's wiring — which
// toggles arm a pin, and that the release signal actually reaches it.
describe("FilePane rendered-swap height hold (#11255)", () => {
  const SOURCE_HEIGHT = 640;

  function stubHeight(node: HTMLElement) {
    // jsdom lays nothing out; give the pane the height a real source view would
    // have so the pin has something to measure.
    node.getBoundingClientRect = vi.fn<() => DOMRect>(() => ({
      height: SOURCE_HEIGHT,
      width: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));
  }

  function seedPanel(filePath: string, fileViewMode: "source" | "rendered") {
    panelsById["file-1"] = { id: "file-1", kind: "file", filePath, fileViewMode };
  }

  function paneElement(location: "dialog" | "grid") {
    return (
      <TooltipProvider>
        <FilePane
          id="file-1"
          title="spec.md"
          isFocused={true}
          location={location}
          onFocus={() => {}}
          onClose={() => {}}
        />
      </TooltipProvider>
    );
  }

  async function renderPane(
    filePath: string,
    location: "dialog" | "grid",
    fileViewMode: "source" | "rendered" = "source"
  ) {
    seedPanel(filePath, fileViewMode);
    const view = render(paneElement(location));
    // Let files:read settle so the viewer branch is actually mounted.
    await waitFor(() => expect(readMock).toHaveBeenCalled());
    const body = await screen.findByTestId("file-pane-body");
    stubHeight(body);
    return { ...view, body };
  }

  async function clickToggle(label: string) {
    const button = screen.getByRole("button", { name: label });
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("pins the source height when a dialog switches markdown to rendered", async () => {
    const { body } = await renderPane("/repo/docs/spec.md", "dialog");

    await clickToggle("Rendered");

    expect(body.style.minHeight).toBe(`${SOURCE_HEIGHT}px`);
  });

  it("releases the pin once the rendered document reports its first commit", async () => {
    const { body, rerender } = await renderPane("/repo/docs/spec.md", "dialog");
    await clickToggle("Rendered");
    expect(body.style.minHeight).toBe(`${SOURCE_HEIGHT}px`);

    // The store mock is inert, so drive the mode change the way the real store
    // would and re-render through the same FilePane instance.
    seedPanel("/repo/docs/spec.md", "rendered");
    rerender(paneElement("dialog"));
    // The pin has to survive the swap itself — that is the whole point.
    expect(body.style.minHeight).toBe(`${SOURCE_HEIGHT}px`);

    const onRendered = markdownViewerProps.current?.onRendered;
    expect(onRendered).toBeTypeOf("function");

    vi.useFakeTimers();
    try {
      act(() => onRendered!());
      expect(body.style.minHeight).toBe(`${SOURCE_HEIGHT}px`);
      act(() => void vi.advanceTimersToNextFrame());
      act(() => void vi.advanceTimersToNextFrame());
    } finally {
      vi.useRealTimers();
    }

    expect(body.style.minHeight).toBe("");
  });

  it("drops the pin when the pane reverts to source before the document lands", async () => {
    const { body, rerender } = await renderPane("/repo/docs/spec.md", "dialog");
    await clickToggle("Rendered");
    expect(body.style.minHeight).toBe(`${SOURCE_HEIGHT}px`);

    seedPanel("/repo/docs/spec.md", "rendered");
    rerender(paneElement("dialog"));
    await clickToggle("Source");

    expect(setFileViewModeMock).toHaveBeenLastCalledWith("file-1", "source");
    expect(body.style.minHeight).toBe("");
  });

  it("drops the pin when the pane leaves the dialog for a layout-sized host", async () => {
    const { body, rerender } = await renderPane("/repo/docs/spec.md", "dialog");
    await clickToggle("Rendered");
    expect(body.style.minHeight).toBe(`${SOURCE_HEIGHT}px`);

    rerender(paneElement("grid"));

    expect(body.style.minHeight).toBe("");
  });

  it("leaves a grid panel unpinned — its cell height is layout-owned, not content-driven", async () => {
    const { body } = await renderPane("/repo/docs/spec.md", "grid");

    await clickToggle("Rendered");

    // The toggle still did its job; only the pin is scoped away.
    expect(setFileViewModeMock).toHaveBeenLastCalledWith("file-1", "rendered");
    expect(body.style.minHeight).toBe("");
  });

  it("leaves HTML alone — its preview frame owns its own height", async () => {
    const { body } = await renderPane("/repo/dist/report.html", "dialog");

    await clickToggle("Rendered");

    expect(setFileViewModeMock).toHaveBeenLastCalledWith("file-1", "rendered");
    expect(body.style.minHeight).toBe("");
  });
});

// #11274: a file with local worktree changes gets a third "Diff" option, so the
// user can see what changed without leaving the viewer. Availability is derived
// per file — Rendered and Diff are independent capabilities.
describe("FilePane diff mode (#11274)", () => {
  const WORKTREE_ID = "wt-1";
  const WORKTREE_PATH = "/repo";

  function seedWorktree(changes: Array<{ path: string; status: GitStatus }> | null) {
    const worktree: WorktreeLike = {
      id: WORKTREE_ID,
      path: WORKTREE_PATH,
      worktreeChanges: changes === null ? null : { changes },
    };
    worktreeState.worktrees.set(WORKTREE_ID, worktree);
  }

  function paneElement() {
    return (
      <TooltipProvider>
        <FilePane
          id="file-1"
          title="index.ts"
          isFocused={false}
          location="grid"
          onFocus={() => {}}
          onClose={() => {}}
        />
      </TooltipProvider>
    );
  }

  async function renderPane(options: {
    filePath?: string;
    worktreeId?: string | undefined;
    fileViewMode?: string;
  }) {
    const filePath = options.filePath ?? "/repo/src/index.ts";
    panelsById["file-1"] = {
      id: "file-1",
      kind: "file",
      filePath,
      worktreeId: "worktreeId" in options ? options.worktreeId : WORKTREE_ID,
      fileViewMode: options.fileViewMode,
    };
    const view = render(paneElement());
    // Flush the file read and the lazy diff chunk so no state update lands
    // outside act(). Can't wait on readMock — an image short-circuits before it.
    await act(async () => {});
    return view;
  }

  function toggleLabels(): string[] {
    return screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .filter((label) => label === "Source" || label === "Rendered" || label === "Diff");
  }

  function lastSubject(): DiffSubjectLike | null {
    const call = useDiffContentMock.mock.calls.at(-1);
    if (!call) throw new Error("useDiffContent was never called");
    return call[0];
  }

  describe("capability matrix", () => {
    it("offers no toggle for a plain unchanged file", async () => {
      await renderPane({ filePath: "/repo/src/index.ts" });
      expect(toggleLabels()).toEqual([]);
    });

    it("offers Source and Diff for a changed non-renderable file", async () => {
      seedWorktree([{ path: "/repo/src/index.ts", status: "modified" }]);
      await renderPane({ filePath: "/repo/src/index.ts" });
      expect(toggleLabels()).toEqual(["Source", "Diff"]);
    });

    it("offers Source and Rendered for an unchanged markdown file", async () => {
      await renderPane({ filePath: "/repo/docs/spec.md" });
      expect(toggleLabels()).toEqual(["Source", "Rendered"]);
    });

    it("offers all three, Diff last, for a changed markdown file", async () => {
      seedWorktree([{ path: "/repo/docs/spec.md", status: "modified" }]);
      await renderPane({ filePath: "/repo/docs/spec.md" });
      expect(toggleLabels()).toEqual(["Source", "Rendered", "Diff"]);
    });
  });

  describe("video preview (#11382)", () => {
    // FileVideoPreview fetch()es the bytes and plays a blob object URL —
    // Chromium's custom-scheme media loader can't do follow-up range requests
    // (electron#51442) — so the suite stubs the fetch/object-URL boundary.
    const videoFetchMock = vi.fn();
    beforeEach(() => {
      videoFetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        blob: () => Promise.resolve(new Blob(["x"])),
      });
      vi.stubGlobal("fetch", videoFetchMock);
      URL.createObjectURL = vi.fn(() => "blob:app://daintree/video-preview");
      URL.revokeObjectURL = vi.fn();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      videoFetchMock.mockReset();
    });

    it("renders a <video> for a playable container without reading the file as text", async () => {
      const { container } = await renderPane({ filePath: "/repo/media/demo.mp4" });

      await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
      // The bytes come from the protocol handler via fetch; the text-read IPC
      // path (whose 500 KB cap produced the misleading error) must never run.
      expect(String(videoFetchMock.mock.calls[0]?.[0])).toContain("daintree-file://");
      expect(container.querySelector("video")?.getAttribute("src")).toMatch(/^blob:/);
      expect(readMock).not.toHaveBeenCalled();
    });

    it("shows a format message for a container Chromium can't demux, not the size cap", async () => {
      const { container } = await renderPane({ filePath: "/repo/media/demo.mov" });

      expect(container.querySelector("video")).toBeNull();
      expect(readMock).not.toHaveBeenCalled();
      expect(screen.getByText(/Can't play this video format/)).toBeTruthy();
    });
  });

  describe("audio preview (#11425)", () => {
    // Same fetch-to-blob boundary as video above: audio rides the identical
    // protocol path because electron#51442 covers <audio> too.
    const audioFetchMock = vi.fn();
    // Captured while the describe body runs, before any beforeEach has swapped
    // them — vi.spyOn would hand back the video suite's own unrestored mock,
    // and unstubAllGlobals never restores a directly assigned URL method.
    const realCreateObjectURL = URL.createObjectURL;
    const realRevokeObjectURL = URL.revokeObjectURL;
    beforeEach(() => {
      audioFetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        blob: () => Promise.resolve(new Blob(["x"])),
      });
      vi.stubGlobal("fetch", audioFetchMock);
      URL.createObjectURL = vi.fn(() => "blob:app://daintree/audio-preview");
      URL.revokeObjectURL = vi.fn();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      URL.createObjectURL = realCreateObjectURL;
      URL.revokeObjectURL = realRevokeObjectURL;
      audioFetchMock.mockReset();
    });

    it("renders an <audio> for a playable format without reading the file as text", async () => {
      const { container } = await renderPane({ filePath: "/repo/media/track.mp3" });

      await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
      // The text-read IPC path is what produced "Binary file — cannot display".
      expect(String(audioFetchMock.mock.calls[0]?.[0])).toContain("daintree-file://");
      expect(container.querySelector("audio")?.getAttribute("src")).toMatch(/^blob:/);
      expect(readMock).not.toHaveBeenCalled();
    });

    it("shows a format message for audio Chromium can't decode, not the binary error", async () => {
      const { container } = await renderPane({ filePath: "/repo/media/track.wma" });

      expect(container.querySelector("audio")).toBeNull();
      expect(readMock).not.toHaveBeenCalled();
      expect(screen.getByText(/Can't play this audio format/)).toBeTruthy();
    });

    it("hides Retry for an unsupported audio format, since it can never succeed", async () => {
      await renderPane({ filePath: "/repo/media/track.aiff" });

      expect(screen.getByText(/Can't play this audio format/)).toBeTruthy();
      expect(screen.queryByText("Retry")).toBeNull();
    });

    it("names a decode failure and offers Retry, which reloads the player", async () => {
      const { container } = await renderPane({ filePath: "/repo/media/track.mp3" });
      await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());

      // A playable extension can still hold a codec Chromium lacks; that's a
      // real failure the pane must name rather than leaving a dead control.
      fireEvent.error(container.querySelector("audio")!);

      expect(container.querySelector("audio")).toBeNull();
      expect(screen.getByText(/audio file couldn't be played/i)).toBeTruthy();

      // Unlike an unsupported extension, this one CAN succeed on a retry.
      fireEvent.click(screen.getByText("Retry"));
      await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
      expect(audioFetchMock.mock.calls.length).toBeGreaterThan(1);
    });
  });

  describe("PDF preview (#11427)", () => {
    it("frames the PDF scheme instead of reading the file as text", async () => {
      const { container } = await renderPane({ filePath: "/repo/docs/spec.pdf" });

      const frame = await waitFor(() => {
        const found = container.querySelector("iframe");
        if (!found) throw new Error("no iframe yet");
        return found;
      });
      // The text-read IPC path is what produced "Binary file — cannot display";
      // a PDF must short-circuit before it ever runs.
      expect(readMock).not.toHaveBeenCalled();
      const src = new URL(frame.getAttribute("src") ?? "");
      expect(src.protocol).toBe("daintree-pdf:");
      expect(src.searchParams.get("path")).toBe("/repo/docs/spec.pdf");
    });

    it("mounts the frame credentialless and unsandboxed", async () => {
      const { container } = await renderPane({ filePath: "/repo/docs/spec.pdf" });

      const frame = await waitFor(() => {
        const found = container.querySelector("iframe");
        if (!found) throw new Error("no iframe yet");
        return found;
      });
      expect(frame.hasAttribute("credentialless")).toBe(true);
      expect(frame.hasAttribute("sandbox")).toBe(false);
    });

    it("never shows the binary-file error even when a text read would reject the file", async () => {
      // Arm the read path with the exact rejection PDFs used to hit. If the
      // classifier were removed the file would fall through and surface it, so
      // this fails loudly rather than passing on an empty default read.
      readMock.mockRejectedValueOnce(Object.assign(new Error("binary"), { code: "BINARY_FILE" }));

      const { container } = await renderPane({ filePath: "/repo/docs/spec.pdf" });

      await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
      expect(screen.queryByText(/Binary file/)).toBeNull();
      expect(readMock).not.toHaveBeenCalled();
    });
  });

  describe("change lookup", () => {
    it("matches a change stored as an absolute path", async () => {
      seedWorktree([{ path: "/repo/src/index.ts", status: "modified" }]);
      await renderPane({ filePath: "/repo/src/index.ts" });
      expect(toggleLabels()).toContain("Diff");
    });

    // The type says worktree-relative; the producer emits absolute today.
    // Both shapes must resolve to the same file.
    it("matches the same change stored as a worktree-relative path", async () => {
      seedWorktree([{ path: "src/index.ts", status: "modified" }]);
      await renderPane({ filePath: "/repo/src/index.ts" });
      expect(toggleLabels()).toContain("Diff");
    });

    it("does not match a different file in the same worktree", async () => {
      seedWorktree([{ path: "/repo/src/other.ts", status: "modified" }]);
      await renderPane({ filePath: "/repo/src/index.ts" });
      expect(toggleLabels()).toEqual([]);
    });

    // Whether a file has local changes is a fact about where it lives, not
    // about the panel's binding — which file.openPanel stamps with the *active*
    // worktree even when it resolved the path against a different root.
    it("finds the change through containment when the panel carries no worktree id", async () => {
      seedWorktree([{ path: "/repo/src/index.ts", status: "modified" }]);
      await renderPane({ filePath: "/repo/src/index.ts", worktreeId: undefined });
      expect(toggleLabels()).toContain("Diff");
    });

    it("finds the change when the panel is bound to a different worktree", async () => {
      seedWorktree([{ path: "/repo/src/index.ts", status: "modified" }]);
      worktreeState.worktrees.set("wt-other", {
        id: "wt-other",
        path: "/other",
        worktreeChanges: { changes: [] },
      });
      await renderPane({ filePath: "/repo/src/index.ts", worktreeId: "wt-other" });
      expect(toggleLabels()).toContain("Diff");
    });

    it("offers no Diff for a file inside no known worktree", async () => {
      seedWorktree([{ path: "/repo/src/index.ts", status: "modified" }]);
      await renderPane({ filePath: "/elsewhere/src/index.ts" });
      expect(toggleLabels()).toEqual([]);
    });

    // Deepest root wins, so a file in a nested worktree diffs against that
    // worktree rather than its parent — which may not list it as changed.
    it("prefers the deepest containing worktree", async () => {
      worktreeState.worktrees.set("wt-outer", {
        id: "wt-outer",
        path: "/repo",
        worktreeChanges: { changes: [] },
      });
      worktreeState.worktrees.set("wt-inner", {
        id: "wt-inner",
        path: "/repo/nested",
        worktreeChanges: { changes: [{ path: "src/index.ts", status: "added" }] },
      });
      await renderPane({ filePath: "/repo/nested/src/index.ts", fileViewMode: "diff" });

      expect(lastSubject()).toEqual({
        source: "working-tree",
        worktreePath: "/repo/nested",
        filePath: "src/index.ts",
        status: "added",
      });
    });

    // A sibling root that merely extends the worktree name must not read as
    // "inside" it — the trap `isPathInside` exists to close.
    it("offers no Diff for a file in a sibling directory sharing the root prefix", async () => {
      seedWorktree([{ path: "/repo-other/src/index.ts", status: "modified" }]);
      await renderPane({ filePath: "/repo-other/src/index.ts" });
      expect(toggleLabels()).toEqual([]);
    });

    it("offers no Diff when the worktree reports a null change list", async () => {
      seedWorktree(null);
      await renderPane({ filePath: "/repo/src/index.ts" });
      expect(toggleLabels()).toEqual([]);
    });
  });

  describe("mode clamping", () => {
    it("falls back to source when a persisted diff mode has no local change", async () => {
      await renderPane({ filePath: "/repo/src/index.ts", fileViewMode: "diff" });
      expect(await screen.findByTestId("code-viewer-mock")).toBeTruthy();
      expect(screen.queryByTestId("diff-viewer-mock")).toBeNull();
    });

    it("falls back to source when a persisted rendered mode has no renderable file", async () => {
      await renderPane({ filePath: "/repo/src/index.ts", fileViewMode: "rendered" });
      expect(await screen.findByTestId("code-viewer-mock")).toBeTruthy();
    });

    // The two capabilities must not authorize each other: a renderable file is
    // not thereby diffable, and a changed file is not thereby renderable.
    it("falls back to source for a persisted diff mode on an unchanged markdown file", async () => {
      await renderPane({ filePath: "/repo/docs/spec.md", fileViewMode: "diff" });
      expect(screen.queryByTestId("diff-viewer-mock")).toBeNull();
      expect(lastSubject()).toBeNull();
    });

    it("falls back to source for a persisted rendered mode on a changed non-renderable file", async () => {
      seedWorktree([{ path: "/repo/src/index.ts", status: "modified" }]);
      await renderPane({ filePath: "/repo/src/index.ts", fileViewMode: "rendered" });
      expect(await screen.findByTestId("code-viewer-mock")).toBeTruthy();
      expect(screen.queryByTestId("markdown-viewer-mock")).toBeNull();
    });

    // The clamp is derived, not written back: a poll that transiently drops the
    // change must not erase the mode the user picked.
    it("never writes the fallback back to panel state", async () => {
      await renderPane({ filePath: "/repo/src/index.ts", fileViewMode: "diff" });
      expect(setFileViewModeMock).not.toHaveBeenCalled();
    });

    it("honours a persisted diff mode once the file is locally changed", async () => {
      seedWorktree([{ path: "/repo/src/index.ts", status: "modified" }]);
      useDiffContentMock.mockReturnValue({
        content: "@@ -1 +1 @@",
        stale: false,
        retry: vi.fn(),
      });
      await renderPane({ filePath: "/repo/src/index.ts", fileViewMode: "diff" });
      expect(await screen.findByTestId("diff-viewer-mock")).toBeTruthy();
    });
  });

  // Every other diff test seeds the mode directly, so a toggle that never
  // dispatched "diff" would leave them all green.
  describe("selecting the option", () => {
    it("asks the store for diff mode when the Diff segment is clicked", async () => {
      seedWorktree([{ path: "/repo/src/index.ts", status: "modified" }]);
      await renderPane({ filePath: "/repo/src/index.ts" });

      await act(async () => {
        screen
          .getByRole("button", { name: "Diff" })
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(setFileViewModeMock).toHaveBeenLastCalledWith("file-1", "diff");
    });
  });

  // Leaving diff lands on source cached before the edit that prompted it.
  describe("returning to source", () => {
    it("re-reads the file when the mode leaves diff", async () => {
      seedWorktree([{ path: "/repo/src/index.ts", status: "modified" }]);
      useDiffContentMock.mockReturnValue({ content: "@@ -1 +1 @@", stale: false, retry: vi.fn() });
      const { rerender } = await renderPane({
        filePath: "/repo/src/index.ts",
        fileViewMode: "diff",
      });
      const readCallsBefore = readMock.mock.calls.length;

      panelsById["file-1"] = {
        id: "file-1",
        kind: "file",
        filePath: "/repo/src/index.ts",
        worktreeId: WORKTREE_ID,
        fileViewMode: "source",
      };
      await act(async () => {
        rerender(paneElement());
      });

      expect(readMock.mock.calls.length).toBeGreaterThan(readCallsBefore);
    });
  });

  describe("diff subject", () => {
    it("passes the worktree-relative path and the exact stored status", async () => {
      seedWorktree([{ path: "/repo/src/index.ts", status: "added" }]);
      await renderPane({ filePath: "/repo/src/index.ts", fileViewMode: "diff" });

      expect(lastSubject()).toEqual({
        source: "working-tree",
        worktreePath: WORKTREE_PATH,
        filePath: "src/index.ts",
        status: "added",
      });
    });

    it("passes no subject while Source is the live mode", async () => {
      seedWorktree([{ path: "/repo/src/index.ts", status: "modified" }]);
      await renderPane({ filePath: "/repo/src/index.ts", fileViewMode: "source" });
      expect(lastSubject()).toBeNull();
    });
  });

  // The viewer joins its rootPath with the diff's worktree-relative paths to
  // build the open-in-editor target, so the root has to be the very worktree the
  // diff was fetched against — never the one the panel happens to be stamped
  // with, which containment resolution exists precisely to override.
  describe("diff viewer root", () => {
    function viewerRoot(): string | null {
      return screen.getByTestId("diff-viewer-mock").getAttribute("data-root");
    }

    async function renderDiff(options: { filePath: string; worktreeId?: string | undefined }) {
      useDiffContentMock.mockReturnValue({ content: "@@ -1 +1 @@", stale: false, retry: vi.fn() });
      await renderPane({ ...options, fileViewMode: "diff" });
      expect(await screen.findByTestId("diff-viewer-mock")).toBeTruthy();
    }

    it("roots the viewer at the resolved worktree, not the panel's stamped one", async () => {
      // Panel is stamped with the outer worktree; the file lives in the nested
      // one, so the relative paths in the diff are relative to the nested root.
      worktreeState.worktrees.set(WORKTREE_ID, {
        id: WORKTREE_ID,
        path: WORKTREE_PATH,
        worktreeChanges: { changes: [] },
      });
      worktreeState.worktrees.set("wt-inner", {
        id: "wt-inner",
        path: "/repo/nested",
        worktreeChanges: { changes: [{ path: "src/index.ts", status: "modified" }] },
      });

      await renderDiff({ filePath: "/repo/nested/src/index.ts" });

      expect(viewerRoot()).toBe(lastSubject()?.worktreePath);
      expect(viewerRoot()).not.toBe(WORKTREE_PATH);
    });

    it("roots the viewer by containment when the panel carries no worktree id", async () => {
      seedWorktree([{ path: "/repo/src/index.ts", status: "modified" }]);

      await renderDiff({ filePath: "/repo/src/index.ts", worktreeId: undefined });

      // Without containment this would be the empty string, leaving the viewer
      // to join a bare relative path.
      expect(viewerRoot()).toBe(lastSubject()?.worktreePath);
      expect(viewerRoot()).toBeTruthy();
    });
  });

  // The diff branch deliberately precedes every load-state branch: these files
  // can never satisfy the source reader, yet their diff is the whole point.
  describe("rendering ahead of the source read", () => {
    it("renders the diff for a deleted file whose source read fails", async () => {
      readMock.mockRejectedValue(
        Object.assign(new Error("gone"), { code: "NOT_FOUND", isClientAppError: true })
      );
      seedWorktree([{ path: "/repo/src/index.ts", status: "deleted" }]);
      useDiffContentMock.mockReturnValue({
        content: "@@ -1 +0,0 @@",
        stale: false,
        retry: vi.fn(),
      });
      await renderPane({ filePath: "/repo/src/index.ts", fileViewMode: "diff" });

      expect(await screen.findByTestId("diff-viewer-mock")).toBeTruthy();
      // Exclusivity, not just presence: the read error must not render beside it.
      expect(screen.queryByText(FILE_READ_ERROR_MESSAGES.NOT_FOUND)).toBeNull();
    });

    it("renders the diff for an image rather than its preview", async () => {
      seedWorktree([{ path: "/repo/assets/logo.png", status: "modified" }]);
      useDiffContentMock.mockReturnValue({
        content: "Binary files differ",
        stale: false,
        retry: vi.fn(),
      });
      const { container } = await renderPane({
        filePath: "/repo/assets/logo.png",
        fileViewMode: "diff",
      });

      expect(await screen.findByTestId("diff-viewer-mock")).toBeTruthy();
      expect(container.querySelector("img")).toBeNull();
    });
  });

  describe("toolbar wiring", () => {
    it("routes Refresh to the diff retry while Diff is live", async () => {
      const retry = vi.fn();
      seedWorktree([{ path: "/repo/src/index.ts", status: "modified" }]);
      useDiffContentMock.mockReturnValue({ content: "@@ -1 +1 @@", stale: false, retry });
      await renderPane({ filePath: "/repo/src/index.ts", fileViewMode: "diff" });
      const readCallsBefore = readMock.mock.calls.length;

      await act(async () => {
        screen
          .getByRole("button", { name: "Refresh" })
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(retry).toHaveBeenCalled();
      // Re-reading the file would not refetch the diff.
      expect(readMock.mock.calls.length).toBe(readCallsBefore);
    });

    it("routes Refresh to the file read while Source is live", async () => {
      const retry = vi.fn();
      seedWorktree([{ path: "/repo/src/index.ts", status: "modified" }]);
      useDiffContentMock.mockReturnValue({ content: undefined, stale: false, retry });
      await renderPane({ filePath: "/repo/src/index.ts", fileViewMode: "source" });
      const readCallsBefore = readMock.mock.calls.length;

      await act(async () => {
        screen
          .getByRole("button", { name: "Refresh" })
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(retry).not.toHaveBeenCalled();
      expect(readMock.mock.calls.length).toBeGreaterThan(readCallsBefore);
    });

    it("surfaces a staleness banner with a refresh action once the file moves under the diff", async () => {
      const retry = vi.fn();
      seedWorktree([{ path: "/repo/src/index.ts", status: "modified" }]);
      useDiffContentMock.mockReturnValue({ content: "@@ -1 +1 @@", stale: true, retry });
      await renderPane({ filePath: "/repo/src/index.ts", fileViewMode: "diff" });

      // By text, not role="status" — the loading skeleton carries that role too.
      expect(await screen.findByText("File changed since this diff loaded")).toBeTruthy();

      // The banner is only useful if its recovery actually refetches.
      await act(async () => {
        screen
          .getAllByRole("button", { name: "Refresh" })
          .at(-1)
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(retry).toHaveBeenCalled();
    });

    it("shows no staleness banner while the diff is still loading", async () => {
      seedWorktree([{ path: "/repo/src/index.ts", status: "modified" }]);
      useDiffContentMock.mockReturnValue({ content: undefined, stale: true, retry: vi.fn() });
      await renderPane({ filePath: "/repo/src/index.ts", fileViewMode: "diff" });

      expect(screen.queryByText("File changed since this diff loaded")).toBeNull();
    });
  });
});

describe("FilePane toolbar refresh spin (#11323)", () => {
  function deferredValue<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  function paneForRefresh() {
    return (
      <TooltipProvider>
        <FilePane
          id="file-1"
          title="index.ts"
          isFocused={false}
          location="grid"
          onFocus={() => {}}
          onClose={() => {}}
        />
      </TooltipProvider>
    );
  }

  function renderFilePane() {
    panelsById["file-1"] = { id: "file-1", kind: "file", filePath: "/repo/src/index.ts" };
    return render(paneForRefresh());
  }

  function refreshIcon(container: HTMLElement): SVGSVGElement {
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Refresh"
    );
    if (!button) throw new Error("Refresh button not rendered");
    const svg = button.querySelector("svg");
    if (!svg) throw new Error("Refresh icon not rendered");
    return svg;
  }

  it("spins while a source refresh is in flight, then finishes the rotation once it settles", async () => {
    readMock.mockReset();
    readMock.mockResolvedValueOnce({ content: "v1" });
    const { container } = renderFilePane();

    // Initial load settles with no refresh in progress — the icon is still.
    await waitFor(() =>
      expect(refreshIcon(container).classList.contains("animate-spin")).toBe(false)
    );

    // The refresh read is held open so the operation is observably "running".
    const pending = deferredValue<{ content: string }>();
    readMock.mockReturnValueOnce(pending.promise);
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((b) => b.getAttribute("aria-label") === "Refresh")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(refreshIcon(container).classList.contains("animate-spin")).toBe(true);

    // The read settles: the spin request is released, but the class must remain
    // until the rotation boundary rather than snapping back mid-turn.
    await act(async () => {
      pending.resolve({ content: "v2" });
    });
    expect(refreshIcon(container).classList.contains("animate-spin")).toBe(true);

    // The rotation completes → the icon stops at 0°.
    act(() => {
      refreshIcon(container).dispatchEvent(new Event("animationiteration", { bubbles: true }));
    });
    expect(refreshIcon(container).classList.contains("animate-spin")).toBe(false);
  });

  it("does not strand the spin when a diff refresh is abandoned before it resolves (#11323)", async () => {
    // A modified file so Diff mode is available; the diff never resolves
    // (content stays undefined), the exact shape that stranded the old predicate.
    worktreeState.worktrees.set("wt-1", {
      id: "wt-1",
      path: "/repo",
      worktreeChanges: { changes: [{ path: "/repo/src/index.ts", status: "modified" }] },
    });
    useDiffContentMock.mockReturnValue({ content: undefined, stale: false, retry: vi.fn() });
    readMock.mockReset();
    readMock.mockResolvedValue({ content: "v1" });
    panelsById["file-1"] = {
      id: "file-1",
      kind: "file",
      filePath: "/repo/src/index.ts",
      worktreeId: "wt-1",
      fileViewMode: "diff",
    };
    const { container, rerender } = render(paneForRefresh());
    await act(async () => {});

    // Refresh while the diff is still loading → the icon spins.
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((b) => b.getAttribute("aria-label") === "Refresh")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(refreshIcon(container).classList.contains("animate-spin")).toBe(true);

    // Abandon the diff by switching to Source before it ever resolves. The old
    // `diffContent !== undefined` predicate would wait forever; the spin must
    // release instead of being stranded.
    panelsById["file-1"] = {
      id: "file-1",
      kind: "file",
      filePath: "/repo/src/index.ts",
      worktreeId: "wt-1",
      fileViewMode: "source",
    };
    rerender(paneForRefresh());
    await act(async () => {});

    act(() => {
      refreshIcon(container).dispatchEvent(new Event("animationiteration", { bubbles: true }));
    });
    expect(refreshIcon(container).classList.contains("animate-spin")).toBe(false);
  });
});

// #11451: the pane had no live signal at all. Text only re-read on focus
// regain — never while the pane stayed focused, which is exactly when an agent
// is rewriting the file — and images, whose URL is a pure function of path and
// root, never re-read even on an explicit Refresh.
describe("FilePane live disk refresh (#11451)", () => {
  const OUTER_ID = "wt-outer";
  const INNER_ID = "wt-inner";

  function seedWorktree(id: string, path: string, ticks: { git?: number; fs?: number } = {}): void {
    const seeded: WorktreeLike = {
      id,
      path,
      worktreeChanges: ticks.git === undefined ? null : { changes: [], lastUpdated: ticks.git },
    };
    worktreeState.worktrees.set(id, seeded);
    if (ticks.fs !== undefined) worktreeState.workingTreeChangedAtById.set(id, ticks.fs);
  }

  function paneElement(isFocused = false) {
    return (
      <TooltipProvider>
        <FilePane
          id="file-1"
          title="index.ts"
          isFocused={isFocused}
          location="grid"
          onFocus={() => {}}
          onClose={() => {}}
        />
      </TooltipProvider>
    );
  }

  async function renderPane(options: {
    filePath?: string;
    worktreeId?: string;
    fileViewMode?: string;
    isFocused?: boolean;
  }) {
    panelsById["file-1"] = {
      id: "file-1",
      kind: "file",
      filePath: options.filePath ?? "/repo/src/index.ts",
      worktreeId: options.worktreeId ?? OUTER_ID,
      fileViewMode: options.fileViewMode,
    };
    const view = render(paneElement(options.isFocused));
    // Can't wait on readMock — image and media paths short-circuit before it.
    await act(async () => {});
    return view;
  }

  /** The mocked store is a plain object, so a tick only lands on re-render. */
  async function commitTick(rerender: (ui: ReactNode) => void, isFocused = false) {
    await act(async () => {
      rerender(paneElement(isFocused));
    });
  }

  function imageSrc(container: HTMLElement): string {
    const src = container.querySelector("img")?.getAttribute("src");
    if (!src) throw new Error("image preview not rendered");
    return src;
  }

  function loadingSkeleton(container: HTMLElement): Element | null {
    return container.querySelector('[role="status"][aria-label="Loading file"]');
  }

  function viewerContent(container: HTMLElement): string | null {
    return (
      container.querySelector('[data-testid="code-viewer-mock"]')?.getAttribute("data-content") ??
      null
    );
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it("re-reads the file when the containing worktree's git-status tick moves", async () => {
    seedWorktree(OUTER_ID, "/repo", { git: 100 });
    readMock.mockResolvedValue({ content: "v1" });
    const { rerender } = await renderPane({});
    const initialReads = readMock.mock.calls.length;

    seedWorktree(OUTER_ID, "/repo", { git: 200 });
    await commitTick(rerender);

    expect(readMock.mock.calls.length).toBe(initialReads + 1);
  });

  it("re-reads the file when only the raw filesystem-write tick moves", async () => {
    // A write into a gitignored folder never moves git status, so the git tick
    // alone would leave the pane stale — the reason both signals are combined.
    seedWorktree(OUTER_ID, "/repo", { fs: 100 });
    readMock.mockResolvedValue({ content: "v1" });
    const { rerender } = await renderPane({});
    const initialReads = readMock.mock.calls.length;

    seedWorktree(OUTER_ID, "/repo", { fs: 200 });
    await commitTick(rerender);

    expect(readMock.mock.calls.length).toBe(initialReads + 1);
  });

  it("takes its tick from the deepest worktree containing the file, not the panel's", async () => {
    // `file.openPanel` stamps the *active* worktree id even when the file lives
    // in another one, so trusting `panel.worktreeId` would watch the wrong tree.
    seedWorktree(OUTER_ID, "/repo", { git: 100 });
    seedWorktree(INNER_ID, "/repo/packages/app", { git: 100 });
    readMock.mockResolvedValue({ content: "v1" });
    const { rerender } = await renderPane({
      filePath: "/repo/packages/app/src/index.ts",
      worktreeId: OUTER_ID,
    });
    const initialReads = readMock.mock.calls.length;

    // The panel's own worktree moving is not this file's business.
    seedWorktree(OUTER_ID, "/repo", { git: 200 });
    await commitTick(rerender);
    expect(readMock.mock.calls.length).toBe(initialReads);

    seedWorktree(INNER_ID, "/repo/packages/app", { git: 200 });
    await commitTick(rerender);
    expect(readMock.mock.calls.length).toBe(initialReads + 1);
  });

  it("stays quiet for a file outside every known worktree", async () => {
    // No watcher covers it, so there is no tick to resolve — it must degrade to
    // no live signal rather than reading on every unrelated worktree update.
    seedWorktree(OUTER_ID, "/repo", { git: 100 });
    readMock.mockResolvedValue({ content: "v1" });
    const { rerender } = await renderPane({ filePath: "/elsewhere/notes.txt" });
    // The pane does read it once — the baseline is a real read, so the
    // assertion below can't pass merely because nothing ever happened.
    expect(readMock).toHaveBeenCalled();
    readMock.mockClear();

    seedWorktree(OUTER_ID, "/repo", { git: 200, fs: 300 });
    await commitTick(rerender);

    expect(readMock).not.toHaveBeenCalled();
  });

  it("re-reads once, not twice, when a tick lands together with leaving Diff", async () => {
    // The tick effect and the leave-Diff effect both fire on that commit; the
    // tick side defers so the file is read once rather than twice.
    worktreeState.worktrees.set(OUTER_ID, {
      id: OUTER_ID,
      path: "/repo",
      worktreeChanges: {
        changes: [{ path: "/repo/src/index.ts", status: "modified" }],
        lastUpdated: 100,
      },
    });
    useDiffContentMock.mockReturnValue({ content: "diff", stale: false, retry: vi.fn() });
    readMock.mockResolvedValue({ content: "v1" });
    const { rerender } = await renderPane({ fileViewMode: "diff" });
    readMock.mockClear();

    // Tick and mode change land in the same commit.
    worktreeState.worktrees.set(OUTER_ID, {
      id: OUTER_ID,
      path: "/repo",
      worktreeChanges: {
        changes: [{ path: "/repo/src/index.ts", status: "modified" }],
        lastUpdated: 200,
      },
    });
    panelsById["file-1"] = {
      id: "file-1",
      kind: "file",
      filePath: "/repo/src/index.ts",
      worktreeId: OUTER_ID,
      fileViewMode: "source",
    };
    await commitTick(rerender);

    expect(readMock.mock.calls.length).toBe(1);
  });

  it("re-reads when a nearer worktree takes over watching an already-open file", async () => {
    // Both ticks are 100 throughout, so only the change of *which* worktree is
    // watched can trigger this. Nothing was watching /repo/packages/app before,
    // making whatever happened there invisible — and because the pane still
    // reads against /repo, its read identity never moves and no explicit load
    // covers the handover.
    seedWorktree(OUTER_ID, "/repo", { git: 100 });
    readMock.mockResolvedValue({ content: "v1" });
    const { rerender } = await renderPane({
      filePath: "/repo/packages/app/src/index.ts",
      worktreeId: OUTER_ID,
    });
    readMock.mockClear();

    seedWorktree(INNER_ID, "/repo/packages/app", { git: 100 });
    await commitTick(rerender);

    expect(readMock).toHaveBeenCalled();
  });

  it("keeps the current viewer on screen while a tick's re-read is in flight", async () => {
    // The whole point of a background re-read: no skeleton swap, so the reader
    // keeps their content and scroll position while the new bytes land.
    seedWorktree(OUTER_ID, "/repo", { git: 100 });
    readMock.mockResolvedValue({ content: "v1" });
    const { container, rerender } = await renderPane({});
    const viewerBefore = container.querySelector('[data-testid="code-viewer-mock"]');
    expect(viewerBefore).not.toBeNull();

    let resolveRead!: (value: { content: string }) => void;
    readMock.mockReturnValueOnce(
      new Promise<{ content: string }>((resolve) => {
        resolveRead = resolve;
      })
    );
    seedWorktree(OUTER_ID, "/repo", { git: 200 });
    await commitTick(rerender);

    expect(loadingSkeleton(container)).toBeNull();
    // Same node, not merely an equivalent one — a remount would reset scroll.
    expect(container.querySelector('[data-testid="code-viewer-mock"]')).toBe(viewerBefore);

    await act(async () => {
      resolveRead({ content: "v2" });
    });
  });

  it("re-requests a raster image on a worktree tick", async () => {
    seedWorktree(OUTER_ID, "/repo", { git: 100 });
    const { container, rerender } = await renderPane({ filePath: "/repo/assets/logo.png" });
    const before = imageSrc(container);

    seedWorktree(OUTER_ID, "/repo", { git: 200 });
    await commitTick(rerender);

    // The URL must actually change: identical `src` lets Chromium skip the
    // fetch entirely, which is why `Cache-Control: no-store` alone never helped.
    expect(imageSrc(container)).not.toBe(before);
    expect(readMock).not.toHaveBeenCalled();
  });

  it("re-requests a raster image on toolbar Refresh", async () => {
    // The headline symptom: the icon spun and the image never reloaded.
    seedWorktree(OUTER_ID, "/repo", { git: 100 });
    const { container } = await renderPane({ filePath: "/repo/assets/logo.png" });
    const before = imageSrc(container);

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((b) => b.getAttribute("aria-label") === "Refresh")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(imageSrc(container)).not.toBe(before);
  });

  it("re-requests a raster image when the pane regains focus", async () => {
    // Both focus effects gated on "loaded", which no image ever reaches.
    seedWorktree(OUTER_ID, "/repo", { git: 100 });
    const { container, rerender } = await renderPane({
      filePath: "/repo/assets/logo.png",
      isFocused: false,
    });
    const before = imageSrc(container);

    await commitTick(rerender, true);

    expect(imageSrc(container)).not.toBe(before);
  });

  it("re-reads and re-sanitizes an SVG on a worktree tick", async () => {
    seedWorktree(OUTER_ID, "/repo", { git: 100 });
    readMock.mockResolvedValue({
      content: '<svg xmlns="http://www.w3.org/2000/svg"><rect /></svg>',
    });
    const { container, rerender } = await renderPane({ filePath: "/repo/assets/icon.svg" });
    await waitFor(() => expect(container.querySelector("svg rect")).not.toBeNull());

    readMock.mockResolvedValue({
      content: '<svg xmlns="http://www.w3.org/2000/svg"><circle /></svg>',
    });
    seedWorktree(OUTER_ID, "/repo", { git: 200 });
    await commitTick(rerender);

    // Inlined markup, so freshness rides React state rather than a URL.
    await waitFor(() => expect(container.querySelector("svg circle")).not.toBeNull());
    expect(container.querySelector("svg rect")).toBeNull();
  });

  it("keeps the last good SVG when a background re-read catches it half-written", async () => {
    // A tick can land mid-save, and truncated markup reads as a sanitizer
    // rejection. Replacing a good drawing with an error over that would be the
    // same mistake the text path's transient-failure guard already avoids.
    seedWorktree(OUTER_ID, "/repo", { git: 100 });
    readMock.mockResolvedValue({
      content: '<svg xmlns="http://www.w3.org/2000/svg"><rect /></svg>',
    });
    const { container, rerender } = await renderPane({ filePath: "/repo/assets/icon.svg" });
    await waitFor(() => expect(container.querySelector("svg rect")).not.toBeNull());

    readMock.mockResolvedValue({ content: "<svg" });
    seedWorktree(OUTER_ID, "/repo", { git: 200 });
    await commitTick(rerender);

    expect(container.querySelector("svg rect")).not.toBeNull();
  });

  it("settles the pane when a failing tick read supersedes an explicit refresh", async () => {
    // Refresh shows the skeleton, then a tick's silent read supersedes it and
    // fails transiently. Swallowing that failure outright would leave nothing
    // to settle the pane: the explicit read is already stale, so the skeleton
    // and the toolbar spin would stay up forever.
    seedWorktree(OUTER_ID, "/repo", { git: 100 });
    readMock.mockResolvedValue({ content: "v1" });
    const { container, rerender } = await renderPane({});

    const explicit = deferred<{ content: string }>();
    readMock.mockReturnValueOnce(explicit.promise);
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((b) => b.getAttribute("aria-label") === "Refresh")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(loadingSkeleton(container)).not.toBeNull();

    // The tick's read supersedes the explicit one, then fails transiently.
    readMock.mockRejectedValueOnce(new Error("EBUSY"));
    seedWorktree(OUTER_ID, "/repo", { git: 200 });
    await commitTick(rerender);
    await act(async () => {
      explicit.resolve({ content: "v1" });
    });

    expect(loadingSkeleton(container)).toBeNull();
    expect(viewerContent(container)).toBe("v1");
  });

  it("surfaces unusable SVG markup on the first read rather than hanging", async () => {
    // Nothing good is on screen yet, so there is nothing to preserve — the
    // failure has to settle the pane instead of leaving it mid-load.
    readMock.mockResolvedValue({ content: "<svg" });
    const { container } = await renderPane({ filePath: "/repo/assets/icon.svg" });

    // Settled into the error surface — not still sitting on the skeleton.
    await waitFor(() => expect(screen.getByText("Retry")).toBeTruthy());
    expect(loadingSkeleton(container)).toBeNull();
  });

  it("re-reads an SVG when the app window regains the foreground", async () => {
    // A separate listener from the pane-focus one, and the only automatic
    // signal a file outside every worktree ever gets — no tick can reach it.
    readMock.mockResolvedValue({
      content: '<svg xmlns="http://www.w3.org/2000/svg"><rect /></svg>',
    });
    const { container } = await renderPane({ filePath: "/elsewhere/icon.svg" });
    await waitFor(() => expect(container.querySelector("svg rect")).not.toBeNull());

    readMock.mockResolvedValue({
      content: '<svg xmlns="http://www.w3.org/2000/svg"><circle /></svg>',
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(container.querySelector("svg circle")).not.toBeNull());
  });

  it("keeps the newest bytes when two overlapping re-reads settle out of order", async () => {
    // Ticks can now start a read while another is still in flight, so the
    // latest-request-wins guard is reachable for the first time: a slow earlier
    // read must not overwrite a newer one that already landed.
    seedWorktree(OUTER_ID, "/repo", { git: 100 });
    readMock.mockResolvedValue({ content: "v1" });
    const { container, rerender } = await renderPane({});

    const first = deferred<{ content: string }>();
    const second = deferred<{ content: string }>();
    readMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    seedWorktree(OUTER_ID, "/repo", { git: 200 });
    await commitTick(rerender);
    seedWorktree(OUTER_ID, "/repo", { git: 300 });
    await commitTick(rerender);

    // Newer read lands first, then the stale one tries to overwrite it.
    await act(async () => {
      second.resolve({ content: "newest" });
    });
    await act(async () => {
      first.resolve({ content: "stale" });
    });

    expect(viewerContent(container)).toBe("newest");
  });

  it("leaves the hidden source alone while Diff owns the surface", async () => {
    // useDiffContent subscribes to the same store and raises its own stale
    // banner; re-reading source nobody can see would just duplicate the work.
    worktreeState.worktrees.set(OUTER_ID, {
      id: OUTER_ID,
      path: "/repo",
      worktreeChanges: {
        changes: [{ path: "/repo/src/index.ts", status: "modified" }],
        lastUpdated: 100,
      },
    } satisfies WorktreeLike);
    useDiffContentMock.mockReturnValue({ content: "diff", stale: false, retry: vi.fn() });
    readMock.mockResolvedValue({ content: "v1" });
    const { rerender } = await renderPane({ fileViewMode: "diff" });
    const initialReads = readMock.mock.calls.length;

    worktreeState.worktrees.set(OUTER_ID, {
      id: OUTER_ID,
      path: "/repo",
      worktreeChanges: {
        changes: [{ path: "/repo/src/index.ts", status: "modified" }],
        lastUpdated: 200,
      },
    } satisfies WorktreeLike);
    await commitTick(rerender);

    expect(readMock.mock.calls.length).toBe(initialReads);
  });

  describe("media keeps playing across a tick", () => {
    // Same fetch-to-blob boundary the video/audio suites above stub: Chromium's
    // custom-scheme media loader can't do follow-up range requests. Typed so
    // reading .mock.calls needs no cast (which would regress the lint ratchet).
    const mediaFetchMock =
      vi.fn<
        (
          input: string | URL | Request
        ) => Promise<Pick<Response, "ok" | "status" | "headers" | "blob">>
      >();
    const realCreateObjectURL = URL.createObjectURL;
    const realRevokeObjectURL = URL.revokeObjectURL;
    beforeEach(() => {
      mediaFetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        blob: () => Promise.resolve(new Blob(["x"])),
      });
      vi.stubGlobal("fetch", mediaFetchMock);
      URL.createObjectURL = vi.fn(() => "blob:app://daintree/media-preview");
      URL.revokeObjectURL = vi.fn();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      mediaFetchMock.mockReset();
      URL.createObjectURL = realCreateObjectURL;
      URL.revokeObjectURL = realRevokeObjectURL;
    });

    it("keeps the same <video> element rather than refetching", async () => {
      // A worktree-wide tick fires on any write; remounting here would restart
      // playback every time an agent touched an unrelated file.
      seedWorktree(OUTER_ID, "/repo", { git: 100 });
      const { container, rerender } = await renderPane({ filePath: "/repo/media/demo.mp4" });
      await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
      const playerBefore = container.querySelector("video");
      const fetchesBefore = mediaFetchMock.mock.calls.length;

      seedWorktree(OUTER_ID, "/repo", { git: 200, fs: 300 });
      await commitTick(rerender);

      expect(container.querySelector("video")).toBe(playerBefore);
      expect(mediaFetchMock.mock.calls.length).toBe(fetchesBefore);
    });

    it("keeps the same <audio> element rather than refetching", async () => {
      // Its own nonce condition, separate from video's — a regression in one
      // leaves the other's test green while restarting the track being played.
      seedWorktree(OUTER_ID, "/repo", { git: 100 });
      const { container, rerender } = await renderPane({ filePath: "/repo/media/track.mp3" });
      await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
      const playerBefore = container.querySelector("audio");
      const fetchesBefore = mediaFetchMock.mock.calls.length;

      seedWorktree(OUTER_ID, "/repo", { git: 200, fs: 300 });
      await commitTick(rerender);

      expect(container.querySelector("audio")).toBe(playerBefore);
      expect(mediaFetchMock.mock.calls.length).toBe(fetchesBefore);
    });

    it("keeps the same PDF frame and URL rather than re-navigating", async () => {
      // Reloading the frame would throw away the reader's page and zoom.
      seedWorktree(OUTER_ID, "/repo", { git: 100 });
      const { container, rerender } = await renderPane({ filePath: "/repo/docs/spec.pdf" });
      await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
      const frameBefore = container.querySelector("iframe");
      const srcBefore = frameBefore?.getAttribute("src");

      seedWorktree(OUTER_ID, "/repo", { git: 200, fs: 300 });
      await commitTick(rerender);

      expect(container.querySelector("iframe")).toBe(frameBefore);
      expect(container.querySelector("iframe")?.getAttribute("src")).toBe(srcBefore);
    });
  });
});
