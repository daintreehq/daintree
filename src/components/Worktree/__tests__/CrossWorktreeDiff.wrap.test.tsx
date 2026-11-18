// @vitest-environment jsdom
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { CrossWorktreeDiff } from "../CrossWorktreeDiff";
import { TooltipProvider } from "@/components/ui/tooltip";

// Cross-worktree compare passed no `wrapLines` at all before #12170, so it
// always scrolled horizontally with no reachable way out. These cover the
// toggle and the prose default, alongside the file stepping they share a
// toolbar with.

const worktrees = new Map([
  [
    "wt-left",
    { id: "wt-left", name: "left", path: "/wt/left", branch: "main", isMainWorktree: true },
  ],
  [
    "wt-right",
    { id: "wt-right", name: "right", path: "/wt/right", branch: "feature", isMainWorktree: false },
  ],
]);

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (sel: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    sel({ worktrees }),
}));

// Mocked rather than real so a test can seed an explicit override without
// leaking a persisted value into the next one.
const preferences = {
  diffIgnoreWhitespace: false,
  // Writes through, so the dialog's next render reads what the click stored.
  setDiffIgnoreWhitespace: vi.fn((value: boolean) => {
    preferences.diffIgnoreWhitespace = value;
  }),
  diffWrapLines: null as boolean | null,
  setDiffWrapLines: vi.fn(),
  diffViewType: "split",
  setDiffViewType: vi.fn(),
  diffShowFileList: true,
  setDiffShowFileList: vi.fn(),
  diffFontSize: "m",
};
vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector: (state: unknown) => unknown) => selector(preferences),
}));

vi.mock("@/components/ui/AppDialog", () => {
  interface MockProps {
    isOpen: boolean;
    children: ReactNode;
  }
  interface SectionProps {
    children?: ReactNode;
    className?: string;
  }
  const AppDialog = ({ isOpen, children }: MockProps) =>
    isOpen ? <div data-testid="app-dialog">{children}</div> : null;
  AppDialog.Header = ({ children }: SectionProps) => <div>{children}</div>;
  AppDialog.Title = ({ children }: SectionProps) => <h2>{children}</h2>;
  AppDialog.CloseButton = () => <button type="button">close</button>;
  return { AppDialog };
});

// The comparison controls ride in the viewer's file header, so the stand-in
// renders the header slots the real one draws.
vi.mock("../DiffViewer", () => ({
  DiffFilePath: ({ path }: { path: string }) => <span>{path}</span>,
  DiffViewer: ({
    diff,
    wrapLines,
    headerLeading,
    headerActions,
    onShowWhitespaceChanges,
  }: {
    diff: string;
    wrapLines?: boolean;
    headerLeading?: ReactNode;
    headerActions?: ReactNode;
    onShowWhitespaceChanges?: () => void;
  }) => (
    <div>
      {headerLeading}
      {headerActions}
      <div data-testid="diff-viewer" data-wrap-lines={String(wrapLines)}>
        {diff}
      </div>
      {onShowWhitespaceChanges && (
        <button type="button" onClick={onShowWhitespaceChanges}>
          Show whitespace changes
        </button>
      )}
    </div>
  ),
}));

vi.mock("../WorktreeSelector", () => ({
  WorktreeSelector: ({ label, onChange }: { label: string; onChange: (id: string) => void }) => (
    <button type="button" onClick={() => onChange(label === "Base" ? "wt-left" : "wt-right")}>
      {label}
    </button>
  ),
}));

const mockCompareWorktrees = vi.fn();

beforeEach(() => {
  mockCompareWorktrees.mockReset();
  preferences.diffWrapLines = null;
  preferences.setDiffWrapLines.mockReset();
  preferences.diffIgnoreWhitespace = false;
  preferences.setDiffIgnoreWhitespace.mockClear();
  Object.defineProperty(window, "electron", {
    value: { git: { compareWorktrees: mockCompareWorktrees } },
    configurable: true,
  });
});

async function setupComparison(files: { path: string; status: string }[]) {
  mockCompareWorktrees.mockImplementation((_path, _b1, _b2, filePath?: string) =>
    Promise.resolve(
      filePath === undefined
        ? {
            branch1: "main",
            branch2: "feature",
            files: files.map((f) => ({ ...f, insertions: 1, deletions: 1 })),
          }
        : `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1 +1 @@\n-old\n+new`
    )
  );

  const view = render(dialogElement());
  fireEvent.click(screen.getByText("Base"));
  fireEvent.click(screen.getByText("Compare"));

  const name = files[0]!.path.split("/").pop()!;
  await waitFor(() => {
    expect(screen.getByText(name)).toBeTruthy();
  });
  fireEvent.click(screen.getByText(name));
  await waitFor(() => {
    expect(screen.getByTestId("diff-viewer")).toBeTruthy();
  });
  return view;
}

