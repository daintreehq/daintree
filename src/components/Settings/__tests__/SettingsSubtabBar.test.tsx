// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { SettingsSubtabBar } from "../SettingsSubtabBar";

const SUBTABS = [
  { id: "claude", label: "Claude" },
  { id: "gemini", label: "Gemini" },
  { id: "codex", label: "Codex" },
];

let resizeObserverCallback: ResizeObserverCallback;
const mockResizeObserver = vi.fn(function (this: unknown, cb: ResizeObserverCallback) {
  resizeObserverCallback = cb;
  return {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };
});

const originalRAF = globalThis.requestAnimationFrame;
const originalCAF = globalThis.cancelAnimationFrame;
const originalResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  globalThis.ResizeObserver = mockResizeObserver as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
  globalThis.cancelAnimationFrame = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.requestAnimationFrame = originalRAF;
  globalThis.cancelAnimationFrame = originalCAF;
  vi.restoreAllMocks();
});

function setScrollGeometry(
  el: HTMLElement,
  {
    scrollWidth,
    clientWidth,
    scrollLeft,
  }: { scrollWidth: number; clientWidth: number; scrollLeft: number }
) {
  Object.defineProperty(el, "scrollWidth", { value: scrollWidth, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: clientWidth, configurable: true });
  Object.defineProperty(el, "scrollLeft", {
    value: scrollLeft,
    configurable: true,
    writable: true,
  });
}

