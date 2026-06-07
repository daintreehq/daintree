// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FigureRail } from "../FigureRail";
import type { HelpFigure } from "@/store/helpPanelStore";

// Render the AppDialog-backed lightbox synchronously — bypass the portal store,
// overlay-state side effects, and the enter/exit animation gate.
vi.mock("@/store", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useOverlayState: () => {} };
});

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

function makeFigure(n: number, overrides: Partial<HelpFigure> = {}): HelpFigure {
  return {
    imageId: `img-${n}`,
    figureNumber: n,
    figureLabel: `image #${n}`,
    url: `https://daintree.org/figure-${n}.png`,
    caption: `Caption ${n}`,
    altText: `Alt ${n}`,
    ...overrides,
  };
}

afterEach(cleanup);

describe("FigureRail", () => {
  it("renders nothing when there are no figures", () => {
    const { container } = render(<FigureRail figures={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one thumbnail per figure in arrival order", () => {
    render(<FigureRail figures={[makeFigure(1), makeFigure(2), makeFigure(3)]} />);
    const thumbs = screen.getAllByTestId("figure-thumbnail");
    expect(thumbs).toHaveLength(3);
  });

  it("shows a skeleton while a thumbnail image is pending, then the label once loaded", () => {
    const { container } = render(<FigureRail figures={[makeFigure(1)]} />);
    // Pending: skeleton bone present, label badge absent.
    expect(container.querySelector(".animate-pulse-delayed")).not.toBeNull();
    expect(screen.queryByText("image #1")).toBeNull();

    fireEvent.load(screen.getByAltText("Alt 1"));
    expect(screen.getByText("image #1")).toBeTruthy();
  });

  it("surfaces a retry affordance when a thumbnail image fails, and a retry refetches", () => {
    render(<FigureRail figures={[makeFigure(1)]} />);
    fireEvent.error(screen.getByAltText("Alt 1"));

    expect(screen.getByRole("button", { name: "Retry figure 1" })).toBeTruthy();
    // Failed state unmounts the <img>.
    expect(screen.queryByAltText("Alt 1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry figure 1" }));
    // Retry returns to pending: the <img> remounts and the retry button is gone.
    expect(screen.getByAltText("Alt 1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry figure 1" })).toBeNull();
  });

  it("gives each failed thumbnail a figure-scoped retry label", () => {
    render(<FigureRail figures={[makeFigure(1), makeFigure(2)]} />);
    fireEvent.error(screen.getByAltText("Alt 1"));
    fireEvent.error(screen.getByAltText("Alt 2"));

    expect(screen.getByRole("button", { name: "Retry figure 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry figure 2" })).toBeTruthy();
  });

  it("sets referrerPolicy=no-referrer on thumbnail images", () => {
    render(<FigureRail figures={[makeFigure(1)]} />);
    expect(screen.getByAltText("Alt 1").getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("highlights only the newest figure with the arrival animation", () => {
    render(<FigureRail figures={[makeFigure(1), makeFigure(2)]} />);
    const thumbs = screen.getAllByTestId("figure-thumbnail");
    expect(thumbs[0]!.classList.contains("animate-figure-arrive")).toBe(false);
    expect(thumbs[1]!.classList.contains("animate-figure-arrive")).toBe(true);
  });

  it("opens the lightbox with an attribution frame when a loaded thumbnail is clicked", () => {
    render(<FigureRail figures={[makeFigure(1), makeFigure(2)]} />);
    fireEvent.load(screen.getByAltText("Alt 1"));
    fireEvent.click(screen.getByRole("button", { name: "Figure 1: Caption 1" }));

    const lightbox = screen.getByTestId("figure-lightbox");
    expect(within(lightbox).getByText("image #1 · Daintree docs")).toBeTruthy();
    expect(within(lightbox).getByText("Caption 1")).toBeTruthy();
    expect(within(lightbox).getByText("Viewing figure 1 of 2")).toBeTruthy();
  });

  it("navigates figures with arrow keys, clamped at both ends", () => {
    render(<FigureRail figures={[makeFigure(1), makeFigure(2)]} />);
    fireEvent.load(screen.getByAltText("Alt 1"));
    fireEvent.click(screen.getByRole("button", { name: "Figure 1: Caption 1" }));

    const lightbox = screen.getByTestId("figure-lightbox");
    // Clamp at the start: ArrowLeft on the first figure is a no-op.
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(within(lightbox).getByText("Viewing figure 1 of 2")).toBeTruthy();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(within(lightbox).getByText("Viewing figure 2 of 2")).toBeTruthy();

    // Clamp at the end: ArrowRight on the last figure is a no-op.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(within(lightbox).getByText("Viewing figure 2 of 2")).toBeTruthy();
  });

  it("auto-closes the lightbox when its figure disappears (session reset / eviction)", () => {
    const { rerender } = render(<FigureRail figures={[makeFigure(1), makeFigure(2)]} />);
    fireEvent.load(screen.getByAltText("Alt 2"));
    fireEvent.click(screen.getByRole("button", { name: "Figure 2: Caption 2" }));
    expect(screen.getByTestId("figure-lightbox")).toBeTruthy();

    // Figure 2 is gone in the next render — the lightbox must not linger on a
    // stale selection.
    rerender(<FigureRail figures={[makeFigure(1)]} />);
    expect(screen.queryByTestId("figure-lightbox")).toBeNull();
  });

  it("closes the lightbox via its close button", () => {
    render(<FigureRail figures={[makeFigure(1)]} />);
    fireEvent.load(screen.getByAltText("Alt 1"));
    fireEvent.click(screen.getByRole("button", { name: "Figure 1: Caption 1" }));
    expect(screen.getByTestId("figure-lightbox")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByTestId("figure-lightbox")).toBeNull();
  });

  // Animated WebP (#10278) plays via the native image decoder; the render path
  // must hand the original URL straight to a plain <img> with no poster/still
  // swap, in both the thumbnail and the lightbox, so the animation can loop.
  it("passes an animated WebP url through unmodified to the thumbnail img", () => {
    const url = "https://daintree.org/demo-loop.webp";
    render(<FigureRail figures={[makeFigure(1, { url })]} />);

    const img = screen.getByAltText("Alt 1");
    expect(img.getAttribute("src")).toBe(url);
    // No still-frame substitution: the rendered element is a plain <img>, not a
    // <canvas>/<video> poster surface.
    expect(img.tagName).toBe("IMG");
  });

  it("opens an animated WebP figure in the lightbox with the same unmodified url, and it becomes visible on load", () => {
    const url = "https://daintree.org/demo-loop.webp";
    render(<FigureRail figures={[makeFigure(1, { url })]} />);
    fireEvent.load(screen.getByAltText("Alt 1"));
    fireEvent.click(screen.getByRole("button", { name: "Figure 1: Caption 1" }));

    const lightbox = screen.getByTestId("figure-lightbox");
    const img = within(lightbox).getByAltText("Alt 1");
    expect(img.getAttribute("src")).toBe(url);
    expect(img.tagName).toBe("IMG");
    // referrerPolicy must carry into the lightbox path too.
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");

    // The lightbox img starts hidden (opacity-0) and reveals on load — a broken
    // onLoad handler would leave an animated WebP permanently invisible.
    expect(img.classList.contains("opacity-0")).toBe(true);
    fireEvent.load(img);
    expect(img.classList.contains("opacity-100")).toBe(true);
  });

  it("renders an animated WebP as a plain looping img with no still-frame swap, even under prefers-reduced-motion", () => {
    // Chromium 148 does not pause native animated images for
    // prefers-reduced-motion (no shipped CSS image-animation property), so the
    // component intentionally keeps rendering a plain looping <img> — no canvas,
    // <video>, or poster still-frame substitution. This guards the documented
    // design decision: a future reduce-motion still-frame path must arrive with
    // a server-supplied poster URL, not by silently swapping the render element.
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    );

    try {
      const url = "https://daintree.org/demo-loop.webp";
      const { container } = render(<FigureRail figures={[makeFigure(1, { url })]} />);

      const img = screen.getByAltText("Alt 1");
      expect(img.tagName).toBe("IMG");
      expect(img.getAttribute("src")).toBe(url);
      // No still-frame substitution surface anywhere in the rail.
      expect(container.querySelector("canvas")).toBeNull();
      expect(container.querySelector("video")).toBeNull();
      expect(img.hasAttribute("poster")).toBe(false);
    } finally {
      // Restore only matchMedia — vi.unstubAllGlobals() would also wipe the
      // module-level ResizeObserver stub other tests rely on. The finally block
      // ensures cleanup even if an assertion above throws.
      vi.stubGlobal("matchMedia", undefined);
    }
  });
});