function dialogElement() {
  return (
    <TooltipProvider>
      <CrossWorktreeDiff isOpen onClose={vi.fn()} initialWorktreeId={null} />
    </TooltipProvider>
  );
}

function wrapButton(): HTMLElement {
  return screen.getByRole("button", { name: "Wrap long lines" });
}

function viewerWrap(): string | null {
  return screen.getByTestId("diff-viewer").getAttribute("data-wrap-lines");
}

describe("CrossWorktreeDiff wrap toggle (#12170)", () => {
  it("offers the toggle for a single-file comparison, where stepping is absent", async () => {
    // The whole row used to be gated on `files.length > 1`, which is exactly how
    // this surface ended up with no reachable toggle.
    await setupComparison([{ path: "docs/spec.md", status: "M" }]);

    expect(wrapButton()).toBeTruthy();
    expect(screen.queryByTestId("cross-worktree-file-position")).toBeNull();
    expect(screen.queryByLabelText("Next file")).toBeNull();
  });

  it("keeps the stepper alongside the toggle for a multi-file comparison", async () => {
    await setupComparison([
      { path: "docs/spec.md", status: "M" },
      { path: "src/a.ts", status: "M" },
    ]);

    expect(wrapButton()).toBeTruthy();
    expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe("1 of 2");
  });

  it("wraps a prose diff and not a code diff under the auto default", async () => {
    await setupComparison([{ path: "docs/spec.md", status: "M" }]);
    expect(viewerWrap()).toBe("true");
    expect(wrapButton().getAttribute("aria-pressed")).toBe("true");
  });

  it("leaves a code diff unwrapped", async () => {
    await setupComparison([{ path: "src/a.ts", status: "M" }]);
    expect(viewerWrap()).toBe("false");
    expect(wrapButton().getAttribute("aria-pressed")).toBe("false");
  });

  it("writes the opposite of the effective value, not of the stored one", async () => {
    await setupComparison([{ path: "docs/spec.md", status: "M" }]);

    fireEvent.click(wrapButton());

    expect(preferences.setDiffWrapLines).toHaveBeenCalledWith(false);
  });

  it("honours an explicit override over the file type", async () => {
    preferences.diffWrapLines = false;
    await setupComparison([{ path: "docs/spec.md", status: "M" }]);

    expect(viewerWrap()).toBe("false");
  });

  it("honours an explicit `true` on a code file", async () => {
    preferences.diffWrapLines = true;
    await setupComparison([{ path: "src/a.ts", status: "M" }]);

    expect(viewerWrap()).toBe("true");
    expect(wrapButton().getAttribute("aria-pressed")).toBe("true");
  });

  it("recomputes auto wrapping when stepping from prose to code", async () => {
    // Auto is derived per file, so stepping has to re-resolve it — a value
    // captured once when the dialog opened would keep the code diff wrapped.
    await setupComparison([
      { path: "docs/spec.md", status: "M" },
      { path: "src/a.ts", status: "M" },
    ]);
    expect(viewerWrap()).toBe("true");

    fireEvent.click(screen.getByLabelText("Next file"));

    await waitFor(() => {
      expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe("2 of 2");
    });
    expect(viewerWrap()).toBe("false");
    expect(wrapButton().getAttribute("aria-pressed")).toBe("false");
  });

  it("hands the roving tab stop to the wrap button when it takes focus", async () => {
    // Two files on purpose: with one, Wrap is the toolbar's only control and
    // already owns the stop, so the assertion would hold no matter what the
    // hook did. Behind the stepper it starts at `tabindex="-1"`, and leaving it
    // there while focused is what lets Tab out of AppDialog, whose trap skips
    // negative tabindex when computing its first/last boundary.
    await setupComparison([
      { path: "docs/spec.md", status: "M" },
      { path: "src/a.ts", status: "M" },
    ]);
    const button = wrapButton();
    expect(button.tabIndex).toBe(-1);

    button.focus();

    expect(document.activeElement).toBe(button);
    expect(button.tabIndex).toBe(0);
    expect(screen.getByLabelText("Next file").tabIndex).toBe(-1);
  });
});

