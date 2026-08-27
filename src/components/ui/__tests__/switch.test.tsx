// @vitest-environment jsdom
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Switch, switchThumbVariants, switchVariants } from "../switch";
import { expectNoUnfocusedAccent, utilitiesInGroup } from "./variantAssertions";

const TONES = ["neutral", "warning", "danger"] as const;
const SIZES = ["sm", "md"] as const;

/** Fills a class string declares, split by whether they apply when checked. */
function fills(classes: string, checked: boolean): string[] {
  return classes
    .split(/\s+/)
    .filter((token) =>
      checked ? token.startsWith("data-[state=checked]:bg-") : /^bg-/.test(token)
    )
    .map((token) => token.replace("data-[state=checked]:", ""));
}

describe("Switch behaviour", () => {
  it("reports the next state on each toggle", () => {
    const onCheckedChange = vi.fn();
    const { rerender } = render(
      <Switch aria-label="Notify" checked={false} onCheckedChange={onCheckedChange} />
    );
    fireEvent.click(screen.getByRole("switch"));
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);

    rerender(<Switch aria-label="Notify" checked onCheckedChange={onCheckedChange} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
  });

  it("stays silent while disabled", () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch aria-label="Notify" checked={false} onCheckedChange={onCheckedChange} disabled />
    );
    fireEvent.click(screen.getByRole("switch"));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("forwards the ref and arbitrary props to the control", () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <Switch
        ref={ref}
        aria-label="Notify"
        checked={false}
        onCheckedChange={vi.fn()}
        data-testid="notify-switch"
        name="notify"
      />
    );
    const control = screen.getByRole("switch");
    expect(ref.current).toBe(control);
    expect(control.getAttribute("data-testid")).toBe("notify-switch");
  });

  it("exposes the resolved tone as a data attribute", () => {
    const { rerender } = render(<Switch aria-label="Notify" checked onCheckedChange={vi.fn()} />);
    expect(screen.getByRole("switch").getAttribute("data-tone")).toBe("neutral");

    rerender(<Switch aria-label="Notify" checked onCheckedChange={vi.fn()} tone="danger" />);
    expect(screen.getByRole("switch").getAttribute("data-tone")).toBe("danger");
  });
});

describe("switchVariants", () => {
  it("changes only the checked fill and focus ring between tones", () => {
    const baseline = new Set(switchVariants({ tone: "neutral" }).split(/\s+/));
    for (const tone of TONES.filter((t) => t !== "neutral")) {
      const added = switchVariants({ tone })
        .split(/\s+/)
        .filter((token) => token.length > 0 && !baseline.has(token));
      expect(added.length).toBeGreaterThan(0);
      expect(
        added.every(
          (token) => token.includes("data-[state=checked]:bg-") || token.includes("outline-")
        ),
        added.join(" ")
      ).toBe(true);
    }
  });

  it("keeps the track and thumb geometry paired across sizes", () => {
    for (const size of SIZES) {
      const track = utilitiesInGroup(switchVariants({ size }), "width");
      const thumb = utilitiesInGroup(switchThumbVariants({ size }), "width");
      expect(track).toHaveLength(1);
      expect(thumb).toHaveLength(1);
      // The thumb has to fit inside the track it travels along.
      expect(Number(thumb[0]!.replace("w-", ""))).toBeLessThan(Number(track[0]!.replace("w-", "")));
    }
  });

  // Regression: a resting thumb painted with the ON fill reads as an
  // illuminated indicator, so an off switch looks on.
  it("never paints the resting thumb with a fill that signals on", () => {
    for (const tone of TONES) {
      const restingThumb = fills(switchThumbVariants({ size: "md" }), false);
      const onThumb = fills(switchThumbVariants({ size: "md" }), true);
      const onTrack = fills(switchVariants({ tone }), true);

      expect(restingThumb.length, "the resting thumb needs a fill").toBeGreaterThan(0);
      expect(onTrack.length, "the on track needs a fill").toBeGreaterThan(0);
      expect(restingThumb).not.toEqual(expect.arrayContaining(onTrack));
      expect(restingThumb).not.toEqual(expect.arrayContaining(onThumb));
    }
  });

  it("gives the resting track a boundary of its own", () => {
    expect(switchVariants()).toMatch(/(^|\s)(border|ring-\d)(\s|-|$)/);
  });

  it("moves the track and the thumb on separate, narrow transitions", () => {
    const track = switchVariants();
    const thumb = switchThumbVariants();
    expect(utilitiesInGroup(track, "transition")).toEqual(["transition-colors"]);
    expect(utilitiesInGroup(thumb, "transition")).toEqual(["transition-transform"]);
    expect(track).not.toContain("transition-all");
    expect(thumb).not.toContain("transition-all");
    // The thumb leads and the track settles behind it — same duration on both
    // would flatten the press into a single undifferentiated move.
    expect(track).toContain("duration-200");
    expect(thumb).toContain("duration-100");
  });

  it("spends accent only on the focus ring", () => {
    for (const tone of TONES) {
      expectNoUnfocusedAccent(switchVariants({ tone }));
    }
  });
});
