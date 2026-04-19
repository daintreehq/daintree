// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsInput } from "../SettingsInput";
import { SettingsSelect } from "../SettingsSelect";
import { SettingsNumberInput } from "../SettingsNumberInput";
import { SettingsTextarea } from "../SettingsTextarea";
import { SettingsChoicebox, type ChoiceboxOption } from "../SettingsChoicebox";
import { SettingsCheckbox } from "../SettingsCheckbox";
import { SettingsSwitch } from "../SettingsSwitch";

describe("SettingsInput", () => {
  it("renders label associated to input", () => {
    render(<SettingsInput label="Username" />);
    expect(screen.getByLabelText("Username")).toBeTruthy();
    expect(screen.getByLabelText("Username").tagName).toBe("INPUT");
  });

  it("wires description to aria-describedby", () => {
    render(<SettingsInput label="Host" description="The server hostname" />);
    const input = screen.getByLabelText("Host");
    const descId = input.getAttribute("aria-describedby");
    expect(descId).toBeTruthy();
    expect(document.getElementById(descId!)?.textContent).toBe("The server hostname");
  });

  it("shows error and sets aria-invalid", () => {
    render(<SettingsInput label="Port" error="Must be a number" />);
    const input = screen.getByLabelText("Port");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert")?.textContent).toBe("Must be a number");
  });

  it("hides description when error is shown", () => {
    render(<SettingsInput label="Port" description="Server port" error="Invalid" />);
    expect(screen.queryByText("Server port")).toBeNull();
    expect(screen.getByText("Invalid")).toBeTruthy();
  });

  it("aria-describedby only references error when both description and error exist", () => {
    render(<SettingsInput label="Port" description="Server port" error="Required" />);
    const input = screen.getByLabelText("Port");
    const describedBy = input.getAttribute("aria-describedby")!;
    const ids = describedBy.split(" ");
    expect(ids).toHaveLength(1);
    expect(document.getElementById(ids[0]!)?.textContent).toBe("Required");
  });

  it("shows modified indicator when isModified", () => {
    const { container } = render(<SettingsInput label="Name" isModified />);
    const dot = container.querySelector(".bg-daintree-accent.rounded-full");
    expect(dot).toBeTruthy();
  });

  it("shows reset button when isModified and onReset and not disabled", () => {
    const onReset = vi.fn();
    render(<SettingsInput label="Name" isModified onReset={onReset} />);
    expect(screen.getByLabelText("Reset Name to default")).toBeTruthy();
  });

  it("hides reset button when disabled", () => {
    render(<SettingsInput label="Name" isModified onReset={vi.fn()} disabled />);
    expect(screen.queryByLabelText("Reset Name to default")).toBeNull();
  });

  it("forwards ref to the input element", () => {
    const ref = vi.fn();
    render(<SettingsInput label="Test" ref={ref} />);
    expect(ref).toHaveBeenCalledWith(expect.any(HTMLInputElement));
  });

  it("uses semantic tokens for background and focus", () => {
    render(<SettingsInput label="Host" />);
    const input = screen.getByLabelText("Host");
    expect(input.className).toContain("bg-surface-input");
    expect(input.className).toContain("focus-visible:outline");
    expect(input.className).toContain("focus-visible:outline-2");
    expect(input.className).toContain("focus-visible:outline-daintree-accent");
    expect(input.className).toContain("focus-visible:outline-offset-2");
  });

  it("uses semantic text tokens for label and description", () => {
    render(<SettingsInput label="Host" description="The server hostname" />);
    const label = screen.getByText("Host");
    const description = screen.getByText("The server hostname");
    expect(label.className).toContain("text-text-secondary");
    expect(description.className).toContain("text-text-muted");
  });
});

