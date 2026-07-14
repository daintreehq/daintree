// @vitest-environment jsdom
import { useState, type CSSProperties, type ReactNode } from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

// Framer's projection engine needs a real layout engine, so jsdom can never prove
// the thumb *slides*. What it can prove is the configuration framer is handed:
// surface the layout props as attributes and assert the invariants that break the
// effect when they're wrong (a shared id, a lost thumb, a crossfade).
interface MockThumbProps {
  layoutId?: string;
  layoutCrossfade?: boolean;
  transition?: { duration?: number };
  style?: CSSProperties;
  className?: string;
  children?: ReactNode;
  "data-slot"?: string;
  "aria-hidden"?: boolean;
}

vi.mock("framer-motion", () => ({
  useReducedMotion: () => false,
  m: {
    div: ({ layoutId, layoutCrossfade, transition, ...rest }: MockThumbProps) => (
      <div
        {...rest}
        data-layout-id={layoutId}
        data-crossfade={String(layoutCrossfade)}
        data-duration={String(transition?.duration)}
      />
    ),
  },
}));

import { SegmentedToggle, type SegmentedToggleOption } from "../SegmentedToggle";

type Mode = "view" | "diff" | "blame";

const OPTIONS: SegmentedToggleOption<Mode>[] = [
  { value: "view", label: "View" },
  { value: "diff", label: "Diff" },
];

const thumbs = () => document.querySelectorAll("[data-slot='segmented-thumb']");

