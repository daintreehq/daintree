// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  forgetComposerSurfacePane,
  trackComposerSurface,
  wasAssistantLastFocused,
  wasAssistantUsedAfter,
} from "../composerSurface";
import { useMacroFocusStore } from "@/store/macroFocusStore";

function field(parent: HTMLElement, wrapperRole?: string): HTMLInputElement {
  const host = document.createElement("div");
  if (wrapperRole) host.setAttribute("role", wrapperRole);
  const input = document.createElement("input");
  host.append(input);
  parent.append(host);
  return input;
}

function pane(parent: HTMLElement, id: string): HTMLElement {
  const root = document.createElement("div");
  root.setAttribute("data-panel-id", id);
  parent.append(root);
  return root;
}

function press(el: Element): void {
  el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
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

  describe("the Assistant against the panes (#15870)", () => {
    it("ranks the Assistant ahead of a pane the person left for it, past the toolbar", () => {
      field(pane(document.body, "agent-a")).focus();
      field(assistant).focus();
      field(document.body, "toolbar").focus();
      press(document.body);

      expect(wasAssistantUsedAfter(["agent-a"])).toBe(true);
    });

    it("ranks a pane the keyboard went back to ahead of the Assistant", () => {
      field(assistant).focus();
      field(pane(document.body, "agent-a")).focus();
      field(document.body, "toolbar").focus();

      expect(wasAssistantUsedAfter(["agent-a"])).toBe(false);
      expect(wasAssistantUsedAfter(["agent-b"])).toBe(true);
      expect(wasAssistantUsedAfter(["agent-b", "agent-a"])).toBe(false);
    });

    it("counts a press in a pane where focus doesn't move", () => {
      const chrome = document.createElement("div");
      pane(document.body, "agent-a").append(chrome);
      field(assistant).focus();
      press(chrome);

      expect(wasAssistantUsedAfter(["agent-a"])).toBe(false);
    });

    it("takes the Assistant's own terminal for the Assistant, never a pane", () => {
      field(assistant).focus();
      press(pane(assistant, "assistant-1"));
      field(pane(assistant, "assistant-1")).focus();

      expect(wasAssistantUsedAfter(["assistant-1"])).toBe(true);
    });

    it("says nothing until the person has been in the Assistant", () => {
      field(pane(document.body, "agent-a")).focus();

      expect(wasAssistantUsedAfter([])).toBe(false);
      expect(wasAssistantUsedAfter(["agent-b"])).toBe(false);
    });

    it("reads an Assistant registered after tracking began", () => {
      const replacement = document.createElement("aside");
      document.body.append(replacement);
      useMacroFocusStore.getState().setRegionRef("assistant", replacement);
      field(replacement).focus();

      expect(wasAssistantUsedAfter([])).toBe(true);
    });

    it("forgets a pane that closed", () => {
      field(assistant).focus();
      field(pane(document.body, "agent-a")).focus();
      forgetComposerSurfacePane("agent-a");

      expect(wasAssistantUsedAfter(["agent-a"])).toBe(true);
    });

    it("forgets everything when stopped", () => {
      field(assistant).focus();
      stop();

      expect(wasAssistantUsedAfter([])).toBe(false);
      stop = trackComposerSurface();
      field(pane(document.body, "agent-a")).focus();
      expect(wasAssistantUsedAfter([])).toBe(false);
    });
  });
});
