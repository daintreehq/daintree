import { describe, expect, it } from "vitest";
import { buttonVariants } from "../button";

describe("buttonVariants", () => {
  it("includes cursor-pointer in the base classes", () => {
    const classes = buttonVariants();
    expect(classes).toContain("cursor-pointer");
  });

  it("uses specific transition instead of transition-all", () => {
    const classes = buttonVariants();
    expect(classes).not.toContain("transition-all");
    // Should contain the base "transition" utility (word boundary check)
    expect(classes).toMatch(/(?:^|\s)transition(?:\s|$)/);
  });

  it("uses asymmetric press timing (1ms down, base duration on release)", () => {
    // Defends against Chromium bug 41304139 where transition-duration: 0s is
    // sometimes ignored. 1ms is imperceptible but unambiguously non-zero.
    const classes = buttonVariants();
    expect(classes).toContain("active:scale-[0.98]");
    expect(classes).toContain("active:duration-[1ms]");
    expect(classes).toContain("duration-150");
  });

  it("includes cursor-pointer across all variants", () => {
    const variants = [
      "default",
      "destructive",
      "outline",
      "secondary",
      "ghost",
      "link",
      "subtle",
      "pill",
      "ghost-danger",
      "ghost-success",
      "ghost-info",
      "info",
      "glow",
      "vibrant",
    ] as const;

    for (const variant of variants) {
      expect(buttonVariants({ variant })).toContain("cursor-pointer");
    }
  });
});
