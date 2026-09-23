// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsGroup, SettingsDependents, SettingsRow } from "../SettingsGroup";
import { SettingsSwitchCard } from "../SettingsSwitchCard";
import { SettingsInput } from "../SettingsInput";
import { SettingsCheckbox } from "../SettingsCheckbox";
import { SettingsChoicebox } from "../SettingsChoicebox";
import { SettingsPresetGroup } from "../SettingsPresetGroup";
import { SettingsSelect } from "../SettingsSelect";

const noop = () => {};

describe("SettingsGroup", () => {
  it("draws related switches on one surface rather than a card each", () => {
    const { container } = render(
      <SettingsGroup>
        <SettingsSwitchCard title="First" isEnabled={false} onChange={noop} />
        <SettingsSwitchCard title="Second" isEnabled onChange={noop} />
        <SettingsSwitchCard title="Third" isEnabled={false} onChange={noop} />
      </SettingsGroup>
    );
    expect(container.querySelectorAll(".settings-card")).toHaveLength(1);
    expect(container.querySelectorAll("[data-settings-row]")).toHaveLength(3);
  });

  it("gives a standalone switch its own one-row group, so it matches grouped ones", () => {
    const { container } = render(
      <SettingsSwitchCard title="Alone" isEnabled={false} onChange={noop} />
    );
    expect(container.querySelectorAll(".settings-card")).toHaveLength(1);
  });

  it("names a switch from its visible title when no separate name is given", () => {
    render(
      <SettingsGroup>
        <SettingsSwitchCard title="Resource monitoring" isEnabled={false} onChange={noop} />
      </SettingsGroup>
    );
    expect(screen.getByRole("switch", { name: "Resource monitoring" })).toBeTruthy();
  });

  it("puts text fields under their label and numbers on the rail", () => {
    const { container } = render(
      <SettingsGroup>
        <SettingsInput label="Command" value="npm run dev" onChange={noop} />
        <SettingsInput label="Timeout" type="number" value={30} onChange={noop} />
      </SettingsGroup>
    );
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-settings-row]"));
    expect(rows.map((r) => r.dataset.settingsRow)).toEqual(["stacked", "inline"]);
    expect(screen.getByRole("textbox", { name: "Command" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "Timeout" })).toBeTruthy();
  });

  it("resets without also toggling the row it sits in", () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    render(
      <SettingsGroup>
        <SettingsSwitchCard
          title="Flash"
          isEnabled
          onChange={onChange}
          isModified
          onReset={onReset}
        />
      </SettingsGroup>
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset Flash to default" }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("toggles a switch row from anywhere on the row", () => {
    const onChange = vi.fn();
    render(
      <SettingsGroup>
        <SettingsSwitchCard title="Flash" subtitle="Flash once" isEnabled onChange={onChange} />
      </SettingsGroup>
    );
    fireEvent.click(screen.getByText("Flash once"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsDependents", () => {
  it("really disables every control under an off parent, and says why", () => {
    const onChange = vi.fn();
    render(
      <SettingsGroup>
        <SettingsSwitchCard title="Parent" isEnabled={false} onChange={noop} />
        <SettingsDependents disabled reason="Turn on Parent to use these">
          <SettingsSwitchCard title="Child switch" isEnabled={false} onChange={onChange} />
          <SettingsInput label="Child field" type="number" value={1} onChange={noop} />
          <SettingsCheckbox label="Child box" description="d" checked={false} onChange={noop} />
          <SettingsRow
            label="Child custom"
            control={({ disabled }) => <button disabled={disabled}>Custom</button>}
          />
        </SettingsDependents>
      </SettingsGroup>
    );
    expect(screen.getByText("Turn on Parent to use these")).toBeTruthy();
    const child = screen.getByRole("switch", { name: "Child switch" }) as HTMLButtonElement;
    expect(child.disabled).toBe(true);
    expect(
      (screen.getByRole("spinbutton", { name: "Child field" }) as HTMLInputElement).disabled
    ).toBe(true);
    expect(
      (screen.getByRole("checkbox", { name: "Child box" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Custom" }) as HTMLButtonElement).disabled).toBe(
      true
    );

    fireEvent.click(screen.getByText("Child switch"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("leaves dependents operable and hides the reason while the parent is on", () => {
    render(
      <SettingsGroup>
        <SettingsDependents disabled={false} reason="Turn on Parent to use these">
          <SettingsSwitchCard title="Child switch" isEnabled={false} onChange={noop} />
        </SettingsDependents>
      </SettingsGroup>
    );
    expect(screen.queryByText("Turn on Parent to use these")).toBeNull();
    expect(
      (screen.getByRole("switch", { name: "Child switch" }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("indents dependents past their parent", () => {
    const { container } = render(
      <SettingsGroup>
        <SettingsSwitchCard title="Parent" isEnabled onChange={noop} />
        <SettingsDependents>
          <SettingsSwitchCard title="Child" isEnabled onChange={noop} />
        </SettingsDependents>
      </SettingsGroup>
    );
    const [parent, child] = Array.from(
      container.querySelectorAll<HTMLElement>("[data-settings-row]")
    );
    const inset = (el: HTMLElement) => Array.from(el.classList).find((c) => /^pl-\d+$/.test(c));
    expect(inset(parent!)).toBeTruthy();
    expect(inset(child!)).toBeTruthy();
    expect(inset(child!)).not.toBe(inset(parent!));
  });
});

describe("SettingsChoicebox radio contract", () => {
  const options = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta" },
    { value: "c", label: "Gamma" },
  ] as const;

  it("is one tab stop, and arrows move the selection with the focus", () => {
    const onChange = vi.fn();
    render(<SettingsChoicebox label="Letter" value="a" onChange={onChange} options={options} />);
    const radios = screen.getAllByRole("radio");
    expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1);

    radios[0]!.focus();
    fireEvent.keyDown(radios[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(radios[1]);
    expect(onChange).toHaveBeenLastCalledWith("b");
  });

  it("names the radiogroup itself when the caller supplies only an aria-label", () => {
    render(
      <SettingsChoicebox
        aria-label="Integration tier"
        value="a"
        onChange={noop}
        options={options}
      />
    );
    expect(screen.getByRole("radiogroup", { name: "Integration tier" })).toBeTruthy();
  });
});

describe("SettingsRow description wiring", () => {
  function describedText(el: Element): string {
    return (el.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" | ");
  }

  it("announces a grouped field's error before its description", () => {
    render(
      <SettingsGroup>
        <SettingsInput
          label="Port"
          type="number"
          description="Loopback only"
          error="Port must be 1024 or higher"
          value={80}
          onChange={noop}
        />
      </SettingsGroup>
    );
    const field = screen.getByRole("spinbutton", { name: "Port" });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(field)).toBe("Port must be 1024 or higher | Loopback only");
  });

  it("tells a disabled control why it is disabled", () => {
    render(
      <SettingsGroup>
        <SettingsDependents disabled>
          <SettingsSelect
            label="Sound"
            value="a"
            onValueChange={noop}
            options={[{ value: "a", label: "Chime" }]}
            disabledReason="Turn on Play sound to choose one"
          />
        </SettingsDependents>
      </SettingsGroup>
    );
    const trigger = screen.getByRole("combobox", { name: "Sound" });
    expect(describedText(trigger)).toContain("Turn on Play sound to choose one");
  });
});

describe("Choices inside a group", () => {
  const presets = [
    { value: 7, label: "7 days" },
    { value: 30, label: "30 days" },
  ] as const;

  it("renders a preset group as one labelled radiogroup on the row", () => {
    const onChange = vi.fn();
    render(
      <SettingsGroup>
        <SettingsPresetGroup
          label="Log retention"
          options={presets}
          value={7}
          onChange={onChange}
        />
      </SettingsGroup>
    );
    const group = screen.getByRole("radiogroup", { name: "Log retention" });
    expect(group).toBeTruthy();
    expect(group.getAttribute("aria-describedby")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "30 days" }));
    expect(onChange).toHaveBeenLastCalledWith(30);
  });

  it("disables choiceboxes under an off parent", () => {
    render(
      <SettingsGroup>
        <SettingsDependents disabled>
          <SettingsChoicebox
            label="Tier"
            value="a"
            onChange={noop}
            options={[
              { value: "a", label: "Alpha" },
              { value: "b", label: "Beta" },
            ]}
          />
        </SettingsDependents>
      </SettingsGroup>
    );
    for (const radio of screen.getAllByRole("radio")) {
      expect((radio as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("offers a checkbox's reset only while it differs from default", () => {
    const onReset = vi.fn();
    const onChange = vi.fn();
    const { rerender } = render(
      <SettingsGroup>
        <SettingsCheckbox
          label="Include tests"
          description="d"
          checked
          onChange={onChange}
          isModified
          onReset={onReset}
        />
      </SettingsGroup>
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset Include tests to default" }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    rerender(
      <SettingsGroup>
        <SettingsCheckbox label="Include tests" description="d" checked={false} onChange={noop} />
      </SettingsGroup>
    );
    expect(screen.queryByRole("button", { name: "Reset Include tests to default" })).toBeNull();
  });
});

describe("Preset group description", () => {
  it("describes the radiogroup with its row description", () => {
    render(
      <SettingsGroup>
        <SettingsPresetGroup
          label="Session history"
          description="Pruned at startup"
          options={[
            { value: 7, label: "7 days" },
            { value: 30, label: "30 days" },
          ]}
          value={7}
          onChange={noop}
        />
      </SettingsGroup>
    );
    const group = screen.getByRole("radiogroup", { name: "Session history" });
    const ids = (group.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain(
      "Pruned at startup"
    );
  });
});