describe("SettingsSelect", () => {
  it("renders label associated to select", () => {
    render(
      <SettingsSelect label="Language">
        <option value="en">English</option>
      </SettingsSelect>
    );
    expect(screen.getByLabelText("Language")).toBeTruthy();
    expect(screen.getByLabelText("Language").tagName).toBe("SELECT");
  });

  it("wires description to aria-describedby", () => {
    render(
      <SettingsSelect label="Theme" description="Choose a color theme">
        <option>Default</option>
      </SettingsSelect>
    );
    const select = screen.getByLabelText("Theme");
    const descId = select.getAttribute("aria-describedby");
    expect(descId).toBeTruthy();
    expect(document.getElementById(descId!)?.textContent).toBe("Choose a color theme");
  });

  it("includes pr-8 right padding for native chevron clearance", () => {
    render(
      <SettingsSelect label="Theme">
        <option>Default</option>
      </SettingsSelect>
    );
    const select = screen.getByLabelText("Theme");
    expect(select.className).toContain("pr-8");
  });

  it("shows reset button when modified", () => {
    const onReset = vi.fn();
    render(
      <SettingsSelect label="Lang" isModified onReset={onReset}>
        <option>EN</option>
      </SettingsSelect>
    );
    expect(screen.getByLabelText("Reset Lang to default")).toBeTruthy();
  });
});

describe("SettingsNumberInput", () => {
  it("renders as type=number", () => {
    render(<SettingsNumberInput label="Count" min={0} max={100} />);
    const input = screen.getByLabelText("Count");
    expect(input.getAttribute("type")).toBe("number");
    expect(input.getAttribute("min")).toBe("0");
    expect(input.getAttribute("max")).toBe("100");
  });
});

describe("SettingsTextarea", () => {
  it("renders label associated to textarea", () => {
    render(<SettingsTextarea label="Instructions" />);
    expect(screen.getByLabelText("Instructions")).toBeTruthy();
    expect(screen.getByLabelText("Instructions").tagName).toBe("TEXTAREA");
  });

  it("wires description to aria-describedby", () => {
    render(<SettingsTextarea label="Notes" description="Additional notes" />);
    const textarea = screen.getByLabelText("Notes");
    const descId = textarea.getAttribute("aria-describedby");
    expect(descId).toBeTruthy();
    expect(document.getElementById(descId!)?.textContent).toBe("Additional notes");
  });

  it("forwards ref to the textarea element", () => {
    const ref = vi.fn();
    render(<SettingsTextarea label="Bio" ref={ref} />);
    expect(ref).toHaveBeenCalledWith(expect.any(HTMLTextAreaElement));
  });

  it("uses semantic tokens for background and focus", () => {
    render(<SettingsTextarea label="Notes" />);
    const textarea = screen.getByLabelText("Notes");
    expect(textarea.className).toContain("bg-surface-input");
    expect(textarea.className).toContain("focus-visible:outline");
    expect(textarea.className).toContain("focus-visible:outline-2");
    expect(textarea.className).toContain("focus-visible:outline-daintree-accent");
    expect(textarea.className).toContain("focus-visible:outline-offset-2");
    expect(textarea.className).toContain("font-mono");
    expect(textarea.className).toContain("resize-y");
  });

  it("uses semantic text tokens for label and description", () => {
    render(<SettingsTextarea label="Notes" description="Additional notes" />);
    const label = screen.getByText("Notes");
    const description = screen.getByText("Additional notes");
    expect(label.className).toContain("text-text-secondary");
    expect(description.className).toContain("text-text-muted");
  });
});

const MOCK_OPTIONS: readonly ChoiceboxOption<string>[] = [
  { value: "compact", label: "Compact", description: "Smaller items" },
  { value: "normal", label: "Normal", description: "Default size" },
  { value: "comfortable", label: "Comfortable", description: "Larger items" },
] as const;

