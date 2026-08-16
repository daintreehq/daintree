// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

// The rejection path ends in this reporter. Mocking it keeps the assertion on
// the observable hand-off (and keeps the real reporter's store/Sentry writes
// out of a component suite).
vi.mock("@/utils/rendererGlobalErrorHandlers", () => ({
  reportRendererGlobalError: vi.fn(),
}));

import { reportRendererGlobalError } from "@/utils/rendererGlobalErrorHandlers";
import { AppMenuButton } from "../AppMenuButton";

const mockedReport = vi.mocked(reportRendererGlobalError);

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
  }
}

const isMacMock = vi.fn(() => false);
vi.mock("@/lib/platform", () => ({
  isMac: () => isMacMock(),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ref,
    ...rest
  }: {
    children: React.ReactNode;
    ref?: React.Ref<HTMLButtonElement>;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button ref={ref} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/icons", () => ({
  Menu: () => <svg data-testid="menu-icon" />,
}));

const showApplication = vi.fn<(payload?: { x?: number; y?: number }) => Promise<void>>(() =>
  Promise.resolve()
);

/** Where DOM focus sat at the exact moment the IPC call was made. */
let focusAtInvoke: Element | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  isMacMock.mockReturnValue(false);
  focusAtInvoke = null;
  showApplication.mockImplementation(() => {
    focusAtInvoke = document.activeElement;
    return Promise.resolve();
  });
  // Testing Library only unmounts what it rendered; nodes appended by hand
  // would otherwise survive and win document.activeElement in a later test.
  document.body.innerHTML = "";
  Object.assign(window, {
    electron: {
      menu: { showApplication: (payload?: { x?: number; y?: number }) => showApplication(payload) },
    },
  });
});

/**
 * Render the button inside a realistic toolbar: the component distinguishes
 * "focus moved within the toolbar" from "focus moved to real content" via the
 * role="toolbar" ancestor, so a bare render would not exercise that branch.
 * The sibling stands in for any other roving-focus toolbar item.
 */
function renderInToolbar() {
  const utils = render(
    <div role="toolbar" aria-label="Main toolbar">
      <button type="button" data-toolbar-item="" data-testid="sibling">
        sibling
      </button>
      <AppMenuButton />
    </div>
  );
  const button = utils.container.querySelector<HTMLButtonElement>("[data-app-menu-button]");
  const sibling = utils.container.querySelector<HTMLButtonElement>("[data-testid=sibling]")!;
  if (button) stubRect(button, { left: 0, bottom: 0 });
  return { ...utils, button, sibling };
}

function stubRect(button: HTMLButtonElement, rect: { left: number; bottom: number }) {
  // Zero-sized rect anchored so that left/bottom are exactly the values under
  // test — DOMRect derives bottom from y + height.
  button.getBoundingClientRect = () => new DOMRect(rect.left, rect.bottom, 0, 0);
}

/** An editable target living outside the toolbar, like a real text input. */
function addEditor(): HTMLInputElement {
  const input = document.createElement("input");
  document.body.appendChild(input);
  return input;
}

