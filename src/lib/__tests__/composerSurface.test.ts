// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trackComposerSurface, wasAssistantLastFocused } from "../composerSurface";
import { useMacroFocusStore } from "@/store/macroFocusStore";

function field(parent: HTMLElement, wrapperRole?: string): HTMLInputElement {
  const host = document.createElement("div");
  if (wrapperRole) host.setAttribute("role", wrapperRole);
  const input = document.createElement("input");
  host.append(input);
  parent.append(host);
  return input;
}

describe("composerSurface", () => {
  let stop: () => void = () => {};
  let assistant: HTMLElement;

  beforeEach(() => {
    assistant = document.createElement("aside");
    document.body.append(assistant);
    useMacroFocusStore.getState().setRegionRef("assistant", assistant);
    stop = trackComposerSurface();
  });

  afterEach(() => {
    stop();
    useMacroFocusStore.getState().setRegionRef("assistant", null);
    document.body.replaceChildren();
  });

  it("remembers the assistant through a palette, a menu and the toolbar", () => {
    field(assistant).focus();
    expect(wasAssistantLastFocused()).toBe(true);

    field(document.body, "toolbar").focus();
    field(document.body, "menu").focus();
    field(document.body, "dialog").focus();
    expect(wasAssistantLastFocused()).toBe(true);
  });

  it("lets go once the keyboard works anywhere else", () => {
    field(assistant).focus();
    field(document.body).focus();

    expect(wasAssistantLastFocused()).toBe(false);
  });

  it("stops following focus when stopped", () => {
    stop();
    field(assistant).focus();

    expect(wasAssistantLastFocused()).toBe(false);
  });
});
