// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ErrorFallback } from "../ErrorFallback";

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

describe("ErrorFallback", () => {
  const baseProps = {
    error: Object.assign(new Error("Test error message"), {
      stack: "Error: Test error message\n    at TestComponent (src/Test.tsx:10:5)",
    }),
    errorInfo: {
      componentStack: "\n    at TestComponent\n    at App",
    } as React.ErrorInfo,
    resetError: vi.fn(),
    incidentId: "error-1710000000000-a3f7b2x",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("production mode", () => {
    beforeEach(() => {
      vi.stubEnv("DEV", false);
    });

    it("does not render raw error.message", () => {
      render(<ErrorFallback {...baseProps} variant="section" />);
      expect(screen.queryByText("Test error message")).toBeNull();
    });

    it("shows friendly message instead of raw error", () => {
      render(<ErrorFallback {...baseProps} variant="section" />);
      expect(
        screen.getByText("Something went wrong. Please try again or contact support.")
      ).toBeTruthy();
    });

    it("displays short incident ID", () => {
      render(<ErrorFallback {...baseProps} variant="section" />);
      expect(screen.getByText("Error ID: a3f7b2x")).toBeTruthy();
    });

    it("does not render technical details", () => {
      render(<ErrorFallback {...baseProps} variant="section" />);
      expect(screen.queryByText("Technical Details")).toBeNull();
    });

    it("does not render stack trace", () => {
      render(<ErrorFallback {...baseProps} variant="section" />);
      expect(screen.queryByText(/at TestComponent/)).toBeNull();
    });
  });

  describe("development mode", () => {
    beforeEach(() => {
      vi.stubEnv("DEV", true);
    });

    it("renders raw error.message", () => {
      render(<ErrorFallback {...baseProps} variant="section" />);
      expect(screen.getByText("Test error message")).toBeTruthy();
    });

    it("does not display incident ID", () => {
      render(<ErrorFallback {...baseProps} variant="section" />);
      expect(screen.queryByText(/Error ID:/)).toBeNull();
    });

    it("renders technical details block for section variant", () => {
      render(<ErrorFallback {...baseProps} variant="section" />);
      expect(screen.getByText("Technical Details")).toBeTruthy();
    });

    it("renders stack trace in details", () => {
      render(<ErrorFallback {...baseProps} variant="section" />);
      expect(screen.getByText(/at TestComponent/)).toBeTruthy();
    });
  });

  describe("component variant", () => {
    it("does not show technical details regardless of env", () => {
      vi.stubEnv("DEV", true);
      render(<ErrorFallback {...baseProps} variant="component" />);
      expect(screen.queryByText("Technical Details")).toBeNull();
    });

    it("does not show incident ID in production", () => {
      vi.stubEnv("DEV", false);
      render(<ErrorFallback {...baseProps} variant="component" />);
      expect(screen.queryByText(/Error ID:/)).toBeNull();
    });
  });

  describe("buttons", () => {
    it("calls resetError when Try Again is clicked", () => {
      vi.stubEnv("DEV", true);
      render(<ErrorFallback {...baseProps} variant="section" />);
      fireEvent.click(screen.getByText("Try Again"));
      expect(baseProps.resetError).toHaveBeenCalledOnce();
    });

    it("shows Report Issue button for section variant with onReport", () => {
      vi.stubEnv("DEV", false);
      const onReport = vi.fn();
      render(<ErrorFallback {...baseProps} variant="section" onReport={onReport} />);
      const btn = screen.getByText("Report Issue");
      fireEvent.click(btn);
      expect(onReport).toHaveBeenCalledOnce();
    });

    it("does not show Report Issue for component variant", () => {
      vi.stubEnv("DEV", false);
      const onReport = vi.fn();
      render(<ErrorFallback {...baseProps} variant="component" onReport={onReport} />);
      expect(screen.queryByText("Report Issue")).toBeNull();
    });

    it("shows Restart Application text for fullscreen variant", () => {
      vi.stubEnv("DEV", false);
      render(<ErrorFallback {...baseProps} variant="fullscreen" />);
      expect(screen.getByText("Restart Application")).toBeTruthy();
    });
  });

  describe("icons", () => {
    it("renders an SVG icon instead of emoji for each variant", () => {
      vi.stubEnv("DEV", false);
      for (const variant of ["fullscreen", "section", "component"] as const) {
        const { container, unmount } = render(<ErrorFallback {...baseProps} variant={variant} />);
        expect(container.querySelector("svg")).toBeTruthy();
        expect(container.textContent).not.toContain("\u26A0\uFE0F");
        unmount();
      }
    });

    it("applies correct size class per variant", () => {
      vi.stubEnv("DEV", false);
      const expected = { fullscreen: "size-16", section: "size-9", component: "size-6" } as const;
      for (const [variant, sizeClass] of Object.entries(expected) as [
        keyof typeof expected,
        string,
      ][]) {
        const { container, unmount } = render(<ErrorFallback {...baseProps} variant={variant} />);
        const svg = container.querySelector("svg");
        expect(svg?.getAttribute("class")).toContain(sizeClass);
        unmount();
      }
    });
  });

  describe("incident ID edge cases", () => {
    it("does not render Error ID when incidentId is null", () => {
      vi.stubEnv("DEV", false);
      render(<ErrorFallback {...baseProps} incidentId={null} variant="section" />);
      expect(screen.queryByText(/Error ID:/)).toBeNull();
    });

    it("does not render Error ID when incidentId is undefined", () => {
      vi.stubEnv("DEV", false);
      render(
        <ErrorFallback
          error={baseProps.error}
          errorInfo={baseProps.errorInfo}
          resetError={baseProps.resetError}
          variant="section"
        />
      );
      expect(screen.queryByText(/Error ID:/)).toBeNull();
    });
  });
});
