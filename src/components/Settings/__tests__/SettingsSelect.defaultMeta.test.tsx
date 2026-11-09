// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsSelect } from "../SettingsSelect";
import { SettingsGroup } from "../SettingsGroup";

const options = [
  { value: "a", label: "Alpha", isDefault: true, description: "First option" },
  { value: "b", label: "Beta" },
];

afterEach(cleanup);

describe("SettingsSelect default annotation (#16598)", () => {
  it("draws Default beside the option and leaves its label and the trigger plain", async () => {
    render(
      <SettingsGroup>
        <SettingsSelect label="Account" value="a" onValueChange={() => {}} options={options} />
      </SettingsGroup>
    );
    const trigger = screen.getByRole("combobox", { name: "Account" });
    expect(trigger.textContent).toBe("Alpha");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const alpha = await screen.findByRole("option", { name: "Alpha" });
    expect(alpha.textContent).toContain("Default");
    const describedBy = (alpha.getAttribute("aria-describedby") ?? "").split(" ");
    const described = describedBy.map((id) => document.getElementById(id)?.textContent);
    expect(describedBy).toHaveLength(2);
    expect(described).toContain("First option");
    expect(described).toContain("Default");

    const beta = screen.getByRole("option", { name: "Beta" });
    expect(beta.textContent).toBe("Beta");
    expect(beta.getAttribute("aria-describedby")).toBeNull();
    expect(trigger.textContent).toBe("Alpha");
  });

  it("announces the default on an option that has no description", async () => {
    render(
      <SettingsGroup>
        <SettingsSelect
          label="Account"
          value="b"
          onValueChange={() => {}}
          options={[
            { value: "a", label: "Alpha" },
            { value: "b", label: "Beta", isDefault: true },
          ]}
        />
      </SettingsGroup>
    );
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Account" }), { key: "ArrowDown" });
    const beta = await screen.findByRole("option", { name: "Beta" });
    const id = beta.getAttribute("aria-describedby");
    expect(document.getElementById(id ?? "")?.textContent).toBe("Default");
  });
});
