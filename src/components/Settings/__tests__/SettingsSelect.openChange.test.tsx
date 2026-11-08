// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsSelect } from "../SettingsSelect";
import { SettingsGroup } from "../SettingsGroup";

const options = [
  { value: "a", label: "Alpha", description: "First option" },
  { value: "b", label: "Beta" },
];

afterEach(cleanup);

describe("SettingsSelect onOpenChange (#16407)", () => {
  it.each([
    ["inside a group", true],
    ["on its own", false],
  ])("tells the caller when the list opens and closes %s", async (_name, grouped) => {
    const onOpenChange = vi.fn();
    const select = (
      <SettingsSelect
        label="Account"
        value="a"
        onValueChange={() => {}}
        onOpenChange={onOpenChange}
        options={options}
      />
    );
    render(grouped ? <SettingsGroup>{select}</SettingsGroup> : select);
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Account" }), { key: "ArrowDown" });
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(await screen.findByRole("option", { name: /Beta/ }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps an option's description out of the trigger once it is picked", async () => {
    render(
      <SettingsGroup>
        <SettingsSelect label="Account" value="a" onValueChange={() => {}} options={options} />
      </SettingsGroup>
    );
    const trigger = screen.getByRole("combobox", { name: "Account" });
    expect(trigger.textContent).toBe("Alpha");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(await screen.findByText("First option")).toBeTruthy();
    expect(trigger.textContent).toBe("Alpha");
  });
});
