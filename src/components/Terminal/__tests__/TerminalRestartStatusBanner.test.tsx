// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TerminalRestartStatusBanner } from "../TerminalRestartStatusBanner";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe("TerminalRestartStatusBanner", () => {
  it("renders nothing for none variant", () => {
    const { container } = render(
      <TerminalRestartStatusBanner
        variant={{ type: "none" }}
        onRestart={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders spinner text for auto-restarting variant and excludes exit-error content", () => {
    render(
      <TerminalRestartStatusBanner
        variant={{ type: "auto-restarting" }}
        onRestart={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText("Auto-restarting\u2026")).toBeTruthy();
    expect(screen.queryByText(/session exited/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /restart session/i })).toBeNull();
  });

  it("auto-restarting variant exposes a polite status live region", () => {
    render(
      <TerminalRestartStatusBanner
        variant={{ type: "auto-restarting" }}
        onRestart={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
  });

  it("exit-error variant uses role=alert without aria-live", () => {
    render(
      <TerminalRestartStatusBanner
        variant={{ type: "exit-error", exitCode: 1 }}
        onRestart={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    const region = screen.getByRole("alert");
    expect(region.hasAttribute("aria-live")).toBe(false);
  });

  it("renders exit code message for exit-error variant and excludes auto-restart content", () => {
    render(
      <TerminalRestartStatusBanner
        variant={{ type: "exit-error", exitCode: 1 }}
        onRestart={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText("Session exited with code 1")).toBeTruthy();
    expect(screen.queryByText("Auto-restarting\u2026")).toBeNull();
  });

  it("calls onRestart when restart button is clicked", () => {
    const onRestart = vi.fn();
    render(
      <TerminalRestartStatusBanner
        variant={{ type: "exit-error", exitCode: 1 }}
        onRestart={onRestart}
        onDismiss={vi.fn()}
      />
    );
    const button = screen.getByRole("button", { name: /restart session/i });
    fireEvent.click(button);
    expect(onRestart).toHaveBeenCalledOnce();
  });

  it("calls onDismiss when dismiss button is clicked", () => {
    const onDismiss = vi.fn();
    render(
      <TerminalRestartStatusBanner
        variant={{ type: "exit-error", exitCode: 1 }}
        onRestart={vi.fn()}
        onDismiss={onDismiss}
      />
    );
    const button = screen.getByRole("button", { name: "Dismiss" });
    fireEvent.click(button);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  describe("session-resume-unavailable variant (issue #9802)", () => {
    it("renders neutral title and a non-accusatory description", () => {
      render(
        <TerminalRestartStatusBanner
          variant={{ type: "session-resume-unavailable" }}
          onRestart={vi.fn()}
          onDismiss={vi.fn()}
        />
      );
      expect(screen.getByText("Session no longer reachable")).toBeTruthy();
      // Neutral phrasing — must not blame the user/agent.
      const description = screen.getByText(/couldn't be restored/i);
      expect(description.textContent).not.toMatch(/expired|you lost|agent closed/i);
    });

    it("uses role=status with a polite live region (toned down per #10823)", () => {
      render(
        <TerminalRestartStatusBanner
          variant={{ type: "session-resume-unavailable" }}
          onRestart={vi.fn()}
          onDismiss={vi.fn()}
        />
      );
      const region = screen.getByRole("status");
      expect(region.getAttribute("aria-live")).toBe("polite");
      expect(region.getAttribute("aria-atomic")).toBe("true");
      // No longer an assertive alert.
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("has no restart action — the terminal already relaunched fresh (#10823)", () => {
      render(
        <TerminalRestartStatusBanner
          variant={{ type: "session-resume-unavailable" }}
          onRestart={vi.fn()}
          onDismiss={vi.fn()}
        />
      );
      expect(screen.queryByRole("button", { name: /start new session/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /restart session/i })).toBeNull();
      // Dismiss is the only control.
      expect(screen.getAllByRole("button")).toHaveLength(1);
    });

    it("has a dismiss control that calls onDismiss (#10823)", () => {
      const onDismiss = vi.fn();
      render(
        <TerminalRestartStatusBanner
          variant={{ type: "session-resume-unavailable" }}
          onRestart={vi.fn()}
          onDismiss={onDismiss}
        />
      );
      const button = screen.getByRole("button", { name: "Dismiss" });
      fireEvent.click(button);
      expect(onDismiss).toHaveBeenCalledOnce();
    });

    // A restart can strand this banner on many panes at once, so the bulk
    // control appears only when the caller says more than one is flagged
    // (#11589) — otherwise the per-pane X already covers the whole set.
    describe("bulk dismissal (issue #11589)", () => {
      it("offers a second control when onDismissAll is supplied", () => {
        render(
          <TerminalRestartStatusBanner
            variant={{ type: "session-resume-unavailable" }}
            onRestart={vi.fn()}
            onDismiss={vi.fn()}
            onDismissAll={vi.fn()}
          />
        );
        expect(screen.getAllByRole("button")).toHaveLength(2);
        expect(screen.getByRole("button", { name: /\bdismiss all\b/i })).toBeTruthy();
      });

      // WCAG "Label in Name": the accessible name must start with the visible
      // label so speech-input users can say what they read, and must add the
      // scope the short label leaves out.
      it("names the bulk control with its visible label plus the missing scope", () => {
        render(
          <TerminalRestartStatusBanner
            variant={{ type: "session-resume-unavailable" }}
            onRestart={vi.fn()}
            onDismiss={vi.fn()}
            onDismissAll={vi.fn()}
          />
        );

        const bulk = screen.getByRole("button", { name: /\bdismiss all\b/i });
        const visible = (bulk.textContent ?? "").trim();
        const accessible = (bulk.getAttribute("aria-label") ?? "").trim();

        expect(visible.length).toBeGreaterThan(0);
        expect(accessible.toLowerCase().startsWith(visible.toLowerCase())).toBe(true);
        expect(accessible.length).toBeGreaterThan(visible.length);
      });

      it("routes each control to its own callback", () => {
        const onDismiss = vi.fn();
        const onDismissAll = vi.fn();
        render(
          <TerminalRestartStatusBanner
            variant={{ type: "session-resume-unavailable" }}
            onRestart={vi.fn()}
            onDismiss={onDismiss}
            onDismissAll={onDismissAll}
          />
        );

        fireEvent.click(screen.getByRole("button", { name: /\bdismiss all\b/i }));
        expect(onDismissAll).toHaveBeenCalledOnce();
        expect(onDismiss).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
        expect(onDismiss).toHaveBeenCalledOnce();
        expect(onDismissAll).toHaveBeenCalledOnce();
      });

      it("still offers no restart action alongside the bulk control", () => {
        render(
          <TerminalRestartStatusBanner
            variant={{ type: "session-resume-unavailable" }}
            onRestart={vi.fn()}
            onDismiss={vi.fn()}
            onDismissAll={vi.fn()}
          />
        );
        expect(screen.queryByRole("button", { name: /restart session/i })).toBeNull();
      });

      it("does not leak the bulk control onto other variants", () => {
        for (const variant of [
          { type: "auto-restarting" },
          { type: "restarting" },
          { type: "exit-error", exitCode: 1 },
        ] as const) {
          const { unmount } = render(
            <TerminalRestartStatusBanner
              variant={variant}
              onRestart={vi.fn()}
              onDismiss={vi.fn()}
              onDismissAll={vi.fn()}
            />
          );
          expect(screen.queryByRole("button", { name: /dismiss all/i })).toBeNull();
          unmount();
        }
      });
    });
  });
});
