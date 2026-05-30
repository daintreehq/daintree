// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { DiagnosticCopyButton } from "../DiagnosticCopyButton";

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function stubClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

describe("DiagnosticCopyButton", () => {
  it("renders nothing when all diagnostic fields are absent", () => {
    const { container } = render(<DiagnosticCopyButton diagnostics={{}} />);
    expect(container.firstChild).toBeNull();
  });

  it("formats errno as a number with no quotes", () => {
    render(<DiagnosticCopyButton diagnostics={{ errno: -2 }} />);
    expect(screen.getByTestId("diagnostic-payload").textContent).toBe("errno=-2");
  });

  it("sanitizes escape sequences from path before display", () => {
    render(<DiagnosticCopyButton diagnostics={{ path: "[31m/bad/path" }} />);
    expect(screen.getByTestId("diagnostic-payload").textContent).toBe("path=/bad/path");
  });

  it("writes the same sanitized payload to clipboard as it displays", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<DiagnosticCopyButton diagnostics={{ path: "\x1b[31m/bad/path", syscall: "spawn" }} />);
    fireEvent.click(screen.getByRole("button", { name: /copy diagnostics/i }));
    expect(writeText).toHaveBeenCalledWith("syscall=spawn path=/bad/path");
  });

  it("collapses newlines/tabs/carriage-returns in path or syscall to single spaces", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<DiagnosticCopyButton diagnostics={{ path: "/a/b\n/c\td", syscall: "spa\rwn" }} />);
    fireEvent.click(screen.getByRole("button", { name: /copy diagnostics/i }));
    expect(writeText).toHaveBeenCalledWith("syscall=spa wn path=/a/b /c d");
  });

  it("writes the formatted payload to clipboard and shows Copied state", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    render(
      <DiagnosticCopyButton diagnostics={{ errno: 13, syscall: "spawn", path: "/usr/bin/zsh" }} />
    );

    const button = screen.getByRole("button", { name: /copy diagnostics/i });
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith("errno=13 syscall=spawn path=/usr/bin/zsh");

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: /diagnostics copied/i })).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByRole("button", { name: /copy diagnostics/i })).toBeTruthy();
  });

  it("does not throw when clipboard.writeText is unavailable", () => {
    const original = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });

    try {
      render(<DiagnosticCopyButton diagnostics={{ errno: 1 }} />);
      const button = screen.getByRole("button", { name: /copy diagnostics/i });
      expect(() => fireEvent.click(button)).not.toThrow();
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: original,
      });
    }
  });

  it("ignores stale clipboard resolution after payload change", async () => {
    vi.useFakeTimers();
    let resolveWrite: () => void = () => {};
    const writeText = vi
      .fn()
      .mockImplementation(() => new Promise<void>((resolve) => (resolveWrite = resolve)));
    stubClipboard(writeText);

    const { rerender } = render(<DiagnosticCopyButton diagnostics={{ errno: 1 }} />);
    fireEvent.click(screen.getByRole("button", { name: /copy diagnostics/i }));

    rerender(<DiagnosticCopyButton diagnostics={{ errno: 2 }} />);
    await act(async () => {
      resolveWrite();
      await Promise.resolve();
    });

    expect(screen.queryByRole("button", { name: /diagnostics copied/i })).toBeNull();
  });
});
