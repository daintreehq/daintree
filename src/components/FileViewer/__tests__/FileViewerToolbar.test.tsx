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
// The fit callback ignores both ResizeObserver arguments (it re-measures the
// element it already holds), so the double stores it as the zero-arg function
// it really is rather than manufacturing entries and an observer to pass it.
let resizeCallbacks: Array<() => void> = [];

class MockResizeObserver {
  constructor(callback: () => void) {
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
    for (const cb of resizeCallbacks) cb();
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
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the fit only ever touches .font and .measureText().width; a real CanvasRenderingContext2D isn't constructible in jsdom
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
  /** The directory part, which is what the fit is allowed to elide. */
  const HEAD = LONG_PATH.slice(0, LONG_PATH.length - BASENAME.length);

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

  it("keeps both ends of the directory head, not just one", () => {
    containerWidth = 200;
    renderPath(LONG_PATH);
    const display = fittedText();

    // Defaulted for noUncheckedIndexedAccess; the non-empty assertions below
    // are what actually reject a missing side.
    const [front = "", back = ""] = display.slice(0, display.length - BASENAME.length).split("…");
    // Spending the whole budget on the prefix would still fit and still keep
    // the basename — so pin both ends: the kept text must be a genuine prefix
    // AND suffix of the elided directory head, and neither may be empty.
    expect(HEAD.startsWith(front)).toBe(true);
    expect(HEAD.endsWith(back)).toBe(true);
    expect(front.length).toBeGreaterThan(0);
    expect(back.length).toBeGreaterThan(0);
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

  it("shows the full text rather than a stale fit once unmeasurable", () => {
    // Must start from a real fit: mounting straight into zero width would pass
    // on the initial state alone, proving nothing about the guard.
    containerWidth = 200;
    renderPath(LONG_PATH);
    expect(fittedText()).not.toBe(LONG_PATH);

    // Zero-width (hidden pane): a stale fit of the previous path would be worse
    // than the untruncated text, which CSS truncate still backstops.
    resizeTo(0);

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

  it("renders as a disclosure with aria-expanded/aria-controls instead of aria-pressed (#11328)", () => {
    render(
      <FileViewerToolbar.IconButton
        label="Toggle file tree"
        onClick={vi.fn()}
        expanded
        controls="tree-region"
        sidebarToggle
      >
        <svg />
      </FileViewerToolbar.IconButton>
    );

    const button = screen.getByRole("button", { name: "Toggle file tree" });
    // Disclosure semantics: expanded/controls present, pressed absent so it
    // isn't announced as a two-state toggle button.
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe("tree-region");
    expect(button.hasAttribute("aria-pressed")).toBe(false);
    // Opts out of the persistent toolbar armed chip (toolbar.css).
    expect(button.hasAttribute("data-sidebar-toggle")).toBe(true);
  });

  it("omits aria-controls when the disclosed region is unmounted", () => {
    render(
      <FileViewerToolbar.IconButton label="Toggle file tree" onClick={vi.fn()} expanded={false}>
        <svg />
      </FileViewerToolbar.IconButton>
    );

    const button = screen.getByRole("button", { name: "Toggle file tree" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    // A dangling aria-controls would point at a collapsed (removed) region.
    expect(button.hasAttribute("aria-controls")).toBe(false);
    expect(button.hasAttribute("data-sidebar-toggle")).toBe(false);
  });
});
