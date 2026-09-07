// @vitest-environment jsdom
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MarkdownFontSize } from "@/store/preferencesStore";

// Radix opens on a pointer sequence and portals its content, neither of which
// jsdom drives faithfully. Render the panel inline and keep its keydown handler
// wired — what this suite owns is the stepping, not Radix's choreography. Same
// shape as the dropdown mock in FileBrowserViewOptions.test.tsx.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({
    children,
    onKeyDown,
    "aria-label": label,
  }: {
    children: ReactNode;
    onKeyDown?: (event: React.KeyboardEvent) => void;
    "aria-label"?: string;
  }) => (
    <div role="dialog" aria-label={label} onKeyDown={onKeyDown}>
      {children}
    </div>
  ),
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import { MarkdownTextSizeControl } from "../MarkdownTextSizeControl";

/** Drives the control the way a host does — it owns no state of its own. */
function Harness({ initial = "sm" as MarkdownFontSize }) {
  const [value, setValue] = useState<MarkdownFontSize>(initial);
  return <MarkdownTextSizeControl value={value} onValueChange={setValue} />;
}

const readout = () => screen.getByTestId("markdown-text-size-value");
const decrease = () => screen.getByTestId("markdown-text-size-decrease");
const increase = () => screen.getByTestId("markdown-text-size-increase");
const reset = () => screen.getByTestId("markdown-text-size-reset");

afterEach(cleanup);

describe("MarkdownTextSizeControl (#12134)", () => {
  it("steps up and down the ladder, including its widening top end", () => {
    render(<Harness initial="lg" />);
    expect(readout().textContent).toBe("18 px");

    fireEvent.click(increase());
    expect(readout().textContent).toBe("20 px");

    // 20 → 24 → 30: the top of the ladder widens on purpose, so a step there
    // is worth taking rather than imperceptible.
    fireEvent.click(increase());
    expect(readout().textContent).toBe("24 px");

    fireEvent.click(decrease());
    expect(readout().textContent).toBe("20 px");
  });

  it("walks every rung of the ladder, and each one reads out its own size", () => {
    render(<Harness initial="2xs" />);
    // The whole ladder, so a rung added without a label — or a label left
    // empty — cannot pass by being the one nobody asserts.
    const climb = ["11 px", "12 px", "14 px", "16 px", "18 px", "20 px", "24 px", "30 px"];
    expect(readout().textContent).toBe(climb[0]);
    for (const expected of climb.slice(1)) {
      fireEvent.click(increase());
      expect(readout().textContent).toBe(expected);
    }
  });

  it("stops at each end of the ladder rather than wrapping", () => {
    render(<Harness initial="2xs" />);
    expect(decrease().getAttribute("aria-disabled")).toBe("true");
    expect(increase().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(decrease());
    expect(readout().textContent).toBe("11 px");

    cleanup();
    render(<Harness initial="3xl" />);
    expect(increase().getAttribute("aria-disabled")).toBe("true");
    expect(decrease().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(increase());
    expect(readout().textContent).toBe("30 px");
  });

  // The ends are announced, never removed: a native `disabled` lands while the
  // button still holds focus, and a focusout inside a Radix popover is what
  // dismisses it — so stepping to the last rung would close the panel.
  it("keeps the button that just reached an end focusable and focused", () => {
    render(<Harness initial="2xl" />);
    increase().focus();
    expect(document.activeElement).toBe(increase());

    fireEvent.click(increase());
    expect(readout().textContent).toBe("30 px");
    expect(increase().getAttribute("aria-disabled")).toBe("true");
    expect(increase().hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(increase());
  });

  it("returns to the default and refuses to act once already there", () => {
    render(<Harness initial="2xl" />);
    expect(reset().getAttribute("aria-disabled")).toBeNull();

    reset().focus();
    fireEvent.click(reset());
    expect(readout().textContent).toBe("14 px");
    expect(reset().getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(reset());

    // Activating it again must not step anything — it says it is inert.
    fireEvent.click(reset());
    expect(readout().textContent).toBe("14 px");
  });

  // The popover is the only interface: every discoverable zoom combo is already
  // bound to whole-window zoom, so these keys are what "accelerator" means here.
  it("steps from the keyboard while the panel is open", () => {
    render(<Harness />);
    const panel = screen.getByRole("dialog", { name: "Text size" });

    fireEvent.keyDown(panel, { key: "ArrowUp" });
    expect(readout().textContent).toBe("16 px");

    fireEvent.keyDown(panel, { key: "+" });
    expect(readout().textContent).toBe("18 px");

    fireEvent.keyDown(panel, { key: "ArrowDown" });
    expect(readout().textContent).toBe("16 px");

    fireEvent.keyDown(panel, { key: "-" });
    expect(readout().textContent).toBe("14 px");

    // An unrelated key must fall through to whatever else is listening.
    fireEvent.keyDown(panel, { key: "a" });
    expect(readout().textContent).toBe("14 px");
  });

  it("announces the size on the trigger and again on every adjustment", () => {
    render(<Harness />);
    // Entering the control says where the document already is...
    expect(screen.getByLabelText("Text size, 14 pixels")).not.toBeNull();

    // ...and the panel stays open across a run of steps, so the readout has to
    // say each one or the stepping is silent.
    expect(readout().getAttribute("aria-live")).toBe("polite");
    expect(readout().getAttribute("aria-atomic")).toBe("true");

    fireEvent.click(increase());
    expect(readout().textContent).toBe("16 px");
    expect(screen.getByLabelText("Text size, 16 pixels")).not.toBeNull();
  });
});
