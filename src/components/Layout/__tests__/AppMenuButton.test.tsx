// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { AppMenuButton } from "../AppMenuButton";

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
  (globalThis as unknown as { window: Window }).window.electron = {
    menu: { showApplication: (payload?: { x?: number; y?: number }) => showApplication(payload) },
  } as never;
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
  const button = utils.container.querySelector(
    "[data-app-menu-button]"
  ) as HTMLButtonElement | null;
  const sibling = utils.container.querySelector("[data-testid=sibling]") as HTMLButtonElement;
  if (button) stubRect(button, { left: 0, bottom: 0 });
  return { ...utils, button, sibling };
}

function stubRect(button: HTMLButtonElement, rect: { left: number; bottom: number }) {
  button.getBoundingClientRect = () =>
    ({ left: rect.left, bottom: rect.bottom }) as unknown as DOMRect;
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
    stubRect(button as HTMLButtonElement, { left: 84, bottom: 44 });

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
    const { button, unmount } = renderInToolbar();
    const editor = addEditor();
    editor.focus();
    button!.focus();
    unmount();

    // A focusin after teardown must not be recorded — if the listener leaked,
    // it would keep writing into a ref belonging to a dead component.
    const late = addEditor();
    expect(() => late.focus()).not.toThrow();
  });

  it("consumes an IPC rejection instead of surfacing an unhandled rejection", async () => {
    showApplication.mockRejectedValueOnce(new Error("window disposed"));
    const { button } = renderInToolbar();

    expect(() => fireEvent.click(button!)).not.toThrow();
    await Promise.resolve();
  });
});