describe("CrossWorktreeDiff ignore whitespace toggle (#17325)", () => {
  const LABEL = "Ignore whitespace changes";

  /** Patch requests (not the whole-file context read), as [file, whitespace flag]. */
  function patchRequests(): [unknown, unknown][] {
    return mockCompareWorktrees.mock.calls
      .filter((call) => call[3] !== undefined && call[6] === undefined)
      .map((call) => [call[3], call[5]]);
  }

  function listRequests(): number {
    return mockCompareWorktrees.mock.calls.filter((call) => call[3] === undefined).length;
  }

  /** Holds patch requests carrying `flag` back until the test settles them. */
  function deferPatch(flag: boolean) {
    let settle!: { resolve: (diff: string) => void; reject: (error: Error) => void };
    const pending = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const fallback = mockCompareWorktrees.getMockImplementation()!;
    mockCompareWorktrees.mockImplementation((...args: unknown[]) =>
      args[3] !== undefined && args[5] === flag && args[6] === undefined
        ? pending
        : fallback(...args)
    );
    return settle;
  }

  it("sits beside Wrap long lines, pressed with the preference", async () => {
    await setupComparison([{ path: "src/a.ts", status: "M" }]);

    const toggle = screen.getByRole("button", { name: LABEL });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.previousElementSibling).toBe(wrapButton());
    // Setup opens the file twice (the auto-open, then a click), both unfiltered.
    expect(patchRequests().length).toBeGreaterThan(0);
    expect(patchRequests().every(([, flag]) => flag === false)).toBe(true);
    expect(screen.queryByRole("button", { name: "Show whitespace changes" })).toBeNull();
  });

  it("reloads only the open file, in the foreground, with whitespace ignored", async () => {
    await setupComparison([
      { path: "src/a.ts", status: "M" },
      { path: "src/b.ts", status: "M" },
    ]);
    fireEvent.click(screen.getByLabelText("Next file"));
    await waitFor(() => {
      expect(screen.getByTestId("diff-viewer").textContent).toContain("src/b.ts");
    });
    const listsBefore = listRequests();
    const patchesBefore = patchRequests().length;
    const settle = deferPatch(true);

    fireEvent.click(screen.getByRole("button", { name: LABEL }));

    expect(preferences.setDiffIgnoreWhitespace).toHaveBeenCalledWith(true);
    expect(patchRequests().slice(patchesBefore)).toEqual([["src/b.ts", true]]);
    // The other mode's patch leaves the screen while the new one loads.
    expect(screen.queryByTestId("diff-viewer")).toBeNull();

    await act(async () => {
      settle.resolve("diff --git a/src/b.ts b/src/b.ts\n@@ -1 +1 @@\n-old\n+ignoring");
    });
    await waitFor(() => {
      expect(screen.getByTestId("diff-viewer").textContent).toContain("ignoring");
    });
    expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe("2 of 2");
    expect(screen.getByRole("button", { name: LABEL }).getAttribute("aria-pressed")).toBe("true");
    expect(listRequests()).toBe(listsBefore);
  });

  it("shows a failed reload instead of keeping the other mode's patch", async () => {
    await setupComparison([{ path: "src/a.ts", status: "M" }]);
    const settle = deferPatch(true);

    fireEvent.click(screen.getByRole("button", { name: LABEL }));
    await act(async () => {
      settle.reject(new Error("git failed"));
    });

    expect(await screen.findByText("Couldn't load this diff")).toBeTruthy();
    expect(screen.queryByTestId("diff-viewer")).toBeNull();
  });

  it("reloads in the foreground when the preference changes under the open dialog", async () => {
    const view = await setupComparison([{ path: "src/a.ts", status: "M" }]);
    const listsBefore = listRequests();
    const settle = deferPatch(true);

    preferences.diffIgnoreWhitespace = true;
    view.rerender(dialogElement());

    await waitFor(() => {
      expect(patchRequests().at(-1)).toEqual(["src/a.ts", true]);
    });
    expect(screen.queryByTestId("diff-viewer")).toBeNull();
    await act(async () => {
      settle.reject(new Error("git failed"));
    });
    expect(await screen.findByText("Couldn't load this diff")).toBeTruthy();
    expect(listRequests()).toBe(listsBefore);
  });

  it("opens filtered when the preference is on, and the viewer's way back reloads unfiltered", async () => {
    preferences.diffIgnoreWhitespace = true;
    const view = await setupComparison([{ path: "src/a.ts", status: "M" }]);
    expect(patchRequests().length).toBeGreaterThan(0);
    expect(patchRequests().every(([, flag]) => flag === true)).toBe(true);
    expect(screen.getByRole("button", { name: LABEL }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Show whitespace changes" }));
    expect(preferences.setDiffIgnoreWhitespace).toHaveBeenCalledWith(false);
    view.rerender(dialogElement());

    await waitFor(() => {
      expect(patchRequests().at(-1)).toEqual(["src/a.ts", false]);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: LABEL }).getAttribute("aria-pressed")).toBe(
        "false"
      );
    });
    expect(screen.queryByRole("button", { name: "Show whitespace changes" })).toBeNull();
  });
});

