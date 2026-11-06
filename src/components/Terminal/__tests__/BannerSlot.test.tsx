// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { BANNER_ENTER_DURATION, BANNER_EXIT_DURATION } from "@/lib/animationUtils";
import { BannerSlot } from "../TerminalPane";

vi.stubGlobal("requestAnimationFrame", ((cb: FrameRequestCallback): number => {
  const timeoutId = setTimeout(() => cb(0), 0);
  return timeoutId as unknown as number;
}) satisfies typeof requestAnimationFrame);
vi.stubGlobal("cancelAnimationFrame", (id: number) =>
  clearTimeout(id as unknown as NodeJS.Timeout)
);

function getWrapper(container: HTMLElement): HTMLElement | null {
  return container.firstElementChild as HTMLElement | null;
}

describe("BannerSlot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders nothing when visible is false on mount", () => {
    const { container } = render(
      <BannerSlot visible={false}>
        <div data-testid="banner">payload</div>
      </BannerSlot>
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders open at opacity-100 when visible is true on mount (no entry flicker)", () => {
    const { container, getByTestId } = render(
      <BannerSlot visible={true}>
        <div data-testid="banner">payload</div>
      </BannerSlot>
    );
    const wrapper = getWrapper(container);
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).toContain("opacity-100");
    expect(wrapper!.className).toContain("ease-[var(--ease-snappy)]");
    expect(wrapper!.style.transitionDuration).toBe(`${BANNER_ENTER_DURATION}ms`);
    expect(getByTestId("banner")).toBeTruthy();
  });

  it("toggling false → true starts at opacity-0 and opens after one rAF tick", () => {
    const { container, rerender } = render(
      <BannerSlot visible={false}>
        <div data-testid="banner">payload</div>
      </BannerSlot>
    );
    expect(container.firstChild).toBeNull();

    act(() => {
      rerender(
        <BannerSlot visible={true}>
          <div data-testid="banner">payload</div>
        </BannerSlot>
      );
    });

    const pre = getWrapper(container);
    expect(pre).not.toBeNull();
    expect(pre!.className).toContain("opacity-0");
    expect(pre!.className).toContain("ease-[var(--ease-exit)]");
    expect(pre!.style.transitionDuration).toBe(`${BANNER_EXIT_DURATION}ms`);

    act(() => {
      vi.advanceTimersByTime(16);
    });

    const open = getWrapper(container);
    expect(open!.className).toContain("opacity-100");
    expect(open!.className).toContain("ease-[var(--ease-snappy)]");
    expect(open!.style.transitionDuration).toBe(`${BANNER_ENTER_DURATION}ms`);
  });

  it("toggling true → false keeps the child mounted during the exit window, then unmounts", () => {
    const { container, rerender, queryByTestId } = render(
      <BannerSlot visible={true}>
        <div data-testid="banner">payload</div>
      </BannerSlot>
    );
    expect(queryByTestId("banner")).not.toBeNull();

    act(() => {
      rerender(
        <BannerSlot visible={false}>
          <div data-testid="banner">payload</div>
        </BannerSlot>
      );
    });

    const exiting = getWrapper(container);
    expect(exiting).not.toBeNull();
    expect(exiting!.className).toContain("opacity-0");
    expect(exiting!.className).toContain("ease-[var(--ease-exit)]");
    expect(exiting!.style.transitionDuration).toBe(`${BANNER_EXIT_DURATION}ms`);
    expect(queryByTestId("banner")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_DURATION);
    });

    expect(container.firstChild).toBeNull();
  });

  it("renders the last-visible children through the exit window even when null is passed", () => {
    const { container, rerender, queryByTestId } = render(
      <BannerSlot visible={true}>
        <div data-testid="cached">first</div>
      </BannerSlot>
    );
    expect(queryByTestId("cached")).not.toBeNull();

    act(() => {
      rerender(<BannerSlot visible={false}>{null}</BannerSlot>);
    });

    expect(queryByTestId("cached")).not.toBeNull();
    expect(getWrapper(container)!.className).toContain("opacity-0");

    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_DURATION);
    });
    expect(container.firstChild).toBeNull();
  });

  it("cancels a pending exit when visible flips back to true mid-exit", () => {
    const { container, rerender, getByTestId } = render(
      <BannerSlot visible={true}>
        <div data-testid="banner">payload</div>
      </BannerSlot>
    );

    act(() => {
      rerender(
        <BannerSlot visible={false}>
          <div data-testid="banner">payload</div>
        </BannerSlot>
      );
    });
    expect(getWrapper(container)!.className).toContain("opacity-0");

    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_DURATION / 2);
    });

    act(() => {
      rerender(
        <BannerSlot visible={true}>
          <div data-testid="banner">payload</div>
        </BannerSlot>
      );
    });
    act(() => {
      vi.advanceTimersByTime(16);
    });

    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_DURATION);
    });

    const wrapper = getWrapper(container);
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).toContain("opacity-100");
    expect(getByTestId("banner")).toBeTruthy();
  });

  it("cancels a pending entry rAF when visible flips back to false pre-rAF", () => {
    const { container, rerender } = render(
      <BannerSlot visible={false}>
        <div data-testid="banner">payload</div>
      </BannerSlot>
    );

    act(() => {
      rerender(
        <BannerSlot visible={true}>
          <div data-testid="banner">payload</div>
        </BannerSlot>
      );
    });
    expect(getWrapper(container)!.className).toContain("opacity-0");

    act(() => {
      rerender(
        <BannerSlot visible={false}>
          <div data-testid="banner">payload</div>
        </BannerSlot>
      );
    });

    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_DURATION);
    });

    expect(container.firstChild).toBeNull();
  });

  it("goes inert while fading out and is interactive while open", () => {
    const { container, rerender } = render(
      <BannerSlot visible={true}>
        <div>payload</div>
      </BannerSlot>
    );
    expect(getWrapper(container)!.hasAttribute("inert")).toBe(false);

    act(() => {
      rerender(
        <BannerSlot visible={false}>
          <div>payload</div>
        </BannerSlot>
      );
    });
    expect(getWrapper(container)!.hasAttribute("inert")).toBe(true);
  });

  // A height transition resizes the terminal (and its PTY) every frame, so the
  // slot snaps its height and only fades.
  it("uses scoped transition-[opacity], never a height or bare transition", () => {
    const { container } = render(
      <BannerSlot visible={true}>
        <div>payload</div>
      </BannerSlot>
    );
    const wrapper = getWrapper(container)!;
    expect(wrapper.className).toContain("transition-[opacity]");
    expect(wrapper.className).not.toContain("transition-[height]");
    expect(wrapper.className).not.toContain("transition-all");
    expect(wrapper.className.match(/\btransition\b(?!-)/)).toBeNull();
  });

  it("applies pointer-events-none while fading out so stale buttons cannot fire", () => {
    const { container, rerender } = render(
      <BannerSlot visible={true}>
        <button type="button">Retry</button>
      </BannerSlot>
    );
    expect(getWrapper(container)!.className).not.toContain("pointer-events-none");

    act(() => {
      rerender(
        <BannerSlot visible={false}>
          <button type="button">Retry</button>
        </BannerSlot>
      );
    });
    expect(getWrapper(container)!.className).toContain("pointer-events-none");
  });

  it("paired slots overlap during a swap (no zero-height frame)", () => {
    function Pair({ which }: { which: "a" | "b" }) {
      return (
        <>
          <BannerSlot visible={which === "a"}>
            <div data-testid="banner-a">A</div>
          </BannerSlot>
          <BannerSlot visible={which === "b"}>
            <div data-testid="banner-b">B</div>
          </BannerSlot>
        </>
      );
    }

    const { container, rerender, queryByTestId } = render(<Pair which="a" />);
    const initialSlots = container.querySelectorAll(".banner-slot");
    expect(initialSlots.length).toBe(1);
    expect(initialSlots[0]!.className).toContain("opacity-100");

    act(() => {
      rerender(<Pair which="b" />);
    });

    // Both slots mounted: A is fading out (opacity-0, cached children still
    // there, holding its height), B is in its pre-rAF opacity-0 frame about to
    // fade in. Neither has unmounted, so the xterm pane below never sees a
    // 0-height gap.
    const midSlots = container.querySelectorAll(".banner-slot");
    expect(midSlots.length).toBe(2);
    expect(queryByTestId("banner-a")).not.toBeNull();
    expect(queryByTestId("banner-b")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(16);
    });

    // After rAF: B fades in, A is still fading out.
    const slotsAfterRaf = Array.from(container.querySelectorAll(".banner-slot"));
    const slotA = slotsAfterRaf.find((el) => el.contains(queryByTestId("banner-a")!))!;
    const slotB = slotsAfterRaf.find((el) => el.contains(queryByTestId("banner-b")!))!;
    expect(slotA.className).toContain("opacity-0");
    expect(slotB.className).toContain("opacity-100");

    act(() => {
      vi.advanceTimersByTime(BANNER_EXIT_DURATION);
    });
    expect(queryByTestId("banner-a")).toBeNull();
    expect(queryByTestId("banner-b")).not.toBeNull();
  });
});
