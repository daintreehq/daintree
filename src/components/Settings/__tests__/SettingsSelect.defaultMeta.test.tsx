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
    expect(alpha.getAttribute("aria-describedby")?.split(" ")).toHaveLength(2);

    const beta = screen.getByRole("option", { name: "Beta" });
    expect(beta.textContent).toBe("Beta");
    expect(beta.getAttribute("aria-describedby")).toBeNull();
    expect(trigger.textContent).toBe("Alpha");
  });
});
