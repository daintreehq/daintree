// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("framer-motion", () => {
  const React = require("react");
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: {
      div: React.forwardRef((props: Record<string, unknown>, ref: React.Ref<HTMLDivElement>) => {
        const { initial, animate, exit, transition, ...rest } = props;
        return <div ref={ref} {...rest} />;
      }),
    },
  };
});

import { CelebrationConfetti } from "../CelebrationConfetti";

describe("CelebrationConfetti", () => {
  let matchMediaSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    matchMediaSpy = vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList
    );
  });

  it("renders particles when reduced motion is not active", () => {
    const { container } = render(<CelebrationConfetti />);
    const particles = document.body.querySelectorAll("[class*='rounded-full']");
    expect(particles.length).toBeGreaterThanOrEqual(6);
    expect(particles.length).toBeLessThanOrEqual(8);
  });

  it("renders nothing when prefers-reduced-motion is active", () => {
    matchMediaSpy.mockImplementation(
      (query: string) =>
        ({
          matches: true,
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList
    );

    const { container } = render(<CelebrationConfetti />);
    const particles = document.body.querySelectorAll("[class*='rounded-full']");
    expect(particles.length).toBe(0);
  });

  it("renders with pointer-events-none container", () => {
    render(<CelebrationConfetti />);
    const overlay = document.body.querySelector(".pointer-events-none");
    expect(overlay).not.toBeNull();
  });
});
