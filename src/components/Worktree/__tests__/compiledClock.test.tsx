/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterAll, afterEach } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import path from "path";
import type { ComponentType } from "react";
import { ACTIVITY_HOLD_DURATION, DECAY_DURATION } from "@/utils/colorInterpolation";
import { importCompiled, isComponent, removeCompiledModules } from "./compileWithReactCompiler";

// The hook the components keep time with is compiled too, as it is in the app.
vi.mock("@/hooks/useWallClock", async () => {
  const { importCompiled: compile } = await import("./compileWithReactCompiler");
  const { resolve } = await import("path");
  return compile(resolve(__dirname, "../../../hooks/useWallClock.ts"));
});

/**
 * The app runs these components through React Compiler; vitest does not. The
 * compiler memoizes render-time work by its inputs and cannot see the wall
 * clock move, so a component that reads the time during render passes every
 * uncompiled test while freezing in the app. These tests compile the real
 * source with the app's settings and drive the compiled component.
 */

async function compiled<P>(relativeSource: string, exportName: string): Promise<ComponentType<P>> {
  const value = (await importCompiled(path.resolve(__dirname, relativeSource)))[exportName];
  if (!isComponent<P>(value)) throw new Error(`${exportName} is not a component`);
  return value;
}

function advanceInSteps(totalMs: number, stepMs = 5_000): void {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    act(() => {
      vi.advanceTimersByTime(Math.min(stepMs, totalMs - elapsed));
    });
  }
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

afterAll(() => {
  removeCompiledModules();
});

describe("compiled components keep time", () => {
  it("ActivityLight fades and turns hollow after it mounts", async () => {
    const ActivityLight = await compiled<{ lastActivityTimestamp: number }>(
      "../ActivityLight.tsx",
      "ActivityLight"
    );
    vi.useFakeTimers();
    const start = Date.now();
    const { container } = render(<ActivityLight lastActivityTimestamp={start} />);
    const dot = () => container.querySelector<HTMLElement>("[data-activity-active]")!;
    const held = dot().style.backgroundColor;

    advanceInSteps(ACTIVITY_HOLD_DURATION + (DECAY_DURATION - ACTIVITY_HOLD_DURATION) / 2);
    expect(dot().getAttribute("data-activity-active")).toBe("true");
    expect(dot().style.backgroundColor).not.toBe(held);

    advanceInSteps(DECAY_DURATION);
    expect(dot().getAttribute("data-activity-active")).toBe("false");
  });

  it("LiveTimeAgo advances its label after it mounts", async () => {
    const LiveTimeAgo = await compiled<{ timestamp: number; noTooltip?: boolean }>(
      "../LiveTimeAgo.tsx",
      "LiveTimeAgo"
    );
    vi.useFakeTimers();
    const { container } = render(<LiveTimeAgo timestamp={Date.now()} noTooltip />);
    const first = container.textContent;

    advanceInSteps(3 * 60_000, 60_000);
    expect(container.textContent).not.toBe(first);
  });

  it("reads the clock afresh each time the subject changes, not only the first", async () => {
    const LiveTimeAgo = await compiled<{ timestamp: number; noTooltip?: boolean }>(
      "../LiveTimeAgo.tsx",
      "LiveTimeAgo"
    );
    vi.useFakeTimers();
    const { container, rerender } = render(<LiveTimeAgo timestamp={Date.now()} noTooltip />);
    const justNow = container.textContent;

    for (let change = 0; change < 3; change++) {
      advanceInSteps(10 * 60_000, 60_000);
      rerender(<LiveTimeAgo timestamp={Date.now()} noTooltip />);
      expect(container.textContent).toBe(justNow);
    }
  });
});