/** Tailwind's `z-<n>`, ignoring variants — jsdom has no stylesheet to compute against. */
function stackLevel(el: Element): number {
  const match = /(?:^|\s)z-(\d+)(?=\s|$)/.exec(el.className);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

/** Does any utility on this element drop it below full opacity (in any state)? */
function dimsBelowFullOpacity(el: Element): boolean {
  return el.className.split(/\s+/).some((utility) => {
    const match = /(?:^|:)opacity-(\d+)$/.exec(utility);
    return match?.[1] !== undefined && Number(match[1]) < 100;
  });
}

/** The button the sole thumb currently lives in — the whole point of the control. */
function thumbOwner(): Element | null {
  expect(thumbs().length).toBe(1);
  return thumbs()[0]?.closest("button") ?? null;
}

function Controlled({ options = OPTIONS }: { options?: SegmentedToggleOption<Mode>[] }) {
  const [value, setValue] = useState<Mode>("view");
  return <SegmentedToggle options={options} value={value} onChange={setValue} />;
}

afterEach(() => {
  delete document.body.dataset.performanceMode;
});

describe("SegmentedToggle", () => {
  it("gives the sole thumb to the pressed segment", () => {
    render(<Controlled />);

    expect(thumbOwner()).toBe(screen.getByRole("button", { pressed: true }));
  });

  it("hands the thumb to the newly pressed segment on change", () => {
    render(<Controlled />);
    expect(thumbOwner()).toBe(screen.getByRole("button", { name: "View" }));

    fireEvent.click(screen.getByRole("button", { name: "Diff" }));

    expect(thumbOwner()).toBe(screen.getByRole("button", { name: "Diff" }));
    expect(screen.getByRole("button", { name: "Diff" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("moves the thumb across a three-way toggle", () => {
    render(<Controlled options={[...OPTIONS, { value: "blame", label: "Blame" }]} />);

    fireEvent.click(screen.getByRole("button", { name: "Blame" }));

    expect(thumbOwner()).toBe(screen.getByRole("button", { name: "Blame" }));
  });

  it("scopes the layout id per instance so sibling toggles don't share a thumb", () => {
    render(
      <>
        <Controlled />
        <Controlled />
      </>
    );

    const ids = [...thumbs()].map((thumb) => thumb.getAttribute("data-layout-id"));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id && id.length > 0)).toBe(true);
  });

  it("keeps one instance's layout id stable across a value change, so framer can track it", () => {
    render(<Controlled />);
    const before = thumbs()[0]?.getAttribute("data-layout-id");

    fireEvent.click(screen.getByRole("button", { name: "Diff" }));

    expect(thumbs()[0]?.getAttribute("data-layout-id")).toBe(before);
  });

  it("moves the thumb without crossfading it, keeping the motion transform-only", () => {
    render(<Controlled />);

    expect(thumbs()[0]?.getAttribute("data-crossfade")).toBe("false");
  });

  it("hides the thumb from assistive tech and from pointers", () => {
    render(<Controlled />);
    const thumb = thumbs()[0];

    expect(thumb?.getAttribute("aria-hidden")).toBe("true");
    expect(thumb?.className).toContain("pointer-events-none");
  });

  it("animates by default and resolves instantly in performance mode", () => {
    const { unmount } = render(<Controlled />);
    expect(Number(thumbs()[0]?.getAttribute("data-duration"))).toBeGreaterThan(0);
    unmount();

    document.body.dataset.performanceMode = "true";
    render(<Controlled />);

    expect(Number(thumbs()[0]?.getAttribute("data-duration"))).toBe(0);
  });

  it("reports the label to assistive tech, overridden by ariaLabel when given", () => {
    render(
      <SegmentedToggle
        options={[
          { value: "view", label: "S", ariaLabel: "Small" },
          { value: "diff", label: "Diff" },
        ]}
        value="view"
        onChange={() => {}}
      />
    );

    expect(screen.getByRole("button", { name: "Small" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Diff" })).toBeTruthy();
  });

  it("keeps every label stacked above the thumb, including its neighbours'", () => {
    render(<Controlled />);
    const thumb = thumbs()[0];

    // The thumb is a positioned element, so painting order alone would put it over
    // the text — and it overflows into the neighbouring segment mid-slide, so it has
    // to sit below EVERY label, not just the one it shares a button with.
    expect(thumb).toBeDefined();
    for (const label of ["View", "Diff"]) {
      expect(stackLevel(screen.getByText(label))).toBeGreaterThan(stackLevel(thumb!));
    }
  });

  it("does not fire onChange for a disabled segment", () => {
    const onChange = vi.fn();
    render(
      <SegmentedToggle
        options={[
          { value: "view", label: "View" },
          { value: "diff", label: "Diff", disabled: true },
        ]}
        value="view"
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Diff" }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("dims a disabled segment without turning the button into a stacking context", () => {
    render(
      <SegmentedToggle
        options={[
          { value: "view", label: "View" },
          { value: "diff", label: "Diff", disabled: true },
        ]}
        value="view"
        onChange={() => {}}
      />
    );
    const disabled = screen.getByRole("button", { name: "Diff" });

    // Opacity below 1 makes an element a stacking context, which would trap this label
    // at its own z-index and let a thumb sliding over from a sibling paint on top of
    // it. The dimming has to sit on the contents, never on the button.
    expect(dimsBelowFullOpacity(disabled)).toBe(false);
    expect(dimsBelowFullOpacity(within(disabled).getByText("Diff"))).toBe(true);
  });

  it("dims a selected-but-disabled segment whole, thumb included, and keeps its thumb", () => {
    render(
      <SegmentedToggle
        options={[
          { value: "view", label: "View", disabled: true },
          { value: "diff", label: "Diff" },
        ]}
        value="view"
        onChange={() => {}}
      />
    );

    // Unavailable is not unselected: the control must still show what's active.
    expect(thumbOwner()).toBe(screen.getByRole("button", { name: "View" }));
    expect(dimsBelowFullOpacity(thumbs()[0]!)).toBe(true);
    expect(dimsBelowFullOpacity(screen.getByText("View"))).toBe(true);
  });

  it("renders no thumb when the value matches no option", () => {
    render(<SegmentedToggle options={OPTIONS} value={"gone" as Mode} onChange={() => {}} />);

    expect(thumbs().length).toBe(0);
  });
});
