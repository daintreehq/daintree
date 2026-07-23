// @vitest-environment jsdom
import { render, act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// FileBrowserViewer is the read-only preview beside the tree. #11319 adds a
// Source/Rendered toggle for markdown, mirroring FilePane. Mock the heavy leaf
// viewers so only FileBrowserViewer's own toolbar + mode wiring renders, and
// capture the viewMode handed to MarkdownViewer — the seam the toggle drives.
const { readMock } = vi.hoisted(() => ({ readMock: vi.fn() }));
vi.mock("@/clients/filesClient", () => ({
  filesClient: { read: readMock },
}));

// dispatch() resolves an ActionDispatchResult union and never rejects; the
// toolbar's external-action handlers branch on `.ok`, so honour that shape.
const { dispatchMock } = vi.hoisted(() => ({ dispatchMock: vi.fn() }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

// A real MarkdownViewer lazy-loads its renderer, hiding the prop under test.
// The mock surfaces viewMode as a data attribute so the toggle wiring is
// observable — without it the mode plumbing could be deleted and stay green.
vi.mock("@/components/Markdown/MarkdownViewer", () => ({
  MarkdownViewer: (props: { viewMode: string }) => (
    <div data-testid="markdown-viewer-mock" data-view-mode={props.viewMode} />
  ),
}));
vi.mock("@/components/FileViewer/CodeViewer", () => ({
  CodeViewer: () => <div data-testid="code-viewer-mock" />,
}));
vi.mock("@/components/Html/HtmlViewer", () => ({
  HtmlViewer: () => <div data-testid="html-viewer-mock" />,
}));

import { FileBrowserViewer } from "../FileBrowserViewer";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderViewer(filePath: string) {
  const fileName = filePath.split("/").pop() ?? filePath;
  return render(
    <TooltipProvider>
      <FileBrowserViewer
        filePath={filePath}
        rootPath="/repo"
        fileName={fileName}
        relativePath={fileName}
        revision="r1"
      />
    </TooltipProvider>
  );
}

// SegmentedToggle renders literal-text buttons; its accessible name is the
// visible label, so click by role + name.
async function clickMode(label: "Source" | "Rendered") {
  const button = await screen.findByRole("button", { name: label });
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function currentViewMode(): string | null {
  return screen.getByTestId("markdown-viewer-mock").getAttribute("data-view-mode");
}

beforeEach(() => {
  readMock.mockReset();
  readMock.mockResolvedValue({ content: "# hello" });
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ ok: true, result: undefined });
  // SegmentedToggle's motion hook (and InlineStatusBanner) read matchMedia at
  // render time; jsdom does not implement it, so provide a no-op stub.
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

describe("FileBrowserViewer markdown Source/Rendered toggle (#11319)", () => {
  it("shows the toggle and defaults to the rendered view for a markdown file", async () => {
    renderViewer("/repo/docs/spec.md");
    // Default preserves the pane's long-standing rendered-first behaviour.
    await waitFor(() => expect(currentViewMode()).toBe("rendered"));
    expect(screen.getByRole("button", { name: "Source" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rendered" })).toBeTruthy();
  });

  it("switches the markdown viewer between source and rendered", async () => {
    renderViewer("/repo/docs/spec.md");
    await waitFor(() => expect(currentViewMode()).toBe("rendered"));
    await clickMode("Source");
    await waitFor(() => expect(currentViewMode()).toBe("source"));
    // Round-trip so the "rendered" segment's mapping is exercised too, not just
    // the "source" one.
    await clickMode("Rendered");
    await waitFor(() => expect(currentViewMode()).toBe("rendered"));
  });

  it("keeps the chosen mode sticky across a different markdown file", async () => {
    const { rerender } = renderViewer("/repo/docs/a.md");
    await waitFor(() => expect(currentViewMode()).toBe("rendered"));
    await clickMode("Source");
    await waitFor(() => expect(currentViewMode()).toBe("source"));

    // Selecting another markdown file in the tree must not silently revert the
    // reader's choice back to rendered — the mode is sticky, mirroring FilePane.
    rerender(
      <TooltipProvider>
        <FileBrowserViewer
          filePath="/repo/docs/b.md"
          rootPath="/repo"
          fileName="b.md"
          relativePath="b.md"
          revision="r1"
        />
      </TooltipProvider>
    );
    await waitFor(() => expect(currentViewMode()).toBe("source"));
  });

  it("drops the toggle and its stale source choice when switching to a non-markdown file", async () => {
    // Start on markdown in Source, then navigate to a .txt in the same viewer —
    // the tree's real usage. Proves the markdown-only toggle disappears and the
    // sticky "source" choice can't leak into the CodeViewer (non-markdown) branch.
    const { rerender } = renderViewer("/repo/docs/a.md");
    await waitFor(() => expect(currentViewMode()).toBe("rendered"));
    await clickMode("Source");
    await waitFor(() => expect(currentViewMode()).toBe("source"));

    rerender(
      <TooltipProvider>
        <FileBrowserViewer
          filePath="/repo/src/notes.txt"
          rootPath="/repo"
          fileName="notes.txt"
          relativePath="notes.txt"
          revision="r1"
        />
      </TooltipProvider>
    );
    await screen.findByTestId("code-viewer-mock");
    expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rendered" })).toBeNull();
    expect(screen.queryByTestId("markdown-viewer-mock")).toBeNull();
  });
});
