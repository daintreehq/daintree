// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDialog, type DialogPlacement } from "../AppDialog";
import { _resetForTests } from "@/lib/escapeStack";
import { useGlobalEscapeDispatcher } from "@/hooks/useGlobalEscapeDispatcher";

const PORTAL_WIDTH = 320;

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));

// Open, so a dialog that leaves the Portal's strip uncovered says so.
vi.mock("@/store/portalStore", () => ({
  usePortalStore: () => ({ isOpen: true, width: PORTAL_WIDTH }),
}));

vi.mock("@/hooks/useOverlayState", () => ({
  useOverlayState: () => {},
}));

let mockPrevOpen = false;

// The exit runs at once, handing focus back as the real presence does at its end.
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({
    isOpen,
    onAnimateOut,
  }: {
    isOpen: boolean;
    onAnimateOut?: () => void;
  }) => {
    if (mockPrevOpen && !isOpen) onAnimateOut?.();
    mockPrevOpen = isOpen;
    return { isVisible: isOpen, shouldRender: isOpen };
  },
}));

vi.mock("@/lib/scrollbarGutter", () => ({
  SCROLLBAR_GUTTER_VAR: "--app-scrollbar-gutter",
  measureScrollbarGutter: vi.fn(() => 0),
  publishScrollbarGutter: vi.fn(() => 0),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

let announceFullscreen: ((isFullscreen: boolean) => void) | null = null;
Object.defineProperty(window, "electron", {
  configurable: true,
  value: {
    window: {
      onFullscreenChange: (callback: (isFullscreen: boolean) => void) => {
        announceFullscreen = callback;
        return () => {};
      },
    },
  },
});

const originalPlatform = Object.getOwnPropertyDescriptor(window.navigator, "platform");

function setNavigatorPlatform(value: string) {
  Object.defineProperty(window.navigator, "platform", { value, configurable: true });
}

function Dispatcher() {
  useGlobalEscapeDispatcher();
  return null;
}

function Dialog({
  placement,
  isOpen = true,
  onClose = () => {},
}: {
  placement: DialogPlacement;
  isOpen?: boolean;
  onClose?: () => void;
}) {
  return (
    <>
      <Dispatcher />
      <AppDialog
        isOpen={isOpen}
        onClose={onClose}
        placement={placement}
        size="workspace"
        maxHeight="h-[min(90vh,1100px)]"
        data-testid="test-dialog"
      >
        <AppDialog.Header>
          <AppDialog.Title>Canopy</AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        <AppDialog.Body>
          <button type="button">Inner</button>
        </AppDialog.Body>
      </AppDialog>
    </>
  );
}

function layer(): HTMLElement {
  return screen.getByTestId("test-dialog");
}

function surface(): HTMLElement {
  const card = layer().firstElementChild;
  if (!(card instanceof HTMLElement)) throw new Error("AppDialog rendered no surface");
  return card;
}

function header(): HTMLElement {
  const heading = screen.getByRole("heading", { name: "Canopy" });
  const bar = heading.parentElement;
  if (!bar) throw new Error("the title has no header around it");
  return bar;
}

beforeEach(() => {
  mockPrevOpen = false;
  _resetForTests();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
});

afterEach(() => {
  act(() => announceFullscreen?.(false));
  cleanup();
  _resetForTests();
  vi.useRealTimers();
  if (originalPlatform) {
    Object.defineProperty(window.navigator, "platform", originalPlatform);
  } else {
    delete (window.navigator as unknown as Record<string, unknown>).platform;
  }
});

describe("AppDialog window placement", () => {
  it("covers the whole window, the Portal's strip too, where a card leaves it", () => {
    const { unmount } = render(<Dialog placement="center" />);
    expect(layer().style.right).toBe(`${PORTAL_WIDTH}px`);
    unmount();

    render(<Dialog placement="window" />);
    expect(layer().style.right).toBe("0px");
  });

  it("lets nothing of the app show through: no scrim tint or blur over it", () => {
    const { unmount } = render(<Dialog placement="center" />);
    const scrimmed = layer().className;
    unmount();

    render(<Dialog placement="window" />);
    const opaque = layer().className;
    expect(scrimmed).toMatch(/\bbackdrop-blur-/);
    expect(scrimmed).toMatch(/\bbg-scrim-/);
    expect(opaque).not.toMatch(/\bbackdrop-blur-/);
    expect(opaque).not.toMatch(/\bbg-scrim-/);
  });

  it("fills the window whatever size and height the caller names", () => {
    const { unmount } = render(<Dialog placement="center" />);
    const card = surface().className;
    unmount();

    render(<Dialog placement="window" />);
    const whole = surface().className;
    expect(card).toMatch(/\bmax-w-/);
    expect(card).toContain("h-[min(90vh,1100px)]");
    expect(whole).not.toMatch(/\bmax-w-/);
    expect(whole).not.toContain("h-[min(90vh,1100px)]");
    expect(whole).not.toMatch(/\brounded-/);
  });

  it("never moves as it opens: it fades with its layer, without a rise or zoom", () => {
    const { unmount } = render(<Dialog placement="center" />);
    const card = surface().className;
    unmount();

    render(<Dialog placement="window" />);
    const whole = surface().className;
    expect(card).toMatch(/starting:translate-y-/);
    expect(card).toMatch(/starting:scale-/);
    expect(whole).not.toMatch(/starting:(translate|scale|opacity)/);
    expect(layer().className).toContain("starting:opacity-0");
  });

  it("claims no-drag over the window and makes its header the title bar", () => {
    render(<Dialog placement="window" />);
    expect(surface().className).toContain("app-no-drag");
    expect(header().className).toContain("dialog-window-header");
  });

  it("keeps a card's header out of the window chrome", () => {
    render(<Dialog placement="center" />);
    expect(header().className).not.toContain("dialog-window-header");
    expect(header().style.paddingLeft).toBe("");
  });

  it("keeps its header clear of the traffic lights until the window goes fullscreen", () => {
    setNavigatorPlatform("MacIntel");
    render(<Dialog placement="window" />);
    expect(header().style.paddingLeft).not.toBe("");

    act(() => announceFullscreen?.(true));
    expect(header().style.paddingLeft).toBe("");
  });

  it("knows the window is already fullscreen when it opens after the change", () => {
    setNavigatorPlatform("MacIntel");
    // Something mounted earlier (the toolbar) heard the change; the dialog
    // opens afterwards and main says nothing more.
    const { unmount } = render(<Dialog placement="window" />);
    act(() => announceFullscreen?.(true));
    unmount();

    render(<Dialog placement="window" />);
    expect(header().style.paddingLeft).toBe("");
  });

  it("clears the Windows caption buttons on the right instead", () => {
    setNavigatorPlatform("Win32");
    render(<Dialog placement="window" />);
    expect(header().style.paddingRight).not.toBe("");
    expect(header().style.paddingLeft).toBe("");
  });

  it("is still a modal dialog the keyboard can't leave, that Escape closes and hands focus back from", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Opener";
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();

    const { rerender } = render(<Dialog placement="window" onClose={onClose} />);
    await act(() => vi.runAllTimersAsync());
    expect(layer().getAttribute("role")).toBe("dialog");
    expect(layer().getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Inner" }));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledOnce();

    rerender(<Dialog placement="window" isOpen={false} onClose={onClose} />);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
