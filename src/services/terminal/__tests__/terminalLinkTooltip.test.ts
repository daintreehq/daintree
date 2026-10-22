// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_TOOLTIP_DELAY_DURATION } from "@/lib/animationUtils";
import { hideTerminalLinkTooltip, showTerminalLinkTooltip } from "../terminalLinkTooltip";

/** A terminal whose element is laid out (jsdom lays nothing out) unless `hidden`. */
function terminalWithElement(hidden = false) {
  const element = document.createElement("div");
  Object.defineProperty(element, "getClientRects", { value: () => ({ length: hidden ? 0 : 1 }) });
  document.body.appendChild(element);
  return { terminal: { element }, element };
}

const hover = new MouseEvent("mousemove", { clientX: 10, clientY: 10 });

function tooltips(element: HTMLElement): Element[] {
  return Array.from(element.querySelectorAll('[role="tooltip"]'));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("terminal link tooltip", () => {
  it("shows the label as text after the tooltip delay", () => {
    const { terminal, element } = terminalWithElement();
    showTerminalLinkTooltip(terminal, hover, "Open with <b>Acme</b>");
    expect(tooltips(element)).toHaveLength(0);
    vi.advanceTimersByTime(UI_TOOLTIP_DELAY_DURATION);
    const [tip] = tooltips(element);
    expect(tip?.textContent).toBe("Open with <b>Acme</b>");
    expect(tip?.querySelector("b")).toBeNull();
  });

  it("keeps one tooltip per terminal, and hiding cancels a pending one", () => {
    const { terminal, element } = terminalWithElement();
    showTerminalLinkTooltip(terminal, hover, "First");
    showTerminalLinkTooltip(terminal, hover, "Second");
    vi.advanceTimersByTime(UI_TOOLTIP_DELAY_DURATION);
    expect(tooltips(element).map((t) => t.textContent)).toEqual(["Second"]);

    hideTerminalLinkTooltip(terminal);
    expect(tooltips(element)).toHaveLength(0);
    showTerminalLinkTooltip(terminal, hover, "Third");
    hideTerminalLinkTooltip(terminal);
    vi.advanceTimersByTime(UI_TOOLTIP_DELAY_DURATION);
    expect(tooltips(element)).toHaveLength(0);
  });

  it.each(["pointerdown", "contextmenu", "wheel", "keydown"])(
    "goes away on %s in the terminal",
    (type) => {
      const { terminal, element } = terminalWithElement();
      showTerminalLinkTooltip(terminal, hover, "Open with Acme");
      vi.advanceTimersByTime(UI_TOOLTIP_DELAY_DURATION);
      element.dispatchEvent(new Event(type));
      expect(tooltips(element)).toHaveLength(0);
    }
  );

  it("never appears on a terminal parked out of sight before the delay ran out", () => {
    const { terminal, element } = terminalWithElement(true);
    showTerminalLinkTooltip(terminal, hover, "Open with Acme");
    vi.advanceTimersByTime(UI_TOOLTIP_DELAY_DURATION);
    expect(tooltips(element)).toHaveLength(0);
  });
});
