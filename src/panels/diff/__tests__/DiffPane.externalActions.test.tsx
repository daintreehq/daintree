// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, render, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitStatus } from "@shared/types/git";
import type { ActionDispatchResult } from "@shared/types/actions";

// The sibling DiffPane.test.tsx stubs `toolbar` away on purpose. These tests are
// the opposite: the toolbar IS the subject, so ContentPanel renders it and the
// body is dropped instead. Radix stays mocked out either way.
vi.mock("@/components/Panel/ContentPanel", () => ({
  ContentPanel: (props: { toolbar?: ReactNode }) => <>{props.toolbar}</>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/Worktree/DiffViewer", () => ({
  DiffViewer: () => null,
}));
vi.mock("@/components/FileViewer/ImageDiffViewer", () => ({
  ImageDiffViewer: () => null,
  isImageDiffCandidate: () => false,
}));
vi.mock("@/components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("@/components/FileViewer/DiffFileSidebar", () => ({ DiffFileSidebar: () => null }));

const { dispatchMock, isMacMock, isWindowsMock, logErrorMock, useDiffContentMock } = vi.hoisted(
  () => ({
    dispatchMock:
      vi.fn<(id: string, args: unknown, opts: unknown) => Promise<ActionDispatchResult<unknown>>>(),
    isMacMock: vi.fn<() => boolean>(),
    isWindowsMock: vi.fn<() => boolean>(),
    logErrorMock: vi.fn(),
    useDiffContentMock: vi.fn(),
  })
);

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));
vi.mock("@/lib/platform", () => ({
  isMac: isMacMock,
  isWindows: isWindowsMock,
  isLinux: () => false,
}));
vi.mock("@/utils/logger", () => ({ logError: logErrorMock }));
vi.mock("../useDiffContent", () => ({ useDiffContent: useDiffContentMock }));

const panelsById: Record<string, unknown> = {};
vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (state: unknown) => unknown) =>
    selector({ panelsById, setDiffPanelFile: vi.fn() }),
}));

const worktrees = new Map<string, { path: string; branch: string }>();
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: unknown) => unknown) => selector({ worktrees }),
}));

vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector: (state: unknown) => unknown) =>
    selector({
      diffViewType: "unified",
      setDiffViewType: vi.fn(),
      diffWrapLines: false,
      setDiffWrapLines: vi.fn(),
      diffShowFileList: false,
      setDiffShowFileList: vi.fn(),
      diffFontSize: "m",
    }),
}));

vi.mock("@/store/diffViewedStore", () => ({
  useDiffViewedStore: (selector: (state: unknown) => unknown) =>
    selector({ toggleViewed: vi.fn() }),
  selectViewedSet: () => new Set<string>(),
}));

import { DiffPane } from "../DiffPane";

const PANEL_ID = "diff-1";
const WORKTREE_ID = "wt-1";
const WORKTREE_ROOT = "/repo";

function ok(): ActionDispatchResult<unknown> {
  return { ok: true, result: undefined };
}

function fail(message: string): ActionDispatchResult<unknown> {
  return { ok: false, error: { code: "EXECUTION_ERROR", message } };
}

function seedPanel(filePath: string | undefined, fileStatus: GitStatus = "modified"): void {
  panelsById[PANEL_ID] = {
    id: PANEL_ID,
    kind: "diff",
    diffSource: "working-tree",
    filePath,
    fileStatus,
  };
}

function renderPane() {
  return render(
    <DiffPane
      id={PANEL_ID}
      title="pane"
      isFocused
      location="dialog"
      worktreeId={WORKTREE_ID}
      onFocus={() => {}}
      onClose={() => {}}
    />
  );
}

/** The reveal button's accessible name is platform-derived, so find it by icon-free elimination. */
function revealButton(): HTMLElement {
  const label = isMacMock()
    ? "Reveal in Finder"
    : isWindowsMock()
      ? "Show in Explorer"
      : "Show in folder";
  return screen.getByLabelText(label);
}

function editorButton(): HTMLElement {
  return screen.getByLabelText("Open in editor");
}

/** Click and let the dispatch promise settle. */
async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el);
  });
}

/** A promise the test resolves by hand, for in-flight/stale-completion cases. */
function deferred(): {
  promise: Promise<ActionDispatchResult<unknown>>;
  resolve: (v: ActionDispatchResult<unknown>) => void;
} {
  let resolve!: (v: ActionDispatchResult<unknown>) => void;
  const promise = new Promise<ActionDispatchResult<unknown>>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue(ok());
  isMacMock.mockReturnValue(true);
  isWindowsMock.mockReturnValue(false);
  logErrorMock.mockReset();
  useDiffContentMock.mockReset();
  useDiffContentMock.mockReturnValue({ content: "diff --git a/a.ts b/a.ts", stale: false, retry: vi.fn() });
  worktrees.clear();
  worktrees.set(WORKTREE_ID, { path: WORKTREE_ROOT, branch: "feature/x" });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  );
});

