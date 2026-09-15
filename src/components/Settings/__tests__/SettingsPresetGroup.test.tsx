// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsPresetGroup } from "../SettingsPresetGroup";

const OPTIONS = [
  { value: 30, label: "30m" },
  { value: 60, label: "1h" },
  { value: 120, label: "2h" },
] as const;

function renderGroup(value: number | null, onChange = vi.fn()) {
  render(
    <SettingsPresetGroup
      label="Idle threshold"
      options={OPTIONS}
      value={value}
      onChange={onChange}
    />
  );
  return onChange;
}

describe("SettingsPresetGroup", () => {
  // These chips were plain buttons whose only expression of "selected" was a background
  // colour. The rule: the current choice is readable from the accessibility tree, not
  // only from the pixels.
  it("exposes exactly one checked option, matching the value", () => {
    renderGroup(60);
    const radios = screen.getAllByRole("radio");
    const checked = radios.filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0]!.textContent).toBe("1h");
  });

  // A radiogroup is ONE tab stop. Two options reporting tabIndex 0 is the bug that makes
  // it behave like a row of separate buttons.
  it("keeps exactly one tab stop in the group", () => {
    renderGroup(120);
    const stops = screen.getAllByRole("radio").filter((r) => r.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.getAttribute("aria-checked")).toBe("true");
  });

  it("still offers one tab stop when nothing is selected yet", () => {
    renderGroup(null);
    const stops = screen.getAllByRole("radio").filter((r) => r.tabIndex === 0);
    expect(stops).toHaveLength(1);
  });

  it("moves and selects with the arrow keys, wrapping at the ends", () => {
    const onChange = renderGroup(120);
    const group = screen.getByRole("radiogroup");
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith(30);

    onChange.mockClear();
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith(60);
  });

  it("names the group from its visible label", () => {
    renderGroup(30);
    expect(screen.getByRole("radiogroup").getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Idle threshold" })).toBeTruthy();
  });

  it("does not select a disabled option by arrow", () => {
    const onChange = vi.fn();
    render(
      <SettingsPresetGroup
        label="Channel"
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B", disabled: true },
          { value: "c", label: "C" },
        ]}
        value="a"
        onChange={onChange}
      />
    );
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("c");
  });
});
