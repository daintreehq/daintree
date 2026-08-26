/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SegmentedRadioGroup } from "../SegmentedRadioGroup";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(cleanup);

const OPTIONS = [
  { value: "new", label: "New branch" },
  { value: "existing", label: "Existing branch" },
  { value: "third", label: "Third" },
];

function renderGroup(value = "new") {
  const onChange = vi.fn();
  render(
    <SegmentedRadioGroup
      options={OPTIONS}
      value={value}
      onChange={onChange}
      aria-label="Branch mode"
    />
  );
  return { onChange, group: screen.getByRole("radiogroup", { name: "Branch mode" }) };
}

describe("SegmentedRadioGroup keyboard model", () => {
  it("keeps the group to a single tab stop by roving tabindex onto the checked segment", () => {
    renderGroup("existing");

    const tabbable = screen
      .getAllByRole("radio")
      .filter((radio) => radio.getAttribute("tabindex") === "0");

    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]?.textContent).toBe("Existing branch");
  });

  it("moves the selection forward and wraps past the last segment", () => {
    const { onChange, group } = renderGroup("third");

    fireEvent.keyDown(group, { key: "ArrowRight" });

    expect(onChange).toHaveBeenCalledWith("new");
  });

  it("moves the selection backward and wraps past the first segment", () => {
    const { onChange, group } = renderGroup("new");

    fireEvent.keyDown(group, { key: "ArrowLeft" });

    expect(onChange).toHaveBeenCalledWith("third");
  });

  it("treats vertical arrows as equivalent to horizontal ones", () => {
    const { onChange, group } = renderGroup("new");

    fireEvent.keyDown(group, { key: "ArrowDown" });

    expect(onChange).toHaveBeenCalledWith("existing");
  });

  it("jumps to the ends on Home and End", () => {
    const { onChange, group } = renderGroup("existing");

    fireEvent.keyDown(group, { key: "Home" });
    expect(onChange).toHaveBeenCalledWith("new");

    fireEvent.keyDown(group, { key: "End" });
    expect(onChange).toHaveBeenCalledWith("third");
  });

  it("leaves unrelated keys to the surrounding form", () => {
    const { onChange, group } = renderGroup();

    fireEvent.keyDown(group, { key: "Enter" });
    fireEvent.keyDown(group, { key: "a" });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("still exposes a tab stop when the value matches no segment", () => {
    renderGroup("unknown-mode");

    const tabbable = screen
      .getAllByRole("radio")
      .filter((radio) => radio.getAttribute("tabindex") === "0");

    expect(tabbable).toHaveLength(1);
    expect(
      screen.getAllByRole("radio").every((r) => r.getAttribute("aria-checked") === "false")
    ).toBe(true);
  });

  it("moves off an unmatched value rather than getting stuck", () => {
    const { onChange, group } = renderGroup("unknown-mode");

    fireEvent.keyDown(group, { key: "ArrowRight" });

    expect(onChange).toHaveBeenCalledWith("existing");
  });
});