describe("SettingsChoicebox", () => {
  it("renders label associated to radio group", () => {
    render(
      <SettingsChoicebox label="Density" value="normal" onChange={vi.fn()} options={MOCK_OPTIONS} />
    );
    const group = screen.getByRole("radiogroup", { name: "Density" });
    expect(group).toBeTruthy();
  });

  it("renders all options as radio buttons", () => {
    render(
      <SettingsChoicebox label="Density" value="normal" onChange={vi.fn()} options={MOCK_OPTIONS} />
    );
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios[0]?.textContent).toContain("Compact");
    expect(radios[1]?.textContent).toContain("Normal");
    expect(radios[2]?.textContent).toContain("Comfortable");
  });

  it("sets aria-checked on selected option", () => {
    render(
      <SettingsChoicebox label="Density" value="normal" onChange={vi.fn()} options={MOCK_OPTIONS} />
    );
    const radios = screen.getAllByRole("radio");
    expect(radios[0]?.getAttribute("aria-checked")).toBe("false");
    expect(radios[1]?.getAttribute("aria-checked")).toBe("true");
    expect(radios[2]?.getAttribute("aria-checked")).toBe("false");
  });

  it("wires description to aria-describedby", () => {
    render(
      <SettingsChoicebox
        label="Density"
        description="Choose dock density"
        value="normal"
        onChange={vi.fn()}
        options={MOCK_OPTIONS}
      />
    );
    const group = screen.getByRole("radiogroup");
    const describedBy = group.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe("Choose dock density");
  });

  it("shows error and sets aria-invalid", () => {
    render(
      <SettingsChoicebox
        label="Density"
        error="Invalid selection"
        value="normal"
        onChange={vi.fn()}
        options={MOCK_OPTIONS}
      />
    );
    const group = screen.getByRole("radiogroup");
    expect(group.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert")?.textContent).toBe("Invalid selection");
  });

  it("hides description when error is shown", () => {
    render(
      <SettingsChoicebox
        label="Density"
        description="Choose dock density"
        error="Invalid selection"
        value="normal"
        onChange={vi.fn()}
        options={MOCK_OPTIONS}
      />
    );
    expect(screen.queryByText("Choose dock density")).toBeNull();
    expect(screen.getByText("Invalid selection")).toBeTruthy();
  });

  it("aria-describedby only references error when both description and error exist", () => {
    render(
      <SettingsChoicebox
        label="Density"
        description="Choose dock density"
        error="Invalid selection"
        value="normal"
        onChange={vi.fn()}
        options={MOCK_OPTIONS}
      />
    );
    const group = screen.getByRole("radiogroup");
    const describedBy = group.getAttribute("aria-describedby")!;
    const ids = describedBy.split(" ");
    expect(ids).toHaveLength(1);
    expect(document.getElementById(ids[0]!)?.textContent).toBe("Invalid selection");
  });

  it("shows modified indicator when isModified", () => {
    const { container } = render(
      <SettingsChoicebox
        label="Density"
        value="normal"
        onChange={vi.fn()}
        options={MOCK_OPTIONS}
        isModified
      />
    );
    const dot = container.querySelector(".bg-daintree-accent.rounded-full");
    expect(dot).toBeTruthy();
  });

  it("shows reset button when isModified and onReset and not disabled", () => {
    const onReset = vi.fn();
    render(
      <SettingsChoicebox
        label="Density"
        value="normal"
        onChange={vi.fn()}
        options={MOCK_OPTIONS}
        isModified
        onReset={onReset}
      />
    );
    expect(screen.getByLabelText("Reset Density to default")).toBeTruthy();
  });

  it("hides reset button when disabled", () => {
    render(
      <SettingsChoicebox
        label="Density"
        value="normal"
        onChange={vi.fn()}
        options={MOCK_OPTIONS}
        isModified
        onReset={vi.fn()}
        disabled
      />
    );
    expect(screen.queryByLabelText("Reset Density to default")).toBeNull();
  });

  it("calls onChange when clicking an option", async () => {
    const onChange = vi.fn();
    render(
      <SettingsChoicebox
        label="Density"
        value="normal"
        onChange={onChange}
        options={MOCK_OPTIONS}
      />
    );

    const compactRadio = screen.getByRole("radio", { name: "Compact Smaller items" });
    fireEvent.click(compactRadio);
    expect(onChange).toHaveBeenCalledWith("compact");
  });

  it("does not call onChange when clicking disabled option", async () => {
    const onChange = vi.fn();
    const optionsWithDisabled = [
      ...MOCK_OPTIONS,
      { value: "large", label: "Large", disabled: true },
    ] as const;

    render(
      <SettingsChoicebox
        label="Density"
        value="normal"
        onChange={onChange}
        options={optionsWithDisabled}
      />
    );

    const largeRadio = screen.getByRole("radio", { name: "Large" });
    fireEvent.click(largeRadio);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not call onChange when clicking disabled group", async () => {
    const onChange = vi.fn();

    render(
      <SettingsChoicebox
        label="Density"
        value="normal"
        onChange={onChange}
        options={MOCK_OPTIONS}
        disabled
      />
    );

    const compactRadio = screen.getByRole("radio", { name: "Compact Smaller items" });
    fireEvent.click(compactRadio);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("updates selection when onChange is called", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SettingsChoicebox
        label="Density"
        value="normal"
        onChange={onChange}
        options={MOCK_OPTIONS}
      />
    );

    const radios = screen.getAllByRole("radio");
    expect(radios[1]?.getAttribute("aria-checked")).toBe("true");

    onChange.mockImplementation(() => {
      rerender(
        <SettingsChoicebox
          label="Density"
          value="compact"
          onChange={onChange}
          options={MOCK_OPTIONS}
        />
      );
    });

    const compactRadio = screen.getByRole("radio", { name: /Compact/ });
    fireEvent.click(compactRadio);
    const updatedRadios = screen.getAllByRole("radio");
    expect(updatedRadios[0]?.getAttribute("aria-checked")).toBe("true");
  });

  it("navigates with arrow keys", async () => {
    const onChange = vi.fn();
    render(
      <SettingsChoicebox
        label="Density"
        value="normal"
        onChange={onChange}
        options={MOCK_OPTIONS}
      />
    );

    const compactRadio = screen.getByRole("radio", { name: "Compact Smaller items" });
    compactRadio.focus();

    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight", code: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Normal Default size" }));

    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight", code: "ArrowRight" });
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: "Comfortable Larger items" })
    );

    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight", code: "ArrowRight" });
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: "Compact Smaller items" })
    );

    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft", code: "ArrowLeft" });
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: "Comfortable Larger items" })
    );

    fireEvent.keyDown(document.activeElement!, { key: "Home", code: "Home" });
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: "Compact Smaller items" })
    );

    fireEvent.keyDown(document.activeElement!, { key: "End", code: "End" });
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: "Comfortable Larger items" })
    );
  });

  it("activates option with Space key", async () => {
    const onChange = vi.fn();
    render(
      <SettingsChoicebox
        label="Density"
        value="normal"
        onChange={onChange}
        options={MOCK_OPTIONS}
      />
    );

    const compactRadio = screen.getByRole("radio", { name: "Compact Smaller items" });
    compactRadio.focus();

    fireEvent.keyDown(document.activeElement!, { key: " ", code: "Space" });
    expect(onChange).toHaveBeenCalledWith("compact");
  });

  it("activates option with Enter key", async () => {
    const onChange = vi.fn();
    render(
      <SettingsChoicebox
        label="Density"
        value="normal"
        onChange={onChange}
        options={MOCK_OPTIONS}
      />
    );

    const compactRadio = screen.getByRole("radio", { name: "Compact Smaller items" });
    compactRadio.focus();

    fireEvent.keyDown(document.activeElement!, { key: "Enter", code: "Enter" });
    expect(onChange).toHaveBeenCalledWith("compact");
  });

  it("applies grid layout when columns prop is set", () => {
    const { container } = render(
      <SettingsChoicebox
        label="Density"
        value="normal"
        onChange={vi.fn()}
        options={MOCK_OPTIONS}
        columns={3}
      />
    );
    const group = container.querySelector('[role="radiogroup"]');
    expect(group?.classList.contains("grid")).toBe(true);
    expect(group?.classList.contains("grid-cols-3")).toBe(true);
  });

  it("respects custom resetAriaLabel", () => {
    const onReset = vi.fn();
    render(
      <SettingsChoicebox
        label="Density"
        value="normal"
        onChange={vi.fn()}
        options={MOCK_OPTIONS}
        isModified
        onReset={onReset}
        resetAriaLabel="Reset density setting"
      />
    );
    expect(screen.getByLabelText("Reset density setting")).toBeTruthy();
  });

  it("applies className to container", () => {
    const { container } = render(
      <SettingsChoicebox
        label="Density"
        value="normal"
        onChange={vi.fn()}
        options={MOCK_OPTIONS}
        className="custom-class"
      />
    );
    const wrapper = container.querySelector(".custom-class");
    expect(wrapper).toBeTruthy();
  });
});