describe("AppMenuButton", () => {
  it("renders nothing on macOS, which keeps its native system menu bar", () => {
    isMacMock.mockReturnValue(true);
    const { button } = renderInToolbar();
    expect(button).toBeNull();
  });

  it("renders a labelled menu trigger on the platforms that lost the native menu", () => {
    const { button } = renderInToolbar();
    expect(button).not.toBeNull();
    expect(button!.getAttribute("aria-haspopup")).toBe("menu");
    expect(button!.getAttribute("aria-label")?.trim()).toBeTruthy();
    // Must stay in the toolbar's roving-focus set to be keyboard reachable.
    expect(button!.hasAttribute("data-toolbar-item")).toBe(true);
  });

  it("anchors the popup to the button's bottom-left corner", () => {
    const { button } = renderInToolbar();
    stubRect(button!, { left: 84, bottom: 44 });

    fireEvent.click(button!);

    expect(showApplication).toHaveBeenCalledWith({ x: 84, y: 44 });
  });

  it("cancels a primary press so the browser never moves focus onto the button", () => {
    const { button } = renderInToolbar();
    const prevented = !fireEvent.pointerDown(button!, { button: 0 });
    expect(prevented).toBe(true);
  });

  it("does not swallow non-primary presses", () => {
    const { button } = renderInToolbar();
    const prevented = !fireEvent.pointerDown(button!, { button: 2 });
    expect(prevented).toBe(false);
  });

  it("returns focus to the editor before asking main to open the menu", () => {
    const { button } = renderInToolbar();
    const editor = addEditor();

    // Keyboard route: the user tabs from the editor onto the button, so focus
    // really is on chrome by the time the menu opens.
    editor.focus();
    button!.focus();
    fireEvent.click(button!);

    expect(focusAtInvoke).toBe(editor);
  });

  it("restores the editor even when the user arrowed across the toolbar to get here", () => {
    const { button, sibling } = renderInToolbar();
    const editor = addEditor();

    // The toolbar's roving focus calls .focus() on each item in turn, so the
    // button's immediate predecessor is a sibling button, not the editor.
    // Restoring that sibling would still point Edit commands at chrome.
    editor.focus();
    sibling.focus();
    button!.focus();
    fireEvent.click(button!);

    expect(focusAtInvoke).toBe(editor);
    expect(focusAtInvoke).not.toBe(sibling);
  });

  it("keeps the editor target across a press that follows keyboard focus", () => {
    const { button } = renderInToolbar();
    const editor = addEditor();

    editor.focus();
    button!.focus();
    // Clicking a button that already holds keyboard focus must not discard the
    // remembered editor — preventDefault leaves focus on the button, so the
    // restore is the only thing pointing Edit commands back at the caret.
    fireEvent.pointerDown(button!, { button: 0 });
    fireEvent.click(button!);

    expect(focusAtInvoke).toBe(editor);
  });

  it("tracks the most recent editor when focus moves between several", () => {
    const { button } = renderInToolbar();
    const first = addEditor();
    const second = addEditor();

    first.focus();
    second.focus();
    button!.focus();
    fireEvent.click(button!);

    expect(focusAtInvoke).toBe(second);
  });

  it("does not restore focus to an editor that has since left the DOM", () => {
    const { button } = renderInToolbar();
    const editor = addEditor();

    editor.focus();
    editor.remove();
    button!.focus();
    fireEvent.click(button!);

    expect(focusAtInvoke).toBe(button);
    expect(showApplication).toHaveBeenCalledTimes(1);
  });

  it("still opens the menu when nothing outside the toolbar was ever focused", () => {
    const { button } = renderInToolbar();

    button!.focus();
    fireEvent.click(button!);

    expect(showApplication).toHaveBeenCalledTimes(1);
  });

  it("stops tracking focus once unmounted", () => {
    // A leaked focusin listener is silent — it just keeps writing into a ref
    // belonging to a dead component — so the only observable evidence of the
    // teardown is the listener registration itself.
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    try {
      const { unmount } = renderInToolbar();
      const added = addSpy.mock.calls
        .filter(([type]) => type === "focusin")
        .map(([, listener]) => listener);
      // Guards the spy itself: without this, a component that never listened
      // would satisfy the empty-vs-empty comparison below.
      expect(added).toHaveLength(1);

      unmount();

      const removed = removeSpy.mock.calls
        .filter(([type]) => type === "focusin")
        .map(([, listener]) => listener);
      expect(removed).toHaveLength(1);
      // Identity, not just a matching count: removeEventListener silently does
      // nothing unless the function reference matches the registered one.
      expect(removed[0]).toBe(added[0]);
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it("consumes an IPC rejection instead of surfacing an unhandled rejection", async () => {
    const failure = new Error("window disposed");
    showApplication.mockRejectedValueOnce(failure);
    const { button } = renderInToolbar();

    fireEvent.click(button!);
    await flushMicrotasks();

    // A bare `void promise` would leave this rejection to escape as an
    // unhandled rejection; routing it through safeFireAndForget lands it here.
    expect(mockedReport).toHaveBeenCalledTimes(1);
    const [kind, error, metadata] = mockedReport.mock.calls[0]!;
    expect(kind).toBe("unhandledrejection");
    expect(error).toBe(failure);
    // The call site supplies its own context rather than letting the raw IPC
    // rejection text stand in as the user-facing message.
    expect(metadata.message).toBeTruthy();
    expect(metadata.message).not.toBe(failure.message);
  });
});
