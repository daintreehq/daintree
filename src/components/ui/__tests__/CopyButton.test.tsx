// @vitest-environment jsdom
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { CopyButton } from "../CopyButton";
import { TooltipProvider } from "../tooltip";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { UI_ACTION_SUCCESS_DWELL_MS } from "@/lib/animationUtils";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

/** The lucide glyph name rendered inside the button (`lucide-copy`, `lucide-check`). */
function glyph(button: HTMLElement): string {
  const svg = button.querySelector("svg");
  return Array.from(svg?.classList ?? []).find((c) => /^lucide-(?!icon$)/.test(c)) ?? "";
}

async function press(button: HTMLElement) {
  await act(async () => {
    fireEvent.click(button);
    await Promise.resolve();
  });
}

describe("CopyButton", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    useAnnouncerStore.setState({ polite: null, assertive: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("confirms with a glyph swap and an announcement while its name stays put", async () => {
    render(<CopyButton text="npm i" aria-label="Copy command" />);
    const button = screen.getByRole("button", { name: "Copy command" });
    const restingGlyph = glyph(button);

    await press(button);

    expect(writeText).toHaveBeenCalledWith("npm i");
    expect(glyph(button)).not.toBe(restingGlyph);
    expect(button.getAttribute("aria-label")).toBe("Copy command");
    expect(useAnnouncerStore.getState().polite?.msg).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(UI_ACTION_SUCCESS_DWELL_MS);
    });
    expect(glyph(button)).toBe(restingGlyph);
  });

  it("never paints the confirmation with a status colour", async () => {
    render(<CopyButton text="x" aria-label="Copy" />);
    const button = screen.getByRole("button", { name: "Copy" });
    await press(button);

    const painted = [button, ...Array.from(button.querySelectorAll("*"))].flatMap((el) =>
      Array.from(el.classList)
    );
    expect(painted.filter((c) => c.includes("status-"))).toEqual([]);
  });

  it("drops the confirmation when the value it copied is replaced", async () => {
    const { rerender } = render(<CopyButton text="/repo/a" aria-label="Copy path" />);
    const button = screen.getByRole("button", { name: "Copy path" });
    const restingGlyph = glyph(button);
    await press(button);
    expect(button.hasAttribute("data-copied")).toBe(true);

    rerender(<CopyButton text="/repo/b" aria-label="Copy path" />);

    expect(button.hasAttribute("data-copied")).toBe(false);
    expect(glyph(button)).toBe(restingGlyph);
  });

  it("reads a function payload at click time", async () => {
    const build = vi.fn(() => "built");
    render(<CopyButton text={build} aria-label="Copy entry" />);
    expect(build).not.toHaveBeenCalled();

    await press(screen.getByRole("button", { name: "Copy entry" }));

    expect(writeText).toHaveBeenCalledWith("built");
  });

  it("lets the caller's click handler cancel the copy", async () => {
    render(<CopyButton text="x" aria-label="Copy" onClick={(e) => e.preventDefault()} />);
    await press(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).not.toHaveBeenCalled();
  });

  describe("labelled", () => {
    it("reads Copied for the dwell, then its label, with a constant name", async () => {
      render(<CopyButton label="Copy MCP config" text="cfg" />);
      const button = screen.getByRole("button", { name: "Copy MCP config" });
      expect(button.textContent).toBe("Copy MCP config");

      await press(button);

      expect(button.textContent).toBe("Copied");
      expect(button.getAttribute("aria-label")).toBe("Copy MCP config");
      expect(useAnnouncerStore.getState().polite?.msg).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(UI_ACTION_SUCCESS_DWELL_MS);
      });
      expect(button.textContent).toBe("Copy MCP config");
    });

    it("reserves room for both words, so the confirmation never moves its neighbours", () => {
      render(<CopyButton label="Copy" text="x" />);
      const reserved = Array.from(
        screen.getByRole("button", { name: "Copy" }).querySelectorAll("[data-label]")
      ).map((el) => el.getAttribute("data-label"));
      // The label, the confirmation and the refusal all size the slot.
      expect(reserved).toContain("Copy");
      expect(reserved).toHaveLength(3);
      expect(reserved.every((word) => word !== null && word.length > 0)).toBe(true);
      expect(new Set(reserved).size).toBe(3);
    });

    it("says a refused write on the button and assertively", async () => {
      writeText.mockRejectedValueOnce(new Error("denied"));
      render(<CopyButton label="Copy JSON" text="{}" />);
      const button = screen.getByRole("button", { name: "Copy JSON" });

      await press(button);

      expect(button.textContent).not.toBe("Copy JSON");
      expect(button.textContent).not.toBe("Copied");
      expect(useAnnouncerStore.getState().assertive?.msg).toBe(button.textContent);
      expect(useAnnouncerStore.getState().polite).toBeNull();
    });

    it("hands a failure to a caller that reports it, with the clipboard's own error", async () => {
      const denied = new Error("denied");
      writeText.mockRejectedValueOnce(denied);
      const onCopyError = vi.fn();
      render(<CopyButton label="Copy" text="k" onCopyError={onCopyError} />);
      const button = screen.getByRole("button", { name: "Copy" });

      await press(button);

      expect(onCopyError).toHaveBeenCalledWith(denied);
      // Stated once, by the caller: the button stays quiet.
      expect(button.textContent).toBe("Copy");
      expect(useAnnouncerStore.getState().assertive).toBeNull();
    });

    it("treats a payload function that throws as a failed copy and writes nothing", async () => {
      const onCopyError = vi.fn();
      render(
        <CopyButton
          label="Copy"
          text={() => Promise.reject(new Error("stale"))}
          onCopyError={onCopyError}
        />
      );

      await press(screen.getByRole("button", { name: "Copy" }));
      await act(async () => {});

      expect(writeText).not.toHaveBeenCalled();
      expect(onCopyError).toHaveBeenCalledWith(expect.objectContaining({ message: "stale" }));
    });

    it("writes through a caller's clipboard when given one", async () => {
      const write = vi.fn(() => Promise.resolve());
      render(<CopyButton label="Copy" text="mkcert -install" write={write} />);
      const button = screen.getByRole("button", { name: "Copy" });

      await press(button);

      expect(write).toHaveBeenCalledWith("mkcert -install");
      expect(writeText).not.toHaveBeenCalled();
      expect(button.textContent).toBe("Copied");
    });
  });

  it("lets a refusal outrank an earlier success still in its dwell", async () => {
    render(<CopyButton label="Copy" text="x" />);
    const button = screen.getByRole("button", { name: "Copy" });
    await press(button);
    expect(button.hasAttribute("data-copied")).toBe(true);

    writeText.mockRejectedValueOnce(new Error("denied"));
    await press(button);

    expect(button.hasAttribute("data-copied")).toBe(false);
    expect(button.textContent).not.toBe("Copied");
  });

  it("writes only the latest click's payload when async payloads resolve out of order", async () => {
    const resolvers: Array<(v: string) => void> = [];
    const text = () => new Promise<string>((resolve) => resolvers.push(resolve));
    render(<CopyButton label="Copy" text={text} />);
    const button = screen.getByRole("button", { name: "Copy" });

    await press(button);
    await press(button);
    await act(async () => {
      resolvers[1]!("newer");
      resolvers[0]!("older");
    });

    expect(writeText.mock.calls.map(([v]) => v)).toEqual(["newer"]);
  });
});
