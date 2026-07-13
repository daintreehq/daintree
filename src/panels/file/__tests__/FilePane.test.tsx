// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FilePane forwards a fixed prop list to ContentPanel; #10991 was a dropped
// `showRestoreControl`, which hid the inline "Move to grid" button on a docked
// single file panel. Stub ContentPanel to capture what FilePane forwards, and
// mock the heavy store/client/viewer surface so we render only FilePane's own
// wiring — the seam that shipped the bug. The stub also renders `toolbar`, so
// the toolbar-owned open-in-editor error banner (#11114) is observable.
const contentPanelProps: Array<Record<string, unknown>> = [];

vi.mock("@/components/Panel/ContentPanel", () => ({
  ContentPanel: (props: Record<string, unknown> & { toolbar?: ReactNode }) => {
    contentPanelProps.push(props);
    return <>{props.toolbar}</>;
  },
}));

// Mutable so a test can seed a real file panel (giving FilePane a filePath, and
// therefore a toolbar) without disturbing the prop-forwarding tests.
const panelsById: Record<string, unknown> = {};

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (state: unknown) => unknown) =>
    selector({ panelsById, setFileViewMode: vi.fn(), setFilePanelPath: vi.fn() }),
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) => selector({ currentProject: null }),
}));
vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector: (state: unknown) => unknown) =>
    selector({ markdownWrapLines: false, setMarkdownWrapLines: vi.fn() }),
}));
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: unknown) => unknown) => selector({ worktrees: new Map() }),
}));
vi.mock("@/store/accessibilityAnnouncerStore", () => ({
  useAnnouncerStore: { getState: () => ({ announce: vi.fn() }) },
}));
vi.mock("@/clients/filesClient", () => ({
  filesClient: {
    read: vi.fn().mockResolvedValue({ content: "" }),
    search: vi.fn().mockResolvedValue({ files: [] }),
  },
}));
// dispatch() resolves an ActionDispatchResult union and never rejects; callers
// branch on `.ok`, so the mock must honour that shape rather than resolve void.
const { dispatchMock } = vi.hoisted(() => ({ dispatchMock: vi.fn() }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));
vi.mock("@/components/Markdown/MarkdownViewer", () => ({ MarkdownViewer: () => null }));
vi.mock("@/components/FileViewer/CodeViewer", () => ({ CodeViewer: () => null }));

import { FilePane } from "../FilePane";
import { TooltipProvider } from "@/components/ui/tooltip";

function lastContentPanelProps(): Record<string, unknown> {
  const props = contentPanelProps.at(-1);
  if (!props) throw new Error("ContentPanel was not rendered");
  return props;
}

beforeEach(() => {
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({ ok: true, result: undefined });
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

    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
