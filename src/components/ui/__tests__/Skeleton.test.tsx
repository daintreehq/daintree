// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

import { Skeleton, SkeletonBone, SkeletonHint, SkeletonText } from "../Skeleton";

const BONE_TEST_ID = "bone";
const TEXT_TEST_ID = "text";

describe("Skeleton", () => {
  describe("ARIA contract", () => {
    it('uses role="status" on the wrapper', () => {
      render(
        <Skeleton>
          <SkeletonBone />
        </Skeleton>
      );
      expect(screen.getByRole("status")).toBeTruthy();
    });

    it("is a polite live region that is never marked busy", () => {
      // `aria-busy` on a live region tells AT to hold back its updates until
      // the region clears — which, on this wrapper, is its own loading message.
      render(<Skeleton />);
      const status = screen.getByRole("status");
      expect(status.getAttribute("aria-live")).toBe("polite");
      expect(status.closest('[aria-busy="true"]')).toBeNull();
    });

    it("uses default label when none provided", () => {
      render(<Skeleton />);
      const status = screen.getByRole("status");
      expect(status.getAttribute("aria-label")).toBe("Loading");
      expect(status.querySelector(".sr-only")?.textContent).toBe("Loading");
    });

    it("respects a custom label", () => {
      render(<Skeleton label="Loading commits" />);
      const status = screen.getByRole("status");
      expect(status.getAttribute("aria-label")).toBe("Loading commits");
      expect(status.querySelector(".sr-only")?.textContent).toBe("Loading commits");
    });

    it("hides each bone from assistive tech via aria-hidden", () => {
      render(
        <Skeleton>
          <SkeletonBone data-testid={BONE_TEST_ID} />
        </Skeleton>
      );
      expect(screen.getByTestId(BONE_TEST_ID).getAttribute("aria-hidden")).toBe("true");
    });

    it("is queryable by accessible name", () => {
      render(<Skeleton label="Loading commits" />);
      expect(screen.getByRole("status", { name: "Loading commits" })).toBeTruthy();
    });
  });

  describe("inert mode", () => {
    it("renders only an aria-hidden wrapper without status semantics", () => {
      render(
        <Skeleton inert data-testid="root">
          <SkeletonBone />
        </Skeleton>
      );
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByTestId("root").getAttribute("aria-hidden")).toBe("true");
    });

    it("does not render the sr-only label when inert", () => {
      const { container } = render(<Skeleton inert label="Loading" />);
      expect(container.querySelector(".sr-only")).toBeNull();
    });
  });

  describe("className passthrough", () => {
    it("merges custom className on the wrapper", () => {
      render(<Skeleton className="my-skeleton" />);
      expect(screen.getByRole("status").className).toContain("my-skeleton");
    });
  });
});

