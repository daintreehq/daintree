// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuickStateFilterBar } from "../QuickStateFilterBar";

describe("QuickStateFilterBar", () => {
  it("renders all four pills", () => {
    render(<QuickStateFilterBar value="all" onChange={() => {}} />);
    expect(screen.getByText("All")).toBeTruthy();
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText("Waiting")).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();
  });

  it("marks the active pill with aria-pressed=true", () => {
    render(<QuickStateFilterBar value="working" onChange={() => {}} />);
    expect(screen.getByText("Working").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("All").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Waiting").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Finished").getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking an inactive pill calls onChange with that value", () => {
    const onChange = vi.fn();
    render(<QuickStateFilterBar value="all" onChange={onChange} />);
    fireEvent.click(screen.getByText("Working"));
    expect(onChange).toHaveBeenCalledWith("working");
  });

  it('clicking the active pill toggles back to "all"', () => {
    const onChange = vi.fn();
    render(<QuickStateFilterBar value="waiting" onChange={onChange} />);
    fireEvent.click(screen.getByText("Waiting"));
    expect(onChange).toHaveBeenCalledWith("all");
  });

  it('"All" is aria-pressed when value is "all"', () => {
    render(<QuickStateFilterBar value="all" onChange={() => {}} />);
    expect(screen.getByText("All").getAttribute("aria-pressed")).toBe("true");
  });
});
