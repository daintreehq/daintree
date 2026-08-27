// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsInput } from "../SettingsInput";
import { SettingsSelect } from "../SettingsSelect";
import { SettingsNumberInput } from "../SettingsNumberInput";
import { SettingsTextarea } from "../SettingsTextarea";
import { SettingsChoicebox, type ChoiceboxOption } from "../SettingsChoicebox";
import { SettingsCheckbox } from "../SettingsCheckbox";
import { SettingsSwitch } from "../SettingsSwitch";
import { PresetColorPicker } from "../PresetColorPicker";

// Strip CSS comments without treating a `/*` inside a quoted string as one —
// index.css opens with `@source not "../.lessons/**/*"`, whose glob contains a
// literal `/*` ... `*/` pair.
function stripComments(css: string): string {
  let out = "";
  let quote: string | null = null;

  for (let i = 0; i < css.length; i += 1) {
    const char = css[i];

    if (quote !== null) {
      out += char;
      if (char === "\\") out += css[++i] ?? "";
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      out += char;
    } else if (char === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      i = close === -1 ? css.length : close + 1;
    } else {
      out += char;
    }
  }

  return out;
}

// Split a block body into its top-level rules. Nested rules stay bundled inside
// their parent's declarations, so a rule guarded by a nested at-rule (a media
// query, say) is never mistaken for one that applies unconditionally.
function topLevelRules(body: string): Array<{ prelude: string; declarations: string }> {
  const rules: Array<{ prelude: string; declarations: string }> = [];
  let depth = 0;
  let start = 0;
  let open = 0;

  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === "{") {
      if (depth === 0) open = i;
      depth += 1;
    } else if (body[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        rules.push({
          prelude: body.slice(start, open),
          declarations: body.slice(open + 1, i),
        });
        start = i + 1;
      }
    }
  }

  return rules;
}

