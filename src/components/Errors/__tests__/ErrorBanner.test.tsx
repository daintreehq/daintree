// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBanner } from "../ErrorBanner";
import type { ErrorRecord } from "@/store/errorStore";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

function makeError(overrides: Partial<ErrorRecord> = {}): ErrorRecord {
  return {
    id: "err-1",
    timestamp: Date.now(),
    type: "unknown",
    message: "Something failed",
    isTransient: false,
    dismissed: false,
    ...overrides,
  };
}

describe("ErrorBanner", () => {
  const onDismiss = vi.fn();

  describe("icon rendering", () => {
    it("renders an SVG icon in compact mode", () => {
      const { container } = render(
        <ErrorBanner error={makeError()} onDismiss={onDismiss} compact />
      );
      expect(container.querySelector("svg")).toBeTruthy();
    });

    it("renders an SVG icon in full mode", () => {
      const { container } = render(<ErrorBanner error={makeError()} onDismiss={onDismiss} />);
      expect(container.querySelector("svg")).toBeTruthy();
    });

    it("does not contain emoji characters", () => {
      const { container } = render(<ErrorBanner error={makeError()} onDismiss={onDismiss} />);
      const text = container.textContent ?? "";
      for (const emoji of [
        "\u{1F4C2}",
        "\u2699\uFE0F",
        "\u{1F4C1}",
        "\u{1F310}",
        "\u26A0\uFE0F",
        "\u274C",
      ]) {
        expect(text).not.toContain(emoji);
      }
    });

    it("renders a distinct icon for each error type", () => {
      const types = ["git", "process", "filesystem", "network", "config", "unknown"] as const;
      for (const type of types) {
        const { container, unmount } = render(
          <ErrorBanner error={makeError({ type })} onDismiss={onDismiss} />
        );
        expect(container.querySelector("svg")).toBeTruthy();
        unmount();
      }
    });
  });

  it("displays error message", () => {
    render(<ErrorBanner error={makeError({ message: "Git push failed" })} onDismiss={onDismiss} />);
    expect(screen.getByText("Git push failed")).toBeTruthy();
  });

  it("shows recovery hint with lightbulb icon", () => {
    const { container } = render(
      <ErrorBanner error={makeError({ recoveryHint: "Try pulling first" })} onDismiss={onDismiss} />
    );
    expect(screen.getByText("Try pulling first")).toBeTruthy();
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThanOrEqual(2);
  });
});
