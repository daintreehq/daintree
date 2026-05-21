/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePRCircuitBreakerStore } from "@/store/prCircuitBreakerStore";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

import { PRDetectionPausedIndicator } from "../PRDetectionPausedIndicator";

function renderIndicator(defaultOpen = false) {
  return render(
    <TooltipProvider>
      <PRDetectionPausedIndicator defaultOpen={defaultOpen} />
    </TooltipProvider>
  );
}

function resetTripped() {
  usePRCircuitBreakerStore.setState({ tripped: false });
}

describe("PRDetectionPausedIndicator", () => {
  beforeEach(resetTripped);

  describe("when tripped is false", () => {
    it("renders nothing", () => {
      renderIndicator();
      expect(screen.queryByRole("status")).toBeNull();
    });
  });

  describe("when tripped is true", () => {
    beforeEach(() => {
      usePRCircuitBreakerStore.setState({ tripped: true });
    });

    it("renders the status trigger with CloudOff icon", () => {
      const { container } = renderIndicator();

      const status = screen.getByRole("status");
      expect(status.getAttribute("aria-label")).toBe("PR detection paused — retrying");
      expect(status.getAttribute("aria-live")).toBe("polite");
      expect(container.querySelector(".lucide-cloud-off")).toBeTruthy();
    });

    it("renders tooltip content when open", () => {
      renderIndicator(true);

      expect(screen.getAllByText("PR detection paused — retrying").length).toBeGreaterThan(0);
    });

    it("keeps the indicator at normal opacity (no dimming classes)", () => {
      renderIndicator();

      const status = screen.getByRole("status");
      expect(status.className).not.toMatch(/opacity-/);
    });

    it("renders regardless of token state (service-wide signal)", () => {
      renderIndicator();
      expect(screen.getByRole("status")).toBeTruthy();
    });
  });

  describe("state toggling", () => {
    it("mounts when tripped flips true and unmounts when false", () => {
      const { rerender, unmount } = render(
        <TooltipProvider>
          <PRDetectionPausedIndicator />
        </TooltipProvider>
      );

      expect(screen.queryByRole("status")).toBeNull();

      usePRCircuitBreakerStore.setState({ tripped: true });
      rerender(
        <TooltipProvider>
          <PRDetectionPausedIndicator />
        </TooltipProvider>
      );
      expect(screen.getByRole("status")).toBeTruthy();

      usePRCircuitBreakerStore.setState({ tripped: false });
      rerender(
        <TooltipProvider>
          <PRDetectionPausedIndicator />
        </TooltipProvider>
      );
      expect(screen.queryByRole("status")).toBeNull();

      unmount();
    });
  });
});