afterEach(() => {
  for (const key of Object.keys(panelsById)) delete panelsById[key];
  vi.unstubAllGlobals();
});

describe("DiffPane toolbar — path resolution", () => {
  it("resolves the panel's worktree-relative path against the worktree root before dispatching", async () => {
    seedPanel("src/index.ts");
    renderPane();

    await click(editorButton());

    const [, args] = dispatchMock.mock.calls[0];
    // Neither input alone is the answer: the root and the relative path combine.
    expect(args).toEqual({ path: `${WORKTREE_ROOT}/src/index.ts` });
  });

  it("passes an already-absolute path through untouched", async () => {
    seedPanel("/elsewhere/vendored.ts");
    renderPane();

    await click(editorButton());

    expect(dispatchMock.mock.calls[0][1]).toEqual({ path: "/elsewhere/vendored.ts" });
  });

  it("recognises a Windows drive path as absolute rather than joining it to the root", async () => {
    // A POSIX-only "starts with /" check would join this onto the worktree root.
    seedPanel("C:\\vendor\\lib.ts");
    renderPane();

    await click(editorButton());

    expect(dispatchMock.mock.calls[0][1]).not.toEqual({
      path: `${WORKTREE_ROOT}/C:\\vendor\\lib.ts`,
    });
  });

  it("still offers the actions for an absolute path when the worktree no longer resolves", async () => {
    worktrees.clear();
    seedPanel("/elsewhere/vendored.ts");
    renderPane();

    await click(editorButton());

    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("hides both actions when a relative path has no worktree root to resolve against", () => {
    worktrees.clear();
    seedPanel("src/index.ts");
    renderPane();

    // Refresh proves the toolbar itself rendered — only the two path-dependent
    // buttons dropped out, rather than the whole toolbar being absent.
    expect(screen.getByLabelText("Refresh")).toBeTruthy();
    expect(screen.queryByLabelText("Open in editor")).toBeNull();
    expect(screen.queryByLabelText("Reveal in Finder")).toBeNull();
  });

  it("keeps offering the actions when the diff itself is unavailable", async () => {
    // A base-branch panel with no base ref can't build a diff subject, but the
    // file on disk is still perfectly revealable.
    panelsById[PANEL_ID] = {
      id: PANEL_ID,
      kind: "diff",
      diffSource: "base-branch",
      filePath: "src/index.ts",
      fileStatus: "modified",
    };
    renderPane();

    await click(revealButton());

    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("offers the actions for a deleted file so the action itself reports what went wrong", async () => {
    seedPanel("src/gone.ts", "deleted");
    dispatchMock.mockResolvedValue(fail("File no longer exists"));
    renderPane();

    await click(revealButton());

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("File no longer exists")).toBeTruthy();
  });
});

describe("DiffPane toolbar — action routing", () => {
  it("routes each button to its own action", async () => {
    seedPanel("src/index.ts");
    renderPane();

    await click(revealButton());
    await click(editorButton());

    expect(dispatchMock.mock.calls.map(([id]) => id)).toEqual([
      "file.showItemInFolder",
      "file.openInEditor",
    ]);
  });

  it("attributes the dispatch to the user", async () => {
    seedPanel("src/index.ts");
    renderPane();

    await click(editorButton());

    expect(dispatchMock.mock.calls[0][2]).toEqual({ source: "user" });
  });
});

describe("DiffPane toolbar — platform naming", () => {
  it("names the file manager for the platform it is actually running on", () => {
    seedPanel("src/index.ts");

    // Located by position rather than by name, so the name itself stays an
    // assertion instead of being smuggled into the query.
    const revealLabelFor = (mac: boolean, windows: boolean): string | null => {
      isMacMock.mockReturnValue(mac);
      isWindowsMock.mockReturnValue(windows);
      const { unmount } = renderPane();
      const label = screen
        .getByLabelText("Open in editor")
        .previousElementSibling?.getAttribute("aria-label") ?? null;
      unmount();
      return label;
    };

    expect(revealLabelFor(true, false)).toBe("Reveal in Finder");
    expect(revealLabelFor(false, true)).toBe("Show in Explorer");
    expect(revealLabelFor(false, false)).toBe("Show in folder");
  });

  it("keeps the failure title on the same platform as the button that failed", async () => {
    isMacMock.mockReturnValue(false);
    isWindowsMock.mockReturnValue(true);
    seedPanel("src/index.ts");
    dispatchMock.mockResolvedValue(fail("nope"));
    renderPane();

    const buttonLabel = revealButton().getAttribute("aria-label") ?? "";
    await click(revealButton());

    // "Show in Explorer" → "Couldn't show in Explorer": the platform noun has to
    // survive into the error, not fall back to the macOS wording.
    const platformNoun = buttonLabel.split(" ").slice(-1)[0];
    expect(screen.getByText(new RegExp(`Couldn't.*${platformNoun}`))).toBeTruthy();
  });
});

describe("DiffPane toolbar — failure and recovery", () => {
  it("surfaces the action's own message rather than a generic one", async () => {
    seedPanel("src/index.ts");
    dispatchMock.mockResolvedValue(fail("Editor binary not found on PATH"));
    renderPane();

    await click(editorButton());

    expect(screen.getByText("Editor binary not found on PATH")).toBeTruthy();
    expect(logErrorMock).toHaveBeenCalled();
  });

  it("re-aims Retry at the target that actually failed", async () => {
    seedPanel("src/index.ts");
    dispatchMock.mockResolvedValue(fail("nope"));
    renderPane();

    await click(revealButton());
    dispatchMock.mockClear();
    await click(screen.getByRole("button", { name: "Retry revealing in Finder" }));

    expect(dispatchMock.mock.calls[0][0]).toBe("file.showItemInFolder");
  });

  it("holds the banner open across a retry and clears it only once that retry succeeds", async () => {
    seedPanel("src/index.ts");
    dispatchMock.mockResolvedValue(fail("transient"));
    renderPane();
    await click(editorButton());

    // Deferred, so the in-between state is observable: clearing the banner up
    // front would "pass" this test's end state while losing the retry's spinner.
    const gate = deferred();
    dispatchMock.mockReset();
    dispatchMock.mockReturnValue(gate.promise);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Retry opening in editor" }));
    });

    expect(screen.getByText("transient")).toBeTruthy();
    expect(dispatchMock.mock.calls[0]).toEqual([
      "file.openInEditor",
      { path: `${WORKTREE_ROOT}/src/index.ts` },
      { source: "user" },
    ]);

    await act(async () => {
      gate.resolve(ok());
      await gate.promise;
    });
    expect(screen.queryByText("transient")).toBeNull();
  });

  it("keeps a failed target's banner when the other target succeeds", async () => {
    seedPanel("src/index.ts");
    dispatchMock.mockResolvedValue(fail("no editor configured"));
    renderPane();
    await click(editorButton());

    // Revealing the file did nothing to configure an editor, so the editor's
    // failure is still true and still needs its Retry.
    dispatchMock.mockResolvedValue(ok());
    await click(revealButton());

    expect(screen.getByText("no editor configured")).toBeTruthy();
  });

  it("disables Retry while its own attempt is in flight", async () => {
    seedPanel("src/index.ts");
    dispatchMock.mockResolvedValue(fail("boom"));
    renderPane();
    await click(editorButton());

    const gate = deferred();
    dispatchMock.mockReturnValue(gate.promise);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Retry opening in editor" }));
    });

    const retry = screen.getByRole("button", { name: "Retry opening in editor" });
    expect(retry.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      gate.resolve(fail("boom"));
      await gate.promise;
    });
    expect(
      screen.getByRole("button", { name: "Retry opening in editor" }).hasAttribute("disabled")
    ).toBe(false);
  });
});

