// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OverrideField } from "../OverrideField";
import { SettingsDependents, SettingsGroup } from "../SettingsGroup";

function renderField(props: Partial<Parameters<typeof OverrideField>[0]> = {}) {
  const onChange = vi.fn();
  const onReset = vi.fn();
  render(
    <SettingsGroup>
      <OverrideField
        label="Shell"
        value={undefined}
        onChange={onChange}
        onReset={onReset}
        inheritDescription="Default: /bin/zsh"
        {...props}
      />
    </SettingsGroup>
  );
  return { onChange, onReset, input: screen.getByRole("textbox") as HTMLInputElement };
}

const modifiedMark = () => document.querySelector("[data-settings-row] .status-mark");

describe("OverrideField", () => {
  it("names the field by its visible label and describes it by what it inherits", () => {
    const { input } = renderField();

    expect(screen.getByLabelText("Shell")).toBe(input);
    const describedBy = input.getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)?.textContent).toBe("Default: /bin/zsh");
  });

  it("keeps the inherited value in view while overriding, so Reset says where it goes back to", () => {
    renderField({ value: "/bin/bash" });

    expect(screen.getByText("Default: /bin/zsh")).toBeTruthy();
  });

  it("marks the row modified and offers a named reset only while overriding", () => {
    const { onReset } = renderField({ value: "/bin/bash" });

    expect(modifiedMark()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset Shell to default" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("shows neither the mark nor the reset while inheriting", () => {
    renderField();

    expect(modifiedMark()).toBeNull();
    expect(screen.queryByRole("button", { name: /^Reset/ })).toBeNull();
  });

  it("passes typed values through as an override", () => {
    const { input, onChange } = renderField();

    fireEvent.change(input, { target: { value: "/bin/bash" } });

    expect(onChange).toHaveBeenCalledWith("/bin/bash");
  });

  it("treats emptying an override as going back to the inherited value, never an empty override", () => {
    const { input, onChange, onReset } = renderField({ value: "/bin/bash" });

    fireEvent.change(input, { target: { value: "" } });

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("takes the disabled state of a switched-off parent and drops the reset with it", () => {
    render(
      <SettingsGroup>
        <SettingsDependents disabled reason="Turn the parent on first">
          <OverrideField
            label="Shell"
            value="/bin/bash"
            onChange={vi.fn()}
            onReset={vi.fn()}
            inheritDescription="Default: /bin/zsh"
          />
        </SettingsDependents>
      </SettingsGroup>
    );

    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /^Reset/ })).toBeNull();
  });

  it("flags an error on the field and reads it before the description", () => {
    const { input } = renderField({ value: "nope", error: "Not a shell" });

    expect(input.getAttribute("aria-invalid")).toBe("true");
    const [first] = input.getAttribute("aria-describedby")!.split(" ");
    expect(document.getElementById(first!)?.textContent).toBe("Not a shell");
  });
});
