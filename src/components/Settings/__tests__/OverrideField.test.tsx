// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OverrideField } from "../OverrideField";

describe("OverrideField", () => {
  it("renders label associated to input", () => {
    render(
      <OverrideField
        label="Shell program"
        value={undefined}
        onChange={vi.fn()}
        onReset={vi.fn()}
        inheritDescription="Inherits app default"
      />
    );
    const input = screen.getByLabelText("Shell program");
    expect(input).toBeTruthy();
    expect(input.tagName).toBe("INPUT");
  });

  it("renders empty input value when inheriting (value is undefined)", () => {
    render(
      <OverrideField
        label="Shell"
        value={undefined}
        onChange={vi.fn()}
        onReset={vi.fn()}
        inheritDescription="Inherits app default"
      />
    );
    const input = screen.getByLabelText("Shell") as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("renders inheritDescription when value is undefined", () => {
    render(
      <OverrideField
        label="Shell"
        value={undefined}
        onChange={vi.fn()}
        onReset={vi.fn()}
        inheritDescription="Inherits app default (1000 lines)"
      />
    );
    expect(screen.getByText("Inherits app default (1000 lines)")).toBeTruthy();
  });

  it("renders overrideDescription when value is set", () => {
    render(
      <OverrideField
        label="Shell"
        value="/bin/bash"
        onChange={vi.fn()}
        onReset={vi.fn()}
        inheritDescription="Inherits app default"
        overrideDescription="Overriding app default"
      />
    );
    expect(screen.getByText("Overriding app default")).toBeTruthy();
    expect(screen.queryByText("Inherits app default")).toBeNull();
  });

  it("wires description to aria-describedby", () => {
    render(
      <OverrideField
        label="Shell"
        value={undefined}
        onChange={vi.fn()}
        onReset={vi.fn()}
        inheritDescription="Inherits app default"
      />
    );
    const input = screen.getByLabelText("Shell");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe("Inherits app default");
  });

  it("does not render reset button when inheriting", () => {
    render(
      <OverrideField
        label="Shell"
        value={undefined}
        onChange={vi.fn()}
        onReset={vi.fn()}
        inheritDescription="Inherits app default"
      />
    );
    expect(screen.queryByLabelText("Reset to global")).toBeNull();
  });

  it("renders reset button when overriding", () => {
    render(
      <OverrideField
        label="Shell"
        value="/bin/bash"
        onChange={vi.fn()}
        onReset={vi.fn()}
        inheritDescription="Inherits app default"
      />
    );
    expect(screen.getByLabelText("Reset to global")).toBeTruthy();
  });

  it("hides reset button when disabled", () => {
    render(
      <OverrideField
        label="Shell"
        value="/bin/bash"
        onChange={vi.fn()}
        onReset={vi.fn()}
        disabled
        inheritDescription="Inherits app default"
      />
    );
    expect(screen.queryByLabelText("Reset to global")).toBeNull();
  });

  it("calls onChange with new value when typing", () => {
    const onChange = vi.fn();
    render(
      <OverrideField
        label="Shell"
        value={undefined}
        onChange={onChange}
        onReset={vi.fn()}
        inheritDescription="Inherits app default"
      />
    );
    const input = screen.getByLabelText("Shell");
    fireEvent.change(input, { target: { value: "/bin/bash" } });
    expect(onChange).toHaveBeenCalledWith("/bin/bash");
  });

  it("calls onReset when reset button is clicked", () => {
    const onReset = vi.fn();
    render(
      <OverrideField
        label="Shell"
        value="/bin/bash"
        onChange={vi.fn()}
        onReset={onReset}
        inheritDescription="Inherits app default"
      />
    );
    fireEvent.click(screen.getByLabelText("Reset to global"));
    expect(onReset).toHaveBeenCalled();
  });

  it("renders override indicator dot when overriding", () => {
    render(
      <OverrideField
        label="Shell"
        value="/bin/bash"
        onChange={vi.fn()}
        onReset={vi.fn()}
        inheritDescription="Inherits app default"
      />
    );
    expect(screen.getByTestId("override-indicator")).toBeTruthy();
  });

  it("does not render override indicator when inheriting", () => {
    render(
      <OverrideField
        label="Shell"
        value={undefined}
        onChange={vi.fn()}
        onReset={vi.fn()}
        inheritDescription="Inherits app default"
      />
    );
    expect(screen.queryByTestId("override-indicator")).toBeNull();
  });

  it("shows error message and sets aria-invalid when error provided", () => {
    render(
      <OverrideField
        label="Scrollback"
        value="999999"
        onChange={vi.fn()}
        onReset={vi.fn()}
        inheritDescription="Inherits app default"
        error="Must be between 100 and 100000"
      />
    );
    const input = screen.getByLabelText("Scrollback");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Must be between 100 and 100000")).toBeTruthy();
  });

  it("forwards input props like placeholder, type, min, max", () => {
    render(
      <OverrideField
        label="Scrollback"
        value={undefined}
        onChange={vi.fn()}
        onReset={vi.fn()}
        inheritDescription="Inherits app default"
        type="number"
        min={100}
        max={100000}
        placeholder="1000"
      />
    );
    const input = screen.getByLabelText("Scrollback");
    expect(input.getAttribute("type")).toBe("number");
    expect(input.getAttribute("min")).toBe("100");
    expect(input.getAttribute("max")).toBe("100000");
    expect(input.getAttribute("placeholder")).toBe("1000");
  });

  it("renders hint label suffix when provided", () => {
    render(
      <OverrideField
        label="Shell"
        hint="(machine-local, not shared)"
        value={undefined}
        onChange={vi.fn()}
        onReset={vi.fn()}
        inheritDescription="Inherits app default"
      />
    );
    expect(screen.getByText("(machine-local, not shared)")).toBeTruthy();
  });

  it("treats clearing the input while overriding as a reset, not an empty override", () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    render(
      <OverrideField
        label="Shell"
        value="/bin/bash"
        onChange={onChange}
        onReset={onReset}
        inheritDescription="Inherits app default"
      />
    );
    const input = screen.getByLabelText("Shell");
    fireEvent.change(input, { target: { value: "" } });
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("forwards empty string normally when already inheriting", () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    render(
      <OverrideField
        label="Shell"
        value={undefined}
        onChange={onChange}
        onReset={onReset}
        inheritDescription="Inherits app default"
      />
    );
    const input = screen.getByLabelText("Shell");
    fireEvent.change(input, { target: { value: "" } });
    expect(onReset).not.toHaveBeenCalled();
  });

  it("uses status-info (not accent) as the override signal", () => {
    render(
      <OverrideField
        label="Shell"
        value="/bin/bash"
        onChange={vi.fn()}
        onReset={vi.fn()}
        inheritDescription="Inherits app default"
      />
    );
    const dot = screen.getByTestId("override-indicator");
    expect(dot.className).toContain("bg-status-info");
    expect(dot.className).not.toContain("bg-accent");
    expect(dot.className).not.toContain("bg-daintree-accent");
  });
});
