// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsInput } from "../SettingsInput";
import { SettingsSelect } from "../SettingsSelect";
import { SettingsNumberInput } from "../SettingsNumberInput";
import { SettingsTextarea } from "../SettingsTextarea";

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
    expect(document.getElementById(ids[0])?.textContent).toBe("Required");
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
});
