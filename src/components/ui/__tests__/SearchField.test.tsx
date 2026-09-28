// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { SearchField, clearSearchBeforeDismiss } from "../SearchField";
import { PopoverSearchField } from "../PopoverSearchField";

const CSS = fs.readFileSync(
  path.resolve(__dirname, "../../../styles/components/search-field.css"),
  "utf-8"
);

const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Declarations of every top-level rule whose selector matches `selector` —
 * the default-mode styling, with the contrast-mode overrides left out.
 */
function rulesFor(selector: RegExp): string {
  const css = BARE.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "").replace(
    /@variant[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g,
    ""
  );
  const out: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selector.test(match[1]!)) out.push(match[2]!);
  }
  return out.join("\n");
}

describe("SearchField", () => {
  it("shows the clear control only while there is something to clear", () => {
    const onClear = vi.fn();
    const { rerender } = render(
      <SearchField aria-label="Search things" value="" onChange={() => {}} onClear={onClear} />
    );
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();

    rerender(
      <SearchField aria-label="Search things" value="abc" onChange={() => {}} onClear={onClear} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search things" }));
  });

  it("puts the caret in the text when the field's chrome is pressed", () => {
    render(<SearchField aria-label="Search things" value="" onChange={() => {}} />);
    const input = screen.getByRole("textbox", { name: "Search things" });
    const field = input.closest(".search-field")!;
    const glyph = field.querySelector("svg")!;
    fireEvent.pointerDown(glyph);
    expect(document.activeElement).toBe(input);
  });

  it("leaves presses on its own buttons to those buttons", () => {
    render(
      <SearchField aria-label="Search things" value="x" onChange={() => {}} onClear={() => {}} />
    );
    const clear = screen.getByRole("button", { name: "Clear search" });
    const event = fireEvent.pointerDown(clear);
    // fireEvent returns false only when the handler called preventDefault.
    expect(event).toBe(true);
  });
});

describe("SearchField Escape", () => {
  function renderField(value: string, extra: Partial<ComponentProps<typeof SearchField>> = {}) {
    const onClear = vi.fn();
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <SearchField
          aria-label="Search things"
          value={value}
          onChange={() => {}}
          onClear={onClear}
          {...extra}
        />
      </div>
    );
    return { onClear, outer, input: screen.getByRole("textbox") };
  }

  it("clears a query and keeps the key from reaching the surface", () => {
    const { onClear, outer, input } = renderField("abc");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it("lets an empty field's Escape through to the surface", () => {
    const { onClear, outer, input } = renderField("");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClear).not.toHaveBeenCalled();
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("stands down when the caller's own handler claimed Escape", () => {
    const { onClear, input } = renderField("abc", {
      onKeyDown: (e) => {
        if (e.key === "Escape") e.stopPropagation();
      },
    });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClear).not.toHaveBeenCalled();
  });

  it("leaves Escape to an IME that is composing", () => {
    const { onClear, input } = renderField("abc");
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(onClear).not.toHaveBeenCalled();
  });

  it("does nothing on Escape without a way to clear", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <SearchField aria-label="Search things" value="abc" onChange={() => {}} />
      </div>
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(outer).toHaveBeenCalledTimes(1);
  });
});

describe("search inside a dismissable layer", () => {
  function focusedInput(value: string): HTMLInputElement {
    render(<input aria-label="Query" defaultValue={value} />);
    const input = screen.getByLabelText("Query") as HTMLInputElement;
    input.focus();
    return input;
  }

  it("clears a focused query instead of letting the layer close", () => {
    const input = focusedInput("abc");
    const onClear = vi.fn();
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    clearSearchBeforeDismiss(event, input, onClear);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("lets the layer close once the query is empty", () => {
    const input = focusedInput("");
    const onClear = vi.fn();
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    clearSearchBeforeDismiss(event, input, onClear);
    expect(onClear).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves Escape to an IME that is composing", () => {
    const input = focusedInput("abc");
    const onClear = vi.fn();
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
      isComposing: true,
    });
    clearSearchBeforeDismiss(event, input, onClear);
    expect(onClear).not.toHaveBeenCalled();
  });

  it("offers the popover field's clear control only while there is a query", () => {
    const onClear = vi.fn();
    const { rerender } = render(
      <PopoverSearchField aria-label="Find" value="" onChange={() => {}} onClear={onClear} />
    );
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    rerender(
      <PopoverSearchField aria-label="Find" value="x" onChange={() => {}} onClear={onClear} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe("SearchField disabled", () => {
  it("does not offer to clear a field that cannot be edited", () => {
    render(
      <SearchField
        aria-label="Search things"
        value="abc"
        disabled
        onChange={() => {}}
        onClear={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Clear search" }).hasAttribute("disabled")).toBe(
      true
    );
  });
});

describe("search field styling contract", () => {
  it("never spends accent on the field, its focus state or its clear control", () => {
    // Palette inputs are focused whenever their palette is open; accent here
    // would be lit on every opening and compete with the region's one anchor.
    expect(BARE).not.toMatch(/accent/);
  });

  it("marks focus with the neutral selection stroke, the palette row's own token", () => {
    const focus = rulesFor(/^\s*\.search-field:has\(\.search-field-input:focus-visible\)\s*$/);
    expect(focus).toMatch(/border-color:\s*var\(--theme-selection-outline\)/);
  });

  it("changes the fill on focus without discarding the theme's resting fill", () => {
    const rest = rulesFor(/^\s*\.search-field\s*$/);
    const focus = rulesFor(/^\s*\.search-field:has\(\.search-field-input:focus-visible\)\s*$/);
    const focusLayer = rulesFor(
      /^\s*\.search-field:has\(\.search-field-input:focus-visible\)::before\s*$/
    );
    expect(rest).toMatch(/background-color:\s*var\(--search-field-bg/);
    // The lift is a layer over whatever the resting colour is, never a swap of it.
    expect(focus).not.toMatch(/background/);
    expect(focusLayer).toMatch(/opacity:\s*1/);
  });

  it("rests on a quieter edge than the form-field boundary", () => {
    const rest = rulesFor(/^\s*\.search-field\s*$/);
    expect(rest).not.toMatch(/border-input/);
  });

  it("keeps the inner input borderless even against index.css's unlayered contrast-mode borders", () => {
    // This file sits in @layer components; a normal declaration there loses to
    // the unlayered `input { border: … }` the contrast modes set, and the field
    // grows a square box inside itself. Only !important reverses that.
    for (const query of ["forced-colors: active", "prefers-contrast: more"]) {
      const at = BARE.indexOf(`@media (${query})`);
      const block = BARE.slice(at, BARE.indexOf("\n  }\n", at));
      expect(block, query).toMatch(/\.search-field-input\s*\{\s*border:\s*none\s*!important/);
    }
  });

  it("keeps forced-colors and increased-contrast handling in separate blocks", () => {
    const queries = [...BARE.matchAll(/@media([^{]*)\{/g)].map((m) => m[1]!.trim());
    expect(queries).toContain("(forced-colors: active)");
    expect(queries).toContain("(prefers-contrast: more)");
    // Both can match at once; the system-colour indicator has to win the cascade.
    expect(queries.lastIndexOf("(forced-colors: active)")).toBeGreaterThan(
      queries.lastIndexOf("(prefers-contrast: more)")
    );
  });
});
