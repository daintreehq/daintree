// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));

import { actionService } from "@/services/ActionService";
import { useTerminalFontStore } from "@/store";
import { TerminalAppearanceTab } from "../TerminalAppearanceTab";
import { SettingsValidationProvider } from "../SettingsValidationRegistry";

const COMMITTED = 12;

function renderTab() {
  const result = render(
    <SettingsValidationProvider>
      <TerminalAppearanceTab activeSubtab="terminal" onSubtabChange={() => {}} />
    </SettingsValidationProvider>
  );
  const input = result.container.querySelector<HTMLInputElement>(
    '[aria-label="Terminal font size"]'
  )!;
  // The scheme picker's swatches draw at a token size; only the font sample is in px.
  const sampleSize = () =>
    Array.from(result.container.querySelectorAll<HTMLElement>('[style*="font-size"]'))
      .map((el) => el.style.fontSize)
      .filter((size) => size.endsWith("px"));
  return { ...result, input, sampleSize };
}

function fontSizeDispatches() {
  return vi
    .mocked(actionService.dispatch)
    .mock.calls.filter(([id]) => id === "terminalConfig.setFontSize")
    .map(([, args]) => args);
}

beforeEach(() => {
  vi.mocked(actionService.dispatch).mockClear();
  useTerminalFontStore.setState({ fontSize: COMMITTED });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Terminal font size field", () => {
  it("keeps a rejected size in the field beside its error, and applies nothing", async () => {
    const { container, input, sampleSize } = renderTab();

    await act(async () => {
      fireEvent.change(input, { target: { value: "40" } });
      fireEvent.blur(input);
    });

    expect(input.value).toBe("40");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toMatch(/between 8 and 24/);
    expect(sampleSize()).toEqual([`${COMMITTED}px`]);
    expect(fontSizeDispatches()).toEqual([]);
  });

  it("moves the sample with each valid step and saves once the steps settle", async () => {
    vi.useFakeTimers();
    const { input, sampleSize } = renderTab();

    for (const value of ["13", "14", "15"]) {
      act(() => {
        fireEvent.change(input, { target: { value } });
      });
      expect(sampleSize()).toEqual([`${value}px`]);
      // Steps arriving faster than the debounce never reach the setting on their own.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(fontSizeDispatches()).toEqual([]);
    }

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(fontSizeDispatches()).toEqual([{ fontSize: 15 }]);
  });

  it("leaves the sample and the setting alone for an invalid draft", async () => {
    vi.useFakeTimers();
    const { input, sampleSize } = renderTab();

    act(() => {
      fireEvent.change(input, { target: { value: "2" } });
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(sampleSize()).toEqual([`${COMMITTED}px`]);
    expect(fontSizeDispatches()).toEqual([]);
  });

  it("applies on Enter without waiting for blur or the debounce", async () => {
    vi.useFakeTimers();
    const { input } = renderTab();

    await act(async () => {
      fireEvent.change(input, { target: { value: "16" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(fontSizeDispatches()).toEqual([{ fontSize: 16 }]);

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(fontSizeDispatches()).toEqual([{ fontSize: 16 }]);
  });

  it("validates on Enter the same way blur does", async () => {
    const { input } = renderTab();

    await act(async () => {
      fireEvent.change(input, { target: { value: "12.5" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(fontSizeDispatches()).toEqual([]);
  });

  it("reverts a draft on Escape, drops its pending save, and keeps the dialog open", async () => {
    vi.useFakeTimers();
    const { input, sampleSize } = renderTab();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);

    act(() => {
      fireEvent.change(input, { target: { value: "18" } });
      fireEvent.keyDown(input, { key: "Escape" });
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(input.value).toBe(String(COMMITTED));
    expect(sampleSize()).toEqual([`${COMMITTED}px`]);
    expect(fontSizeDispatches()).toEqual([]);
    expect(outer).not.toHaveBeenCalled();

    act(() => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    expect(outer).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", outer);
  });

  it("clears an invalid draft's error on Escape", () => {
    const { input } = renderTab();

    act(() => {
      fireEvent.change(input, { target: { value: "40" } });
      fireEvent.blur(input);
    });
    act(() => {
      fireEvent.keyDown(input, { key: "Escape" });
    });

    expect(input.value).toBe(String(COMMITTED));
    expect(input.getAttribute("aria-invalid")).not.toBe("true");
  });

  it("lets a size changed elsewhere win over a draft still waiting to save", async () => {
    vi.useFakeTimers();
    const { input, sampleSize } = renderTab();

    act(() => {
      fireEvent.change(input, { target: { value: "14" } });
    });
    act(() => {
      useTerminalFontStore.setState({ fontSize: 20 });
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(input.value).toBe("20");
    expect(sampleSize()).toEqual(["20px"]);
    expect(fontSizeDispatches()).toEqual([]);
  });

  it("keeps a previewed step when the tab unmounts before the debounce settles", () => {
    vi.useFakeTimers();
    const { input, unmount } = renderTab();

    act(() => {
      fireEvent.change(input, { target: { value: "14" } });
    });
    unmount();

    expect(fontSizeDispatches()).toEqual([{ fontSize: 14 }]);
  });
});
