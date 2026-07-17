// @vitest-environment jsdom
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode; asChild?: boolean }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { FileViewerToolbar } from "../FileViewerToolbar";

// The fit is pure measurement, and jsdom measures nothing: clientWidth is 0 and
// there is no canvas. Stub both with a monospace model — every glyph CHAR_PX
// wide — so the assertions below exercise the truncation algorithm rather than
// jsdom's CSS engine.
const CHAR_PX = 10;
const PAD_X = 36; // pl-7 (28) + pr-2 (8), matching the pill's padding

let containerWidth = 0;
let resizeCallbacks: ResizeObserverCallback[] = [];

class MockResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** Re-fit at a new width, the way a real ResizeObserver would. */
function resizeTo(width: number) {
  containerWidth = width;
  act(() => {
    for (const cb of resizeCallbacks) cb([], {} as ResizeObserver);
  });
}

const availableWidth = () => containerWidth - PAD_X;

beforeEach(() => {
  resizeCallbacks = [];
  containerWidth = 0;
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  // Override only the five properties the fit reads, delegating the rest to
  // jsdom: testing-library's accessible-name computation calls
  // getPropertyValue() on this same object, so a bare literal would break every
  // getByRole in the file.
  const FIT_STYLE: Record<string, string> = {
    fontWeight: "400",
    fontSize: "12px",
    fontFamily: "monospace",
    paddingLeft: "28px",
    paddingRight: "8px",
  };
  const realGetComputedStyle = window.getComputedStyle.bind(window);
  vi.stubGlobal("getComputedStyle", (el: Element, pseudo?: string | null) => {
    const real = realGetComputedStyle(el, pseudo ?? undefined);
    return new Proxy(real, {
      get(target, prop) {
        if (typeof prop === "string" && prop in FIT_STYLE) return FIT_STYLE[prop];
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText: (text: string) => ({ width: text.length * CHAR_PX }),
  } as unknown as CanvasRenderingContext2D);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => containerWidth,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FileViewerToolbar.Path", () => {
  const LONG_PATH = "src/components/deeply/nested/file.tsx";
  const BASENAME = "/file.tsx";

  function renderPath(path: string, { copied = false, onCopy = vi.fn() } = {}) {
    render(<FileViewerToolbar.Path path={path} copied={copied} onCopy={onCopy} />);
    return screen.getByRole("button", { name: "Copy file path" });
  }

  /** The pill's rendered text, which is what useFittedPath computed. */
  const fittedText = () => screen.getByRole("button", { name: "Copy file path" }).textContent ?? "";

  it("shows the path untruncated when it fits", () => {
    containerWidth = LONG_PATH.length * CHAR_PX + PAD_X + 20;
    renderPath(LONG_PATH);

    expect(fittedText()).toBe(LONG_PATH);
  });

  it("collapses the middle to fit, always keeping the basename", () => {
    containerWidth = 200;
    renderPath(LONG_PATH);
    const display = fittedText();

    expect(display).not.toBe(LONG_PATH);
    // The file name is reserved first — it survives at any width.
    expect(display.endsWith(BASENAME)).toBe(true);
    // One ellipsis, in the middle — not a chain of them.
    expect(display.match(/…/g)).toHaveLength(1);
    // And the result actually fits the space it measured against.
    expect(display.length * CHAR_PX).toBeLessThanOrEqual(availableWidth());
  });

  it("keeps as much of the head as fits — one more character would overflow", () => {
    containerWidth = 200;
    renderPath(LONG_PATH);
    const display = fittedText();

    // Maximality: the fit is the *most* head text that fits, so a single extra
    // character must not. This is what distinguishes a real binary search from
    // a fixed-length truncation that happens to fit.
    expect((display.length + 1) * CHAR_PX).toBeGreaterThan(availableWidth());
  });

  it("restores the full path once the pill is wide enough again", () => {
    containerWidth = 200;
    renderPath(LONG_PATH);
    expect(fittedText()).not.toBe(LONG_PATH);

    resizeTo(LONG_PATH.length * CHAR_PX + PAD_X + 20);

    expect(fittedText()).toBe(LONG_PATH);
  });

  it("falls back to the bare file name when even an elided head cannot fit", () => {
    // Narrower than "…/file.tsx" — the pane is too small for any head hint.
    containerWidth = PAD_X + BASENAME.length * CHAR_PX;
    renderPath(LONG_PATH);

    expect(fittedText()).toBe("file.tsx");
  });

  it("shows the full text rather than a stale fit while unmeasurable", () => {
    // Zero-width (hidden pane): a stale fit of the *previous* path would be
    // worse than the untruncated text, which CSS truncate still backstops.
    containerWidth = 0;
    renderPath(LONG_PATH);

    expect(fittedText()).toBe(LONG_PATH);
  });

  it("keeps a stable accessible name while showing copied feedback", () => {
    containerWidth = 400;
    const { rerender } = render(
      <FileViewerToolbar.Path path={LONG_PATH} copied={false} onCopy={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: "Copy file path" })).toBeTruthy();

    rerender(<FileViewerToolbar.Path path={LONG_PATH} copied onCopy={vi.fn()} />);

    // The feedback rides the tooltip and the icon, never the accessible name —
    // a name that flips to "Copied!" would make the control unfindable exactly
    // when a test or a screen-reader user goes looking for it.
    expect(screen.getByRole("button", { name: "Copy file path" })).toBeTruthy();
  });

  it("copies on click", () => {
    containerWidth = 400;
    const onCopy = vi.fn();
    fireEvent.click(renderPath(LONG_PATH, { onCopy }));

    expect(onCopy).toHaveBeenCalledTimes(1);
  });
});

describe("FileViewerToolbar.IconButton", () => {
  it("forwards clicks and a test id", () => {
    const onClick = vi.fn();
    render(
      <FileViewerToolbar.IconButton label="Refresh" onClick={onClick} data-testid="refresh-btn">
        <svg />
      </FileViewerToolbar.IconButton>
    );

    fireEvent.click(screen.getByTestId("refresh-btn"));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("is a plain button, not a toggle, when no pressed state is given", () => {
    render(
      <FileViewerToolbar.IconButton label="Refresh" onClick={vi.fn()}>
        <svg />
      </FileViewerToolbar.IconButton>
    );

    // aria-pressed must be absent rather than "false": the latter would
    // announce Refresh as an unpressed toggle.
    expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("aria-pressed")).toBe(
      false
    );
  });

  it("reflects the pressed state of a toggle", () => {
    const { rerender } = render(
      <FileViewerToolbar.IconButton label="Wrap long lines" onClick={vi.fn()} pressed={false}>
        <svg />
      </FileViewerToolbar.IconButton>
    );
    expect(
      screen.getByRole("button", { name: "Wrap long lines" }).getAttribute("aria-pressed")
    ).toBe("false");

    rerender(
      <FileViewerToolbar.IconButton label="Wrap long lines" onClick={vi.fn()} pressed>
        <svg />
      </FileViewerToolbar.IconButton>
    );

    expect(
      screen.getByRole("button", { name: "Wrap long lines" }).getAttribute("aria-pressed")
    ).toBe("true");
  });
});
