// @vitest-environment jsdom
import { render, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

import { HelpIntroBanner } from "../HelpIntroBanner";

describe("HelpIntroBanner", () => {
  it("renders the Shift+Enter tip as keys and a Dismiss button", () => {
    const { container, getByText, getByLabelText } = render(
      <HelpIntroBanner onDismiss={vi.fn()} />
    );

    // One chip per key, like every other shortcut in the app.
    const keys = Array.from(container.querySelectorAll("kbd")).map((k) => k.textContent);
    expect(keys).toEqual(["Shift", "Enter"]);
    expect(getByText(/add a newline without/i)).toBeTruthy();
    expect(getByLabelText("Dismiss")).toBeTruthy();
  });

  it("calls onDismiss when the X button is clicked", () => {
    const onDismiss = vi.fn();
    const { getByLabelText } = render(<HelpIntroBanner onDismiss={onDismiss} />);

    fireEvent.click(getByLabelText("Dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("Escape bubbles to outer handler and does not dismiss", () => {
    const onDismiss = vi.fn();
    const outerKeyDown = vi.fn();
    const { getByLabelText } = render(
      <div onKeyDown={outerKeyDown}>
        <HelpIntroBanner onDismiss={onDismiss} />
      </div>
    );

    fireEvent.keyDown(getByLabelText("Dismiss"), { key: "Escape" });

    expect(onDismiss).not.toHaveBeenCalled();
    expect(outerKeyDown).toHaveBeenCalledTimes(1);
  });

  it("does not call onDismiss for non-Escape keys", () => {
    const onDismiss = vi.fn();
    const { getByLabelText } = render(<HelpIntroBanner onDismiss={onDismiss} />);

    fireEvent.keyDown(getByLabelText("Dismiss"), { key: "Enter" });
    fireEvent.keyDown(getByLabelText("Dismiss"), { key: "Tab" });

    expect(onDismiss).not.toHaveBeenCalled();
  });
});
