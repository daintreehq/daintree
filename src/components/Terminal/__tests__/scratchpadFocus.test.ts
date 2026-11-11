// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const focusMock = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/components/Panel/panelFocusRegistry", () => ({ focusPanelInput: focusMock }));

import { returnFocusFromScratchpad } from "../scratchpadFocus";
import { SCRATCHPAD_BOUNDARY_ATTR } from "@/lib/terminalScratchpad";

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function mountEditor(owner: string): HTMLTextAreaElement {
  const aside = document.createElement("aside");
  aside.setAttribute(SCRATCHPAD_BOUNDARY_ATTR, owner);
  const ta = document.createElement("textarea");
  aside.appendChild(ta);
  document.body.appendChild(aside);
  ta.focus();
  return ta;
}

describe("returnFocusFromScratchpad", () => {
  it("focuses the pane when the editor holds focus", () => {
    mountEditor("term-1");
    returnFocusFromScratchpad("term-1");
    expect(focusMock).toHaveBeenCalledWith("term-1");
  });

  it("leaves the notes before asking the pane, which refuses while they hold focus", () => {
    const ta = mountEditor("term-1");
    focusMock.mockImplementation(() => {
      expect(document.activeElement).not.toBe(ta);
      return true;
    });
    returnFocusFromScratchpad("term-1");
    expect(focusMock).toHaveBeenCalledTimes(1);
  });

  it("forces the handoff for the Hide button even when it did not take focus", () => {
    returnFocusFromScratchpad("term-1", true);
    expect(focusMock).toHaveBeenCalledWith("term-1");
  });

  it("leaves focus alone when it is elsewhere or in another pane's notes", () => {
    returnFocusFromScratchpad("term-1");
    mountEditor("term-2");
    returnFocusFromScratchpad("term-1");
    expect(focusMock).not.toHaveBeenCalled();
  });
});
