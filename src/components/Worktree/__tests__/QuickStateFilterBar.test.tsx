// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuickStateFilterBar } from "../QuickStateFilterBar";

describe("QuickStateFilterBar", () => {
  it("renders all four pills without counts when counts prop is omitted", () => {
    render(<QuickStateFilterBar value="all" onChange={() => {}} />);
    expect(screen.getByText("All")).toBeTruthy();
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText("Waiting")).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();
  });

  it("renders counts in parentheses for non-all tabs", () => {
    render(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ working: 3, waiting: 1, finished: 5 }}
      />
    );
    expect(screen.getByText("All")).toBeTruthy();
    expect(screen.getByText(/Working \(3\)/)).toBeTruthy();
    expect(screen.getByText(/Waiting \(1\)/)).toBeTruthy();
    expect(screen.getByText(/Finished \(5\)/)).toBeTruthy();
  });

  it("renders zero counts explicitly", () => {
    render(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ working: 0, waiting: 0, finished: 0 }}
      />
    );
    expect(screen.getByText(/Working \(0\)/)).toBeTruthy();
    expect(screen.getByText(/Waiting \(0\)/)).toBeTruthy();
    expect(screen.getByText(/Finished \(0\)/)).toBeTruthy();
  });

  it("marks the active pill with aria-pressed=true", () => {
    render(
      <QuickStateFilterBar
        value="working"
        onChange={() => {}}
        counts={{ working: 2, waiting: 0, finished: 1 }}
      />
    );
    expect(screen.getByRole("button", { name: /Working/ }).getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect(screen.getByText("All").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: /Waiting/ }).getAttribute("aria-pressed")).toBe(
      "false"
    );
    expect(screen.getByRole("button", { name: /Finished/ }).getAttribute("aria-pressed")).toBe(
      "false"
    );
  });

  it("clicking an inactive pill calls onChange with that value", () => {
    const onChange = vi.fn();
    render(
      <QuickStateFilterBar
        value="all"
        onChange={onChange}
        counts={{ working: 1, waiting: 0, finished: 0 }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Working/ }));
    expect(onChange).toHaveBeenCalledWith("working");
  });

  it('clicking the active pill toggles back to "all"', () => {
    const onChange = vi.fn();
    render(
      <QuickStateFilterBar
        value="waiting"
        onChange={onChange}
        counts={{ working: 0, waiting: 3, finished: 0 }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Waiting/ }));
    expect(onChange).toHaveBeenCalledWith("all");
  });

  it('"All" is aria-pressed when value is "all"', () => {
    render(<QuickStateFilterBar value="all" onChange={() => {}} />);
    expect(screen.getByText("All").getAttribute("aria-pressed")).toBe("true");
  });
});
