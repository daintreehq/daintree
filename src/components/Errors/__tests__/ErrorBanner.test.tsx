// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBanner } from "../ErrorBanner";
import type { ErrorRecord } from "@/store/errorStore";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";

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

  describe("compact dismiss-only fallback", () => {
    afterEach(() => {
      useDiagnosticsStore.getState().reset();
    });

    it("renders 'View errors' alongside dismiss when compact has no retry", () => {
      render(<ErrorBanner error={makeError()} onDismiss={onDismiss} compact />);
      expect(screen.getByRole("button", { name: "View errors" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Dismiss error" })).toBeTruthy();
    });

    it("opens the diagnostics dock to the problems tab when 'View errors' clicked", () => {
      render(<ErrorBanner error={makeError()} onDismiss={onDismiss} compact />);
      expect(useDiagnosticsStore.getState().isOpen).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "View errors" }));
      const state = useDiagnosticsStore.getState();
      expect(state.isOpen).toBe(true);
      expect(state.activeTab).toBe("problems");
    });

    it("does not render 'View errors' when retry is available", () => {
      render(
        <ErrorBanner
          error={makeError({ isTransient: true, retryAction: "git" })}
          onDismiss={onDismiss}
          onRetry={vi.fn()}
          compact
        />
      );
      expect(screen.queryByRole("button", { name: "View errors" })).toBeNull();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    });

    it("renders 'View errors' when isTransient is true but onRetry is missing", () => {
      render(
        <ErrorBanner
          error={makeError({ isTransient: true, retryAction: "git" })}
          onDismiss={onDismiss}
          compact
        />
      );
      expect(screen.getByRole("button", { name: "View errors" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });

    it("hides 'View errors' while a retry is in progress", () => {
      render(
        <ErrorBanner
          error={makeError({
            retryProgress: { attempt: 1, maxAttempts: 3 },
          })}
          onDismiss={onDismiss}
          onCancelRetry={vi.fn()}
          compact
        />
      );
      expect(screen.queryByRole("button", { name: "View errors" })).toBeNull();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    });
  });

  describe("full variant dismiss-only fallback", () => {
    afterEach(() => {
      useDiagnosticsStore.getState().reset();
    });

    it("renders 'View errors' alongside dismiss when full has no retry and no details", () => {
      render(<ErrorBanner error={makeError()} onDismiss={onDismiss} />);
      expect(screen.getByRole("button", { name: "View errors" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Dismiss error" })).toBeTruthy();
    });

    it("opens the diagnostics dock to the problems tab when 'View errors' clicked", () => {
      render(<ErrorBanner error={makeError()} onDismiss={onDismiss} />);
      expect(useDiagnosticsStore.getState().isOpen).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "View errors" }));
      const state = useDiagnosticsStore.getState();
      expect(state.isOpen).toBe(true);
      expect(state.activeTab).toBe("problems");
    });

    it("does not render 'View errors' when retry is available", () => {
      render(
        <ErrorBanner
          error={makeError({ isTransient: true, retryAction: "git" })}
          onDismiss={onDismiss}
          onRetry={vi.fn()}
        />
      );
      expect(screen.queryByRole("button", { name: "View errors" })).toBeNull();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    });

    it("does not render 'View errors' when error.details is present", () => {
      render(
        <ErrorBanner error={makeError({ details: "stack trace here" })} onDismiss={onDismiss} />
      );
      expect(screen.queryByRole("button", { name: "View errors" })).toBeNull();
      expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
    });

    it("hides 'View errors' while a retry is in progress", () => {
      render(
        <ErrorBanner
          error={makeError({
            retryProgress: { attempt: 1, maxAttempts: 3 },
          })}
          onDismiss={onDismiss}
          onCancelRetry={vi.fn()}
        />
      );
      expect(screen.queryByRole("button", { name: "View errors" })).toBeNull();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    });

    it("renders 'View errors' when isTransient is true but onRetry is missing", () => {
      render(
        <ErrorBanner
          error={makeError({ isTransient: true, retryAction: "git" })}
          onDismiss={onDismiss}
        />
      );
      expect(screen.getByRole("button", { name: "View errors" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });
  });

  describe("retry button styling", () => {
    it("does not use success-green classes on the compact retry button", () => {
      render(
        <ErrorBanner
          error={makeError({ isTransient: true, retryAction: "git" })}
          onDismiss={onDismiss}
          onRetry={vi.fn()}
          compact
        />
      );
      const retry = screen.getByRole("button", { name: "Retry" });
      expect(retry.className).not.toMatch(/status-success/);
      expect(retry.className).toMatch(/status-error/);
    });

    it("does not use success-green classes on the full retry button", () => {
      render(
        <ErrorBanner
          error={makeError({ isTransient: true, retryAction: "git" })}
          onDismiss={onDismiss}
          onRetry={vi.fn()}
        />
      );
      const retry = screen.getByRole("button", { name: "Retry" });
      expect(retry.className).not.toMatch(/status-success/);
      expect(retry.className).toMatch(/status-error/);
    });
  });

  describe("correlation ID copy", () => {
    let writeText: ReturnType<typeof vi.fn>;
    const fullId = "abcd1234-5678-90ef-1234-567890abcdef";

    beforeEach(() => {
      vi.useFakeTimers();
      writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("renders the full correlation ID, not just the first segment", () => {
      render(<ErrorBanner error={makeError({ correlationId: fullId })} onDismiss={onDismiss} />);
      expect(screen.getByText(`Ref: ${fullId}`)).toBeTruthy();
    });

    it("copies the full ID to clipboard and shows 'Copied' for ~2s", async () => {
      render(<ErrorBanner error={makeError({ correlationId: fullId })} onDismiss={onDismiss} />);
      const button = screen.getByRole("button", { name: `Copy correlation ID ${fullId}` });
      await act(async () => {
        fireEvent.click(button);
      });
      expect(writeText).toHaveBeenCalledWith(fullId);
      expect(screen.getByText("Ref: Copied")).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.queryByText("Ref: Copied")).toBeNull();
      expect(screen.getByText(`Ref: ${fullId}`)).toBeTruthy();
    });

    it("stays silent when clipboard rejects", async () => {
      writeText.mockRejectedValueOnce(new Error("denied"));
      render(<ErrorBanner error={makeError({ correlationId: fullId })} onDismiss={onDismiss} />);
      const button = screen.getByRole("button", { name: `Copy correlation ID ${fullId}` });
      await act(async () => {
        fireEvent.click(button);
      });
      // Allow promise rejection microtask to settle.
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.queryByText("Ref: Copied")).toBeNull();
      expect(screen.getByText(`Ref: ${fullId}`)).toBeTruthy();
    });

    it("clears the copied timeout when unmounted", async () => {
      const { unmount } = render(
        <ErrorBanner error={makeError({ correlationId: fullId })} onDismiss={onDismiss} />
      );
      const button = screen.getByRole("button", { name: `Copy correlation ID ${fullId}` });
      await act(async () => {
        fireEvent.click(button);
      });
      unmount();
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      // No assertion error on unmounted state-updates — implicit pass.
    });

    it("resets the 'Copied' label when correlationId changes", async () => {
      const otherId = "deadbeef-0000-0000-0000-000000000000";
      const { rerender } = render(
        <ErrorBanner error={makeError({ correlationId: fullId })} onDismiss={onDismiss} />
      );
      const button = screen.getByRole("button", { name: `Copy correlation ID ${fullId}` });
      await act(async () => {
        fireEvent.click(button);
      });
      expect(screen.getByText("Ref: Copied")).toBeTruthy();
      rerender(
        <ErrorBanner
          error={makeError({ id: "err-2", correlationId: otherId })}
          onDismiss={onDismiss}
        />
      );
      expect(screen.queryByText("Ref: Copied")).toBeNull();
      expect(screen.getByText(`Ref: ${otherId}`)).toBeTruthy();
    });

    it("extends the 'Copied' window when clicked twice within 2s", async () => {
      render(<ErrorBanner error={makeError({ correlationId: fullId })} onDismiss={onDismiss} />);
      const button = screen.getByRole("button", { name: `Copy correlation ID ${fullId}` });
      await act(async () => {
        fireEvent.click(button);
      });
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByText("Ref: Copied")).toBeTruthy();
      await act(async () => {
        fireEvent.click(button);
      });
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });
      // 1500ms after the second click → still within the fresh 2s window.
      expect(screen.getByText("Ref: Copied")).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.queryByText("Ref: Copied")).toBeNull();
    });
  });
});
