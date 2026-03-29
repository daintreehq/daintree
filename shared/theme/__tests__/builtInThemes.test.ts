import { describe, expect, it } from "vitest";
import { BUILT_IN_THEME_SOURCES } from "../builtInThemes/index.js";

describe("built-in themes", () => {
  it.each(BUILT_IN_THEME_SOURCES.map((t) => [t.id, t]))("%s has materialBlur set", (_id, theme) => {
    expect(theme.palette.strategy?.materialBlur).toBeGreaterThan(0);
  });
});