const FILES = [
  { path: "src/alpha.ts", status: "M", insertions: 3, deletions: 1 },
  { path: "src/beta.ts", status: "M", insertions: 1, deletions: 1 },
  { path: "src/gamma.ts", status: "A", insertions: 9, deletions: 0 },
];

/** The latest patch request, leaving out the whole-file read that follows it. */
function lastPatchCall(): unknown[] | undefined {
  return mockCompareWorktrees.mock.calls
    .filter((call) => call[3] !== undefined && call[6] === undefined)
    .at(-1);
}

async function setupSteppingComparison() {
  mockCompareWorktrees.mockImplementation((_path, _b1, _b2, filePath?: string) =>
    Promise.resolve(
      filePath === undefined
        ? { branch1: "main", branch2: "feature", files: FILES }
        : `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1 +1 @@\n-old\n+new`
    )
  );

  render(
    <TooltipProvider>
      <CrossWorktreeDiff isOpen onClose={vi.fn()} initialWorktreeId={null} />
    </TooltipProvider>
  );
  fireEvent.click(screen.getByText("Base"));
  fireEvent.click(screen.getByText("Compare"));

  await waitFor(() => {
    expect(screen.getByText("alpha.ts")).toBeTruthy();
  });
}

describe("CrossWorktreeDiff file stepping", () => {
  it("opens the first file in list order once the comparison lands", async () => {
    await setupSteppingComparison();

    await waitFor(() => {
      expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe("1 of 3");
    });
    expect(lastPatchCall()).toEqual([
      "/wt/left",
      "main",
      "feature",
      "src/alpha.ts",
      undefined,
      false,
      undefined,
      undefined,
    ]);
  });

  it("steps forward and back through the comparison set", async () => {
    await setupSteppingComparison();
    await waitFor(() => {
      expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe("1 of 3");
    });

    fireEvent.keyDown(window, { key: "]" });
    await waitFor(() => {
      expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe("2 of 3");
    });
    expect(lastPatchCall()).toEqual([
      "/wt/left",
      "main",
      "feature",
      "src/beta.ts",
      undefined,
      false,
      undefined,
      undefined,
    ]);

    fireEvent.keyDown(window, { key: "[" });
    await waitFor(() => {
      expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe("1 of 3");
    });
  });

  it("does not step past either end", async () => {
    await setupSteppingComparison();
    await waitFor(() => {
      expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe("1 of 3");
    });

    // `[` on the first file is a no-op (no file fetch happens).
    const callsBefore = mockCompareWorktrees.mock.calls.length;
    fireEvent.keyDown(window, { key: "[" });
    expect(mockCompareWorktrees.mock.calls.length).toBe(callsBefore);

    fireEvent.keyDown(window, { key: "]" }); // 2 of 3
    fireEvent.keyDown(window, { key: "]" }); // 3 of 3
    await waitFor(() => {
      expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe("3 of 3");
    });

    const callsAtEnd = mockCompareWorktrees.mock.calls.length;
    fireEvent.keyDown(window, { key: "]" });
    expect(mockCompareWorktrees.mock.calls.length).toBe(callsAtEnd);
    const next = screen.getByLabelText("Next file");
    expect(next.getAttribute("aria-disabled")).toBe("true");
    // Unavailable, not natively disabled, so a focused button keeps focus; and
    // activating it at the end is a no-op like the key.
    expect(next.hasAttribute("disabled")).toBe(false);
    fireEvent.click(next);
    expect(mockCompareWorktrees.mock.calls.length).toBe(callsAtEnd);
  });

  it("stepper buttons navigate like the bracket keys", async () => {
    await setupSteppingComparison();

    fireEvent.click(screen.getByText("alpha.ts"));
    await waitFor(() => {
      expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe("1 of 3");
    });
    expect(screen.getByLabelText("Previous file").getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(screen.getByLabelText("Next file"));
    await waitFor(() => {
      expect(screen.getByTestId("cross-worktree-file-position").textContent).toBe("2 of 3");
    });
  });
});
