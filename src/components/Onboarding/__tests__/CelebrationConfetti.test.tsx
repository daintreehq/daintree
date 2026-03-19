// @vitest-environment jsdom
import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: React.forwardRef((props: Record<string, unknown>, ref: React.Ref<HTMLDivElement>) => {
      const {
        initial: _initial,
        animate: _animate,
        exit: _exit,
        transition: _transition,
        ...rest
      } = props;
      return <div ref={ref} {...rest} />;
    }),
  },
}));

import { CelebrationConfetti } from "../CelebrationConfetti";

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  );
}

describe("CelebrationConfetti", () => {
  beforeEach(() => {
    stubMatchMedia(false);
  });

  it("renders particles when reduced motion is not active", () => {
    render(<CelebrationConfetti />);
    const particles = document.body.querySelectorAll("[class*='rounded-full']");
    expect(particles.length).toBeGreaterThanOrEqual(6);
    expect(particles.length).toBeLessThanOrEqual(8);
  });

  it("renders nothing when prefers-reduced-motion is active", () => {
    stubMatchMedia(true);

    render(<CelebrationConfetti />);
    const particles = document.body.querySelectorAll("[class*='rounded-full']");
    expect(particles.length).toBe(0);
  });

  it("renders with pointer-events-none container", () => {
    render(<CelebrationConfetti />);
    const overlay = document.body.querySelector(".pointer-events-none");
    expect(overlay).not.toBeNull();
  });
});
