// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_TRANSIENT_HINT_DWELL_MS,
} from "@/lib/animationUtils";
import { DockActivityCue, getFinishedCheckMotion } from "../DockActivityCue";

afterEach(cleanup);

function parseExit(animation: string): { duration: number; delay: number } {
  const times = [...animation.matchAll(/(-?\d+(?:\.\d+)?)ms/g)].map((m) => Number(m[1]));
  if (times.length < 2) throw new Error(`no duration + delay in "${animation}"`);
  return { duration: times[0]!, delay: times[1]! };
}

describe("DockActivityCue", () => {
  it("fades the check out completely before the dwell timer unmounts it", () => {
    const { duration, delay } = parseExit(
      String(getFinishedCheckMotion(UI_TRANSIENT_HINT_DWELL_MS).animation)
    );
    expect(delay + duration).toBeLessThanOrEqual(UI_TRANSIENT_HINT_DWELL_MS);
  });

  it("holds the check fully visible between its entry and its exit", () => {
    const { delay } = parseExit(
      String(getFinishedCheckMotion(UI_TRANSIENT_HINT_DWELL_MS).animation)
    );
    expect(delay).toBeGreaterThanOrEqual(UI_ENTER_DURATION);
  });

  it("never schedules the exit before mount for a dwell shorter than the exit", () => {
    const { delay } = parseExit(String(getFinishedCheckMotion(UI_EXIT_DURATION / 2).animation));
    expect(delay).toBeGreaterThanOrEqual(0);
  });

  it("carries its motion on the rendered finished check", () => {
    const { container } = render(<DockActivityCue state="finished" />);
    const check = container.querySelector('[data-dock-activity-state="finished"] svg');
    if (!(check instanceof SVGElement)) throw new Error("finished check glyph not rendered");
    expect(check.style.animation).not.toBe("");
  });

  it("stays silent to assistive tech in both states", () => {
    for (const state of ["working", "finished"] as const) {
      const { container, unmount } = render(<DockActivityCue state={state} />);
      const slot = container.querySelector(`[data-dock-activity-state="${state}"]`);
      expect(slot?.getAttribute("aria-hidden")).toBe("true");
      unmount();
    }
  });
});
