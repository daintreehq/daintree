// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TerminalRestartStatusBanner } from "../TerminalRestartStatusBanner";

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

  it("renders spinner text for auto-restarting variant", () => {
    render(
      <TerminalRestartStatusBanner
        variant={{ type: "auto-restarting" }}
        onRestart={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText("Auto-restarting\u2026")).toBeTruthy();
  });

  it("renders exit code message for exit-error variant", () => {
    render(
      <TerminalRestartStatusBanner
        variant={{ type: "exit-error", exitCode: 1 }}
        onRestart={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText("Session exited with code 1")).toBeTruthy();
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
    const button = screen.getByRole("button", { name: /dismiss restart prompt/i });
    fireEvent.click(button);
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
