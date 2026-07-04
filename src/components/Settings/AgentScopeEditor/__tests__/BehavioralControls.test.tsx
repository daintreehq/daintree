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
    effectiveSkipPerms: false,
    inheritResolvesToOn: true,
    inheritOriginLabel: "global setting",
    inlineMode: "inherit",
    inlineInheritResolvesToInline: true,
    inlineInheritOriginLabel: "global setting",
    customArgsValue: "",
    customArgsPlaceholder: "--flag",
    customArgsDescription: "Extra CLI flags",
    customFlagsOverride: undefined,
    supportsInlineMode: true,
    defaultDangerousArg: "--dangerously-skip-permissions",
    onDangerousModeChange: vi.fn(),
    onInlineModeChange: vi.fn(),
    onCustomFlagsChange: vi.fn(),
    onCustomFlagsOverrideReset: vi.fn(),
    ...overrides,
  };
}

describe("BehavioralControls — skip permissions control", () => {
  it("renders the skip-permissions control as three radios, not text inputs (issue #10530)", () => {
    const { container } = render(<BehavioralControls {...makeProps()} />);
    const region = container.querySelector("#agents-skip-permissions");
    if (!(region instanceof HTMLElement)) throw new Error("skip-permissions region not found");
    const scoped = within(region);
    expect(scoped.getAllByRole("radio")).toHaveLength(3);
    expect(scoped.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("surfaces the inherited resolved value inline on the Default option and updates with the parent", () => {
    const { rerender } = render(
      <BehavioralControls {...makeProps({ inheritResolvesToOn: true })} />
    );
    expect(screen.getByRole("radio", { name: /Default \(On\)/ })).toBeTruthy();

    rerender(<BehavioralControls {...makeProps({ inheritResolvesToOn: false })} />);
    expect(screen.getByRole("radio", { name: /Default \(Off\)/ })).toBeTruthy();
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
});

describe("BehavioralControls — alt-screen mode control (#10876)", () => {
  it("renders the alt-screen control as three radios only when the agent supports inline mode", () => {
    const { container, rerender } = render(<BehavioralControls {...makeProps()} />);
    const region = container.querySelector("#agents-inline-mode");
    if (!(region instanceof HTMLElement)) throw new Error("inline-mode region not found");
    expect(within(region).getAllByRole("radio")).toHaveLength(3);

    rerender(<BehavioralControls {...makeProps({ supportsInlineMode: false })} />);
    expect(container.querySelector("#agents-inline-mode")).toBeNull();
  });

  it("labels the options by effect (Inline / Alt screen), decoupled from stored value polarity", () => {
    const { container } = render(<BehavioralControls {...makeProps()} />);
    const region = container.querySelector("#agents-inline-mode") as HTMLElement;
    const scoped = within(region);
    // Exact names so "Inline" doesn't also match the "Default (Inline)" option.
    expect(scoped.getByRole("radio", { name: "Inline" })).toBeTruthy();
    expect(scoped.getByRole("radio", { name: "Alt screen" })).toBeTruthy();
  });

  it("surfaces what the inline Default resolves to and flips with the parent state", () => {
    const { container, rerender } = render(
      <BehavioralControls {...makeProps({ inlineInheritResolvesToInline: true })} />
    );
    const region = () => container.querySelector("#agents-inline-mode") as HTMLElement;
    expect(within(region()).getByRole("radio", { name: /Default \(Inline\)/ })).toBeTruthy();

    rerender(<BehavioralControls {...makeProps({ inlineInheritResolvesToInline: false })} />);
    expect(within(region()).getByRole("radio", { name: /Default \(Alt screen\)/ })).toBeTruthy();
  });
});