// Collect every `animate-*` class that a `@variant reduce-motion` block silences
// outright. Only bare `.animate-x` selector items count: `.animate-x::before`,
// `.animate-x .child` and `:not(.animate-x)` all kill motion on something other
// than the element carrying the class, and must not be read as coverage.
function reduceMotionKilledClasses(css: string): Set<string> {
  const source = stripComments(css);
  const killed = new Set<string>();
  const marker = "@variant reduce-motion";

  for (let from = source.indexOf(marker); from !== -1; from = source.indexOf(marker, from)) {
    const open = source.indexOf("{", from);
    if (open === -1) break;

    let depth = 1;
    let end = open + 1;
    while (end < source.length && depth > 0) {
      if (source[end] === "{") depth += 1;
      else if (source[end] === "}") depth -= 1;
      end += 1;
    }

    for (const { prelude, declarations } of topLevelRules(source.slice(open + 1, end - 1))) {
      // `(?<!-)` rules out a custom property such as `--animation: none`.
      if (prelude.trimStart().startsWith("@")) continue;
      if (!/(?<!-)animation:\s*none/.test(declarations)) continue;

      for (const item of prelude.split(",")) {
        const name = /^\.(animate-[\w-]+)$/.exec(item.trim())?.[1];
        if (name !== undefined) killed.add(name);
      }
    }

    from = end;
  }

  return killed;
}

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
    const errorId = input.getAttribute("aria-describedby")!;
    expect(document.getElementById(errorId)?.textContent).toBe("Must be a number");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps description visible alongside error", () => {
    render(<SettingsInput label="Port" description="Server port" error="Invalid" />);
    expect(screen.getByText("Server port")).toBeTruthy();
    expect(screen.getByText("Invalid")).toBeTruthy();
  });

  it("aria-describedby references both error and description when both exist", () => {
    render(<SettingsInput label="Port" description="Server port" error="Required" />);
    const input = screen.getByLabelText("Port");
    const describedBy = input.getAttribute("aria-describedby")!;
    const ids = describedBy.split(" ");
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0]!)?.textContent).toBe("Required");
    expect(document.getElementById(ids[1]!)?.textContent).toBe("Server port");
  });

  it("shows modified indicator when isModified", () => {
    const { container } = render(<SettingsInput label="Name" isModified />);
    const dot = container.querySelector(".bg-state-modified.rounded-full");
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
  const EN_OPTIONS = [{ value: "en", label: "English" }];
  const DEFAULT_OPTIONS = [{ value: "d", label: "Default" }];

  it("renders label associated to combobox trigger", () => {
    render(
      <SettingsSelect label="Language" value="en" onValueChange={() => {}} options={EN_OPTIONS} />
    );
    const trigger = screen.getByLabelText("Language");
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute("role")).toBe("combobox");
  });

  it("wires description to aria-describedby", () => {
    render(
      <SettingsSelect
        label="Theme"
        description="Choose a color theme"
        value="d"
        onValueChange={() => {}}
        options={DEFAULT_OPTIONS}
      />
    );
    const trigger = screen.getByLabelText("Theme");
    const descId = trigger.getAttribute("aria-describedby");
    expect(descId).toBeTruthy();
    expect(document.getElementById(descId!)?.textContent).toBe("Choose a color theme");
  });

  it("displays the selected option label in the trigger", () => {
    render(
      <SettingsSelect label="Language" value="en" onValueChange={() => {}} options={EN_OPTIONS} />
    );
    expect(screen.getByLabelText("Language").textContent).toContain("English");
  });

  it("sets aria-invalid when error is provided", () => {
    render(
      <SettingsSelect
        label="Lang"
        error="Required"
        value="en"
        onValueChange={() => {}}
        options={EN_OPTIONS}
      />
    );
    const trigger = screen.getByLabelText("Lang");
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
    const errorId = trigger.getAttribute("aria-describedby")!;
    expect(document.getElementById(errorId)?.textContent).toBe("Required");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("aria-describedby references both error and description when both exist", () => {
    render(
      <SettingsSelect
        label="Theme"
        description="Choose a color theme"
        error="Required"
        value="d"
        onValueChange={() => {}}
        options={DEFAULT_OPTIONS}
      />
    );
    const trigger = screen.getByLabelText("Theme");
    const ids = trigger.getAttribute("aria-describedby")!.split(" ");
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0]!)?.textContent).toBe("Required");
    expect(document.getElementById(ids[1]!)?.textContent).toBe("Choose a color theme");
  });

  it("shows reset button when modified", () => {
    const onReset = vi.fn();
    render(
      <SettingsSelect
        label="Lang"
        isModified
        onReset={onReset}
        value="en"
        onValueChange={() => {}}
        options={EN_OPTIONS}
      />
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

  it("shows error and sets aria-invalid without role=alert", () => {
    render(<SettingsTextarea label="Notes" error="Cannot be empty" />);
    const textarea = screen.getByLabelText("Notes");
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    const errorId = textarea.getAttribute("aria-describedby")!;
    expect(document.getElementById(errorId)?.textContent).toBe("Cannot be empty");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("aria-describedby references both error and description when both exist", () => {
    render(
      <SettingsTextarea label="Notes" description="Additional notes" error="Cannot be empty" />
    );
    const textarea = screen.getByLabelText("Notes");
    const ids = textarea.getAttribute("aria-describedby")!.split(" ");
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0]!)?.textContent).toBe("Cannot be empty");
    expect(document.getElementById(ids[1]!)?.textContent).toBe("Additional notes");
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
    const errorId = group.getAttribute("aria-describedby")!;
    expect(document.getElementById(errorId)?.textContent).toBe("Invalid selection");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps description visible alongside error", () => {
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
    expect(screen.getByText("Choose dock density")).toBeTruthy();
    expect(screen.getByText("Invalid selection")).toBeTruthy();
  });

  it("aria-describedby references both error and description when both exist", () => {
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
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0]!)?.textContent).toBe("Invalid selection");
    expect(document.getElementById(ids[1]!)?.textContent).toBe("Choose dock density");
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
    const dot = container.querySelector(".bg-state-modified.rounded-full");
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

  it("reserves a check-icon slot on every option, visible only on the selected one", () => {
    render(
      <SettingsChoicebox label="Density" value="normal" onChange={vi.fn()} options={MOCK_OPTIONS} />
    );
    const radios = screen.getAllByRole("radio");
    // Every option keeps the slot (prevents reflow); only the selected one is visible.
    radios.forEach((radio) => {
      expect(radio.querySelectorAll("svg[aria-hidden='true']")).toHaveLength(1);
    });
    const visibleCheck = (radio: Element) => {
      const icon = radio.querySelector("svg[aria-hidden='true']")!;
      return !icon.classList.contains("invisible");
    };
    expect(radios.map(visibleCheck)).toEqual([false, true, false]);
  });

  it("moves the visible check when the selected value changes", () => {
    const { rerender } = render(
      <SettingsChoicebox label="Density" value="normal" onChange={vi.fn()} options={MOCK_OPTIONS} />
    );
    rerender(
      <SettingsChoicebox
        label="Density"
        value="compact"
        onChange={vi.fn()}
        options={MOCK_OPTIONS}
      />
    );
    const radios = screen.getAllByRole("radio");
    const visibleCheck = (radio: Element) => {
      const icon = radio.querySelector("svg[aria-hidden='true']");
      return !!icon && !icon.classList.contains("invisible");
    };
    expect(radios.map(visibleCheck)).toEqual([true, false, false]);
  });

  it("folds resolvedLabel into the option's accessible name", () => {
    const options: readonly ChoiceboxOption<string>[] = [
      { value: "inherit", label: "Default", resolvedLabel: "(On)", muted: true },
      { value: "on", label: "On" },
      { value: "off", label: "Off" },
    ];
    render(<SettingsChoicebox label="Skip" value="inherit" onChange={vi.fn()} options={options} />);
    expect(screen.getByRole("radio", { name: /Default \(On\)/ })).toBeTruthy();
  });

  it("keeps a muted option fully selectable", () => {
    const onChange = vi.fn();
    const options: readonly ChoiceboxOption<string>[] = [
      { value: "inherit", label: "Default", resolvedLabel: "(Off)", muted: true },
      { value: "on", label: "On" },
    ];
    render(<SettingsChoicebox label="Skip" value="on" onChange={onChange} options={options} />);
    const mutedRadio = screen.getByRole("radio", { name: /Default \(Off\)/ });
    expect(mutedRadio.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(mutedRadio);
    expect(onChange).toHaveBeenCalledWith("inherit");
  });

  it("renders the muted option with a lighter label weight than a peer option", () => {
    const options: readonly ChoiceboxOption<string>[] = [
      { value: "inherit", label: "Default", muted: true },
      { value: "on", label: "On" },
    ];
    render(<SettingsChoicebox label="Skip" value="on" onChange={vi.fn()} options={options} />);
    const mutedLabel = screen.getByText("Default");
    const peerLabel = screen.getByText("On");
    expect(mutedLabel.classList.contains("font-normal")).toBe(true);
    expect(mutedLabel.classList.contains("font-medium")).toBe(false);
    expect(peerLabel.classList.contains("font-medium")).toBe(true);
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
    const ids = checkbox.getAttribute("aria-describedby")!.split(" ");
    expect(document.getElementById(ids[0]!)?.textContent).toBe("Invalid state");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("omits aria-invalid when no error is present", () => {
    render(
      <SettingsCheckbox
        label="Test Setting"
        description="A test description"
        checked={false}
        onChange={vi.fn()}
      />
    );
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox.getAttribute("aria-invalid")).toBeNull();
  });

  it("keeps description visible alongside error", () => {
    render(
      <SettingsCheckbox
        label="Test Setting"
        description="A test description"
        checked={false}
        onChange={vi.fn()}
        error="Invalid state"
      />
    );
    expect(screen.getByText("A test description")).toBeTruthy();
    expect(screen.getByText("Invalid state")).toBeTruthy();
  });

  it("aria-describedby references both error and description when both exist", () => {
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
    const describedBy = checkbox.getAttribute("aria-describedby")!;
    const ids = describedBy.split(" ");
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0]!)?.textContent).toBe("Invalid state");
    expect(document.getElementById(ids[1]!)?.textContent).toBe("A test description");
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
    expect(checkbox.className).toContain("bg-surface-input");
    expect(checkbox.className).toContain("border-border-strong");
  });

  // Membership, not emphasis: the checked box borrows the text colour, never
  // the accent, which is reserved for the one load-bearing signal on screen.
  it("marks the checked state without spending the accent", () => {
    render(
      <SettingsCheckbox
        label="Test Setting"
        description="A test description"
        checked={true}
        onChange={vi.fn()}
      />
    );
    const checkbox = screen.getByRole("checkbox");
    const checkedFills = checkbox.className
      .split(/\s+/)
      .filter((name) => name.startsWith("data-[state=checked]:bg-"));
    expect(checkedFills).toHaveLength(1);
    expect(checkedFills[0]).not.toContain("accent");
  });

  // A 16px box at the repo's 10px base radius reads as a radio button.
  it("does not round the box far enough to read as a radio", () => {
    render(
      <SettingsCheckbox
        label="Test Setting"
        description="A test description"
        checked={false}
        onChange={vi.fn()}
      />
    );
    const radii = screen
      .getByRole("checkbox")
      .className.split(/\s+/)
      .filter((name) => /^rounded(-|$)/.test(name));
    expect(radii).toHaveLength(1);
    expect(radii[0]).not.toBe("rounded");
    expect(radii[0]).not.toBe("rounded-lg");
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

  // Cross-source contract (#11166): whatever animation the checkmark indicator
  // carries must be registered in a reduce-motion kill-list, or the check-in
  // animation keeps playing for users who asked for no motion. Reads the classes
  // off the rendered node rather than naming them, so a rename in either file
  // that isn't mirrored in the other fails here. This asserts source
  // registration, not computed style — jsdom applies no stylesheet.
  it("registers the checked indicator's animate-* classes in the reduce-motion kill-list", () => {
    render(
      <SettingsCheckbox
        label="Test Setting"
        description="A test description"
        checked={true}
        onChange={vi.fn()}
      />
    );
    const indicator = screen.getByRole("checkbox").querySelector("svg")?.parentElement;
    expect(indicator).toBeTruthy();

    const animationClasses = [...indicator!.classList].filter((name) =>
      name.startsWith("animate-")
    );
    expect(animationClasses.length).toBeGreaterThan(0);

    const killed = reduceMotionKilledClasses(
      readFileSync(resolve(__dirname, "../../../index.css"), "utf8")
    );
    animationClasses.forEach((name) => expect([...killed]).toContain(name));
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
    const switchEl = container.querySelector('[role="switch"]') as HTMLButtonElement | null;
    // Keyed off the real :disabled state rather than a conditional class, so
    // the dimming cannot drift out of sync with whether the control is live.
    expect(switchEl?.disabled).toBe(true);
    expect(switchEl?.classList.contains("disabled:opacity-50")).toBe(true);
    expect(switchEl?.classList.contains("disabled:cursor-not-allowed")).toBe(true);
  });

  it("uses correct track dimensions", () => {
    const { container } = render(
      <SettingsSwitch checked={false} onCheckedChange={vi.fn()} aria-label="Test switch" />
    );
    const switchEl = container.querySelector('[role="switch"]');
    expect(switchEl?.classList.contains("w-11")).toBe(true);
    expect(switchEl?.classList.contains("h-6")).toBe(true);
  });

  it("uses specific transitions (not transition-all) with asymmetric track/thumb timing", () => {
    const { container } = render(
      <SettingsSwitch checked={false} onCheckedChange={vi.fn()} aria-label="Test switch" />
    );
    const switchEl = container.querySelector('[role="switch"]');
    expect(switchEl?.className).toContain("transition-colors");
    expect(switchEl?.className).not.toContain("transition-all");
    expect(switchEl?.className).toContain("duration-200");
    expect(switchEl?.className).toContain("ease-out");
    expect(switchEl?.className).not.toContain("duration-150");
    expect(switchEl?.className).not.toContain("ease-in-out");

    const thumb = switchEl?.querySelector("[data-state]");
    expect(thumb?.className).toContain("transition-transform");
    expect(thumb?.className).not.toContain("transition-all");
    expect(thumb?.className).toContain("duration-100");
    expect(thumb?.className).toContain("ease-[var(--ease-out-expo)]");
    expect(thumb?.className).not.toContain("duration-150");
    expect(thumb?.className).not.toContain("ease-in-out");
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
    expect(switchEl?.getAttribute("data-tone")).toBe("neutral");
    expect(switchEl?.className).toContain("data-[state=checked]:bg-text-primary");
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
    expect(switchEl?.getAttribute("data-tone")).toBe("warning");
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
    expect(switchEl?.getAttribute("data-tone")).toBe("danger");
    expect(switchEl?.className).toContain("data-[state=checked]:bg-status-error");
  });

  // The off state used to paint the thumb with the very fill the on state uses
  // for its TRACK, so a switch that was off presented a solid high-contrast
  // circle and read as lit. The rule, not the values: the resting thumb must
  // never borrow the fill that means "on", and the two thumb states must
  // differ from each other.
  it("never paints the resting thumb with the fill that signals on", () => {
    const { container } = render(
      <SettingsSwitch checked={false} onCheckedChange={vi.fn()} aria-label="Test switch" />
    );
    const track = container.querySelector('[role="switch"]');
    const thumb = container.querySelector('[role="switch"] > span');

    const bg = (className: string | undefined, checked: boolean) =>
      (className ?? "")
        .split(/\s+/)
        .filter((c) => (checked ? c.startsWith("data-[state=checked]:bg-") : /^bg-/.test(c)))
        .map((c) => c.replace("data-[state=checked]:", ""));

    const restingThumb = bg(thumb?.className, false);
    const onTrack = bg(track?.className, true);
    const onThumb = bg(thumb?.className, true);

    expect(restingThumb.length, "the resting thumb needs a fill").toBeGreaterThan(0);
    expect(onTrack.length, "the on track needs a fill").toBeGreaterThan(0);
    expect(restingThumb).not.toEqual(expect.arrayContaining(onTrack));
    expect(restingThumb).not.toEqual(expect.arrayContaining(onThumb));
  });

  it("gives the resting track a boundary so the control stays discernible", () => {
    const { container } = render(
      <SettingsSwitch checked={false} onCheckedChange={vi.fn()} aria-label="Test switch" />
    );
    const track = container.querySelector('[role="switch"]');
    // Either spelling is fine; what matters is that the resting control has an
    // edge of its own and does not rely on its fill alone to be discernible.
    expect(track?.className).toMatch(/(^|\s)(border|ring-\d)(\s|-|$)/);
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

describe("layout contract — subgrid participation", () => {
  const getRoot = (container: HTMLElement) => container.firstElementChild as HTMLElement;

  it("SettingsInput root has grid-cols-subgrid", () => {
    const { container } = render(<SettingsInput label="Test" />);
    expect(getRoot(container).classList.contains("grid-cols-subgrid")).toBe(true);
  });

  it("SettingsSelect root has grid-cols-subgrid", () => {
    const { container } = render(
      <SettingsSelect
        label="Test"
        value="a"
        onValueChange={vi.fn()}
        options={[{ value: "a", label: "A" }]}
      />
    );
    expect(getRoot(container).classList.contains("grid-cols-subgrid")).toBe(true);
  });

  it("SettingsTextarea root has grid-cols-subgrid", () => {
    const { container } = render(<SettingsTextarea label="Test" />);
    expect(getRoot(container).classList.contains("grid-cols-subgrid")).toBe(true);
  });

  it("SettingsChoicebox root has grid-cols-subgrid", () => {
    const options: ChoiceboxOption[] = [{ value: "a", label: "A" }];
    const { container } = render(
      <SettingsChoicebox label="Test" value="a" onChange={vi.fn()} options={options} />
    );
    expect(getRoot(container).classList.contains("grid-cols-subgrid")).toBe(true);
  });

  it("SettingsCheckbox outer wrapper has grid-cols-subgrid", () => {
    const { container } = render(
      <SettingsCheckbox label="Test" description="desc" checked={false} onChange={vi.fn()} />
    );
    expect(getRoot(container).classList.contains("grid-cols-subgrid")).toBe(true);
  });
});

describe("touched prop — error gating", () => {
  const ERR = "This field is required";

  const hasInvalid = (container: HTMLElement) =>
    container.querySelector('[aria-invalid="true"]') !== null;

  const hasErrorBorder = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("*")).some((el) =>
      el.className.toString().includes("border-status-error")
    );

  it("SettingsInput hides error styling when touched={false}", () => {
    const { container } = render(<SettingsInput label="Name" error={ERR} touched={false} />);
    expect(hasInvalid(container)).toBe(false);
    expect(hasErrorBorder(container)).toBe(false);
    expect(screen.queryByText(ERR)).toBeNull();
  });

  it("SettingsInput shows error styling when touched omitted (backward compat)", () => {
    const { container } = render(<SettingsInput label="Name" error={ERR} />);
    expect(hasInvalid(container)).toBe(true);
    expect(hasErrorBorder(container)).toBe(true);
    expect(screen.getByText(ERR)).toBeTruthy();
  });

  it("SettingsInput shows error styling when touched={true}", () => {
    const { container } = render(<SettingsInput label="Name" error={ERR} touched={true} />);
    expect(hasInvalid(container)).toBe(true);
    expect(screen.getByText(ERR)).toBeTruthy();
  });

  it("SettingsNumberInput hides error styling when touched={false}", () => {
    const { container } = render(<SettingsNumberInput label="Count" error={ERR} touched={false} />);
    expect(hasInvalid(container)).toBe(false);
    expect(hasErrorBorder(container)).toBe(false);
    expect(screen.queryByText(ERR)).toBeNull();
  });

  it("SettingsNumberInput shows error styling when touched omitted (backward compat)", () => {
    const { container } = render(<SettingsNumberInput label="Count" error={ERR} />);
    expect(hasInvalid(container)).toBe(true);
    expect(screen.getByText(ERR)).toBeTruthy();
  });

  it("SettingsTextarea hides error styling when touched={false}", () => {
    const { container } = render(<SettingsTextarea label="Bio" error={ERR} touched={false} />);
    expect(hasInvalid(container)).toBe(false);
    expect(hasErrorBorder(container)).toBe(false);
    expect(screen.queryByText(ERR)).toBeNull();
  });

  it("SettingsTextarea shows error styling when touched omitted (backward compat)", () => {
    const { container } = render(<SettingsTextarea label="Bio" error={ERR} />);
    expect(hasInvalid(container)).toBe(true);
    expect(hasErrorBorder(container)).toBe(true);
    expect(screen.getByText(ERR)).toBeTruthy();
  });

  it("SettingsSelect hides error styling when touched={false}", () => {
    const { container } = render(
      <SettingsSelect
        label="Lang"
        value="en"
        onValueChange={vi.fn()}
        options={[{ value: "en", label: "English" }]}
        error={ERR}
        touched={false}
      />
    );
    expect(hasInvalid(container)).toBe(false);
    expect(hasErrorBorder(container)).toBe(false);
    expect(screen.queryByText(ERR)).toBeNull();
  });

  it("SettingsSelect shows error styling when touched omitted (backward compat)", () => {
    const { container } = render(
      <SettingsSelect
        label="Lang"
        value="en"
        onValueChange={vi.fn()}
        options={[{ value: "en", label: "English" }]}
        error={ERR}
      />
    );
    expect(hasInvalid(container)).toBe(true);
    expect(hasErrorBorder(container)).toBe(true);
    expect(screen.getByText(ERR)).toBeTruthy();
  });

  it("SettingsChoicebox hides error styling when touched={false}", () => {
    const { container } = render(
      <SettingsChoicebox
        label="Density"
        value="normal"
        onChange={vi.fn()}
        options={MOCK_OPTIONS}
        error={ERR}
        touched={false}
      />
    );
    expect(hasInvalid(container)).toBe(false);
    expect(screen.queryByText(ERR)).toBeNull();
  });

  it("SettingsChoicebox shows error styling when touched omitted (backward compat)", () => {
    const { container } = render(
      <SettingsChoicebox
        label="Density"
        value="normal"
        onChange={vi.fn()}
        options={MOCK_OPTIONS}
        error={ERR}
      />
    );
    expect(hasInvalid(container)).toBe(true);
    expect(screen.getByText(ERR)).toBeTruthy();
  });

  it("SettingsCheckbox hides error styling when touched={false}", () => {
    const { container } = render(
      <SettingsCheckbox
        label="Agree"
        description="desc"
        checked={false}
        onChange={vi.fn()}
        error={ERR}
        touched={false}
      />
    );
    expect(hasInvalid(container)).toBe(false);
    expect(hasErrorBorder(container)).toBe(false);
    expect(screen.queryByText(ERR)).toBeNull();
  });

  it("SettingsCheckbox shows error styling when touched omitted (backward compat)", () => {
    const { container } = render(
      <SettingsCheckbox
        label="Agree"
        description="desc"
        checked={false}
        onChange={vi.fn()}
        error={ERR}
      />
    );
    expect(hasInvalid(container)).toBe(true);
    expect(hasErrorBorder(container)).toBe(true);
    expect(screen.getByText(ERR)).toBeTruthy();
  });

  it("SettingsInput drops dangling aria-describedby errorId when touched={false}", () => {
    const { container } = render(<SettingsInput label="Name" error={ERR} touched={false} />);
    const input = container.querySelector("input");
    expect(input?.getAttribute("aria-describedby")).toBeNull();
  });

  // Each entry: control selector + a render() of the primitive with
  // error + description + touched=false. aria-describedby must resolve to
  // exactly the description node — never the (non-rendered) error node.
  const DESC = "Helps explain the field";
  const describedByCases: ReadonlyArray<{
    name: string;
    selector: string;
    render: () => ReturnType<typeof render>;
  }> = [
    {
      name: "SettingsInput",
      selector: "input",
      render: () =>
        render(<SettingsInput label="Name" error={ERR} description={DESC} touched={false} />),
    },
    {
      name: "SettingsNumberInput",
      selector: "input",
      render: () =>
        render(
          <SettingsNumberInput label="Count" error={ERR} description={DESC} touched={false} />
        ),
    },
    {
      name: "SettingsTextarea",
      selector: "textarea",
      render: () =>
        render(<SettingsTextarea label="Bio" error={ERR} description={DESC} touched={false} />),
    },
    {
      name: "SettingsSelect",
      selector: '[role="combobox"]',
      render: () =>
        render(
          <SettingsSelect
            label="Lang"
            value="en"
            onValueChange={vi.fn()}
            options={[{ value: "en", label: "English" }]}
            error={ERR}
            description={DESC}
            touched={false}
          />
        ),
    },
    {
      name: "SettingsChoicebox",
      selector: '[role="radiogroup"]',
      render: () =>
        render(
          <SettingsChoicebox
            label="Density"
            value="normal"
            onChange={vi.fn()}
            options={MOCK_OPTIONS}
            error={ERR}
            description={DESC}
            touched={false}
          />
        ),
    },
    {
      name: "SettingsCheckbox",
      selector: '[role="checkbox"]',
      render: () =>
        render(
          <SettingsCheckbox
            label="Agree"
            description={DESC}
            checked={false}
            onChange={vi.fn()}
            error={ERR}
            touched={false}
          />
        ),
    },
  ];

  describedByCases.forEach(({ name, selector, render: renderPrimitive }) => {
    it(`${name} aria-describedby resolves to description only (not errorId) when touched={false}`, () => {
      const { container } = renderPrimitive();
      const control = container.querySelector(selector);
      const describedBy = control?.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      const ids = describedBy!.split(" ").filter(Boolean);
      const texts = ids.map((id) => document.getElementById(id)?.textContent);
      expect(texts).toContain(DESC);
      expect(texts).not.toContain(ERR);
      expect(screen.queryByText(ERR)).toBeNull();
    });
  });
});

describe("transition-all regression — field primitives", () => {
  const expectNoTransitionAll = (container: HTMLElement) => {
    container.querySelectorAll("*").forEach((el) => {
      expect(el.className.toString()).not.toContain("transition-all");
    });
  };

  it("SettingsInput uses no transition-all", () => {
    const { container } = render(<SettingsInput label="Test" error="err" />);
    expectNoTransitionAll(container);
  });

  it("SettingsNumberInput uses no transition-all", () => {
    const { container } = render(<SettingsNumberInput label="Test" error="err" />);
    expectNoTransitionAll(container);
  });

  it("SettingsTextarea uses no transition-all", () => {
    const { container } = render(<SettingsTextarea label="Test" error="err" />);
    expectNoTransitionAll(container);
  });

  it("SettingsSelect uses no transition-all", () => {
    const { container } = render(
      <SettingsSelect
        label="Test"
        value="en"
        onValueChange={vi.fn()}
        options={[{ value: "en", label: "English" }]}
        error="err"
      />
    );
    expectNoTransitionAll(container);
  });

  it("SettingsChoicebox uses no transition-all", () => {
    const { container } = render(
      <SettingsChoicebox
        label="Test"
        value="normal"
        onChange={vi.fn()}
        options={MOCK_OPTIONS}
        error="err"
      />
    );
    expectNoTransitionAll(container);
  });

  it("SettingsCheckbox uses no transition-all", () => {
    const { container } = render(
      <SettingsCheckbox
        label="Test"
        description="desc"
        checked={false}
        onChange={vi.fn()}
        error="err"
      />
    );
    expectNoTransitionAll(container);
  });

  it("PresetColorPicker trigger uses transition-shadow, not transition-all", () => {
    const { container } = render(
      <PresetColorPicker color="#e06c75" onChange={vi.fn()} agentColor="#e06c75" />
    );
    const trigger = container.querySelector('[data-testid="preset-color-picker-trigger"]');
    expect(trigger?.className).toContain("transition-shadow");
    expect(trigger?.className).not.toContain("transition-all");
    expectNoTransitionAll(container);
  });
});