describe("DiffPane toolbar — banner precedence", () => {
  it("lets a failed action displace the stale-diff notice, and restores it on dismiss", async () => {
    useDiffContentMock.mockReturnValue({
      content: "diff --git a/a.ts b/a.ts",
      stale: true,
      retry: vi.fn(),
    });
    seedPanel("src/index.ts");
    dispatchMock.mockResolvedValue(fail("boom"));
    renderPane();

    expect(screen.getByText("File changed since this diff loaded")).toBeTruthy();

    await click(editorButton());
    expect(screen.queryByText("File changed since this diff loaded")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss editor error" }));
    });
    expect(screen.getByText("File changed since this diff loaded")).toBeTruthy();
  });
});

describe("DiffPane toolbar — concurrency", () => {
  it("collapses a double-click into one dispatch", async () => {
    const gate = deferred();
    // Once-then-default, so the post-settlement click is a genuinely new
    // operation rather than a replay of the already-resolved promise.
    dispatchMock.mockReturnValueOnce(gate.promise).mockResolvedValue(ok());
    seedPanel("src/index.ts");
    renderPane();

    act(() => {
      fireEvent.click(editorButton());
      fireEvent.click(editorButton());
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.resolve(ok());
      await gate.promise;
    });

    // The guard releases once the first attempt settles.
    await click(editorButton());
    expect(dispatchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a result that lands after the panel moved to another file", async () => {
    const gate = deferred();
    dispatchMock.mockReturnValue(gate.promise);
    seedPanel("src/index.ts");
    const { rerender } = renderPane();

    act(() => {
      fireEvent.click(editorButton());
    });

    seedPanel("src/other.ts");
    rerender(
      <DiffPane
        id={PANEL_ID}
        title="pane"
        isFocused
        location="dialog"
        worktreeId={WORKTREE_ID}
        onFocus={() => {}}
        onClose={() => {}}
      />
    );

    await act(async () => {
      gate.resolve(fail("stale failure"));
      await gate.promise;
    });

    // The failure belonged to the file that is no longer open.
    expect(screen.queryByText("stale failure")).toBeNull();
  });

  it("discards an in-flight result when the worktree moves, and re-aims at the new root", async () => {
    const gate = deferred();
    dispatchMock.mockReturnValueOnce(gate.promise).mockResolvedValue(ok());
    seedPanel("src/index.ts");
    const { rerender } = renderPane();

    act(() => {
      fireEvent.click(editorButton());
    });

    // A worktree move re-aims the buttons without `filePath` changing at all —
    // which is why the reset keys on the resolved path, not the relative one.
    worktrees.set(WORKTREE_ID, { path: "/repo-moved", branch: "feature/x" });
    rerender(
      <DiffPane
        id={PANEL_ID}
        title="pane"
        isFocused
        location="dialog"
        worktreeId={WORKTREE_ID}
        onFocus={() => {}}
        onClose={() => {}}
      />
    );

    await act(async () => {
      gate.resolve(fail("failed against the old root"));
      await gate.promise;
    });
    expect(screen.queryByText("failed against the old root")).toBeNull();

    // The move also released the guard, so the button works against the new root.
    await click(editorButton());
    expect(dispatchMock.mock.calls[1][1]).toEqual({ path: "/repo-moved/src/index.ts" });
  });

  it("lets one button run while the other is still in flight, and still reports its result", async () => {
    const gate = deferred();
    dispatchMock.mockReturnValueOnce(gate.promise).mockResolvedValue(ok());
    seedPanel("src/index.ts");
    renderPane();

    act(() => {
      fireEvent.click(revealButton());
    });
    // A slow reveal must not swallow a click on the other button.
    await click(editorButton());

    expect(dispatchMock.mock.calls.map(([id]) => id)).toEqual([
      "file.showItemInFolder",
      "file.openInEditor",
    ]);

    // The sibling starting must not invalidate this one: a per-dispatch counter
    // would have marked the reveal stale here and eaten its failure silently.
    await act(async () => {
      gate.resolve(fail("reveal came back after the editor started"));
      await gate.promise;
    });
    expect(screen.getByText("reveal came back after the editor started")).toBeTruthy();
  });

  it("won't let a superseded result unlock the attempt that replaced it", async () => {
    const stale = deferred();
    const live = deferred();
    dispatchMock.mockReturnValueOnce(stale.promise).mockReturnValueOnce(live.promise);
    seedPanel("src/index.ts");
    const { rerender } = renderPane();

    act(() => {
      fireEvent.click(editorButton());
    });

    seedPanel("src/other.ts");
    rerender(
      <DiffPane
        id={PANEL_ID}
        title="pane"
        isFocused
        location="dialog"
        worktreeId={WORKTREE_ID}
        onFocus={() => {}}
        onClose={() => {}}
      />
    );
    act(() => {
      fireEvent.click(editorButton());
    });
    expect(dispatchMock).toHaveBeenCalledTimes(2);

    // The first file's result lands last. Releasing the guard on its way out
    // would hand the second file's in-flight attempt a free slot.
    await act(async () => {
      stale.resolve(ok());
      await stale.promise;
    });
    await click(editorButton());

    expect(dispatchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      live.resolve(ok());
      await live.promise;
    });
  });

  it("leaves a retry usable while only the other target is pending", async () => {
    seedPanel("src/index.ts");
    dispatchMock.mockResolvedValue(fail("no editor configured"));
    renderPane();
    await click(editorButton());

    const gate = deferred();
    dispatchMock.mockReturnValue(gate.promise);
    act(() => {
      fireEvent.click(revealButton());
    });

    // Pending is per target: a slow reveal says nothing about the editor, so
    // the editor's own Retry must stay live.
    expect(
      screen.getByRole("button", { name: "Retry opening in editor" }).hasAttribute("disabled")
    ).toBe(false);

    await act(async () => {
      gate.resolve(ok());
      await gate.promise;
    });
  });
});
