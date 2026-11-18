// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { BehavioralControls } from "../BehavioralControls";
import type { ComponentProps } from "react";

type Props = ComponentProps<typeof BehavioralControls>;

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    scopeKind: "default",
    scopeLabel: "Claude",
    dangerousMode: "inherit",
    effectiveLevel: "cli-default",
    effectivePermissionArgs: "",
    autoSupported: false,
    inheritLevel: "skip",
    inheritHint: "Inherited from global setting",
    customArgsValue: "",
    customArgsPlaceholder: "--flag",
    customArgsDescription: "Extra CLI flags",
    customFlagsOverride: undefined,
    onDangerousModeChange: vi.fn(),
    onCustomFlagsChange: vi.fn(),
    onCustomFlagsOverrideReset: vi.fn(),
    ...overrides,
  };
}

describe("BehavioralControls — skip permissions control", () => {
  it("renders the permission control as three radios, not text inputs, for an agent with no Auto mode (issue #10530)", () => {
    const { container } = render(<BehavioralControls {...makeProps()} />);
    const region = container.querySelector("#agents-skip-permissions");
    if (!(region instanceof HTMLElement)) throw new Error("skip-permissions region not found");
    const scoped = within(region);
    expect(scoped.getAllByRole("radio")).toHaveLength(3);
    expect(scoped.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("puts the choice on the row's rail as a segmented control, not a column of tiles", () => {
    const { container } = render(<BehavioralControls {...makeProps()} />);
    const region = container.querySelector("#agents-skip-permissions");
    if (!(region instanceof HTMLElement)) throw new Error("skip-permissions region not found");
    expect(region.getAttribute("data-settings-row")).toBe("inline");
    const group = within(region).getByRole("radiogroup", { name: "Permission prompts" });
    const describedBy = group.getAttribute("aria-describedby") ?? "";
    const described = describedBy
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(described).toContain("Inherited from global setting");
  });

  it("names the flags the resolved level adds, marking only Skip all as a bypass", () => {
    const { container, rerender } = render(
      <BehavioralControls
        {...makeProps({
          effectiveLevel: "skip",
          effectivePermissionArgs: "--dangerously-skip-permissions",
        })}
      />
    );
    const region = container.querySelector("#agents-skip-permissions");
    if (!(region instanceof HTMLElement)) throw new Error("skip-permissions region not found");
    expect(within(region).getByText("--dangerously-skip-permissions")).toBeTruthy();
    expect(region.querySelector("svg.lucide-shield-off")).not.toBeNull();

    rerender(
      <BehavioralControls
        {...makeProps({
          autoSupported: true,
          dangerousMode: "auto",
          effectiveLevel: "auto",
          effectivePermissionArgs: "--permission-mode auto",
        })}
      />
    );
    expect(within(region).getByText("--permission-mode auto")).toBeTruthy();
    expect(region.querySelector("svg.lucide-shield-off")).toBeNull();

    rerender(<BehavioralControls {...makeProps({ dangerousMode: "off" })} />);
    expect(region.querySelector("code")).toBeNull();
  });

  it("surfaces the inherited resolved level inline on the Inherit option and updates with the parent", () => {
    const { rerender } = render(<BehavioralControls {...makeProps({ inheritLevel: "skip" })} />);
    expect(screen.getByRole("radio", { name: "Inherit (Skip all)" })).toBeTruthy();

    rerender(<BehavioralControls {...makeProps({ inheritLevel: "cli-default" })} />);
    expect(screen.getByRole("radio", { name: "Inherit (CLI default)" })).toBeTruthy();

    rerender(<BehavioralControls {...makeProps({ autoSupported: true, inheritLevel: "auto" })} />);
    expect(screen.getByRole("radio", { name: "Inherit (Auto)" })).toBeTruthy();
  });

  it("offers Auto between the CLI default and Skip all only where the agent declares it (#17435)", () => {
    const onDangerousModeChange = vi.fn();
    const { rerender } = render(<BehavioralControls {...makeProps({ onDangerousModeChange })} />);
    expect(screen.queryByRole("radio", { name: "Auto" })).toBeNull();

    rerender(<BehavioralControls {...makeProps({ autoSupported: true, onDangerousModeChange })} />);
    expect(screen.getAllByRole("radio").map((radio) => radio.textContent)).toEqual([
      "Inherit (Skip all)",
      "CLI default",
      "Auto",
      "Skip all",
    ]);
    screen.getByRole("radio", { name: "Auto" }).click();
    expect(onDangerousModeChange).toHaveBeenCalledWith("auto");
  });

  it("keeps a saved Auto the agent can't honour visible but disabled, and says what launches", () => {
    const { container } = render(
      <BehavioralControls {...makeProps({ dangerousMode: "auto", autoSupported: false })} />
    );
    const auto = screen.getByRole("radio", { name: "Auto" });
    expect(auto.getAttribute("aria-checked")).toBe("true");
    expect(auto.hasAttribute("disabled") || auto.getAttribute("aria-disabled") === "true").toBe(
      true
    );
    const region = container.querySelector("#agents-skip-permissions");
    if (!(region instanceof HTMLElement)) throw new Error("skip-permissions region not found");
    expect(region.textContent).toContain(
      "This agent has no Auto mode, so it launches with its CLI default"
    );
  });

  it("shows the inherit provenance hint only while Default is selected", () => {
    // Scope to the skip-permissions region — the alt-screen control renders its
    // own identical "Inherited from …" hint when it is also on Default.
    const region = (container: HTMLElement) => {
      const el = container.querySelector("#agents-skip-permissions");
      if (!(el instanceof HTMLElement)) throw new Error("skip-permissions region not found");
      return within(el);
    };
    const { container, rerender } = render(
      <BehavioralControls {...makeProps({ dangerousMode: "inherit" })} />
    );
    expect(region(container).getByText("Inherited from global setting")).toBeTruthy();

    rerender(<BehavioralControls {...makeProps({ dangerousMode: "on" })} />);
    expect(region(container).queryByText("Inherited from global setting")).toBeNull();
  });

  it("renders whichever inherit hint the scope supplies, and none once a choice is explicit", () => {
    const region = (container: HTMLElement) => {
      const el = container.querySelector("#agents-skip-permissions");
      if (!(el instanceof HTMLElement)) throw new Error("skip-permissions region not found");
      return within(el);
    };
    for (const inheritHint of [
      "The global setting doesn't apply to this agent",
      "Inherited from agent default",
    ]) {
      const { container, rerender, unmount } = render(
        <BehavioralControls {...makeProps({ inheritHint })} />
      );
      expect(region(container).getByText(inheritHint)).toBeTruthy();
      expect(region(container).queryByText("Inherited from global setting")).toBeNull();
      for (const dangerousMode of ["on", "off", "auto"] as const) {
        rerender(<BehavioralControls {...makeProps({ inheritHint, dangerousMode })} />);
        expect(region(container).queryByText(inheritHint), dangerousMode).toBeNull();
      }
      unmount();
    }
  });
});

describe("BehavioralControls — no screen-mode choice (#16356)", () => {
  it("offers no alt-screen control, leaving only the radios for permission prompts", () => {
    const { container } = render(<BehavioralControls {...makeProps()} />);
    expect(screen.queryByText(/alt.screen/i)).toBeNull();
    expect(screen.queryByRole("radio", { name: "Inline" })).toBeNull();
    const skip = container.querySelector("#agents-skip-permissions");
    if (!(skip instanceof HTMLElement)) throw new Error("skip-permissions region not found");
    expect(screen.getAllByRole("radio")).toEqual(within(skip).getAllByRole("radio"));
  });
});
