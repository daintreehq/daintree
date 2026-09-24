// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { SearchField } from "../SearchField";

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
    expect(rest).toMatch(/background-color:\s*var\(--search-field-bg/);
    // A wash layered as an image sits over whatever the resting colour is.
    expect(focus).toMatch(/background-image:/);
    expect(focus).not.toMatch(/background-color:/);
  });

  it("rests on a quieter edge than the form-field boundary", () => {
    const rest = rulesFor(/^\s*\.search-field\s*$/);
    expect(rest).not.toMatch(/border-input/);
  });

  it("keeps forced-colors and increased-contrast handling in separate blocks", () => {
    const queries = [...BARE.matchAll(/@media([^{]*)\{/g)].map((m) => m[1]!.trim());
    expect(queries).toContain("(forced-colors: active)");
    expect(queries).toContain("(prefers-contrast: more)");
  });
});
