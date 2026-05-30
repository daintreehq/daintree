// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ErrorFallback } from "../ErrorFallback";
import { actionService } from "@/services/ActionService";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

function installClipboardMock(): { writeText: ReturnType<typeof vi.fn> } {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return { writeText };
}

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
    installClipboardMock();
    useAnnouncerStore.setState({ polite: null, assertive: null });
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
        screen.getByText("This pane crashed but the rest of Daintree is still running.")
      ).toBeTruthy();
    });

    it("displays full incident ID inside a copy button", () => {
      render(<ErrorFallback {...baseProps} variant="section" />);
      const copyButton = screen.getByTestId("error-fallback-copy-id");
      expect(copyButton.textContent).toBe("error-1710000000000-a3f7b2x");
      expect(copyButton.getAttribute("aria-label")).toBe("Copy error ID");
    });

    it("renders technical details so crash reporters see the stack", () => {
      render(<ErrorFallback {...baseProps} variant="section" />);
      expect(screen.getByText("Technical details")).toBeTruthy();
    });

    it("renders the stack trace inside the details block", () => {
      render(<ErrorFallback {...baseProps} variant="section" />);
      expect(screen.getByText(/at TestComponent/)).toBeTruthy();
    });

    it("keeps the details block collapsed by default (no open attribute)", () => {
      const { container } = render(<ErrorFallback {...baseProps} variant="section" />);
      const details = container.querySelector("details");
      expect(details).toBeTruthy();
      expect(details?.hasAttribute("open")).toBe(false);
    });

    it("scrubs user paths from the displayed stack", () => {
      const error = Object.assign(new Error("boom"), {
        stack: "Error: boom\n    at fn (/Users/alice/project/src/file.ts:10:5)",
      });
      const { container } = render(
        <ErrorFallback {...baseProps} error={error} variant="section" />
      );
      const pre = container.querySelector("pre");
      expect(pre?.textContent).toContain("/Users/USER/project/src/file.ts");
      expect(pre?.textContent).not.toContain("/Users/alice/");
    });

    it("scrubs user paths from the displayed component stack", () => {
      const error = Object.assign(new Error("boom"), { stack: "Error: boom" });
      const errorInfo = {
        componentStack: "\n    at Comp (/home/bob/app/Comp.tsx:3:1)",
      } as React.ErrorInfo;
      const { container } = render(
        <ErrorFallback {...baseProps} error={error} errorInfo={errorInfo} variant="section" />
      );
      const pre = container.querySelector("pre");
      expect(pre?.textContent).toContain("/home/USER/app/Comp.tsx");
      expect(pre?.textContent).not.toContain("/home/bob/");
    });

    it("renders details when only error.stack is present (no componentStack)", () => {
      const error = Object.assign(new Error("boom"), {
        stack: "Error: boom\n    at solo (file.ts:1:1)",
      });
      render(
        <ErrorFallback
          error={error}
          resetError={baseProps.resetError}
          incidentId={baseProps.incidentId}
          variant="section"
        />
      );
      expect(screen.getByText("Technical details")).toBeTruthy();
      expect(screen.getByText(/at solo/)).toBeTruthy();
    });

    it("does not render details when both stack and componentStack are absent", () => {
      const error = Object.assign(new Error("boom"), { stack: undefined });
      const { container } = render(
        <ErrorFallback
          error={error}
          errorInfo={{ componentStack: "" } as React.ErrorInfo}
          resetError={baseProps.resetError}
          incidentId={baseProps.incidentId}
          variant="section"
        />
      );
      expect(screen.queryByText("Technical details")).toBeNull();
      expect(container.querySelector("details")).toBeNull();
    });

    it("renders technical details for the fullscreen variant too", () => {
      render(<ErrorFallback {...baseProps} variant="fullscreen" />);
      expect(screen.getByText("Technical details")).toBeTruthy();
      expect(screen.getByText(/at TestComponent/)).toBeTruthy();
    });

    it("scrubs the component stack when error.stack is absent", () => {
      const error = Object.assign(new Error("boom"), { stack: undefined });
      const errorInfo = {
        componentStack: "\n    at Comp (/home/bob/app/Comp.tsx:3:1)",
      } as React.ErrorInfo;
      const { container } = render(
        <ErrorFallback {...baseProps} error={error} errorInfo={errorInfo} variant="section" />
      );
      const pre = container.querySelector("pre");
      expect(pre?.textContent).toContain("No stack trace available");
      expect(pre?.textContent).toContain("/home/USER/app/Comp.tsx");
      expect(pre?.textContent).not.toContain("/home/bob/");
    });

    it("scrubs Windows user paths from the displayed stack", () => {
      const error = Object.assign(new Error("boom"), {
        stack: "Error: boom\n    at fn (C:\\Users\\alice\\project\\file.ts:10:5)",
      });
      const { container } = render(
        <ErrorFallback {...baseProps} error={error} variant="section" />
      );
      const pre = container.querySelector("pre");
      expect(pre?.textContent).toContain("C:\\Users\\USER\\project\\file.ts");
      expect(pre?.textContent).not.toContain("C:\\Users\\alice\\");
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
      expect(screen.getByText("Technical details")).toBeTruthy();
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
      expect(screen.queryByText("Technical details")).toBeNull();
    });

    it("does not show incident ID in production", () => {
      vi.stubEnv("DEV", false);
      render(<ErrorFallback {...baseProps} variant="component" />);
      expect(screen.queryByText(/Error ID:/)).toBeNull();
    });
  });

  describe("buttons", () => {
    it("calls resetError when Reload pane is clicked", () => {
      vi.stubEnv("DEV", true);
      render(<ErrorFallback {...baseProps} variant="section" />);
      fireEvent.click(screen.getByText("Reload pane"));
      expect(baseProps.resetError).toHaveBeenCalledOnce();
    });

    it("shows Report issue button for section variant with onReport", () => {
      vi.stubEnv("DEV", false);
      const onReport = vi.fn();
      render(<ErrorFallback {...baseProps} variant="section" onReport={onReport} />);
      const btn = screen.getByText("Report issue");
      fireEvent.click(btn);
      expect(onReport).toHaveBeenCalledOnce();
    });

    it("does not show Report issue for component variant", () => {
      vi.stubEnv("DEV", false);
      const onReport = vi.fn();
      render(<ErrorFallback {...baseProps} variant="component" onReport={onReport} />);
      expect(screen.queryByText("Report issue")).toBeNull();
    });

    it("does not show View logs for component variant", () => {
      vi.stubEnv("DEV", false);
      render(<ErrorFallback {...baseProps} variant="component" />);
      expect(screen.queryByText("View logs")).toBeNull();
    });

    it("shows View logs for section variant", () => {
      vi.stubEnv("DEV", false);
      render(<ErrorFallback {...baseProps} variant="section" />);
      expect(screen.getByText("View logs")).toBeTruthy();
    });

    it("shows View logs for fullscreen variant", () => {
      vi.stubEnv("DEV", false);
      render(<ErrorFallback {...baseProps} variant="fullscreen" />);
      expect(screen.getByText("View logs")).toBeTruthy();
    });

    it("dispatches logs.openFile when View logs is clicked", () => {
      vi.stubEnv("DEV", false);
      render(<ErrorFallback {...baseProps} variant="section" />);
      fireEvent.click(screen.getByText("View logs"));
      expect(actionService.dispatch).toHaveBeenCalledWith("logs.openFile", undefined, {
        source: "user",
      });
    });

    it("shows Try again text for fullscreen variant", () => {
      vi.stubEnv("DEV", false);
      render(<ErrorFallback {...baseProps} variant="fullscreen" />);
      const restart = screen.getByTestId("error-fallback-restart");
      expect(restart.textContent).toBe("Try again");
    });

    it("disables Report issue button while reportInFlight is true", () => {
      vi.stubEnv("DEV", false);
      const onReport = vi.fn();
      render(
        <ErrorFallback {...baseProps} variant="section" onReport={onReport} reportInFlight={true} />
      );
      const button = screen.getByTestId("error-fallback-report") as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });

    it("enables Report issue button when reportInFlight is false", () => {
      vi.stubEnv("DEV", false);
      const onReport = vi.fn();
      render(
        <ErrorFallback
          {...baseProps}
          variant="section"
          onReport={onReport}
          reportInFlight={false}
        />
      );
      const button = screen.getByTestId("error-fallback-report") as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
  });

  describe("fullscreen accessibility", () => {
    beforeEach(() => {
      vi.stubEnv("DEV", false);
    });

    it("renders alertdialog role and aria-modal on the fullscreen container", () => {
      render(<ErrorFallback {...baseProps} variant="fullscreen" />);
      const container = screen.getByTestId("error-fallback");
      expect(container.getAttribute("role")).toBe("alertdialog");
      expect(container.getAttribute("aria-modal")).toBe("true");
      expect(container.getAttribute("aria-labelledby")).toBe("error-fallback-title");
      const title = screen.getByTestId("error-fallback-title");
      expect(title.id).toBe("error-fallback-title");
    });

    it("does not apply alertdialog role to section variant", () => {
      render(<ErrorFallback {...baseProps} variant="section" />);
      const container = screen.getByTestId("error-fallback");
      expect(container.getAttribute("role")).toBeNull();
      expect(container.getAttribute("aria-modal")).toBeNull();
      expect(container.getAttribute("aria-labelledby")).toBeNull();
    });

    it("does not apply alertdialog role to component variant", () => {
      render(<ErrorFallback {...baseProps} variant="component" />);
      const container = screen.getByTestId("error-fallback");
      expect(container.getAttribute("role")).toBeNull();
    });

    it("does not assign id to the title for section variant (avoids duplicate IDs)", () => {
      render(<ErrorFallback {...baseProps} variant="section" />);
      const title = screen.getByTestId("error-fallback-title");
      expect(title.id).toBe("");
    });

    it("auto-focuses the primary action button on fullscreen variant", () => {
      render(<ErrorFallback {...baseProps} variant="fullscreen" />);
      expect(document.activeElement).toBe(screen.getByTestId("error-fallback-restart"));
    });
  });

  describe("copy error ID button", () => {
    beforeEach(() => {
      vi.stubEnv("DEV", false);
    });

    it("writes the incident ID to the clipboard on click", async () => {
      const { writeText } = installClipboardMock();
      render(<ErrorFallback {...baseProps} variant="section" />);
      fireEvent.click(screen.getByTestId("error-fallback-copy-id"));
      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith("error-1710000000000-a3f7b2x");
      });
    });

    it("flips the visible label to 'Copied' after a successful copy", async () => {
      render(<ErrorFallback {...baseProps} variant="section" />);
      const button = screen.getByTestId("error-fallback-copy-id");
      fireEvent.click(button);
      await waitFor(() => {
        expect(button.textContent).toBe("Copied");
      });
    });

    it("keeps aria-label constant on the copy button (avoids double-announce)", async () => {
      render(<ErrorFallback {...baseProps} variant="section" />);
      const button = screen.getByTestId("error-fallback-copy-id");
      expect(button.getAttribute("aria-label")).toBe("Copy error ID");
      fireEvent.click(button);
      await waitFor(() => {
        expect(button.textContent).toBe("Copied");
      });
      expect(button.getAttribute("aria-label")).toBe("Copy error ID");
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

  describe("screen-reader announcements (#8937)", () => {
    beforeEach(() => {
      vi.stubEnv("DEV", false);
    });

    it("announces section variant assertively on mount with stopped-working phrasing", () => {
      render(<ErrorFallback {...baseProps} variant="section" componentName="Git panel" />);
      const { assertive, polite } = useAnnouncerStore.getState();
      expect(assertive?.msg).toBe("Git panel stopped working");
      expect(polite).toBeNull();
    });

    it("announces component variant politely on mount with error phrasing", () => {
      render(<ErrorFallback {...baseProps} variant="component" componentName="Recipe runner" />);
      const { polite, assertive } = useAnnouncerStore.getState();
      expect(polite?.msg).toBe("Recipe runner error");
      expect(assertive).toBeNull();
    });

    it("falls back to a generic name when componentName is missing", () => {
      render(<ErrorFallback {...baseProps} variant="section" />);
      expect(useAnnouncerStore.getState().assertive?.msg).toBe("Section stopped working");
    });

    it("does not announce for fullscreen variant (covered by role=alertdialog + autoFocus)", () => {
      render(<ErrorFallback {...baseProps} variant="fullscreen" componentName="App" />);
      const { polite, assertive } = useAnnouncerStore.getState();
      expect(polite).toBeNull();
      expect(assertive).toBeNull();
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
