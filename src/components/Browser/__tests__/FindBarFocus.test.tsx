// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FindBar } from "../FindBar";
import { useFindInPage } from "@/hooks/useFindInPage";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

let shortcutCallback: ((payload: { panelId: string; shortcut: string }) => void) | null = null;

beforeEach(() => {
  shortcutCallback = null;
  Object.defineProperty(window, "electron", {
    value: {
      webview: {
        onFindShortcut: (cb: typeof shortcutCallback) => {
          shortcutCallback = cb;
          return () => {
            shortcutCallback = null;
          };
        },
      },
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeWebview(): Electron.WebviewTag {
  const el = document.createElement("div");
  el.tabIndex = 0;
  el.dataset.testid = "webview";
  return Object.assign(el, {
    findInPage: vi.fn(() => 1),
    stopFindInPage: vi.fn(),
  }) as unknown as Electron.WebviewTag;
}

function Pane({ webview }: { webview: Electron.WebviewTag | null }) {
  const find = useFindInPage("panel-1", webview, true, true);
  return (
    <div data-panel-id="panel-1" tabIndex={-1} data-testid="pane">
      <button type="button" onClick={find.open}>
        Open find
      </button>
      {find.isOpen && <FindBar find={find} />}
      {webview && <WebviewHost webview={webview} />}
    </div>
  );
}

function WebviewHost({ webview }: { webview: Electron.WebviewTag }) {
  return (
    <div
      ref={(host) => {
        if (host && !host.contains(webview)) host.appendChild(webview);
      }}
    />
  );
}

async function openBar() {
  fireEvent.click(screen.getByText("Open find"));
  return (await screen.findByLabelText("Find in page")) as HTMLInputElement;
}

describe("find bar focus and kept state", () => {
  it("hands the keyboard to the webview when Escape closes the bar", async () => {
    const webview = makeWebview();
    render(<Pane webview={webview} />);
    const input = await openBar();
    input.focus();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByLabelText("Find in page")).toBeNull();
    expect(document.activeElement).toBe(webview);
  });

  it("hands the keyboard to the webview when the close button closes the bar", async () => {
    const webview = makeWebview();
    render(<Pane webview={webview} />);
    await openBar();
    const close = screen.getByLabelText("Close find bar");
    close.focus();

    fireEvent.click(close);

    expect(screen.queryByLabelText("Find in page")).toBeNull();
    expect(document.activeElement).toBe(webview);
  });

  it("falls back to the pane when there is no webview to take the keyboard", async () => {
    render(<Pane webview={null} />);
    const input = await openBar();
    input.focus();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(document.activeElement).toBe(screen.getByTestId("pane"));
  });

  it("leaves the keyboard where it is when a forwarded close arrives after the user moved on", async () => {
    const webview = makeWebview();
    const other = document.createElement("button");
    document.body.appendChild(other);
    render(<Pane webview={webview} />);
    await openBar();
    other.focus();

    act(() => shortcutCallback!({ panelId: "panel-1", shortcut: "close" }));

    expect(screen.queryByLabelText("Find in page")).toBeNull();
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("reopens with the query selected and match case still on", async () => {
    const webview = makeWebview();
    render(<Pane webview={webview} />);
    const input = await openBar();
    fireEvent.change(input, { target: { value: "needle" } });
    fireEvent.click(screen.getByLabelText("Match case"));
    fireEvent.keyDown(input, { key: "Escape" });

    const reopened = await openBar();

    expect(reopened.value).toBe("needle");
    expect(screen.getByLabelText("Match case").getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => {
      expect(document.activeElement).toBe(reopened);
      expect(reopened.selectionStart).toBe(0);
      expect(reopened.selectionEnd).toBe("needle".length);
    });
    expect(webview.findInPage).toHaveBeenLastCalledWith("needle", {
      findNext: true,
      matchCase: true,
    });
  });
});