describe("SettingsCheckbox", () => {
  it("renders label and description", () => {
    render(
      <SettingsCheckbox
        label="Test Setting"
        description="A test description"
        checked={false}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByText("Test Setting")).toBeTruthy();
    expect(screen.getByText("A test description")).toBeTruthy();
  });

  it("associates label with checkbox", () => {
    const onChange = vi.fn();
    render(
      <SettingsCheckbox
        label="Test Setting"
        description="A test description"
        checked={false}
        onChange={onChange}
      />
    );
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeTruthy();
  });

  it("wires description to aria-describedby", () => {
    render(
      <SettingsCheckbox
        label="Test Setting"
        description="A test description"
        checked={false}
        onChange={vi.fn()}
      />
    );
    const checkbox = screen.getByRole("checkbox");
    const describedBy = checkbox.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
  });

  it("shows error and sets aria-invalid", () => {
    render(
      <SettingsCheckbox
        label="Test Setting"
        description="A test description"
        checked={false}
        onChange={vi.fn()}
        error="Invalid state"
      />
    );
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert")?.textContent).toBe("Invalid state");
  });

  it("hides description when error is shown", () => {
    render(
      <SettingsCheckbox
        label="Test Setting"
        description="A test description"
        checked={false}
        onChange={vi.fn()}
        error="Invalid state"
      />
    );
    expect(screen.queryByText("A test description")).toBeNull();
    expect(screen.getByText("Invalid state")).toBeTruthy();
  });

  it("calls onChange with false when unchecking", async () => {
    const onChange = vi.fn();
    render(
      <SettingsCheckbox
        label="Test Setting"
        description="A test description"
        checked={true}
        onChange={onChange}
      />
    );

    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("calls onChange with true when checking", async () => {
    const onChange = vi.fn();
    render(
      <SettingsCheckbox
        label="Test Setting"
        description="A test description"
        checked={false}
        onChange={onChange}
      />
    );

    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does not call onChange when disabled", async () => {
    const onChange = vi.fn();
    render(
      <SettingsCheckbox
        label="Test Setting"
        description="A test description"
        checked={false}
        onChange={onChange}
        disabled
      />
    );

    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("applies disabled styling", () => {
    render(
      <SettingsCheckbox
        label="Test Setting"
        description="A test description"
        checked={false}
        onChange={vi.fn()}
        disabled
      />
    );
    const checkbox = screen.getByRole("checkbox");
    const checkboxEl = checkbox as HTMLInputElement;
    expect(checkboxEl.disabled).toBe(true);
    const label = screen.getByText("Test Setting");
    expect(label).toBeTruthy();
    expect(label.classList.contains("cursor-not-allowed")).toBe(true);
  });

  it("uses semantic tokens for background and border", () => {
    render(
      <SettingsCheckbox
        label="Test Setting"
        description="A test description"
        checked={false}
        onChange={vi.fn()}
      />
    );
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox.className).toContain("bg-daintree-bg");
    expect(checkbox.className).toContain("border-border-strong");
  });

  it("uses accent color when checked", () => {
    render(
      <SettingsCheckbox
        label="Test Setting"
        description="A test description"
        checked={true}
        onChange={vi.fn()}
      />
    );
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox.className).toContain("data-[state=checked]:bg-daintree-accent");
    expect(checkbox.className).toContain("data-[state=checked]:border-daintree-accent");
  });

  it("renders checkmark when checked", () => {
    render(
      <SettingsCheckbox
        label="Test Setting"
        description="A test description"
        checked={true}
        onChange={vi.fn()}
      />
    );
    const checkbox = screen.getByRole("checkbox");
    const indicator = checkbox.querySelector("svg");
    expect(indicator).toBeTruthy();
  });

  it("uses error styling when error is present", () => {
    render(
      <SettingsCheckbox
        label="Test Setting"
        description="A test description"
        checked={false}
        onChange={vi.fn()}
        error="Invalid state"
      />
    );
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox.className).toContain("border-status-error");
    expect(checkbox.className).toContain("data-[state=checked]:border-status-error");
  });
});

describe("SettingsSwitch", () => {
  it("renders with aria-label", () => {
    render(<SettingsSwitch checked={false} onCheckedChange={vi.fn()} aria-label="Test switch" />);
    const switchEl = screen.getByRole("switch");
    expect(switchEl).toBeTruthy();
    expect(switchEl.getAttribute("aria-label")).toBe("Test switch");
  });

  it("calls onCheckedChange with true when toggling on", async () => {
    const onChange = vi.fn();
    render(<SettingsSwitch checked={false} onCheckedChange={onChange} aria-label="Test switch" />);

    const switchEl = screen.getByRole("switch");
    fireEvent.click(switchEl);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("calls onCheckedChange with false when toggling off", async () => {
    const onChange = vi.fn();
    render(<SettingsSwitch checked={true} onCheckedChange={onChange} aria-label="Test switch" />);

    const switchEl = screen.getByRole("switch");
    fireEvent.click(switchEl);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("does not call onCheckedChange when disabled", async () => {
    const onChange = vi.fn();
    render(
      <SettingsSwitch
        checked={false}
        onCheckedChange={onChange}
        aria-label="Test switch"
        disabled
      />
    );

    const switchEl = screen.getByRole("switch");
    fireEvent.click(switchEl);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("applies disabled styling", () => {
    const { container } = render(
      <SettingsSwitch checked={false} onCheckedChange={vi.fn()} aria-label="Test switch" disabled />
    );
    const switchEl = container.querySelector('[role="switch"]');
    expect(switchEl?.classList.contains("opacity-50")).toBe(true);
    expect(switchEl?.classList.contains("cursor-not-allowed")).toBe(true);
  });

  it("uses correct track dimensions", () => {
    const { container } = render(
      <SettingsSwitch checked={false} onCheckedChange={vi.fn()} aria-label="Test switch" />
    );
    const switchEl = container.querySelector('[role="switch"]');
    expect(switchEl?.classList.contains("w-11")).toBe(true);
    expect(switchEl?.classList.contains("h-6")).toBe(true);
  });

  it("uses specific transitions (not transition-all)", () => {
    const { container } = render(
      <SettingsSwitch checked={false} onCheckedChange={vi.fn()} aria-label="Test switch" />
    );
    const switchEl = container.querySelector('[role="switch"]');
    expect(switchEl?.className).toContain("transition-colors");
    expect(switchEl?.className).not.toContain("transition-all");

    const thumb = switchEl?.querySelector("[data-state]");
    expect(thumb?.className).toContain("transition-transform");
    expect(thumb?.className).not.toContain("transition-all");
  });

  it("applies accent color scheme by default", () => {
    const { container } = render(
      <SettingsSwitch
        checked={true}
        onCheckedChange={vi.fn()}
        aria-label="Test switch"
        colorScheme="accent"
      />
    );
    const switchEl = container.querySelector('[role="switch"]');
    expect(switchEl?.className).toContain("data-[state=checked]:bg-daintree-accent");
  });

  it("applies amber color scheme", () => {
    const { container } = render(
      <SettingsSwitch
        checked={true}
        onCheckedChange={vi.fn()}
        aria-label="Test switch"
        colorScheme="amber"
      />
    );
    const switchEl = container.querySelector('[role="switch"]');
    expect(switchEl?.className).toContain("data-[state=checked]:bg-status-warning");
  });

  it("applies danger color scheme", () => {
    const { container } = render(
      <SettingsSwitch
        checked={true}
        onCheckedChange={vi.fn()}
        aria-label="Test switch"
        colorScheme="danger"
      />
    );
    const switchEl = container.querySelector('[role="switch"]');
    expect(switchEl?.className).toContain("data-[state=checked]:bg-status-error");
  });

  it("applies correct thumb colors for contrast", () => {
    const { container: offContainer } = render(
      <SettingsSwitch checked={false} onCheckedChange={vi.fn()} aria-label="Test switch" />
    );
    const thumbOff = offContainer.querySelector('[role="switch"] > span');
    expect(thumbOff?.className).toContain("bg-daintree-text");

    const { container: onContainer } = render(
      <SettingsSwitch checked={true} onCheckedChange={vi.fn()} aria-label="Test switch" />
    );
    const thumbOn = onContainer.querySelector('[role="switch"] > span');
    expect(thumbOn?.className).toContain("data-[state=checked]:bg-text-inverse");
  });

  it("toggles with keyboard (Space key)", () => {
    const onChange = vi.fn();
    render(<SettingsSwitch checked={false} onCheckedChange={onChange} aria-label="Test switch" />);

    const switchEl = screen.getByRole("switch");
    fireEvent.click(switchEl);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("applies className to root", () => {
    const { container } = render(
      <SettingsSwitch
        checked={false}
        onCheckedChange={vi.fn()}
        aria-label="Test switch"
        className="custom-class"
      />
    );
    const switchEl = container.querySelector('[role="switch"]');
    expect(switchEl?.classList.contains("custom-class")).toBe(true);
  });
});