describe("SettingsSubtabBar", () => {
  it("renders all subtab buttons", () => {
    const onChange = vi.fn();
    render(<SettingsSubtabBar subtabs={SUBTABS} activeId="claude" onChange={onChange} />);
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("Gemini")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("calls onChange with the clicked subtab id", () => {
    const onChange = vi.fn();
    render(<SettingsSubtabBar subtabs={SUBTABS} activeId="claude" onChange={onChange} />);
    fireEvent.click(screen.getByText("Gemini").closest("button")!);
    expect(onChange).toHaveBeenCalledWith("gemini");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("renders icons via renderIcon with isActive flag", () => {
    const renderIcon = vi.fn((isActive: boolean) => (
      <span data-testid={isActive ? "active-icon" : "inactive-icon"} />
    ));
    const subtabs = [
      { id: "a", label: "A", renderIcon },
      { id: "b", label: "B", renderIcon },
    ];
    render(<SettingsSubtabBar subtabs={subtabs} activeId="a" onChange={vi.fn()} />);
    expect(screen.getAllByTestId("active-icon")).toHaveLength(1);
    expect(screen.getAllByTestId("inactive-icon")).toHaveLength(1);
  });

  it("does not render trailing wrapper when trailing is undefined", () => {
    const subtabs = [{ id: "a", label: "A" }];
    const { container } = render(
      <SettingsSubtabBar subtabs={subtabs} activeId="a" onChange={vi.fn()} />
    );
    const button = container.querySelector("button[role='tab']")!;
    expect(button.querySelector(".flex.items-center.gap-1")).toBeNull();
  });

  it("renders trailing content", () => {
    const subtabs = [
      {
        id: "a",
        label: "A",
        trailing: <span data-testid="trailing-dot" />,
      },
    ];
    render(<SettingsSubtabBar subtabs={subtabs} activeId="a" onChange={vi.fn()} />);
    expect(screen.getByTestId("trailing-dot")).toBeTruthy();
  });

  it("renders a tablist element", () => {
    render(<SettingsSubtabBar subtabs={SUBTABS} activeId="claude" onChange={vi.fn()} />);
    expect(screen.getByRole("tablist")).toBeTruthy();
  });

  it("returns null when subtabs list is empty", () => {
    const { container } = render(<SettingsSubtabBar subtabs={[]} activeId="" onChange={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("marks active button with aria-selected and role=tab", () => {
    render(<SettingsSubtabBar subtabs={SUBTABS} activeId="gemini" onChange={vi.fn()} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);

    const geminiTab = screen.getByText("Gemini").closest("button")!;
    expect(geminiTab.getAttribute("aria-selected")).toBe("true");
    expect(geminiTab.getAttribute("tabindex")).toBe("0");

    const claudeTab = screen.getByText("Claude").closest("button")!;
    expect(claudeTab.getAttribute("aria-selected")).toBe("false");
    expect(claudeTab.getAttribute("tabindex")).toBe("-1");
  });

  it("navigates tabs with ArrowRight/ArrowLeft keys", () => {
    const onChange = vi.fn();
    render(<SettingsSubtabBar subtabs={SUBTABS} activeId="claude" onChange={onChange} />);
    const tablist = screen.getByRole("tablist");
    const claudeTab = screen.getByText("Claude").closest("button")!;

    claudeTab.focus();
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("gemini");

    onChange.mockClear();
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("claude");
  });

  it("wraps around with ArrowRight on last tab", () => {
    const onChange = vi.fn();
    render(<SettingsSubtabBar subtabs={SUBTABS} activeId="codex" onChange={onChange} />);
    const tablist = screen.getByRole("tablist");
    const codexTab = screen.getByText("Codex").closest("button")!;

    codexTab.focus();
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("claude");
  });

  it("navigates to first/last with Home/End keys", () => {
    const onChange = vi.fn();
    render(<SettingsSubtabBar subtabs={SUBTABS} activeId="gemini" onChange={onChange} />);
    const tablist = screen.getByRole("tablist");
    const geminiTab = screen.getByText("Gemini").closest("button")!;

    geminiTab.focus();
    fireEvent.keyDown(tablist, { key: "Home" });
    expect(onChange).toHaveBeenCalledWith("claude");

    onChange.mockClear();
    fireEvent.keyDown(tablist, { key: "End" });
    expect(onChange).toHaveBeenCalledWith("codex");
  });

  describe("scroll overflow chevrons", () => {
    it("does not render chevrons when content fits", () => {
      render(<SettingsSubtabBar subtabs={SUBTABS} activeId="claude" onChange={vi.fn()} />);
      const tablist = screen.getByRole("tablist");

      act(() => {
        setScrollGeometry(tablist, { scrollWidth: 300, clientWidth: 300, scrollLeft: 0 });
        resizeObserverCallback([], {} as ResizeObserver);
      });

      expect(screen.queryByLabelText("Scroll tabs left")).toBeNull();
      expect(screen.queryByLabelText("Scroll tabs right")).toBeNull();
    });

    it("renders right chevron when scrollable to the right", () => {
      render(<SettingsSubtabBar subtabs={SUBTABS} activeId="claude" onChange={vi.fn()} />);
      const tablist = screen.getByRole("tablist");

      act(() => {
        setScrollGeometry(tablist, { scrollWidth: 500, clientWidth: 300, scrollLeft: 0 });
        resizeObserverCallback([], {} as ResizeObserver);
      });

      expect(screen.queryByLabelText("Scroll tabs right")).toBeTruthy();
      expect(screen.queryByLabelText("Scroll tabs left")).toBeNull();
    });

    it("renders left chevron when scrolled away from start", () => {
      render(<SettingsSubtabBar subtabs={SUBTABS} activeId="claude" onChange={vi.fn()} />);
      const tablist = screen.getByRole("tablist");

      act(() => {
        setScrollGeometry(tablist, { scrollWidth: 500, clientWidth: 300, scrollLeft: 200 });
        resizeObserverCallback([], {} as ResizeObserver);
      });

      expect(screen.queryByLabelText("Scroll tabs left")).toBeTruthy();
      expect(screen.queryByLabelText("Scroll tabs right")).toBeNull();
    });

    it("renders both chevrons when scrolled to middle", () => {
      render(<SettingsSubtabBar subtabs={SUBTABS} activeId="claude" onChange={vi.fn()} />);
      const tablist = screen.getByRole("tablist");

      act(() => {
        setScrollGeometry(tablist, { scrollWidth: 600, clientWidth: 200, scrollLeft: 100 });
        resizeObserverCallback([], {} as ResizeObserver);
      });

      expect(screen.queryByLabelText("Scroll tabs left")).toBeTruthy();
      expect(screen.queryByLabelText("Scroll tabs right")).toBeTruthy();
    });

    it("clicking right chevron calls scrollIntoView on first clipped tab", () => {
      render(<SettingsSubtabBar subtabs={SUBTABS} activeId="claude" onChange={vi.fn()} />);
      const tablist = screen.getByRole("tablist");
      const tabs = screen.getAllByRole("tab");

      act(() => {
        setScrollGeometry(tablist, { scrollWidth: 500, clientWidth: 300, scrollLeft: 0 });
        resizeObserverCallback([], {} as ResizeObserver);
      });

      tablist.getBoundingClientRect = () =>
        ({
          left: 0,
          right: 300,
          top: 0,
          bottom: 40,
          width: 300,
          height: 40,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      tabs[0].getBoundingClientRect = () =>
        ({
          left: 0,
          right: 100,
          top: 0,
          bottom: 40,
          width: 100,
          height: 40,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      tabs[1].getBoundingClientRect = () =>
        ({
          left: 100,
          right: 200,
          top: 0,
          bottom: 40,
          width: 100,
          height: 40,
          x: 100,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      tabs[2].getBoundingClientRect = () =>
        ({
          left: 200,
          right: 350,
          top: 0,
          bottom: 40,
          width: 150,
          height: 40,
          x: 200,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;

      const scrollIntoViewSpy = vi.fn();
      tabs[2].scrollIntoView = scrollIntoViewSpy;

      fireEvent.click(screen.getByLabelText("Scroll tabs right"));
      expect(scrollIntoViewSpy).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "nearest",
        inline: "end",
      });
    });

    it("clicking left chevron calls scrollIntoView on last clipped-left tab", () => {
      render(<SettingsSubtabBar subtabs={SUBTABS} activeId="claude" onChange={vi.fn()} />);
      const tablist = screen.getByRole("tablist");
      const tabs = screen.getAllByRole("tab");

      act(() => {
        setScrollGeometry(tablist, { scrollWidth: 500, clientWidth: 300, scrollLeft: 200 });
        resizeObserverCallback([], {} as ResizeObserver);
      });

      tablist.getBoundingClientRect = () =>
        ({
          left: 0,
          right: 300,
          top: 0,
          bottom: 40,
          width: 300,
          height: 40,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      tabs[0].getBoundingClientRect = () =>
        ({
          left: -100,
          right: -10,
          top: 0,
          bottom: 40,
          width: 90,
          height: 40,
          x: -100,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      tabs[1].getBoundingClientRect = () =>
        ({
          left: 0,
          right: 100,
          top: 0,
          bottom: 40,
          width: 100,
          height: 40,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      tabs[2].getBoundingClientRect = () =>
        ({
          left: 100,
          right: 200,
          top: 0,
          bottom: 40,
          width: 100,
          height: 40,
          x: 100,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;

      const scrollIntoViewSpy = vi.fn();
      tabs[0].scrollIntoView = scrollIntoViewSpy;

      fireEvent.click(screen.getByLabelText("Scroll tabs left"));
      expect(scrollIntoViewSpy).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "nearest",
        inline: "start",
      });
    });

    it("updates chevron visibility on scroll events", () => {
      render(<SettingsSubtabBar subtabs={SUBTABS} activeId="claude" onChange={vi.fn()} />);
      const tablist = screen.getByRole("tablist");

      act(() => {
        setScrollGeometry(tablist, { scrollWidth: 500, clientWidth: 300, scrollLeft: 0 });
        resizeObserverCallback([], {} as ResizeObserver);
      });

      expect(screen.queryByLabelText("Scroll tabs right")).toBeTruthy();
      expect(screen.queryByLabelText("Scroll tabs left")).toBeNull();

      act(() => {
        setScrollGeometry(tablist, { scrollWidth: 500, clientWidth: 300, scrollLeft: 100 });
        fireEvent.scroll(tablist);
      });

      expect(screen.queryByLabelText("Scroll tabs left")).toBeTruthy();
      expect(screen.queryByLabelText("Scroll tabs right")).toBeTruthy();
    });
  });
});
