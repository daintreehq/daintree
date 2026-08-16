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

/** Records where DOM focus sat at the moment the IPC call was made. */
let focusAtInvoke: Element | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  isMacMock.mockReturnValue(false);
  focusAtInvoke = null;
  // Testing Library only unmounts what it rendered; inputs appended by hand
  // would otherwise survive and win document.activeElement in a later test.
  document.body.innerHTML = "";
  showApplication.mockImplementation(() => {
    focusAtInvoke = document.activeElement;
    return Promise.resolve();
  });
  (globalThis as unknown as { window: Window }).window.electron = {
    menu: { showApplication: (payload?: { x?: number; y?: number }) => showApplication(payload) },
  } as never;
});

function renderButton() {
  const utils = render(<AppMenuButton />);
  return { ...utils, button: utils.container.querySelector("button") };
}

function stubRect(button: HTMLButtonElement, rect: { left: number; bottom: number }) {
  button.getBoundingClientRect = () =>
    ({ left: rect.left, bottom: rect.bottom }) as unknown as DOMRect;
}

function addInput(): HTMLInputElement {
  const input = document.createElement("input");
  document.body.appendChild(input);
  return input;
}

/**
 * Reproduce a keyboard arrival: move real focus onto the button, then deliver
 * the focus event carrying the element the user came from. `fireEvent.focus`
 * alone never moves `document.activeElement`, and calling `button.focus()`
 * afterwards would fire a second, relatedTarget-less focus event that clears
 * what the component just recorded.
 */
function focusFrom(button: HTMLButtonElement, from: HTMLElement) {
  button.focus();
  fireEvent.focus(button, { relatedTarget: from });
}

describe("AppMenuButton", () => {
  it("renders nothing on macOS, which keeps its native system menu bar", () => {
    isMacMock.mockReturnValue(true);
    const { container } = render(<AppMenuButton />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders a labelled menu trigger on the platforms that lost the native menu", () => {
    const { button } = renderButton();
    expect(button).not.toBeNull();
    expect(button!.getAttribute("aria-haspopup")).toBe("menu");
    expect(button!.getAttribute("aria-label")?.trim()).toBeTruthy();
    // Must stay in the toolbar's roving-focus set to be keyboard reachable.
    expect(button!.hasAttribute("data-toolbar-item")).toBe(true);
  });

  it("anchors the popup to the button's bottom-left corner", () => {
    const { button } = renderButton();
    stubRect(button as HTMLButtonElement, { left: 84, bottom: 44 });

    fireEvent.click(button!);

    expect(showApplication).toHaveBeenCalledWith({ x: 84, y: 44 });
  });

  it("keeps a primary press from stealing focus, so Edit commands keep their target", () => {
    const { button } = renderButton();
    const input = addInput();
    input.focus();

    const prevented = !fireEvent.pointerDown(button!, { button: 0 });

    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it("does not swallow non-primary presses", () => {
    const { button } = renderButton();
    const prevented = !fireEvent.pointerDown(button!, { button: 2 });
    expect(prevented).toBe(false);
  });

  it("restores the pre-focus element before asking main to open the menu", () => {
    const { button } = renderButton();
    stubRect(button as HTMLButtonElement, { left: 0, bottom: 0 });
    const input = addInput();

    // Keyboard route: focus really moved onto the button, so relatedTarget is
    // the only record of where the user was.
    focusFrom(button as HTMLButtonElement, input);
    fireEvent.click(button!);

    expect(focusAtInvoke).toBe(input);
  });

  it("does not restore focus to an element that has since left the DOM", () => {
    const { button } = renderButton();
    stubRect(button as HTMLButtonElement, { left: 0, bottom: 0 });
    const input = addInput();

    focusFrom(button as HTMLButtonElement, input);
    input.remove();
    fireEvent.click(button!);

    expect(focusAtInvoke).toBe(button);
  });

  it("does not reuse a stale focus target on a later pointer press", () => {
    const { button } = renderButton();
    stubRect(button as HTMLButtonElement, { left: 0, bottom: 0 });
    const input = addInput();

    focusFrom(button as HTMLButtonElement, input);
    fireEvent.click(button!);
    expect(focusAtInvoke).toBe(input);

    // A subsequent mouse press starts from a clean slate: pointerdown clears
    // the remembered target, so focus is left wherever the user actually is.
    const other = addInput();
    other.focus();
    fireEvent.pointerDown(button!, { button: 0 });
    fireEvent.click(button!);

    expect(focusAtInvoke).toBe(other);
  });

  it("consumes an IPC rejection instead of surfacing an unhandled rejection", async () => {
    showApplication.mockRejectedValueOnce(new Error("window disposed"));
    const { button } = renderButton();
    stubRect(button as HTMLButtonElement, { left: 0, bottom: 0 });

    expect(() => fireEvent.click(button!)).not.toThrow();
    await Promise.resolve();
  });
});
