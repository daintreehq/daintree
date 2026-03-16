// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TerminalRestartStatusBanner } from "../TerminalRestartStatusBanner";
import type { RestartBannerVariant } from "../restartStatus";

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

  it("renders spinner text for auto-restarting variant", () => {
    render(
      <TerminalRestartStatusBanner
        variant={{ type: "auto-restarting" }}
        onRestart={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText("Auto-restarting\u2026")).toBeInTheDocument();
  });

  it("renders exit code message for exit-error variant", () => {
    render(
      <TerminalRestartStatusBanner
        variant={{ type: "exit-error", exitCode: 1 }}
        onRestart={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText("Session exited with code 1")).toBeInTheDocument();
  });

  it("calls onRestart when restart button is clicked", async () => {
    const onRestart = vi.fn();
    render(
      <TerminalRestartStatusBanner
        variant={{ type: "exit-error", exitCode: 1 }}
        onRestart={onRestart}
        onDismiss={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: /restart session/i }));
    expect(onRestart).toHaveBeenCalledOnce();
  });

  it("calls onDismiss when dismiss button is clicked", async () => {
    const onDismiss = vi.fn();
    render(
      <TerminalRestartStatusBanner
        variant={{ type: "exit-error", exitCode: 1 }}
        onRestart={vi.fn()}
        onDismiss={onDismiss}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: /dismiss restart prompt/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
