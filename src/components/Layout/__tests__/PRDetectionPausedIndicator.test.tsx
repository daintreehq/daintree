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

const PAUSED = "PR detection paused — retrying";

describe("PRDetectionPausedIndicator", () => {
  beforeEach(resetTripped);

  describe("when tripped is true", () => {
    beforeEach(() => {
      usePRCircuitBreakerStore.setState({ tripped: true });
    });

    it("renders a focusable status slot with the CloudOff icon", () => {
      const { container } = renderIndicator();

      const slot = screen.getByRole("button", { name: PAUSED });
      expect(slot.hasAttribute("data-toolbar-item")).toBe(true);
      expect(container.querySelector(".lucide-cloud-off")).toBeTruthy();
    });

    it("announces the pause as live-region text", () => {
      renderIndicator();

      const status = screen.getByRole("status");
      expect(status.getAttribute("aria-live")).toBe("polite");
      expect(status.textContent).toBe(PAUSED);
    });

    it("renders tooltip content when open", () => {
      renderIndicator(true);

      expect(screen.getAllByText(PAUSED).length).toBeGreaterThan(0);
    });

    it("keeps the indicator at normal opacity (no dimming classes)", () => {
      renderIndicator();

      expect(screen.getByRole("button", { name: PAUSED }).className).not.toMatch(/opacity-/);
    });

    it("announces without a slot when another slot stands for the fault", () => {
      render(
        <TooltipProvider>
          <PRDetectionPausedIndicator showSlot={false} />
        </TooltipProvider>
      );

      expect(screen.queryByRole("button", { name: PAUSED })).toBeNull();
      expect(screen.getByRole("status").textContent).toBe(PAUSED);
    });
  });

  describe("state toggling", () => {
    it("keeps the live region mounted and shows the slot only while tripped", () => {
      const { rerender, unmount } = render(
        <TooltipProvider>
          <PRDetectionPausedIndicator />
        </TooltipProvider>
      );

      // Mounted empty first, so the pause is a change the region announces.
      expect(screen.getByRole("status").textContent).toBe("");
      expect(screen.queryByRole("button", { name: PAUSED })).toBeNull();

      usePRCircuitBreakerStore.setState({ tripped: true });
      rerender(
        <TooltipProvider>
          <PRDetectionPausedIndicator />
        </TooltipProvider>
      );
      expect(screen.getByRole("status").textContent).toBe(PAUSED);
      expect(screen.getByRole("button", { name: PAUSED })).toBeTruthy();

      usePRCircuitBreakerStore.setState({ tripped: false });
      rerender(
        <TooltipProvider>
          <PRDetectionPausedIndicator />
        </TooltipProvider>
      );
      expect(screen.getByRole("status").textContent).toBe("");
      expect(screen.queryByRole("button", { name: PAUSED })).toBeNull();

      unmount();
    });
  });
});