describe("SkeletonBone", () => {
  it("is aria-hidden", () => {
    render(<SkeletonBone data-testid={BONE_TEST_ID} />);
    const bone = screen.getByTestId(BONE_TEST_ID);
    expect(bone.getAttribute("aria-hidden")).toBe("true");
  });

  it("uses animate-pulse-delayed by default", () => {
    render(<SkeletonBone data-testid={BONE_TEST_ID} />);
    expect(screen.getByTestId(BONE_TEST_ID).className).toContain("animate-pulse-delayed");
  });

  it("switches to animate-pulse-immediate when immediate is set", () => {
    render(<SkeletonBone immediate data-testid={BONE_TEST_ID} />);
    const cls = screen.getByTestId(BONE_TEST_ID).className;
    expect(cls).toContain("animate-pulse-immediate");
    expect(cls).not.toContain("animate-pulse-delayed");
  });

  it("does not include shimmer class by default", () => {
    render(<SkeletonBone data-testid={BONE_TEST_ID} />);
    expect(screen.getByTestId(BONE_TEST_ID).className).not.toContain("animate-skeleton-shimmer");
  });

  it("adds animate-skeleton-shimmer when shimmer is set", () => {
    render(<SkeletonBone shimmer data-testid={BONE_TEST_ID} />);
    expect(screen.getByTestId(BONE_TEST_ID).className).toContain("animate-skeleton-shimmer");
  });

  it("applies a fixed pixel height when heightPx is provided", () => {
    render(<SkeletonBone heightPx={68} data-testid={BONE_TEST_ID} />);
    expect(screen.getByTestId(BONE_TEST_ID).style.height).toBe("68px");
  });

  it("heightPx wins over an explicit style.height", () => {
    render(<SkeletonBone heightPx={68} style={{ height: "40px" }} data-testid={BONE_TEST_ID} />);
    expect(screen.getByTestId(BONE_TEST_ID).style.height).toBe("68px");
  });

  it("ignores NaN heightPx", () => {
    render(<SkeletonBone heightPx={Number.NaN} data-testid={BONE_TEST_ID} />);
    expect(screen.getByTestId(BONE_TEST_ID).style.height).toBe("");
  });

  it("ignores negative heightPx", () => {
    render(<SkeletonBone heightPx={-20} data-testid={BONE_TEST_ID} />);
    expect(screen.getByTestId(BONE_TEST_ID).style.height).toBe("");
  });

  it("ignores Infinity heightPx", () => {
    render(<SkeletonBone heightPx={Number.POSITIVE_INFINITY} data-testid={BONE_TEST_ID} />);
    expect(screen.getByTestId(BONE_TEST_ID).style.height).toBe("");
  });

  it("forces aria-hidden true even if a caller passes aria-hidden={false}", () => {
    render(<SkeletonBone aria-hidden={false} data-testid={BONE_TEST_ID} />);
    expect(screen.getByTestId(BONE_TEST_ID).getAttribute("aria-hidden")).toBe("true");
  });

  it("merges custom className", () => {
    render(<SkeletonBone className="w-12 h-4" data-testid={BONE_TEST_ID} />);
    const cls = screen.getByTestId(BONE_TEST_ID).className;
    expect(cls).toContain("w-12");
    expect(cls).toContain("h-4");
  });
});

describe("SkeletonText", () => {
  it("renders 3 lines by default", () => {
    render(<SkeletonText data-testid={TEXT_TEST_ID} />);
    expect(screen.getByTestId(TEXT_TEST_ID).children.length).toBe(3);
  });

  it("renders the requested line count", () => {
    render(<SkeletonText lines={5} data-testid={TEXT_TEST_ID} />);
    expect(screen.getByTestId(TEXT_TEST_ID).children.length).toBe(5);
  });

  it("clamps negative line counts to 0", () => {
    render(<SkeletonText lines={-2} data-testid={TEXT_TEST_ID} />);
    expect(screen.getByTestId(TEXT_TEST_ID).children.length).toBe(0);
  });

  it("clamps non-finite line counts to 0", () => {
    render(<SkeletonText lines={Number.NaN} data-testid={TEXT_TEST_ID} />);
    expect(screen.getByTestId(TEXT_TEST_ID).children.length).toBe(0);
  });

  it("floors fractional line counts", () => {
    render(<SkeletonText lines={3.9} data-testid={TEXT_TEST_ID} />);
    expect(screen.getByTestId(TEXT_TEST_ID).children.length).toBe(3);
  });

  it("clamps absurdly large line counts to a sane ceiling", () => {
    render(<SkeletonText lines={1_000_000} data-testid={TEXT_TEST_ID} />);
    const rendered = screen.getByTestId(TEXT_TEST_ID).children.length;
    expect(rendered).toBeLessThanOrEqual(100);
    expect(rendered).toBeGreaterThan(0);
  });

  it("cycles widths through [w-full, w-3/4, w-1/2]", () => {
    render(<SkeletonText lines={4} data-testid={TEXT_TEST_ID} />);
    const lines = Array.from(screen.getByTestId(TEXT_TEST_ID).children);
    expect(lines[0]?.className).toContain("w-full");
    expect(lines[1]?.className).toContain("w-3/4");
    expect(lines[2]?.className).toContain("w-1/2");
    expect(lines[3]?.className).toContain("w-full");
  });

  it("is aria-hidden on the container", () => {
    render(<SkeletonText lines={1} data-testid={TEXT_TEST_ID} />);
    expect(screen.getByTestId(TEXT_TEST_ID).getAttribute("aria-hidden")).toBe("true");
  });

  it("uses animate-pulse-delayed by default on each line", () => {
    render(<SkeletonText lines={2} data-testid={TEXT_TEST_ID} />);
    for (const line of Array.from(screen.getByTestId(TEXT_TEST_ID).children)) {
      expect(line.className).toContain("animate-pulse-delayed");
    }
  });

  it("switches to animate-pulse-immediate when immediate is set", () => {
    render(<SkeletonText lines={2} immediate data-testid={TEXT_TEST_ID} />);
    for (const line of Array.from(screen.getByTestId(TEXT_TEST_ID).children)) {
      expect(line.className).toContain("animate-pulse-immediate");
    }
  });

  it("layers shimmer on each line when shimmer is set", () => {
    render(<SkeletonText lines={2} shimmer data-testid={TEXT_TEST_ID} />);
    for (const line of Array.from(screen.getByTestId(TEXT_TEST_ID).children)) {
      expect(line.className).toContain("animate-skeleton-shimmer");
    }
  });

  it("respects custom line height and gap classes", () => {
    render(
      <SkeletonText
        lines={2}
        lineHeightClassName="h-6"
        gapClassName="space-y-4"
        data-testid={TEXT_TEST_ID}
      />
    );
    const root = screen.getByTestId(TEXT_TEST_ID);
    expect(root.className).toContain("space-y-4");
    for (const line of Array.from(root.children)) {
      expect(line.className).toContain("h-6");
    }
  });

  it("does not use transition-all", () => {
    const { container } = render(<SkeletonText lines={3} />);
    expect(container.innerHTML).not.toContain("transition-all");
  });
});

