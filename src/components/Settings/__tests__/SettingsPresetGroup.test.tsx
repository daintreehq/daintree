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

  // The one tab stop has to be a button that can take focus. Falling back to index
  // zero regardless made the group unreachable whenever option zero was disabled.
  it("puts the tab stop on the first enabled option when the selection is disabled", () => {
    render(
      <SettingsPresetGroup
        label="Channel"
        options={[
          { value: "a", label: "A", disabled: true },
          { value: "b", label: "B", disabled: true },
          { value: "c", label: "C" },
        ]}
        value="a"
        onChange={vi.fn()}
      />
    );
    const stops = screen.getAllByRole("radio").filter((r) => r.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.hasAttribute("disabled")).toBe(false);
    expect(stops[0]!.textContent).toBe("C");
  });

  it("still offers one tab stop when nothing is selected yet", () => {
    renderGroup(null);
    const stops = screen.getAllByRole("radio").filter((r) => r.tabIndex === 0);
    expect(stops).toHaveLength(1);
  });

  it("moves and selects with the arrow keys, wrapping at the ends", () => {
    const onChange = renderGroup(120);
    const group = screen.getByRole("radiogroup");
    // Last option, so Right wraps to the first.
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith(30);

    // Focus is now on the first option, so Left wraps back to the last. Movement follows
    // focus rather than the `value` prop, which this uncontrolled render never updates.
    onChange.mockClear();
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith(120);
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

describe("SettingsPresetGroup — movement follows focus, not the committed value", () => {
  // A save can be rejected and rolled back, leaving `value` back where it started while
  // focus stays on the option the user tried. Deriving the next step from `value` then
  // re-attempts the option that just failed instead of moving past it.
  it("advances from the focused option when the value did not follow", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SettingsPresetGroup label="Retention" options={OPTIONS} value={30} onChange={onChange} />
    );
    const group = screen.getByRole("radiogroup");

    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith(60);

    // The commit was rejected: value stays at 30 while focus sits on 60.
    rerender(
      <SettingsPresetGroup label="Retention" options={OPTIONS} value={30} onChange={onChange} />
    );

    onChange.mockClear();
    fireEvent.keyDown(group, { key: "ArrowRight" });
    // Moves on to 120 rather than re-offering the 60 that just failed.
    expect(onChange).toHaveBeenCalledWith(120);
  });
});
