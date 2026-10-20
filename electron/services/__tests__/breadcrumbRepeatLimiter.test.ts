import { describe, expect, it } from "vitest";
import {
  BreadcrumbRepeatLimiter,
  REPEATS_PER_WINDOW,
  REPEAT_WINDOW_MS,
  type LimitableBreadcrumb,
} from "../breadcrumbRepeatLimiter.js";

const notFound = (id: string): LimitableBreadcrumb => ({
  category: "console",
  level: "error",
  message: `[IPC] Error on channel terminal:get-info [undefined]: Error: Failed to get terminal info: Terminal terminal-${id} not found`,
});

const ids = [
  "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f",
  "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  "11111111-2222-4333-8444-555555555555",
  "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  "01234567-89ab-4cde-8f01-23456789abcd",
  "fedcba98-7654-4321-8fed-cba987654321",
];

describe("BreadcrumbRepeatLimiter", () => {
  it("keeps six dead terminals polled for three minutes from filling the ring", () => {
    let now = 0;
    const limiter = new BreadcrumbRepeatLimiter(() => now);
    let kept = 0;
    for (; now < 180_000; now += 5_000) {
      for (const id of ids) if (limiter.filter(notFound(id))) kept++;
    }
    // 216 identical answers; the issue saw 147 of them in a 250-slot ring.
    expect(kept).toBeLessThanOrEqual(Math.ceil(180_000 / REPEAT_WINDOW_MS) * REPEATS_PER_WINDOW);
  });

  it("lets unrelated lines through while one repeats", () => {
    const limiter = new BreadcrumbRepeatLimiter(() => 0);
    for (let i = 0; i < 20; i++) limiter.filter(notFound(ids[i % ids.length]));
    const other = {
      category: "console",
      level: "error",
      message: "[WorkspaceHost] Host error: boom",
    };
    expect(limiter.filter(other)).toBe(other);
  });

  it("tells error codes apart", () => {
    const limiter = new BreadcrumbRepeatLimiter(() => 0);
    const exit = (code: number) => ({
      category: "console",
      level: "warn",
      message: `exited ${code}`,
    });
    for (let i = 0; i < REPEATS_PER_WINDOW; i++) limiter.filter(exit(1));
    expect(limiter.filter(exit(1))).toBeNull();
    expect(limiter.filter(exit(2))).not.toBeNull();
  });

  it("says how many repeats were dropped on the next one it keeps", () => {
    let now = 0;
    const limiter = new BreadcrumbRepeatLimiter(() => now);
    for (let i = 0; i < REPEATS_PER_WINDOW + 4; i++) limiter.filter(notFound(ids[0]));
    now = REPEAT_WINDOW_MS;
    expect(limiter.filter(notFound(ids[1]))?.data).toEqual({ suppressedRepeats: 4 });
  });

  it("never limits process, navigation or action breadcrumbs", () => {
    const limiter = new BreadcrumbRepeatLimiter(() => 0);
    const crumb = { category: "child-process", level: "warning", message: "gone" };
    for (let i = 0; i < 50; i++) expect(limiter.filter(crumb)).toBe(crumb);
  });
});