describe("SkeletonHint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function advance(ms: number) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  it("renders nothing visible before the first threshold", () => {
    const { container } = render(<SkeletonHint />);
    expect(container.querySelector(".animate-hint-fade-in")).toBeNull();
    expect(screen.queryByText("Still working…")).toBeNull();
  });

  it("always renders an aria-live region so AT registers it up front", () => {
    const { container } = render(<SkeletonHint />);
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).toBeTruthy();
    expect(live?.getAttribute("aria-atomic")).toBe("true");
    expect(live?.classList.contains("sr-only")).toBe(true);
    expect(live?.textContent).toBe("");
  });

  it('shows "Still working…" at exactly 8000ms', () => {
    render(<SkeletonHint />);
    advance(7_999);
    expect(screen.queryByText("Still working…")).toBeNull();
    advance(1);
    expect(screen.getAllByText("Still working…").length).toBeGreaterThan(0);
  });

  it('escalates to "Taking longer than usual…" at 13000ms', () => {
    render(<SkeletonHint />);
    advance(13_000);
    expect(screen.getAllByText("Taking longer than usual…").length).toBeGreaterThan(0);
    expect(screen.queryByText("Still working…")).toBeNull();
  });

  it("updates the sr-only live region copy on phase change", () => {
    const { container } = render(<SkeletonHint />);
    const live = container.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe("");

    advance(8_000);
    expect(live.textContent).toBe("Still working…");

    advance(5_000);
    expect(live.textContent).toBe("Taking longer than usual…");
  });

  it("appends an action affordance announcement to the live region at the action phase", () => {
    const { container } = render(<SkeletonHint onCancel={() => {}} onRetry={() => {}} />);
    const live = container.querySelector('[aria-live="polite"]')!;
    advance(20_000);
    expect(live.textContent).toBe("Taking longer than usual… Cancel and retry options available.");
  });

  it("announces the Cancel affordance at the first phase, before Retry exists", () => {
    const { container } = render(<SkeletonHint onCancel={() => {}} onRetry={() => {}} />);
    const live = container.querySelector('[aria-live="polite"]')!;
    advance(8_000);
    // Cancel surfaces with the first hint; Retry is still gated to the action
    // phase, so only Cancel is announced here.
    expect(live.textContent).toBe("Still working… Cancel option available.");
  });

  it("scopes the action affordance announcement to the handlers actually passed", () => {
    const { container, rerender } = render(<SkeletonHint onCancel={() => {}} />);
    const live = container.querySelector('[aria-live="polite"]')!;
    advance(20_000);
    expect(live.textContent).toBe("Taking longer than usual… Cancel option available.");
    rerender(<SkeletonHint onRetry={() => {}} />);
    advance(20_000);
    expect(live.textContent).toBe("Taking longer than usual… Retry option available.");
  });

  it("does not append an action affordance announcement when no handlers are passed", () => {
    const { container } = render(<SkeletonHint />);
    const live = container.querySelector('[aria-live="polite"]')!;
    advance(20_000);
    expect(live.textContent).toBe("Taking longer than usual…");
  });

  it("does not show action buttons at the action threshold when no handlers are passed", () => {
    render(<SkeletonHint />);
    advance(20_000);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("renders Cancel at the first threshold and fires the handler when clicked", () => {
    const onCancel = vi.fn();
    render(<SkeletonHint onCancel={onCancel} />);
    advance(7_999);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    advance(1);
    const button = screen.getByRole("button", { name: "Cancel" });
    fireEvent.click(button);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps Cancel visible as the copy escalates through later phases", () => {
    render(<SkeletonHint onCancel={() => {}} />);
    advance(8_000);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    advance(5_000); // second phase
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    advance(7_000); // action phase
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("renders Retry only at the action threshold and fires the handler when clicked", () => {
    const onRetry = vi.fn();
    render(<SkeletonHint onRetry={onRetry} />);
    advance(13_000);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    advance(7_000);
    const button = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders both Cancel and Retry at the action threshold when both handlers are passed", () => {
    render(<SkeletonHint onCancel={() => {}} onRetry={() => {}} />);
    advance(20_000);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("shows Cancel but withholds Retry before the action threshold", () => {
    render(<SkeletonHint onCancel={() => {}} onRetry={() => {}} />);
    advance(13_000); // second phase — past first, before action
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("clears all timers on unmount (no leaks)", () => {
    const { unmount } = render(<SkeletonHint />);
    advance(4_999);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("respects custom thresholds", () => {
    render(<SkeletonHint firstThreshold={1_000} secondThreshold={2_000} actionThreshold={3_000} />);
    advance(1_000);
    expect(screen.getAllByText("Still working…").length).toBeGreaterThan(0);
    advance(1_000);
    expect(screen.getAllByText("Taking longer than usual…").length).toBeGreaterThan(0);
  });

  it("clamps out-of-order actionThreshold to monotonic ascending so Retry can't flash early", () => {
    // actionThreshold is intentionally smaller than secondThreshold —
    // without clamping, Retry would flash at 2s then disappear at 3s when
    // setPhase("second") fires. With clamping, action is held to >= second.
    render(
      <SkeletonHint
        firstThreshold={1_000}
        secondThreshold={3_000}
        actionThreshold={2_000}
        onRetry={() => {}}
      />
    );
    advance(2_000);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    advance(1_000);
    // At 3s the clamped action threshold finally fires alongside second.
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("clamps secondThreshold below firstThreshold to firstThreshold (no backward jump)", () => {
    render(<SkeletonHint firstThreshold={5_000} secondThreshold={2_000} />);
    advance(5_000);
    // Both first and second clamped to fire together at 5s — second wins on
    // tick order, so the displayed copy is the second-phase copy.
    expect(screen.getAllByText("Taking longer than usual…").length).toBeGreaterThan(0);
    expect(screen.queryByText("Still working…")).toBeNull();
  });

  it("falls back to defaults for non-finite or negative thresholds", () => {
    render(
      <SkeletonHint
        firstThreshold={Number.NaN}
        secondThreshold={-100}
        actionThreshold={Number.POSITIVE_INFINITY}
      />
    );
    advance(7_999);
    expect(screen.queryByText("Still working…")).toBeNull();
    advance(1);
    expect(screen.getAllByText("Still working…").length).toBeGreaterThan(0);
  });

  it("marks the visible copy span as aria-hidden so AT only hears the live region", () => {
    const { container } = render(<SkeletonHint />);
    advance(8_000);
    const visible = container.querySelector("span.animate-hint-fade-in[aria-hidden='true']");
    expect(visible).toBeTruthy();
    expect(visible?.textContent).toBe("Still working…");
    // Live region is sr-only; the visible span must NOT carry aria-live.
    const liveRegions = container.querySelectorAll('[aria-live="polite"]');
    expect(liveRegions.length).toBe(1);
    expect(liveRegions[0]?.classList.contains("sr-only")).toBe(true);
  });

  it("the hint root is not nested inside any role=status element", () => {
    const { container } = render(
      <div>
        <Skeleton>
          <SkeletonBone />
        </Skeleton>
        <SkeletonHint data-testid="hint" />
      </div>
    );
    const hint = container.querySelector('[data-testid="hint"]')!;
    expect(hint.closest('[role="status"]')).toBeNull();
  });

  function copyNode(container: HTMLElement) {
    return container.querySelector("span.animate-hint-fade-in[aria-hidden='true']");
  }

  it("re-fires the copy's fade when the copy escalates", () => {
    const { container } = render(<SkeletonHint />);
    advance(8_000);
    const first = copyNode(container);
    expect(first?.textContent).toBe("Still working…");
    advance(5_000);
    const second = copyNode(container);
    expect(second?.textContent).toBe("Taking longer than usual…");
    expect(second).not.toBe(first);
  });

  it("keeps the copy node at the action phase when the words do not change", () => {
    const { container } = render(<SkeletonHint />);
    advance(13_000);
    const before = copyNode(container);
    expect(before).toBeTruthy();
    advance(7_000);
    expect(copyNode(container)).toBe(before);
  });

  it("fades Retry in when it surfaces at the action phase", () => {
    render(<SkeletonHint onRetry={() => {}} />);
    advance(20_000);
    expect(screen.getByRole("button", { name: "Retry" }).className).toContain(
      "animate-hint-fade-in"
    );
  });

  it("never remounts Cancel as the copy escalates, so a focused Cancel keeps focus", () => {
    render(<SkeletonHint onCancel={() => {}} onRetry={() => {}} />);
    advance(8_000);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    act(() => cancel.focus());
    expect(document.activeElement).toBe(cancel);
    // Both later rungs change what is on screen: the copy escalates, then Retry surfaces.
    advance(5_000);
    advance(7_000);
    expect(screen.getByRole("button", { name: "Cancel" })).toBe(cancel);
    expect(document.activeElement).toBe(cancel);
  });

  it("keeps a focused Cancel mounted and focused when Retry surfaces beside it", () => {
    render(<SkeletonHint onCancel={() => {}} onRetry={() => {}} />);
    advance(13_000);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    act(() => cancel.focus());
    advance(7_000);
    // A keyboard user who tabbed to Cancel must not be dropped on <body> when
    // the row gains a button: the same node survives and keeps focus.
    expect(screen.getByRole("button", { name: "Cancel" })).toBe(cancel);
    expect(document.activeElement).toBe(cancel);
    const retry = screen.getByRole("button", { name: "Retry" });
    // Retry is the new content, so it is the thing that fades in.
    expect(retry.classList.contains("animate-hint-fade-in")).toBe(true);
  });

  it("does not use transition-all", () => {
    const { container } = render(<SkeletonHint />);
    advance(5_000);
    expect(container.innerHTML).not.toContain("transition-all");
  });

  it("Cancel/Retry buttons use the ghost variant (no accent color)", () => {
    render(<SkeletonHint onCancel={() => {}} onRetry={() => {}} />);
    advance(20_000);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const retry = screen.getByRole("button", { name: "Retry" });
    // Ghost variant uses text-text-secondary, not text-accent-* / bg-primary
    for (const button of [cancel, retry]) {
      expect(button.className).toContain("text-text-secondary");
      expect(button.className).not.toContain("bg-primary");
      expect(button.className).not.toContain("text-accent");
    }
  });

  it("merges custom className on the wrapper", () => {
    const { container } = render(<SkeletonHint className="my-hint" data-testid="hint" />);
    const hint = container.querySelector('[data-testid="hint"]')!;
    expect(hint.className).toContain("my-hint");
  });

  it("prefers a custom message over the generic first-phase copy", () => {
    const { container } = render(<SkeletonHint message="Fetching 3 of 12 files…" />);
    const live = container.querySelector('[aria-live="polite"]')!;
    advance(8_000);
    expect(screen.getAllByText("Fetching 3 of 12 files…").length).toBeGreaterThan(0);
    expect(screen.queryByText("Still working…")).toBeNull();
    expect(live.textContent).toBe("Fetching 3 of 12 files…");
  });

  it("keeps the custom message through the second phase", () => {
    render(<SkeletonHint message="Fetching 3 of 12 files…" />);
    advance(13_000);
    expect(screen.getAllByText("Fetching 3 of 12 files…").length).toBeGreaterThan(0);
    expect(screen.queryByText("Taking longer than usual…")).toBeNull();
  });

  it("falls back to the generic stall copy at the action phase even with a message", () => {
    render(<SkeletonHint message="Fetching 3 of 12 files…" />);
    advance(20_000);
    expect(screen.getAllByText("Taking longer than usual…").length).toBeGreaterThan(0);
    expect(screen.queryByText("Fetching 3 of 12 files…")).toBeNull();
  });

  it("includes the Cancel affordance after a custom message in the live region", () => {
    const { container } = render(
      <SkeletonHint message="Fetching 3 of 12 files…" onCancel={() => {}} />
    );
    const live = container.querySelector('[aria-live="polite"]')!;
    advance(8_000);
    expect(live.textContent).toBe("Fetching 3 of 12 files… Cancel option available.");
  });

  it("falls back to the generic copy when message is an empty string", () => {
    render(<SkeletonHint message="" />);
    advance(8_000);
    expect(screen.getAllByText("Still working…").length).toBeGreaterThan(0);
  });

  it("reflects a changed message immediately while visible", () => {
    const { rerender } = render(<SkeletonHint message="Fetching 1 of 12 files…" />);
    advance(8_000);
    expect(screen.getAllByText("Fetching 1 of 12 files…").length).toBeGreaterThan(0);
    rerender(<SkeletonHint message="Fetching 7 of 12 files…" />);
    expect(screen.getAllByText("Fetching 7 of 12 files…").length).toBeGreaterThan(0);
    expect(screen.queryByText("Fetching 1 of 12 files…")).toBeNull();
  });

  it("renders the copy in the visible (aria-hidden) row, not only the live region", () => {
    const { container } = render(<SkeletonHint message="Fetching 3 of 12 files…" />);
    advance(8_000);
    const visible = container.querySelector('span.animate-hint-fade-in[aria-hidden="true"]');
    expect(visible?.textContent).toBe("Fetching 3 of 12 files…");
  });

  it("withholds Retry one tick before the action threshold and shows it exactly at it", () => {
    render(<SkeletonHint onRetry={() => {}} />);
    advance(19_999);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    advance(1);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("drops Cancel and its announcement when the handler is removed while visible", () => {
    const { container, rerender } = render(<SkeletonHint onCancel={() => {}} />);
    const live = container.querySelector('[aria-live="polite"]')!;
    advance(8_000);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(live.textContent).toBe("Still working… Cancel option available.");
    rerender(<SkeletonHint />);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(live.textContent).toBe("Still working…");
  });
});

describe("animate-hint-fade-in CSS contract", () => {
  const css = readFileSync(resolve(__dirname, "../../../index.css"), "utf8");
  // The `@custom-variant` definitions moved to the design contract, which the
  // plugin Tailwind compiler consumes alongside index.css (#12220). The
  // keyframe and the utility that uses the variant still live in index.css.
  const contractCss = readFileSync(
    resolve(__dirname, "../../../styles/design-contract.css"),
    "utf8"
  );

  it("declares the hint-fade-in keyframe", () => {
    expect(css).toMatch(/@keyframes\s+hint-fade-in\b/);
  });

  it("declares the .animate-hint-fade-in utility class", () => {
    expect(css).toMatch(/\.animate-hint-fade-in\s*\{/);
  });

  it("declares the reduce-motion custom variant", () => {
    expect(contractCss).toMatch(/@custom-variant\s+reduce-motion\s*\{/);
    expect(contractCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    // The body-attribute branch must NOT use `&` — at top-level `@variant`
    // usage, `&` desugars to `:scope` and the resulting selectors never
    // match. CSS nesting auto-prepends the ancestor. See the
    // @custom-variant definition comment in styles/design-contract.css.
    expect(contractCss).toMatch(
      /@custom-variant\s+reduce-motion[\s\S]*?body\[data-reduce-animations="true"\]\s*\{\s*@slot/
    );
  });

  it("disables the fade under @variant reduce-motion (OS + app toggle)", () => {
    expect(css).toMatch(
      /@variant\s+reduce-motion\s*\{[\s\S]*?\.animate-hint-fade-in[\s\S]*?animation:\s*none/
    );
  });

  it("forces opacity 1 under body[data-performance-mode]", () => {
    expect(css).toMatch(
      /body\[data-performance-mode="true"\][\s\S]*?\.animate-hint-fade-in[\s\S]*?opacity:\s*1/
    );
  });
});

describe("animate-skeleton-shimmer CSS contract", () => {
  // Read the source CSS once. Build pipeline transforms (Tailwind, autoprefixer)
  // shouldn't matter — we're asserting authored intent in src/index.css.
  const css = readFileSync(resolve(__dirname, "../../../index.css"), "utf8");

  it("declares the skeleton-shimmer keyframe", () => {
    expect(css).toMatch(/@keyframes\s+skeleton-shimmer\b/);
  });

  it("declares the .animate-skeleton-shimmer utility class", () => {
    expect(css).toMatch(/\.animate-skeleton-shimmer\s*\{/);
  });

  it("hides the ::after sweep under @variant reduce-motion (OS + app toggle)", () => {
    expect(css).toMatch(
      /@variant\s+reduce-motion\s*\{[\s\S]*?\.animate-skeleton-shimmer::after[\s\S]*?display:\s*none/
    );
  });

  it("hides the ::after sweep under body[data-performance-mode]", () => {
    // The rule is a selector list shared with the Pulse skeleton shimmer, so
    // allow the sibling selector between ::after and the declaration block.
    expect(css).toMatch(
      /body\[data-performance-mode="true"\]\s+\.animate-skeleton-shimmer::after[^{]*\{[^}]*display:\s*none/
    );
    expect(css).toMatch(
      /body\[data-performance-mode="true"\]\s+\.pulse-skeleton-shimmer::after[^{]*\{[^}]*display:\s*none/
    );
  });
});

describe("skeleton bone motion CSS contract", () => {
  const css = readFileSync(resolve(__dirname, "../../../index.css"), "utf8");

  /** The body of the first `@keyframes name { … }` block. */
  function keyframes(name: string): string {
    const start = css.search(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = css.indexOf("{", start); i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
    }
    throw new Error(`unterminated @keyframes ${name}`);
  }

  /** The declarations of the first top-level `selector { … }` rule. */
  function rule(selector: string, from = 0): string {
    const at = css.indexOf(`${selector} {`, from);
    expect(at).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at) + 1);
  }

  it("the looping pulse never takes a bone to zero opacity", () => {
    // A looping animation restarts from its first keyframe every iteration. When
    // the anti-flicker gate lived inside the loop (`0% { opacity: 0 }`), every
    // bone blinked out once a cycle. Whatever the loop's shape, none of its
    // stops may hide the bone.
    for (const name of ["skeleton-pulse"]) {
      const stops = [...keyframes(name).matchAll(/opacity:\s*([\d.]+)/g)].map((m) => Number(m[1]));
      expect(stops.length).toBeGreaterThan(1);
      expect(Math.min(...stops)).toBeGreaterThan(0);
    }
  });

  it("every looping skeleton animation is one of the zero-free loops", () => {
    for (const selector of [".animate-pulse-delayed", ".animate-pulse-immediate"]) {
      const body = rule(selector);
      const loops = body.includes("animation-name:")
        ? (() => {
            const names = body.match(/animation-name:\s*([^;]+);/)![1]!.split(",");
            const counts = body.match(/animation-iteration-count:\s*([^;]+);/)![1]!.split(",");
            return names.filter((_, i) => counts[i]?.trim() === "infinite").map((n) => n.trim());
          })()
        : [body.match(/animation:\s*([\w-]+)[^;]*infinite/)![1]!];
      expect(loops, selector).toEqual(["skeleton-pulse"]);
    }
  });

  it("reduced motion keeps the anti-flicker gate on delayed bones", () => {
    // Reduced motion removes motion, not the gate: a static bone that appears
    // for a 100ms load is the flash the gate exists to prevent.
    const variant = css.indexOf("@variant reduce-motion");
    expect(variant).toBeGreaterThan(-1);
    const body = rule(".animate-pulse-delayed", variant);
    expect(body).toMatch(/var\(--anti-flicker-delay\)/);
    expect(body).toMatch(/backwards/);
  });

  it("forced colors gives every bone an outline, since the fill is stripped", () => {
    const forced = css.indexOf("@media (forced-colors: active)");
    expect(forced).toBeGreaterThan(-1);
    const body = rule("[data-skeleton-bone]", forced);
    expect(body).toMatch(/outline:\s*1px solid \w+/);
  });

  it("every rendered bone carries the attribute those modes key off", () => {
    const { container } = render(
      <Skeleton>
        <SkeletonBone />
        <SkeletonText lines={2} />
      </Skeleton>
    );
    const painted = [...container.querySelectorAll("[class*='bg-tint']")];
    expect(painted.length).toBe(3);
    for (const el of painted) expect(el.hasAttribute("data-skeleton-bone")).toBe(true);
  });
});
