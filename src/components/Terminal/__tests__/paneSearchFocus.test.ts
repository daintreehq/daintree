// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { focusPaneSearchInput } from "../paneSearchFocus";

afterEach(() => {
  document.body.innerHTML = "";
});

function paneWithSearch(query: string): { pane: HTMLDivElement; input: HTMLInputElement } {
  const pane = document.createElement("div");
  const input = document.createElement("input");
  input.setAttribute("data-terminal-search-input", "");
  input.value = query;
  pane.appendChild(input);
  document.body.appendChild(pane);
  return { pane, input };
}

describe("focusPaneSearchInput", () => {
  it("focuses this pane's field even when an earlier pane's bar is open", () => {
    const first = paneWithSearch("earlier");
    const second = paneWithSearch("later");

    focusPaneSearchInput(second.pane);

    expect(document.activeElement).toBe(second.input);
    expect(document.activeElement).not.toBe(first.input);
  });

  it("selects the query already in the field", () => {
    const { pane, input } = paneWithSearch("needle");
    input.focus();
    input.setSelectionRange(6, 6);

    focusPaneSearchInput(pane);

    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(6);
  });

  it("does nothing when the pane has no search field yet", () => {
    paneWithSearch("elsewhere");
    const empty = document.createElement("div");
    document.body.appendChild(empty);

    focusPaneSearchInput(empty);
    focusPaneSearchInput(null);

    expect(document.activeElement).toBe(document.body);
  });
});
