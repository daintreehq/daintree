// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TERMINAL_SCROLLBAR_WIDTH } from "@/config/xtermConfig";
import { TerminalChipRow } from "../TerminalChipRow";

// XtermAdapter's `pl-3`/`pr-3` wrapper padding; xterm draws the track inside the right one.
const XTERM_WRAPPER_PADDING = 12;

function renderRow() {
  const { container } = render(
    <TerminalChipRow leading={<button>fleet</button>} trailing={<button>pill</button>} />
  );
  const row = container.firstElementChild;
  if (!(row instanceof HTMLElement)) throw new Error("no row rendered");
  return row;
}

describe("TerminalChipRow", () => {
  it("keeps the trailing chip clear of xterm's scrollbar track", () => {
    const row = renderRow();
    const right = parseFloat(row.style.paddingRight);
    expect(right).toBeGreaterThan(XTERM_WRAPPER_PADDING + TERMINAL_SCROLLBAR_WIDTH);
  });

  it("insets both chips the same distance inside the text column", () => {
    const row = renderRow();
    const left = parseFloat(row.style.paddingLeft) - XTERM_WRAPPER_PADDING;
    const right =
      parseFloat(row.style.paddingRight) - XTERM_WRAPPER_PADDING - TERMINAL_SCROLLBAR_WIDTH;
    expect(left).toBeGreaterThan(0);
    expect(right).toBe(left);
  });

  it("lays both chips out in one flex row so they share the width budget", () => {
    renderRow();
    const fleet = screen.getByText("fleet").parentElement;
    const pill = screen.getByText("pill").parentElement;
    expect(fleet?.parentElement).toBe(pill?.parentElement);
    const row = fleet?.parentElement;
    expect(row?.className.split(/\s+/)).toContain("flex");
  });
});
